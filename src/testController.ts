import * as vscode from 'vscode';
import * as path from 'path';
import { parseScenarioLine, formatTestName } from './gherkin';
import { execAsync, getWorkspaceRoot, getOutputChannel } from './utils';

/**
 * VS Code native Test Controller for pytest-bdd scenarios.
 * Uses the Test API (vscode.TestController) instead of a custom TreeDataProvider.
 */
export class BddTestController {
  private _controller: vscode.TestController;
  private _runProfile: vscode.TestRunProfile | undefined;
  private _debugProfile: vscode.TestRunProfile | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor() {
    this._controller = vscode.tests.createTestController(
      'bddFeatureController',
      'BDD Feature Tests',
    );

    this._controller.refreshHandler = () => this._discoverTests();

    // Run profile
    this._runProfile = this._controller.createRunProfile(
      'Run',
      vscode.TestRunProfileKind.Run,
      (request, token) => this._runTests(request, token),
    );

    // Debug profile
    this._debugProfile = this._controller.createRunProfile(
      'Debug',
      vscode.TestRunProfileKind.Debug,
      (request, token) => this._debugTests(request, token),
    );

    // Watch for file changes
    this._disposables.push(
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId === 'feature') {
          this._refreshFeatureFile(doc);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._discoverTests()),
    );

    // Initial discovery
    this._discoverTests();
  }

  dispose(): void {
    this._controller.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
  }

  /**
   * Discover all .feature files and their scenarios.
   */
  private async _discoverTests(): Promise<void> {
    const featureFiles = await vscode.workspace.findFiles('**/*.feature');
    this._controller.items.replace([]);

    for (const fileUri of featureFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        this._addFeatureFileItems(fileUri, doc);
      } catch {
        // Skip unreadable files
      }
    }
  }

  /**
   * Parse a feature file and add its scenarios as test items.
   */
  private _addFeatureFileItems(fileUri: vscode.Uri, doc: vscode.TextDocument): void {
    const text = doc.getText();
    const lines = text.split(/\r?\n/);

    // Get feature name
    let featureName = path.basename(fileUri.fsPath);
    for (const line of lines) {
      const match = line.match(/^\s*(Feature|功能)\s*:\s*(.+)/);
      if (match) {
        featureName = match[2].trim();
        break;
      }
    }

    const featureItem = this._controller.createTestItem(
      fileUri.toString(),
      featureName,
      fileUri,
    );
    featureItem.canResolveChildren = true;
    this._controller.items.add(featureItem);

    // Find scenarios
    let isInExamples = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();

      // Track if we're inside an Examples block (skip those lines)
      if (/^\s*(Examples|例子)\s*:/.test(trimmed)) {
        isInExamples = true;
        continue;
      }
      if (isInExamples) {
        if (trimmed.startsWith('|') || trimmed === '') {
          continue;
        }
        isInExamples = false;
      }

      const scenarioName = parseScenarioLine(line);
      if (scenarioName !== undefined) {
        const testId = `${fileUri.toString()}#scenario:${i}`;
        const testItem = this._controller.createTestItem(
          testId,
          scenarioName,
          fileUri,
        );
        testItem.range = new vscode.Range(i, 0, i, line.length);
        featureItem.children.add(testItem);
      }
    }
  }

  /**
   * Refresh a single feature file's test items.
   */
  private _refreshFeatureFile(doc: vscode.TextDocument): void {
    const existing = this._controller.items.get(doc.uri.toString());
    if (existing) {
      existing.children.replace([]);
      this._addFeatureFileItems(doc.uri, doc);
    }
  }

  /**
   * Run tests using pytest.
   */
  private async _runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const run = this._controller.createTestRun(request);
    const tests = this._collectTests(request);

    try {
      for (const test of tests) {
        if (token.isCancellationRequested) {
          break;
        }
        run.started(test);
        await this._runSingleTest(test, run);
      }
    } finally {
      run.end();
    }
  }

  /**
   * Debug tests.
   */
  private async _debugTests(
    request: vscode.TestRunRequest,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const tests = this._collectTests(request);
    if (tests.length === 0) {
      return;
    }

    // For debug, run the first test via debugpy
    const test = tests[0];
    const testPath = this._buildTestPath(test);
    if (!testPath) {
      return;
    }

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

    const root = getWorkspaceRoot();
    if (root) {
      debugConfig.cwd = root;
    }

    await vscode.debug.startDebugging(undefined, debugConfig);
  }

  /**
   * Collect all test items from a request.
   */
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

  /**
   * Run a single test via pytest and update the test run.
   */
  private async _runSingleTest(test: vscode.TestItem, run: vscode.TestRun): Promise<void> {
    const testPath = this._buildTestPath(test);
    if (!testPath) {
      run.skipped(test);
      return;
    }

    const root = getWorkspaceRoot();
    const config = vscode.workspace.getConfiguration('bddFeature');
    const pytestCmd = config.get<string>('pytestCommand', 'pytest -q');

    try {
      const output = await execAsync(`${pytestCmd} "${testPath}"`, root);
      const channel = getOutputChannel();
      channel.appendLine(`\n--- ${test.label} ---`);
      channel.appendLine(output);

      if (output.includes('passed') && !output.includes('failed')) {
        run.passed(test);
      } else if (output.includes('failed') || output.includes('error')) {
        run.failed(test, new vscode.TestMessage(output));
      } else if (output.includes('skipped')) {
        run.skipped(test);
      } else {
        run.passed(test);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      run.failed(test, new vscode.TestMessage(msg));
    }
  }

  /**
   * Build a pytest node id from a test item.
   */
  private _buildTestPath(test: vscode.TestItem): string | undefined {
    if (!test.uri) {
      return undefined;
    }

    const filePath = test.uri.fsPath;
    // If this is a scenario item (has range), build the test function name
    if (test.range) {
      // Find the corresponding test function
      // For now, just use the scenario name to build a test name
      const testName = formatTestName(test.label.toString());
      return `${filePath}::test_${testName}`;
    }

    return filePath;
  }
}
