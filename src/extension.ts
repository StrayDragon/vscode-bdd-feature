import * as vscode from 'vscode';
import { FeatureDefinitionProvider } from './definitionProvider';
import { FeatureCompletionProvider } from './completionProvider';
import { FeatureSemanticTokensProvider, semanticTokensLegend } from './semanticToken';
import { FeatureReferenceProvider } from './referenceProvider';
import { createStepDefinition } from './createStep';
import { runScenario, runFile } from './runner';
import { BddTestController } from './testController';
import { scanStepDefinitions, registerStepRefreshOnSave } from './steps';
import { ensureBindings } from './bindings';
import { bindFeatureCommand } from './bindFeature';
import { onConfigChange, toggles } from './config';
import { BddDiagnostics } from './providers/diagnostics';
import { BddCodeActionProvider } from './providers/codeActions';
import { getCodeLensProvider } from './providers/codeLens';
import {
  BddDocumentSymbolProvider,
  BddWorkspaceSymbolProvider,
  BddFoldingRangeProvider,
} from './providers/symbols';
import { BddHoverProvider } from './providers/hover';
import { BddTableFormattingProvider } from './providers/tableFormat';
import { BddRenameProvider } from './providers/rename';
import { BddSnippetProvider } from './providers/snippets';
import { findStepUsages } from './refSearch';
import type { StepDefinition } from './model';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('BDD Feature');
  outputChannel.appendLine('BDD Feature extension activating...');

  // ── Scanning ──
  void scanStepDefinitions();
  void ensureBindings();
  registerStepRefreshOnSave(context.subscriptions);

  // ── Core providers (always on) ──
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureDefinitionProvider(),
    ),
    vscode.languages.registerCompletionItemProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureCompletionProvider(),
      ' ',
    ),
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureSemanticTokensProvider(),
      semanticTokensLegend,
    ),
    vscode.languages.registerReferenceProvider(
      [
        { language: 'feature', scheme: 'file' },
        { language: 'python', scheme: 'file' },
        { language: 'rust', scheme: 'file' },
      ],
      new FeatureReferenceProvider(),
    ),
  );

  // ── Test Controller ──
  context.subscriptions.push(new BddTestController());

  // ── Toggleable UX mechanisms ──
  const diagnostics = new BddDiagnostics();
  context.subscriptions.push(diagnostics);
  void diagnostics.refresh();

  const codeLens = getCodeLensProvider();

  context.subscriptions.push(
    // Diagnostics
    vscode.languages.registerCodeActionsProvider(
      [{ language: 'feature', scheme: 'file' }],
      new BddCodeActionProvider(),
      { providedCodeActionKinds: BddCodeActionProvider.providedKinds },
    ),
    // CodeLens (feature + definition files)
    vscode.languages.registerCodeLensProvider(
      [
        { language: 'feature', scheme: 'file' },
        { language: 'python', scheme: 'file' },
        { language: 'rust', scheme: 'file' },
      ],
      codeLens,
    ),
    // Symbols & folding
    vscode.languages.registerDocumentSymbolProvider(
      { language: 'feature', scheme: 'file' },
      new BddDocumentSymbolProvider(),
    ),
    vscode.languages.registerWorkspaceSymbolProvider(new BddWorkspaceSymbolProvider()),
    vscode.languages.registerFoldingRangeProvider(
      { language: 'feature', scheme: 'file' },
      new BddFoldingRangeProvider(),
    ),
    // Hover
    vscode.languages.registerHoverProvider({ language: 'feature', scheme: 'file' }, new BddHoverProvider()),
    // Table formatting
    vscode.languages.registerDocumentRangeFormattingEditProvider(
      { language: 'feature', scheme: 'file' },
      new BddTableFormattingProvider(),
    ),
    // Rename
    vscode.languages.registerRenameProvider(
      [
        { language: 'feature', scheme: 'file' },
        { language: 'rust', scheme: 'file' },
      ],
      new BddRenameProvider(),
    ),
    // Snippets
    vscode.languages.registerCompletionItemProvider(
      { language: 'feature', scheme: 'file' },
      new BddSnippetProvider(),
    ),
  );

  // React to toggles / workspace changes
  onConfigChange(() => {
    codeLens.notifyRefresh();
    if (!toggles.diagnostics()) {
      diagnostics.clear();
    } else {
      void diagnostics.refresh();
    }
  }, context.subscriptions);

  // Refresh diagnostics + lenses when definitions/bindings change on save
  registerStepRefreshHook(context.subscriptions, () => {
    diagnostics.requestRefresh();
    codeLens.notifyRefresh();
  });

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.createStep', () => createStepDefinition()),
    vscode.commands.registerCommand('bddFeature.runScenario', (line?: number) => runScenario(false, line)),
    vscode.commands.registerCommand('bddFeature.debugScenario', (line?: number) => runScenario(true, line)),
    vscode.commands.registerCommand('bddFeature.runFile', () => runFile(false)),
    vscode.commands.registerCommand('bddFeature.debugFile', () => runFile(true)),
    vscode.commands.registerCommand('bddFeature.bindFeature', (uri?: vscode.Uri) => bindFeatureCommand(uri)),
    vscode.commands.registerCommand(
      'bddFeature._openDefinition',
      async (uriString: string, line: number) => {
        const uri = vscode.Uri.parse(uriString);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const lineLength = doc.lineAt(Math.min(line, doc.lineCount - 1)).text.length;
        editor.revealRange(new vscode.Range(line, 0, line, lineLength));
        editor.selection = new vscode.Selection(line, 0, line, lineLength);
      },
    ),
    vscode.commands.registerCommand(
      'bddFeature._resolveUsageLens',
      async (uri: vscode.Uri, line: number, def: StepDefinition) => {
        const usages = await findStepUsages([def], { excludeUri: uri });
        await vscode.commands.executeCommand(
          'editor.action.showReferences',
          uri,
          new vscode.Position(line, 0),
          usages.map(u => new vscode.Location(u.uri, new vscode.Range(u.line, u.startCol, u.line, u.endCol))),
        );
        return usages.length;
      },
    ),
    vscode.commands.registerCommand('bddFeature.refreshSteps', async () => {
      await scanStepDefinitions();
      await ensureBindings();
      await diagnostics.refresh();
      codeLens.notifyRefresh();
      vscode.window.showInformationMessage('BDD step definitions refreshed');
    }),
  );

  outputChannel.appendLine('BDD Feature extension activated');
}

function registerStepRefreshHook(disposables: vscode.Disposable[], cb: () => void): void {
  disposables.push(vscode.workspace.onDidSaveTextDocument(doc => {
    if (
      doc.languageId === 'python' ||
      doc.languageId === 'rust' ||
      doc.languageId === 'feature'
    ) {
      cb();
    }
  }));
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
