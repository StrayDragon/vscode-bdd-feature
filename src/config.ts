import * as vscode from 'vscode';

/**
 * Feature-toggle helpers. Every UX mechanism registers a provider that
 * early-returns when its switch is off, so toggles apply instantly without
 * re-registration and never leak state.
 */

export function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('bddFeature').get<T>(key, fallback);
}

export function onConfigChange(cb: () => void, disposables: vscode.Disposable[]): void {
  disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('bddFeature')) {
      cb();
    }
  }));
}

export const toggles = {
  diagnostics: () => cfg('enableDiagnostics', true),
  codeActions: () => cfg('enableCodeActions', true),
  codeLens: () => cfg('enableCodeLens', true),
  documentSymbols: () => cfg('enableDocumentSymbols', true),
  workspaceSymbols: () => cfg('enableWorkspaceSymbols', true),
  folding: () => cfg('enableFoldingRanges', true),
  hover: () => cfg('enableHover', true),
  tableFormat: () => cfg('enableTableFormatting', true),
  rename: () => cfg('enableRename', true),
  snippets: () => cfg('enableSnippets', true),
  tags: () => cfg('enableTags', true),
  featuresView: () => cfg('enableFeaturesView', true),
};
