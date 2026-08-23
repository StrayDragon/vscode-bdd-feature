import * as vscode from 'vscode';
import { parseScenarioLine, parseFeatureLine, detectDocumentLanguage } from '../gherkin';
import { toggles, cfg } from '../config';
import { defsInFile, findStepUsages } from '../refSearch';

/**
 * CodeLens:
 *  - .feature: ▶ Run / 🐞 Debug above each scenario; ▶ Run All above the feature
 *  - step-definition files: "N references" above decorators/attributes
 */
export class BddCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  notifyRefresh(): void {
    this._onDidChange.fire();
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!toggles.codeLens()) {
      return [];
    }
    return document.languageId === 'feature'
      ? this._featureLenses(document)
      : this._definitionLenses(document);
  }

  private async _featureLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    const dialect = detectDocumentLanguage(document.getText());
    const lenses: vscode.CodeLens[] = [];
    const runEnabled = cfg('codeLens.runScenarios', true);

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const range = new vscode.Range(i, 0, i, line.text.length);

      if (runEnabled) {
        const scenario = parseScenarioLine(line.text, dialect);
        if (scenario !== undefined) {
          lenses.push(
            this._lens(range, '$(play) Run Scenario', 'bddFeature.runScenario', [i]),
            this._lens(range, '$(debug-alt) Debug', 'bddFeature.debugScenario', [i]),
          );
          continue;
        }
        const feature = parseFeatureLine(line.text, dialect);
        if (feature !== undefined && feature.trim()) {
          lenses.push(this._lens(range, '$(run-all) Run All', 'bddFeature.runFile', []));
        }
      }
    }
    return lenses;
  }

  private async _definitionLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    if (!cfg('codeLens.usages', true)) {
      return [];
    }
    if (document.languageId !== 'python' && document.languageId !== 'rust') {
      return [];
    }
    const lenses: vscode.CodeLens[] = [];
    const seenLines = new Set<number>();

    for (const def of defsInFile(document.uri.fsPath)) {
      if (seenLines.has(def.decoratorLine)) {
        continue;
      }
      seenLines.add(def.decoratorLine);
      // Resolve lazily-ish: compute counts on lens request to keep scan cheap.
      const range = new vscode.Range(def.decoratorLine, 0, def.decoratorLine, 0);
      lenses.push({
        range,
        command: {
          title: '…',
          command: 'bddFeature._resolveUsageLens',
          arguments: [document.uri, def.decoratorLine, def],
        },
        isResolved: false,
      });
    }
    return lenses;
  }

  private _lens(
    range: vscode.Range,
    title: string,
    command: string,
    args: unknown[],
  ): vscode.CodeLens {
    return {
      range,
      isResolved: true,
      command: { title, command, arguments: args },
    };
  }
}

/** Shared instance accessor so extension.ts can trigger refresh after scans. */
let shared: BddCodeLensProvider | undefined;
export function getCodeLensProvider(): BddCodeLensProvider {
  shared ??= new BddCodeLensProvider();
  return shared;
}
