import * as vscode from 'vscode';
import { FeatureDefinitionProvider } from './definitionProvider';
import { FeatureCompletionProvider } from './completionProvider';
import { FeatureSemanticTokensProvider, semanticTokensLegend } from './semanticToken';
import { FeatureReferenceProvider } from './referenceProvider';
import { createStepDefinition } from './createStep';
import { runScenario, runFile } from './runner';
import { BddTestController } from './testController';
import { scanStepDefinitions, registerStepRefreshOnSave } from './steps';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('BDD Feature');
  outputChannel.appendLine('BDD Feature extension activating...');

  // ── Step definitions scanning ──
  scanStepDefinitions();
  registerStepRefreshOnSave(context.subscriptions);

  // ── Definition Provider ──
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureDefinitionProvider(),
    ),
  );

  // ── Completion Provider ──
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureCompletionProvider(),
    ),
  );

  // ── Semantic Tokens Provider ──
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: 'feature', scheme: 'file' },
      new FeatureSemanticTokensProvider(),
      semanticTokensLegend,
    ),
  );

  // ── Reference Provider ──
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(
      [{ language: 'feature', scheme: 'file' }, { language: 'python', scheme: 'file' }],
      new FeatureReferenceProvider(),
    ),
  );

  // ── Test Controller ──
  const testController = new BddTestController();
  context.subscriptions.push(testController);

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.createStep', () => createStepDefinition()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.runScenario', () => runScenario(false)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.debugScenario', () => runScenario(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.runFile', () => runFile(false)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.debugFile', () => runFile(true)),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('bddFeature.refreshSteps', async () => {
      await scanStepDefinitions();
      vscode.window.showInformationMessage('BDD step definitions refreshed');
    }),
  );

  outputChannel.appendLine('BDD Feature extension activated');
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
