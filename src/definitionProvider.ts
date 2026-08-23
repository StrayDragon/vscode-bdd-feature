import * as vscode from 'vscode';
import {
  parseStepLine,
  parseScenarioLine,
  detectDocumentLanguage,
  resolveInheritedStepType,
} from './gherkin';
import { findMatchingSteps } from './steps';
import { getBindingsForFeature, ensureBindings } from './bindings';
import type { StepDefinition } from './model';

/**
 * Go to Definition for .feature files.
 *
 * - Step lines → the step-definition decorator/attribute. Jumps land precisely
 *   on the pattern text (targetSelectionRange), not at column 0.
 * - Scenario headers → the binding site (Python `scenarios()` call or Rust
 *   `#[scenario]` attribute).
 */
export class FeatureDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LocationLink[]> {
    const dialect = detectDocumentLanguage(document.getText());
    const line = document.lineAt(position.line);
    const parsed = parseStepLine(line.text, dialect);

    if (!parsed) {
      const scenarioName = parseScenarioLine(line.text, dialect);
      if (!scenarioName) {
        return [];
      }
      await ensureBindings();
      return this._scenarioBindingLinks(document.uri.fsPath, scenarioName, line);
    }

    const stepType =
      parsed.type ??
      resolveInheritedStepType(n => document.lineAt(n).text, position.line, dialect);

    const matches = findMatchingSteps(parsed.text, stepType);
    if (matches.length === 0) {
      return [];
    }

    const origin = this._originRange(line, parsed.keyword);
    return matches.map(def => this._toLocationLink(def, origin));
  }

  private _toLocationLink(
    def: StepDefinition,
    origin: vscode.Range | undefined,
  ): vscode.LocationLink {
    const sel = def.patternSelection;
    const targetSelectionRange = sel
      ? new vscode.Range(
          new vscode.Position(sel.startLine, sel.startCol),
          new vscode.Position(sel.endLine, sel.endCol),
        )
      : new vscode.Range(
          new vscode.Position(def.decoratorLine, 0),
          new vscode.Position(def.decoratorLine + 1, 0),
        );
    const targetRange = new vscode.Range(
      new vscode.Position(def.decoratorLine, 0),
      new vscode.Position((def.functionLine ?? def.decoratorLine) + 3, 0),
    );
    return {
      targetUri: def.file,
      targetRange,
      targetSelectionRange,
      originSelectionRange: origin,
    };
  }

  /** Range of the step text after the keyword in the feature file. */
  private _originRange(line: vscode.TextLine, keyword: string): vscode.Range | undefined {
    const idx = line.text.indexOf(keyword);
    if (idx === -1) {
      return undefined;
    }
    const after = line.text.slice(idx + keyword.length);
    const ws = after.length - after.trimStart().length;
    const start = idx + keyword.length + ws;
    const end = start + after.trim().length;
    return new vscode.Range(
      new vscode.Position(line.lineNumber, start),
      new vscode.Position(line.lineNumber, end),
    );
  }

  private async _scenarioBindingLinks(
    featureFsPath: string,
    scenarioName: string,
    headerLine: vscode.TextLine,
  ): Promise<vscode.LocationLink[]> {
    const bindings = getBindingsForFeature(featureFsPath, scenarioName);
    if (bindings.length === 0) {
      return [];
    }
    return bindings.map(b => ({
      targetUri: b.file,
      targetRange: new vscode.Range(
        new vscode.Position(b.line, 0),
        new vscode.Position(b.line + 2, 0),
      ),
      targetSelectionRange: new vscode.Range(
        new vscode.Position(b.line, 0),
        new vscode.Position(b.line, Number.MAX_SAFE_INTEGER),
      ),
    }));
  }
}
