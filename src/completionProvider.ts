import * as vscode from 'vscode';
import {
  parseStepLine, getStepType,
  detectDocumentLanguage,
  getStepKeywordsForLanguage, getStructuralKeywordsForLanguage,
} from './gherkin';
import { findCompletionCandidates } from './steps';

/**
 * Provides auto-completion for .feature files:
 * 1. Language-aware Gherkin keyword suggestions (line start)
 * 2. Cached step definition suggestions with snippet placeholders (after step keyword)
 */
export class FeatureCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const lineText = line.text;
    const cursorOffset = position.character;
    const textBeforeCursor = lineText.substring(0, cursorOffset);
    const trimmedBefore = textBeforeCursor.trimStart();
    const indent = lineText.length - lineText.trimStart().length;

    // Detect document language
    const lang = detectDocumentLanguage(document.getText());

    // ── Scenario A: line-start keyword suggestions ──
    // Cursor is at indent level, no step keyword typed yet
    if (trimmedBefore.length === 0 || !parseStepLine(textBeforeCursor)) {
      const stepInfo = parseStepLine(textBeforeCursor);
      if (!stepInfo && trimmedBefore.length === 0) {
        return this._keywordCompletions(lang, indent, position);
      }
    }

    // ── Scenario B: step definition suggestions after keyword ──
    const stepInfo = parseStepLine(lineText);
    if (!stepInfo) {
      // Partial keyword typed — still offer keyword completions
      if (trimmedBefore.length > 0 && !/\s/.test(trimmedBefore)) {
        return this._keywordCompletions(lang, indent, position);
      }
      return [];
    }

    let stepType = getStepType(stepInfo.keyword);
    if (!stepType) {
      stepType = this._getPreviousStepType(document, position.line);
    }

    const candidates = findCompletionCandidates(stepInfo.text, stepType);
    return this._stepDefinitionCompletions(candidates, stepInfo.keyword, lineText, position);
  }

  /**
   * Build keyword completion items for line-start input.
   * Suggests structural keywords + step keywords filtered by document language.
   */
  private _keywordCompletions(
    lang: ReturnType<typeof detectDocumentLanguage>,
    indent: number,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    // Structural keywords
    for (const kw of getStructuralKeywordsForLanguage(lang)) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.insertText = kw + ': ';
      item.detail = 'Gherkin keyword';
      item.sortText = '0_' + kw; // sort to top
      item.range = new vscode.Range(
        new vscode.Position(position.line, indent),
        position,
      );
      items.push(item);
    }

    // Step keywords
    for (const kw of getStepKeywordsForLanguage(lang)) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.insertText = kw + ' ';
      item.detail = 'Step keyword';
      item.sortText = '1_' + kw;
      item.range = new vscode.Range(
        new vscode.Position(position.line, indent),
        position,
      );
      items.push(item);
    }

    return items;
  }

  /**
   * Build step definition completion items with snippet placeholders.
   * Converts {param} → ${1:param} for tab-stop navigation.
   */
  private _stepDefinitionCompletions(
    candidates: ReturnType<typeof findCompletionCandidates>,
    keyword: string,
    lineText: string,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];

    // Compute the start of the step text area (after keyword + whitespace)
    const kwIdx = lineText.indexOf(keyword);
    const afterKw = lineText.substring(kwIdx + keyword.length);
    const leadingWs = afterKw.length - afterKw.trimStart().length;
    const stepTextStart = kwIdx + keyword.length + leadingWs;

    for (const def of candidates) {
      // Convert {param} to snippet placeholders
      const snippet = this._toSnippet(def.text);
      const item = new vscode.CompletionItem(
        def.text,
        vscode.CompletionItemKind.Snippet,
      );
      item.insertText = new vscode.SnippetString(snippet);
      item.detail = `@${def.type} step`;
      item.documentation = new vscode.MarkdownString(
        `**${keyword}** ${def.text}\n\n` +
        `\`${def.file.fsPath.split('/').pop()}\` (line ${def.line + 1})`,
      );
      item.range = new vscode.Range(
        new vscode.Position(position.line, stepTextStart),
        position,
      );
      items.push(item);
    }

    return items;
  }

  /**
   * Convert a step pattern string to a VS Code snippet.
   * Example: "user {name} logs in with {password}"
   *       → "user ${1:name} logs in with ${2:password}"
   */
  private _toSnippet(pattern: string): string {
    let idx = 1;
    return pattern.replace(/\{(\w+)(?::[^}]*)?\}/g, (_match, name) => {
      return `\${${idx++}:${name}}`;
    });
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
      if (/^\s*(Feature|功能|Scenario\s*Outline|场景大纲|剧本大纲|場景大綱|劇本大綱|Scenario|场景|剧本|場景|劇本|Background|背景|Rule|规则|規則)\s*:/i.test(lineText)) {
        break;
      }
    }
    return undefined;
  }
}
