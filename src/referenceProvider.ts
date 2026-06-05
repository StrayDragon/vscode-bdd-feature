import * as vscode from 'vscode';
import { parseStepLine, getStepType, parseScenarioLine } from './gherkin';

/**
 * Provides Find References for .feature steps and Python step decorators.
 *
 * From a .feature file: finds all other .feature files using the same step.
 * From a Python file: finds all .feature files referencing that step.
 */
export class FeatureReferenceProvider implements vscode.ReferenceProvider {
  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    if (document.languageId === 'feature') {
      return this._findFeatureReferences(document, position, context);
    }
    if (document.languageId === 'python') {
      return this._findPythonReferences(document, position, context);
    }
    return [];
  }

  /**
   * Find all usages of a step across feature files.
   */
  private async _findFeatureReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.ReferenceContext,
  ): Promise<vscode.Location[]> {
    const line = document.lineAt(position.line);
    const stepInfo = parseStepLine(line.text);
    if (!stepInfo) {
      return [];
    }

    const results: vscode.Location[] = [];

    // Include the declaration if requested
    if (context.includeDeclaration) {
      results.push(new vscode.Location(document.uri, position));
    }

    // Search all feature files
    const featureFiles = await vscode.workspace.findFiles('**/*.feature');
    for (const fileUri of featureFiles) {
      if (fileUri.fsPath === document.uri.fsPath) {
        continue;
      }

      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const text = doc.getText();
        const lines = text.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          const otherStep = parseStepLine(lines[i]);
          if (otherStep && otherStep.text === stepInfo.text) {
            results.push(new vscode.Location(fileUri, new vscode.Position(i, 0)));
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }

  /**
   * Find all feature file references from a Python step decorator.
   */
  private async _findPythonReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
  ): Promise<vscode.Location[]> {
    const line = document.lineAt(position.line);
    const trimmed = line.text.trim();

    // Check if we're on a @given/@when/@then decorator
    const decoratorMatch = trimmed.match(/^@(given|when|then|step)\s*\(/);
    if (!decoratorMatch) {
      return [];
    }

    // Extract the step text from the decorator
    const fullLine = trimmed;
    const strMatch = fullLine.match(/(?:Parser\s*\()?(?:r?["'])(.+?)(?:["'])/);
    if (!strMatch) {
      return [];
    }

    const stepText = strMatch[1].toLowerCase();
    const results: vscode.Location[] = [];

    // Search all feature files for matching steps
    const featureFiles = await vscode.workspace.findFiles('**/*.feature');
    for (const fileUri of featureFiles) {
      try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        const lines = doc.getText().split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          const stepInfo = parseStepLine(lines[i]);
          if (stepInfo && stepInfo.text.toLowerCase() === stepText) {
            results.push(new vscode.Location(fileUri, new vscode.Position(i, 0)));
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results;
  }
}
