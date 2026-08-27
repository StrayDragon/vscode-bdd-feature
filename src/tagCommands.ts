import * as vscode from 'vscode';
import {
  compileTagExpression,
  tagExprToPytestMarker,
  tagExprToPlaywrightGrep,
  TagExpressionError,
} from './gherkin/tags';
import {
  ensureTagIndex,
  matchingScenarios,
  type ScenarioMatch,
} from './tagIndex';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { detectTsBddRunner } from './tsBdd';
import { getWorkspaceRoot, getOutputChannel } from './utils';
import { buildScenarioCommands, runScenarioCommands } from './runTarget';

/**
 * Run scenarios by Cucumber tag expression.
 *
 * Strategy — native runner filters win (one process, row-accurate):
 *   1. pytest-bdd      → `pytest -m "<markers>"`   (tags become pytest marks)
 *   2. cucumber-js     → `cucumber-js … --tags "<expr>"`
 *   3. playwright-bdd  → `playwright test --grep "<translated regex>"`
 *   4. rust / unknown  → scenario QuickPick fallback (per-scenario commands)
 */

const EXAMPLES = 'e.g. @smoke and not @slow · (@a or @b) and not @wip · ~@draft';

export async function runScenariosByTagExpression(prefill?: string): Promise<void> {
  const expression = await promptTagExpression(prefill);
  if (expression === undefined) {
    return; // cancelled or invalid
  }

  await Promise.all([ensureTagIndex(), ensureBindings()]);
  let predicate;
  try {
    predicate = compileTagExpression(expression);
  } catch (e) {
    showExpressionError(e);
    return;
  }

  const matches = matchingScenarios(predicate);
  if (matches.length === 0) {
    vscode.window.showInformationMessage(`No scenarios match "${expression}"`);
    return;
  }

  const files = new Set(matches.map(m => m.file.fsPath));
  void vscode.window.showInformationMessage(
    `"${expression}" matches ${matches.length} scenario${matches.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'} — launching…`,
  );

  await dispatchNative(expression, matches);
}

/** Ask for an expression; returns undefined when cancelled/invalid. */
async function promptTagExpression(prefill?: string): Promise<string | undefined> {
  const value = await vscode.window.showInputBox({
    title: 'BDD: Run Scenarios by Tag Expression',
    value: prefill,
    placeHolder: '@smoke and not @wip',
    prompt: `Cucumber tag expression. ${EXAMPLES}`,
    validateInput: text => {
      if (!text.trim()) {
        return undefined; // allow empty to close silently
      }
      try {
        compileTagExpression(text);
        return undefined;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
  });
  return value?.trim() ? value : undefined;
}

function showExpressionError(err: unknown): void {
  const msg =
    err instanceof TagExpressionError && err.position !== undefined
      ? `${err.message} (position ${err.position})`
      : err instanceof Error
        ? err.message
        : String(err);
  void vscode.window.showErrorMessage(`Invalid tag expression: ${msg}`);
}

// ── Dispatch ──

type Strategy =
  | { kind: 'pytest'; marker: string }
  | { kind: 'cucumber'; files: string[] }
  | { kind: 'playwright'; grepRegex: string }
  | { kind: 'fallback' };

async function resolveStrategy(expression: string, matches: ScenarioMatch[]): Promise<Strategy> {
  // Explicit code bindings are the strongest signal about the project's runner.
  let hasPython = false;
  let hasRust = false;
  for (const m of matches.slice(0, 200)) {
    const bindings = getBindingsForFeature(m.file.fsPath);
    if (bindings.some(b => b.lang === 'python')) {
      hasPython = true;
      break;
    }
    if (!hasRust && bindings.some(b => b.lang === 'rust')) {
      hasRust = true;
    }
  }
  if (hasPython) {
    try {
      return { kind: 'pytest', marker: tagExprToPytestMarker(expression) };
    } catch {
      return { kind: 'fallback' }; // non-identifier tags → per-scenario path
    }
  }
  if (hasRust) {
    return { kind: 'fallback' }; // rstest-bdd has no native tag filter yet
  }

  const tsRunner = await detectTsBddRunner();
  if (tsRunner === 'cucumber-js') {
    const files = [...new Set(matches.map(m => m.file.fsPath))];
    return files.length > 0 ? { kind: 'cucumber', files } : { kind: 'fallback' };
  }
  if (tsRunner === 'playwright-bdd') {
    try {
      return { kind: 'playwright', grepRegex: tagExprToPlaywrightGrep(expression) };
    } catch {
      return { kind: 'fallback' };
    }
  }
  return { kind: 'fallback' };
}

async function dispatchNative(expression: string, matches: ScenarioMatch[]): Promise<void> {
  const strategy = await resolveStrategy(expression, matches);
  switch (strategy.kind) {
    case 'pytest': {
      const cmd = cfg('pytestCommand', 'pytest -q');
      await runInTerminal([`${cmd} -m ${shellQuote(strategy.marker)}`]);
      return;
    }
    case 'cucumber': {
      const base = cfg('cucumberCommand', 'npx cucumber-js');
      // Chunk file lists so long command lines stay within shell limits.
      const chunks = chunkByBudget(strategy.files.map(f => shellQuote(f)), 6000);
      await runInTerminal(chunks.map(args => `${base} --tags ${shellQuote(expression)} ${args}`));
      return;
    }
    case 'playwright': {
      const base = cfg('playwrightCommand', 'npx playwright test');
      await runInTerminal([`${base} --grep ${shellQuote(strategy.grepRegex)}`]);
      return;
    }
    case 'fallback':
      await runViaQuickPick(matches);
      return;
  }
}

// ── Terminal execution (streams output, zero buffering) ──

async function runInTerminal(commands: string[]): Promise<void> {
  let terminal = vscode.window.terminals.find(t => t.name === TERMINAL_NAME && !t.exitStatus);
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: TERMINAL_NAME });
  }
  terminal.show(true);
  // Commands are queued as shell input — typed-ahead lines stay in the TTY
  // buffer while the previous runner (pytest/cucumber) is foregrounded and
  // are consumed by the next shell prompt, so chunked batches run in order.
  for (const cmd of commands) {
    terminal.sendText(cmd, true);
  }
}

