import * as vscode from 'vscode';
import { parseStepLine, getStepType } from './gherkin';
import { findCompletionCandidates } from './steps';

/**
 * Provides auto-completion for .feature file steps.
 * Suggests step definitions found in Python step files.
 */
export class FeatureCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const stepInfo = parseStepLine(line.text);

    if (!stepInfo) {
      return [];
    }

    // Determine step type for filtering
    let stepType = getStepType(stepInfo.keyword);
    if (!stepType) {
      stepType = this._getPreviousStepType(document, position.line);
    }

    const candidates = findCompletionCandidates(stepInfo.text, stepType);

    const items: vscode.CompletionItem[] = [];
    for (const def of candidates) {
      // Capitalize first letter for the keyword part
      const keyword = stepInfo.keyword;
      const insertText = def.text;

      const item = new vscode.CompletionItem(insertText, vscode.CompletionItemKind.Text);
      item.detail = `@${def.type} step`;
      item.documentation = new vscode.MarkdownString(
        `**${keyword}** ${insertText}\n\n` +
        `\`${def.file.fsPath.split('/').pop()}\` (line ${def.line + 1})`,
      );
      // Only insert the step text (the keyword is already typed)
      item.range = new vscode.Range(
        new vscode.Position(position.line, line.text.indexOf(stepInfo.text) >= 0 ? line.text.indexOf(stepInfo.text) : position.character),
        position,
      );
      items.push(item);
    }

    return items;
  }

  private _getPreviousStepType(document: vscode.TextDocument, currentLine: number): 'given' | 'when' | 'then' | undefined {
    for (let i = currentLine - 1; i >= 0; i--) {
      const lineText = document.lineAt(i).text;
      const stepInfo = parseStepLine(lineText);
      if (stepInfo) {
        const type = getStepType(stepInfo.keyword);
        if (type) {
          return type;
        }
      }
      if (/^\s*(Feature|功能|Scenario\s*Outline|场景大纲|剧本大纲|Scenario|场景|剧本|Background|背景|Rule|规则)\s*:/i.test(lineText)) {
        break;
      }
    }
    return undefined;
  }
}
