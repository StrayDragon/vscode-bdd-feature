import * as vscode from 'vscode';
import { parseStepLine, getStepType } from './gherkin';
import { findMatchingSteps } from './steps';

/**
 * Provides Go to Definition for .feature file steps.
 * Navigates from a step line in a .feature file to the corresponding
 * Python step definition decorated with @given/@when/@then.
 */
export class FeatureDefinitionProvider implements vscode.DefinitionProvider {
  async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Definition | vscode.LocationLink[]> {
    const line = document.lineAt(position.line);
    const stepInfo = parseStepLine(line.text);

    if (!stepInfo) {
      return [];
    }

    // Determine the step type, handling And/But/* inheritance
    let stepType = getStepType(stepInfo.keyword);
    if (!stepType) {
      // And/But/* — inherit from the previous step
      stepType = this._getPreviousStepType(document, position.line);
    }

    const matches = findMatchingSteps(stepInfo.text, stepType);
    if (matches.length === 0) {
      return [];
    }

    // Return the first match (or all if multiple)
    return matches.map(def => new vscode.Location(def.file, new vscode.Position(def.line, 0)));
  }

  /**
   * Walk backwards from the current line to find the last explicit Given/When/Then keyword.
   */
  private _getPreviousStepType(document: vscode.TextDocument, currentLine: number): 'given' | 'when' | 'then' | undefined {
    for (let i = currentLine - 1; i >= 0; i--) {
      const lineText = document.lineAt(i).text;
      const stepInfo = parseStepLine(lineText);
      if (stepInfo) {
        const type = getStepType(stepInfo.keyword);
        if (type) {
          return type;
        }
        // Continue if it's And/But/*
      }
      // Stop at structural keywords
      if (/^\s*(Feature|功能|Scenario|场景|剧本|Background|背景|Rule|规则)\s*:/i.test(lineText)) {
        break;
      }
    }
    return undefined;
  }
}
