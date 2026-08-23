import * as vscode from 'vscode';
import * as path from 'path';
import { parseScenarioLine, detectDocumentLanguage, resolveInheritedStepType } from './gherkin';
import { pytestTestName } from './testNames';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { getWorkspaceRoot } from './utils';

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

/** Run or debug the current scenario. */
export async function runScenario(debug = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'feature') {
    return;
  }

  const ctx = findEnclosingScenario(editor.document, editor.selection.start.line);
  if (!ctx) {
    vscode.window.showWarningMessage('No Scenario found above cursor position');
    return;
  }

  await ensureBindings();
  const bindings = getBindingsForFeature(ctx.featurePath, ctx.scenarioName);
  if (bindings.length === 0) {
    vscode.window.showWarningMessage(
      `No binding found for "${ctx.scenarioName}". ` +
        `Add scenarios("...") (Python) or #[scenario(...)] (Rust) first.`,
    );
    return;
  }

  for (const binding of bindings) {
    if (binding.lang === 'python') {
      await runPythonBinding(binding, ctx, debug);
    } else {
      await runRustBinding(binding, debug);
    }
  }
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
      any = true;
      if (b.lang === 'python') {
        await _runInTerminal(pythonCommand(), `"${b.file.fsPath}"`);
      } else {
        const target = rustTargetFor(b.file.fsPath);
        await _runInTerminal(cargoCommand(), target ? ` --test ${target}` : '');
      }
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
