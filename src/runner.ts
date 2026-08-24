import * as vscode from 'vscode';
import * as path from 'path';
import { parseScenarioLine, detectDocumentLanguage, resolveInheritedStepType } from './gherkin';
import { pytestTestName } from './testNames';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { getWorkspaceRoot } from './utils';
import {
  detectTsBddRunner,
  cucumberCommand,
  playwrightCommand,
  escapeRegExpLiteral,
} from './tsBdd';

interface ScenarioContext {
  scenarioName: string;
  featurePath: string;
}

/** Locate the enclosing scenario of the cursor in a .feature document. */
export function findEnclosingScenario(
  document: vscode.TextDocument,
  cursorLine: number,
): ScenarioContext | undefined {
  const dialect = detectDocumentLanguage(document.getText());
  for (let i = cursorLine; i >= 0; i--) {
    const name = parseScenarioLine(document.lineAt(i).text, dialect);
    if (name !== undefined) {
      return { scenarioName: name, featurePath: document.uri.fsPath };
    }
  }
  return undefined;
}

/** Run or debug the scenario at `atLine` (or under the cursor). */
export async function runScenario(debug = false, atLine?: number): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'feature') {
    return;
  }

  const ctx = findEnclosingScenario(
    editor.document,
    atLine ?? editor.selection.start.line,
  );
  if (!ctx) {
    vscode.window.showWarningMessage('No Scenario found above cursor position');
    return;
  }

  await ensureBindings();
  const bindings = getBindingsForFeature(ctx.featurePath, ctx.scenarioName);
  if (bindings.length === 0) {
    // cucumber-js / playwright-bdd discover features without code bindings —
    // run through the detected runner instead of warning.
    if (await runWithTsRunner(ctx.featurePath, ctx.scenarioName)) {
      return;
    }
    vscode.window.showWarningMessage(
      `No binding found for "${ctx.scenarioName}". ` +
        `Add scenarios("...") (Python), #[scenario(...)] (Rust), defineFeature(loadFeature(...)) (TS) ` +
        `or install @cucumber/cucumber / playwright-bdd.`,
    );
    return;
  }

  for (const binding of bindings) {
    if (binding.lang === 'python') {
      await runPythonBinding(binding, ctx, debug);
    } else if (binding.lang === 'rust') {
      await runRustBinding(binding, debug);
    } else {
      await runWithTsRunner(ctx.featurePath, ctx.scenarioName);
    }
  }
}

/**
 * Run a scenario/feature via the workspace's TS BDD runner, when detectable.
 * Returns true when a command was issued.
 */
export async function runWithTsRunner(
  featurePath: string,
  scenarioName?: string,
): Promise<boolean> {
  const runner = await detectTsBddRunner();
  if (!runner) {
    return false;
  }
  const nameArg = scenarioName ? escapeRegExpLiteral(scenarioName) : undefined;
  if (runner === 'cucumber-js') {
    const args = [`"${featurePath}"`];
    if (nameArg) {
      args.push('--name', `"${nameArg}"`);
    }
    await _runInTerminal(cucumberCommand(), args.join(' '));
    return true;
  }
  // playwright-bdd: generated tests are greppable by scenario title
  await _runInTerminal(playwrightCommand(), nameArg ? `-g "${nameArg}"` : '');
  return true;
}

