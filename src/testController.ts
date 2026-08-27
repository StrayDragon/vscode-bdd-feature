import * as vscode from 'vscode';
import { parseFeatureLine, detectDocumentLanguage, parseScenarioLine } from './gherkin';
import { parseFeatureTags } from './gherkin/tags';
import { ensureBindings, getBindingsForFeature } from './bindings';
import { getWorkspaceRoot } from './utils';
import { detectTsBddRunner } from './tsBdd';
import { toggles } from './config';
import {
  buildScenarioCommands,
  runScenarioCommands,
} from './runTarget';

/**
 * VS Code native Test Controller.
 *
 * - Lazy discovery: feature items resolve children on demand (big-repo perf)
 * - Tags: binding language (python/rust/typescript/unbound) + every effective
 *   Gherkin tag of the scenario, so the built-in test-explorer filter works
 *   with `@smoke`, `@wip`, … out of the box
 * - Continuous run: re-executes the last request when watched files change
 */

/** Interned TestTags — avoids re-allocating for repeated tags across items. */
const testTagCache = new Map<string, vscode.TestTag>();
function internedTag(name: string): vscode.TestTag {
  let t = testTagCache.get(name);
  if (!t) {
    t = new vscode.TestTag(name);
    testTagCache.set(name, t);
  }
  return t;
}

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
    const text = doc.getText();
    const dialect = detectDocumentLanguage(text);
    const lines = text.split(/\r?\n/);

    let featureName = fileUri.path.split('/').pop() ?? fileUri.fsPath;
    let foundHeader = false;
    for (let i = 0; i < lines.length; i++) {
      const title = parseFeatureLine(lines[i], dialect);
      if (title !== undefined && title.trim()) {
        featureName = title;
        foundHeader = true;
        break;
      }
    }

    const item = this._controller.createTestItem(fileUri.toString(), featureName, fileUri);
    item.canResolveChildren = true;
    if (foundHeader && toggles.tags()) {
      // Reuses the already-split lines — no extra IO.
      const parsed = parseFeatureTags(lines);
      const featureTags = parsed.nodes[0]?.kind === 'feature' ? parsed.nodes[0].effective : [];
      if (featureTags.length > 0) {
        item.tags = featureTags.map(internedTag);
      }
    }
    this._controller.items.add(item);
  }

  /** Populate scenarios under a feature node, tagging by binding + Gherkin tags. */
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
    const lines = doc.getText().split(/\r?\n/);
    const parsed = parseFeatureTags(lines);

    let tsRunnerCache: Awaited<ReturnType<typeof detectTsBddRunner>> | undefined;
    let tsRunnerProbed = false;
    const probeTsRunner = async () => {
      if (!tsRunnerProbed) {
        tsRunnerProbed = true;
        tsRunnerCache = await detectTsBddRunner(); // memoized upstream anyway
      }
      return tsRunnerCache;
    };

    for (const node of parsed.scenarios) {
      const name = node.title ?? '';
      const child = this._controller.createTestItem(
        `${item.uri.toString()}#scenario:${node.line}`,
        name,
        item.uri,
      );
      child.range = new vscode.Range(node.line, 0, node.line, lines[node.line].length);

      const bindings = getBindingsForFeature(item.uri.fsPath, name);
      const langTag = bindings.some(b => b.lang === 'python')
        ? 'python'
        : bindings.some(b => b.lang === 'rust')
          ? 'rust'
          : bindings.some(b => b.lang === 'typescript') || (await probeTsRunner())
            ? 'typescript'
            : 'unbound';

      const gherkinTags = toggles.tags() ? node.effective.map(internedTag) : [];
      child.tags = [internedTag(langTag), ...gherkinTags];
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
    const dialect = detectDocumentLanguage(doc.getText());
    const line = doc.lineAt(test.range.start.line);
    const name = parseScenarioLine(line.text, dialect);
    if (name === undefined) {
      run.skipped(test);
      return;
    }
    const root = getWorkspaceRoot();

    const commands = await buildScenarioCommands(test.uri, name);
    if (commands.length === 0) {
      run.skipped(test);
      return;
    }

    const result = await runScenarioCommands(commands, root);
    if (result.ok) {
      run.passed(test);
    } else {
      run.failed(test, new vscode.TestMessage(result.output.slice(0, 8000)));
    }
  }
}
