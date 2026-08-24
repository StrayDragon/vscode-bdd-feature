import * as vscode from 'vscode';
import {
  parseScenarioLine,
  parseFeatureLine,
  detectDocumentLanguage,
} from './gherkin';
import { pytestTestName } from './testNames';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { getWorkspaceRoot } from './utils';
import {
  detectTsBddRunner,
  cucumberCommand,
  playwrightCommand,
  escapeRegExpLiteral,
} from './tsBdd';

/**
 * VS Code native Test Controller.
 *
 * - Lazy discovery: feature items resolve children on demand (big-repo perf)
 * - Tags: python / rust / unbound per scenario, filterable in the UI
 * - Continuous run: re-executes the last request when watched files change
 */
export class BddTestController {
  private _controller: vscode.TestController;
  private _disposables: vscode.Disposable[] = [];
  private _watcher: vscode.FileSystemWatcher | undefined;
  private _continuousRequest: vscode.TestRunRequest | undefined;
  private _continuousTimer: NodeJS.Timeout | undefined;

  constructor() {
    this._controller = vscode.tests.createTestController(
      'bddFeatureController',
      'BDD Feature Tests',
    );

    this._controller.refreshHandler = () => this.refresh();
    // Lazy children resolution
    this._controller.resolveHandler = item =>
      item ? this._resolveFeatureItem(item) : Promise.resolve();

    const runProfile = this._controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this._runTests(request, token),
    );
    runProfile.supportsContinuousRun = true;

    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'feature') {
          void this._reloadFeatureFile(doc);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
  }

  dispose(): void {
    this._watcher?.dispose();
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
        this._addFeatureItem(uri, doc);
      } catch {
        // skip
      }
    }
  }

  /** Create the feature node without children — resolved lazily. */
  private _addFeatureItem(fileUri: vscode.Uri, doc: vscode.TextDocument): void {
    const dialect = detectDocumentLanguage(doc.getText());
    const lines = doc.getText().split(/\r?\n/);

    let featureName = fileUri.path.split('/').pop() ?? fileUri.fsPath;
    for (let i = 0; i < lines.length; i++) {
      const title = parseFeatureLine(lines[i], dialect);
      if (title !== undefined && title.trim()) {
        featureName = title;
        break;
      }
    }

    const item = this._controller.createTestItem(fileUri.toString(), featureName, fileUri);
    item.canResolveChildren = true;
    this._controller.items.add(item);
  }

  /** Populate scenarios under a feature node, tagging by binding language. */
  private async _resolveFeatureItem(item: vscode.TestItem): Promise<void> {
    if (!item.uri) {
      return;
    }
    await ensureBindings();
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(item.uri);
    } catch {
      return;
    }
    const dialect = detectDocumentLanguage(doc.getText());
    const lines = doc.getText().split(/\r?\n/);

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
      const name = parseScenarioLine(lines[i], dialect);
      if (name === undefined) {
        continue;
      }
      const child = this._controller.createTestItem(
        `${item.uri.toString()}#scenario:${i}`,
        name,
        item.uri,
      );
      child.range = new vscode.Range(i, 0, i, lines[i].length);
      const bindings = getBindingsForFeature(item.uri.fsPath, name);
      const tsRunner =
        !bindings.length || bindings.some(b => b.lang === 'typescript')
          ? await detectTsBddRunner()
          : undefined;
      const tag = bindings.some(b => b.lang === 'python')
        ? 'python'
        : bindings.some(b => b.lang === 'rust')
          ? 'rust'
          : bindings.some(b => b.lang === 'typescript') || tsRunner
            ? 'typescript'
            : 'unbound';
      child.tags = [new vscode.TestTag(tag)];
      item.children.add(child);
    }
  }

  private async _reloadFeatureFile(doc: vscode.TextDocument): Promise<void> {
    const existing = this._controller.items.get(doc.uri.toString());
    if (!existing) {
      return;
    }
    existing.children.replace([]);
    await this._resolveFeatureItem(existing);
  }

  private async _runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    if (request.continuous) {
      this._startContinuous(request);
      // Fall through to execute once immediately
    }

    await ensureBindings();
    const run = this._controller.createTestRun(request);
    let tests: vscode.TestItem[] = [];
    try {
      tests = await this._collectTests(request);
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

  /** Watch sources and re-run the last continuous request (debounced). */
  private _startContinuous(request: vscode.TestRunRequest): void {
    this._continuousRequest = request;
    if (this._watcher) {
      return;
    }
    this._watcher = vscode.workspace.createFileSystemWatcher('**/*.{feature,py,rs,ts,js}');
    const schedule = () => {
      if (this._continuousTimer) {
        clearTimeout(this._continuousTimer);
      }
      this._continuousTimer = setTimeout(() => {
        const req = this._continuousRequest;
        if (req) {
          const tokenSource = new vscode.CancellationTokenSource();
          void this._runTests(req, tokenSource.token);
        }
      }, 600);
    };
    this._disposables.push(this._watcher);
    for (const evt of [this._watcher.onDidChange, this._watcher.onDidCreate]) {
      this._disposables.push(evt(schedule));
    }
  }

  /** Gather leaves; lazily resolving feature nodes that were never expanded. */
  private async _collectTests(request: vscode.TestRunRequest): Promise<vscode.TestItem[]> {
    const tests: vscode.TestItem[] = [];
    const gather = async (item: vscode.TestItem): Promise<void> => {
      if (request.exclude?.includes(item)) {
        return;
      }
      if (item.children.size === 0 && item.canResolveChildren) {
        await this._resolveFeatureItem(item);
      }
      if (item.children.size > 0) {
        for (const [, child] of item.children) {
          await gather(child);
        }
      } else {
        tests.push(item);
      }
    };
    if (request.include) {
      for (const inc of request.include) {
        await gather(inc);
      }
    } else {
      for (const [, item] of this._controller.items) {
        await gather(item);
      }
    }
    return tests;
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
    const root = getWorkspaceRoot();

    // Build one command per binding; empty list → resolve via TS runner.
    const buildCmds = async (): Promise<string[][]> => {
      const bindings = getBindingsForFeature(test.uri!.fsPath, name);
      if (bindings.length === 0) {
        const runner = await detectTsBddRunner();
        if (!runner) {
          return [];
        }
        const nameArg = escapeRegExpLiteral(name);
        return [
          runner === 'cucumber-js'
            ? [...cucumberCommand().split(/\s+/), test.uri!.fsPath, '--name', nameArg]
            : [...playwrightCommand().split(/\s+/), '-g', nameArg],
        ];
      }
      const cmds: string[][] = [];
      for (const b of bindings) {
        if (b.lang === 'python') {
          const pytestCmd = vscode.workspace
            .getConfiguration('bddFeature')
            .get<string>('pytestCommand', 'pytest -q');
          cmds.push([...pytestCmd.split(/\s+/), `${b.file.fsPath}::${pytestTestName(name)}`]);
        } else if (b.lang === 'rust') {
          const cargoCmd = vscode.workspace
            .getConfiguration('bddFeature')
            .get<string>('cargoTestCommand', 'cargo test');
          cmds.push([
            ...cargoCmd.split(/\s+/),
            '--',
            '--exact',
            ...(b.rustTestFnName ? [b.rustTestFnName] : []),
          ]);
        } else {
          // TS binding (jest-cucumber): the runnable unit is the binding file,
          // executed by the user's jest/vitest — approximate via detected runner.
          const runner = await detectTsBddRunner();
          if (!runner) {
            continue;
          }
          const nameArg = escapeRegExpLiteral(name);
          cmds.push(
            runner === 'cucumber-js'
              ? [...cucumberCommand().split(/\s+/), test.uri!.fsPath, '--name', nameArg]
              : [...playwrightCommand().split(/\s+/), '-g', nameArg],
          );
        }
      }
      return cmds;
    };

    const commands = await buildCmds();
    if (commands.length === 0) {
      run.skipped(test);
      return;
    }

    let allPassed = true;
    const messages: string[] = [];
    for (const cmd of commands) {
      try {
        const output = await exec(cmd, root);
        const failed =
          /test result:\s*FAILED/.test(output) ||
          /[1-9]\d*\s+failed/.test(output) ||
          /no tests ran|collected\s+0\s+items/.test(output) ||
          /\b\d+\s+passed\b.*\b[1-9]\d*\s+failed\b/.test(output);
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
}

function exec(command: string[], cwd?: string): Promise<string> {
  const cp = require('child_process') as typeof import('child_process');
  return new Promise((resolve, reject) => {
    cp.execFile(
      command[0],
      command.slice(1),
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || String(error)));
        } else {
          resolve(stdout || stderr);
        }
      },
    );
  });
}
