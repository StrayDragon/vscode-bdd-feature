import * as vscode from 'vscode';
import { parseStepLine, parseScenarioLine, detectDocumentLanguage } from './gherkin';
import { getStepDefinitions, whenStepsReady } from './steps';
import { stepMatchesDefinition } from './matching';
import { readFileText } from './utils';

/**
 * Find References.
 *
 * - From a .feature step: other feature files using the SAME definition
 *   (parametric patterns included — all steps resolving to any matching
 *   definition are listed).
 * - From a Python decorator / Rust attribute: every feature step that
 *   resolves to that definition.
 */
export class FeatureReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    const dialect = detectDocumentLanguage(document.getText());
    const line = document.lineAt(position.line);

    // ── Origin is a feature file ──
    if (document.languageId === 'feature') {
      const parsed = parseStepLine(line.text, dialect);
      if (!parsed) {
        return [];
      }
      await whenStepsReady();
      const originDefs = getStepDefinitions().filter(
        d => stepMatchesDefinition(parsed.text, d) &&
          (d.type === 'step' || !parsed.type || d.type === parsed.type),
      );
      return this._findFeatureUsages(parsed.text, parsed.type, originDefs, document.uri, context.includeDeclaration);
    }

    // ── Origin is a definition file ──
    if (document.languageId === 'python' || document.languageId === 'rust') {
      await whenStepsReady();
      const defsHere = getStepDefinitions().filter(d =>
        d.file.fsPath === document.uri.fsPath &&
        (d.decoratorLine === position.line ||
          d.functionLine === position.line),
      );
      if (defsHere.length === 0) {
        return [];
      }
      // ONE workspace sweep evaluates every definition (the former
      // per-def loop re-swept all features N times and duplicated
      // overlapping Locations).
      return this._findFeatureUsagesForDefs(defsHere, context.includeDeclaration);
    }

    return [];
  }

  /** All feature steps matching ANY of the given definitions (single sweep). */
  private async _findFeatureUsagesForDefs(
    defs: readonly StepDefinitionLite[],
    includeDecl: boolean,
  ): Promise<vscode.Location[]> {
    const results: vscode.Location[] = [];
    const featureFiles = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
    for (const fileUri of featureFiles) {
      try {
        const text = await readFileText(fileUri);
        const dialect = detectDocumentLanguage(text);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseStepLine(lines[i], dialect);
          if (!parsed) {
            continue;
          }
          if (defs.some(def => stepMatchesDefinition(parsed.text, def))) {
            results.push(new vscode.Location(fileUri, new vscode.Range(i, 0, i, lines[i].length)));
          }
        }
      } catch {
        // skip unreadable
      }
    }
    void includeDecl;
    return results;
  }

  /**
   * Scan all .feature files for steps that resolve to one of `originDefs`
   * (or whose text matches `stepText` when no definitions exist yet).
   */
  private async _findFeatureUsages(
    stepText: string,
    stepType: 'given' | 'when' | 'then' | 'step' | undefined,
    originDefs: readonly StepDefinitionLite[],
    excludeUri: vscode.Uri | undefined,
    includeDeclaration: boolean,
  ): Promise<vscode.Location[]> {
    void stepType;
    const results: vscode.Location[] = [];
    const featureFiles = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);

    for (const fileUri of featureFiles) {
      try {
        const text = await readFileText(fileUri);
        const dialect = detectDocumentLanguage(text);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const parsed = parseStepLine(lines[i], dialect);
          if (!parsed) {
            continue;
          }
          const matches =
            originDefs.length > 0
              ? originDefs.some(def => stepMatchesDefinition(parsed.text, def))
              : parsed.text === stepText;
          if (matches && !(fileUri.fsPath === excludeUri?.fsPath)) {
            results.push(new vscode.Location(fileUri, new vscode.Range(i, 0, i, lines[i].length)));
          }
        }
        // Scenario header references to the same file's binding? skip —
        // definition-level references only.
        void parseScenarioLine;
      } catch {
        // skip unreadable
      }
    }

    if (includeDeclaration && excludeUri) {
      // The declaration for a feature-step query is the step line itself.
      results.unshift(new vscode.Location(excludeUri, new vscode.Range(0, 0, 0, 0)));
    }
    return results;
  }
}

type StepDefinitionLite = import('./model').StepDefinition;

function typeOf(def: StepDefinitionLite): 'given' | 'when' | 'then' | 'step' | undefined {
  return def.type;
}
