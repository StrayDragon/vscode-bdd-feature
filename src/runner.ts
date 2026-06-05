import * as vscode from 'vscode';
import * as path from 'path';
import { parseScenarioLine, formatTestName } from './gherkin';
import { execAsync, getWorkspaceRoot, getOutputChannel } from './utils';

/**
 * Run or debug the current scenario from a .feature file.
 */
export async function runScenario(debug = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'feature') {
    return;
  }

  const document = editor.document;
  const cursorLine = editor.selection.start.line;

  // Walk upward to find the Scenario line
  let scenarioLine: string | undefined;
  let scenarioLineNumber = cursorLine;
  for (let i = cursorLine; i >= 0; i--) {
    const lineText = document.lineAt(i).text;
    const scenarioName = parseScenarioLine(lineText);
    if (scenarioName !== undefined) {
      scenarioLine = lineText;
      scenarioLineNumber = i;
      break;
    }
  }

  if (!scenarioLine) {
    vscode.window.showWarningMessage('No Scenario found above cursor position');
    return;
  }

  const scenarioName = parseScenarioLine(scenarioLine);
  if (!scenarioName) {
    return;
  }

  // Find the test Python file that corresponds to this feature
  const featurePath = document.uri.fsPath;
  const featureDir = path.dirname(featurePath);
  const featureBasename = path.basename(featurePath, '.feature');

  // Look for test_*.py in common patterns
  const searchPatterns = [
    // Same directory
    path.join(featureDir, `test_${featureBasename}.py`),
    // Parent directory
    path.join(featureDir, '..', `test_${featureBasename}.py`),
    // Sibling test directory
    path.join(featureDir, '..', 'test', `test_${featureBasename}.py`),
  ];

  // Also search in workspace
  const wsPatterns = [
    `**/test_${featureBasename}.py`,
  ];

  let testFilePath: string | undefined;

  // Check direct paths first
  for (const p of searchPatterns) {
    try {
      const uri = vscode.Uri.file(p);
      await vscode.workspace.openTextDocument(uri);
      testFilePath = p;
      break;
    } catch {
      // File doesn't exist
    }
  }

  // If not found, search workspace
  if (!testFilePath) {
    const found = await vscode.workspace.findFiles(`**/test_${featureBasename}.py`, '**/__pycache__/**');
    if (found.length > 0) {
      testFilePath = found[0].fsPath;
    }
  }

  if (!testFilePath) {
    vscode.window.showWarningMessage(`No test file found for feature: ${featureBasename}.feature`);
    return;
  }

  // Build pytest node id
  const testName = formatTestName(scenarioName);
  const testNode = `${testFilePath}::test_${testName}`;

  if (debug) {
    await _debugTest(testNode);
  } else {
    await _runTest(testNode);
  }
}

/**
 * Run or debug the current file.
 */
export async function runFile(debug = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const filePath = editor.document.uri.fsPath;
  if (debug) {
    await _debugTest(filePath);
  } else {
    await _runTest(filePath);
  }
}

/**
 * Run a pytest command in the terminal.
 */
async function _runTest(testPath: string): Promise<void> {
  const root = getWorkspaceRoot();
  const config = vscode.workspace.getConfiguration('bddFeature');
  const pytestCmd = config.get<string>('pytestCommand', 'pytest -q');

  // Get or create terminal
  let terminal = vscode.window.terminals.find(t => t.name === 'BDD Test');
  if (!terminal) {
    terminal = vscode.window.createTerminal('BDD Test');
  }

  terminal.show(true);
  if (root) {
    terminal.sendText(`cd "${root}"`);
  }
  terminal.sendText(`${pytestCmd} "${testPath}"`);
}

/**
 * Debug a test using VS Code's Python debugger.
 */
async function _debugTest(testPath: string): Promise<void> {
  const root = getWorkspaceRoot();
  const config = vscode.workspace.getConfiguration('bddFeature');
  const extraArgs = config.get<string[]>('pytestDebugArgs', []);

  const debugConfig: vscode.DebugConfiguration = {
    name: 'Python: pytest',
    type: 'debugpy',
    request: 'launch',
    module: 'pytest',
    args: [testPath, ...extraArgs],
    justMyCode: true,
    console: 'integratedTerminal',
  };

  if (root) {
    debugConfig.cwd = root;
  }

  await vscode.debug.startDebugging(undefined, debugConfig);
}