/** Run or debug the whole file (delegates by language of active editor). */
export async function runFile(debug = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const fsPath = editor.document.uri.fsPath;

  if (editor.document.languageId === 'feature') {
    await ensureBindings();
    // Run every distinct binding file that references this feature.
    const all = getBindingsForFeature(fsPath);
    const seen = new Set<string>();
    let any = false;
    for (const b of all) {
      if (seen.has(b.file.fsPath)) {
        continue;
      }
      seen.add(b.file.fsPath);
      if (b.lang === 'python') {
        any = true;
        await _runInTerminal(pythonCommand(), `"${b.file.fsPath}"`);
      } else if (b.lang === 'rust') {
        any = true;
        const target = rustTargetFor(b.file.fsPath);
        await _runInTerminal(cargoCommand(), target ? ` --test ${target}` : '');
      } else {
        any = (await runWithTsRunner(fsPath)) || any;
      }
    }
    if (!any) {
      // No code bindings — try the TS runners before giving up.
      any = await runWithTsRunner(fsPath);
    }
    if (!any) {
      vscode.window.showWarningMessage('No test binding found for this feature file');
    }
    return;
  }

  if (editor.document.languageId === 'python' && debug) {
    await debugPytest(`"${fsPath}"`);
  } else if (editor.document.languageId === 'python') {
    await _runInTerminal(pythonCommand(), `"${fsPath}"`);
  } else if (editor.document.languageId === 'rust') {
    await _runInTerminal(cargoCommand(), '');
  } else if (
    editor.document.languageId === 'typescript' ||
    editor.document.languageId === 'javascript'
  ) {
    const runner = await detectTsBddRunner();
    if (runner === 'cucumber-js') {
      await _runInTerminal(cucumberCommand(), '');
    } else if (runner === 'playwright-bdd') {
      await _runInTerminal(playwrightCommand(), '');
    }
  }
}

// ── Python ──

function pythonCommand(): string {
  return vscode.workspace.getConfiguration('bddFeature').get<string>('pytestCommand', 'pytest -q');
}

async function runPythonBinding(
  binding: import('./model').FeatureBinding,
  ctx: ScenarioContext,
  debug: boolean,
): Promise<void> {
  const relFile = path.relative(getWorkspaceRoot() ?? '', binding.file.fsPath);
  const testName = pytestTestName(ctx.scenarioName);
  const nodeId = `${relFile}::${testName}`;

  if (debug) {
    await debugPytest(nodeId);
    return;
  }
  // Exact node id also collects all parametrized outline variants.
  await _runInTerminal(pythonCommand(), `"${nodeId}"`);
}

async function debugPytest(targetArg: string): Promise<void> {
  const extraArgs = vscode.workspace
    .getConfiguration('bddFeature')
    .get<string[]>('pytestDebugArgs', []);
  const root = getWorkspaceRoot();
  const config: vscode.DebugConfiguration = {
    name: 'Python: pytest-bdd',
    type: 'debugpy',
    request: 'launch',
    module: 'pytest',
    args: [targetArg, ...extraArgs],
    justMyCode: true,
    console: 'integratedTerminal',
  };
  if (root) {
    config.cwd = root;
  }
  await vscode.debug.startDebugging(undefined, config);
}

// ── Rust ──

function cargoCommand(): string {
  return vscode.workspace
    .getConfiguration('bddFeature')
    .get<string>('cargoTestCommand', 'cargo test');
}

/** Infer the integration-test target from a tests/ path layout. */
export function rustTargetFor(bindingFsPath: string): string | undefined {
  const parts = bindingFsPath.split('/');
  const testsIdx = parts.lastIndexOf('tests');
  if (testsIdx === -1) {
    return undefined;
  }
  const rest = parts.slice(testsIdx + 1);
  if (rest.length === 1) {
    return rest[0].replace(/\.rs$/, ''); // tests/foo.rs → target foo
  }
  return rest[0]; // tests/bdd/bindings_x.rs → target bdd (main.rs)
}

async function runRustBinding(
  binding: import('./model').FeatureBinding,
  debug: boolean,
): Promise<void> {
  if (!binding.rustTestFnName) {
    return;
  }
  const target = rustTargetFor(binding.file.fsPath);
  const cmd = cargoCommand();
  const args = target ? ` --test ${target} ${binding.rustTestFnName}` : ` ${binding.rustTestFnName}`;
  if (debug) {
    vscode.window.showInformationMessage(
      'Rust BDD debugging: use CodeLLDB on the cargo test binary; running without debugger.',
    );
  }
  await _runInTerminal(cmd, args);
}

// ── Shared ──

async function _runInTerminal(command: string, args: string): Promise<void> {
  const root = getWorkspaceRoot();
  let terminal = vscode.window.terminals.find(t => t.name === 'BDD Test');
  if (!terminal) {
    terminal = vscode.window.createTerminal('BDD Test');
  }
  terminal.show(true);
  if (root) {
    terminal.sendText(`cd "${root}"`);
  }
  terminal.sendText(`${command} ${args}`.trim());
}
