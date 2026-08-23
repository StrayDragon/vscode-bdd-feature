import * as vscode from 'vscode';
import {
  parseScenarioLine,
  parseFeatureLine,
  detectDocumentLanguage,
} from './gherkin';
import { pytestTestName } from './testNames';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { getWorkspaceRoot } from './utils';

/**
 * VS Code native Test Controller.
 *
 * Discovers scenarios in .feature files and executes them through their
 * discovered bindings (pytest for Python, cargo test for Rust).
 */
export class BddTestController {
  private _controller: vscode.TestController;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._controller = vscode.tests.createTestController(
      'bddFeatureController',
      'BDD Feature Tests',
    );

    this._controller.refreshHandler = () => this.refresh();

    this._controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this._runTests(request, token),
    );

    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'feature') {
          this._refreshFeatureFile(doc);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );

    void this.refresh();
  }

  dispose(): void {
    this._controller.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  /** Full re-discovery of feature files + binding index. */
  async refresh(): Promise<void> {
    await ensureBindings();
    const featureFiles = await vscode.workspace.findFiles(
      '**/*.feature',
      '**/{node_modules,target}/**',
      3000,
    );
    this._controller.items.replace([]);
    for (const uri of featureFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        this._addFeatureFileItems(uri, doc);
      } catch {
        // skip
      }
    }
  }

  private _addFeatureFileItems(fileUri: vscode.Uri, doc: vscode.TextDocument): void {
    const dialect = detectDocumentLanguage(doc.getText());
    const lines = doc.getText().split(/\r?\n/);

    let featureName = fileUri.path.split('/').pop() ?? fileUri.fsPath;
    for (let i = 0; i < lines.length; i++) {
      const title = parseFeatureLine(lines[i], dialect);
      if (title !== undefined) {
        featureName = title || featureName;
        break;
      }
    }

    const featureItem = this._controller.createTestItem(fileUri.toString(), featureName, fileUri);
    featureItem.canResolveChildren = true;
    this._controller.items.add(featureItem);

    let inExamples = false;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      if (/^(Examples|例子)\s*:/i.test(trimmed)) {
        inExamples = true;
        continue;
      }
      if (inExamples) {
        if (trimmed.startsWith('|') || trimmed === '') {
          continue;
        }
        inExamples = false;
      }
      const scenarioName = parseScenarioLine(lines[i], dialect);
      if (scenarioName !== undefined) {
        const item = this._controller.createTestItem(
          `${fileUri.toString()}#scenario:${i}`,
          scenarioName,
          fileUri,
        );
        item.range = new vscode.Range(i, 0, i, lines[i].length);
        featureItem.children.add(item);
      }
    }
  }

  private _refreshFeatureFile(doc: vscode.TextDocument): void {
    const existing = this._controller.items.get(doc.uri.toString());
    if (!existing) {
      return;
    }
    existing.children.replace([]);
    this._addFeatureFileItems(doc.uri, doc);
  }

  private async _runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    await ensureBindings();
    const run = this._controller.createTestRun(request);
    const tests = this._collectTests(request);

    try {
      for (const test of tests) {
        if (token.isCancellationRequested) {
          break;
        }
        run.started(test);
        await this._runSingle(test, run);
      }
    } finally {
      run.end();
    }
  }

  private async _runSingle(test: vscode.TestItem, run: vscode.TestRun): Promise<void> {
    if (!test.uri || !test.range) {
      run.skipped(test);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(test.uri);
    const line = doc.lineAt(test.range.start.line);
    const dialect = detectDocumentLanguage(doc.getText());
    const name = parseScenarioLine(line.text, dialect);
    if (name === undefined) {
      run.skipped(test);
      return;
    }

    const bindings = getBindingsForFeature(test.uri.fsPath, name);
    if (bindings.length === 0) {
      run.skipped(test);
      return;
    }

    const root = getWorkspaceRoot();
    let allPassed = true;
    const messages: string[] = [];

    for (const b of bindings) {
      try {
        let output: string;
        let cmd: string[];
        if (b.lang === 'python') {
          const pytestCmd = vscode.workspace
            .getConfiguration('bddFeature')
            .get<string>('pytestCommand', 'pytest -q');
          cmd = [...pytestCmd.split(/\s+/), `${b.file.fsPath}::${pytestTestName(name)}`];
        } else {
          const cargoCmd = vscode.workspace
            .getConfiguration('bddFeature')
            .get<string>('cargoTestCommand', 'cargo test');
          cmd = [
            ...cargoCmd.split(/\s+/),
            '--',
            '--exact',
            ...(b.rustTestFnName ? [b.rustTestFnName] : []),
          ];
        }
        output = await exec(cmd, root);
        // Simple, robust summary heuristics:
        //   pytest → "1 failed, 2 passed" / "no tests ran";  cargo → "test result: FAILED"
        const failed =
          /test result:\s*FAILED/.test(output) ||
          /[1-9]\d*\s+failed/.test(output) ||
          /no tests ran|collected\s+0\s+items/.test(output);
        if (failed) {
          allPassed = false;
        }
        messages.push(output.slice(-4000));
      } catch (err) {
        allPassed = false;
        messages.push(err instanceof Error ? err.message : String(err).slice(0, 4000));
      }
    }

    if (allPassed) {
      run.passed(test);
    } else {
      run.failed(test, new vscode.TestMessage(messages.join('\n---\n').slice(0, 8000)));
    }
  }

  private _collectTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    const tests: vscode.TestItem[] = [];
    const gather = (item: vscode.TestItem) => {
      if (request.exclude?.includes(item)) {
        return;
      }
      if (item.children.size > 0) {
        item.children.forEach(gather);
      } else {
        tests.push(item);
      }
    };
    if (request.include) {
      request.include.forEach(gather);
    } else {
      this._controller.items.forEach(gather);
    }
    return tests;
  }
}

function exec(command: string[], cwd?: string): Promise<string> {
  const cp = require('child_process') as typeof import('child_process');
  return new Promise((resolve, reject) => {
    cp.exec(command.join(' '), { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        reject(new Error(stderr || String(error)));
      } else {
        resolve(stdout || stderr);
      }
    });
  });
}