const TERMINAL_NAME = 'BDD Tag Run';

// ── Per-scenario fallback ──

async function runViaQuickPick(matches: ScenarioMatch[]): Promise<void> {
  type PickItem = vscode.QuickPickItem & { ref: ScenarioMatch };
  const items: PickItem[] = matches
    .slice()
    .sort((a, b) => a.file.relPath.localeCompare(b.file.relPath) || a.scenario.line - b.scenario.line)
    .map(m => ({
      label: `${m.file.featureName ?? basename(m.file.relPath)} › ${m.scenario.name || '(untitled)'}`,
      description: `${m.file.relPath}:${m.scenario.line + 1}`,
      detail: m.scenario.tags.join(' '),
      picked: true,
      ref: m,
    }));

  const selected = await vscode.window.showQuickPick(items, {
    title: 'BDD: Scenarios matching the tag expression',
    placeHolder: 'Pre-selected from the expression — uncheck what you do not want to run',
    canPickMany: true,
    matchOnDescription: true,
    matchOnDetail: false,
  });
  if (!selected || selected.length === 0) {
    return;
  }

  const root = getWorkspaceRoot();
  const channel = getOutputChannel();
  channel.appendLine(`── BDD tag run: ${selected.length} scenario(s) ──`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Running BDD scenarios…', cancellable: true },
    async (progress, token) => {
      let failed = 0;
      for (let i = 0; i < selected.length; i++) {
        if (token.isCancellationRequested) {
          break;
        }
        const it = selected[i];
        progress.report({
          message: `${i + 1}/${selected.length}: ${it.ref.scenario.name}`,
          increment: (100 / selected.length),
        });
        const cmds = await buildScenarioCommands(it.ref.file.uri, it.ref.scenario.name);
        if (cmds.length === 0) {
          channel.appendLine(`SKIP (unbound) ${it.description}`);
          continue;
        }
        const result = await runScenarioCommands(cmds, root);
        channel.appendLine(`${result.ok ? 'PASS' : 'FAIL'} ${it.description}`);
        if (!result.ok) {
          failed++;
          channel.appendLine(result.output);
        }
      }
      channel.show(true);
      if (failed > 0) {
        void vscode.window.showWarningMessage(`BDD tag run finished: ${failed} failed (see output)`);
      } else {
        void vscode.window.showInformationMessage('BDD tag run finished: all passed');
      }
    },
  );
}

// ── Small helpers ──

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('bddFeature').get<T>(key, fallback);
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** POSIX-safe quoting that also survives Windows cmd reasonably well. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  if (process.platform === 'win32') {
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function chunkByBudget(quotedArgs: string[], budget: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const arg of quotedArgs) {
    if (current && current.length + arg.length + 1 > budget) {
      chunks.push(current);
      current = arg;
    } else {
      current = current ? `${current} ${arg}` : arg;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}
