import * as vscode from 'vscode';
import {
  parseStepLine,
  detectDocumentLanguage,
  completionKeywordSets,
  resolveInheritedStepType,
} from './gherkin';
import { findCompletionCandidates } from './steps';

/**
 * Completion for .feature files:
 * 1. Language-aware Gherkin keyword suggestions (driven by gherkin-languages.json)
 * 2. Step definition suggestions with snippet placeholders (Python + Rust defs)
 */
export class FeatureCompletionProvider implements vscode.CompletionItemProvider {
  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
    _context: vscode.CompletionContext,
  ): Promise<vscode.CompletionItem[]> {
    const line = document.lineAt(position.line);
    const textBefore = line.text.substring(0, position.character);
    const trimmedBefore = textBefore.trimStart();
    const indent = line.text.length - line.text.trimStart().length;
    const dialect = detectDocumentLanguage(document.getText());

    // ── Line start: structural + step keywords ──
    if (trimmedBefore.length === 0) {
      return this._keywordCompletions(dialect, indent, position);
    }

    // ── Partial keyword typed ──
    if (!/\s/.test(trimmedBefore)) {
      return this._keywordCompletions(dialect, indent, position);
    }

    // ── After a step keyword: step definitions ──
    const parsed = parseStepLine(line.text, dialect);
    if (!parsed) {
      return [];
    }
    const stepType =
      parsed.type ??
      resolveInheritedStepType(n => document.lineAt(n).text, position.line, dialect);

    const candidates = findCompletionCandidates(parsed.text, stepType);
    return this._stepCompletions(candidates, parsed.keyword, line, position);
  }

  private _keywordCompletions(
    dialect: ReturnType<typeof detectDocumentLanguage>,
    indent: number,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const items: vscode.CompletionItem[] = [];
    const sets = completionKeywordSets(dialect);

    for (const { keyword, role } of sets.structural) {
      const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
      item.insertText = `${keyword}: `;
      item.detail = `Gherkin ${role}`;
      item.sortText = `0_${keyword}`;
      item.range = new vscode.Range(new vscode.Position(position.line, indent), position);
      items.push(item);
    }

    for (const kw of sets.steps) {
      const item = new vscode.CompletionItem(kw, vscode.CompletionItemKind.Keyword);
      item.insertText = `${kw} `;
      item.detail = 'Gherkin step';
      item.sortText = `1_${kw}`;
      item.range = new vscode.Range(new vscode.Position(position.line, indent), position);
      items.push(item);
    }

    return items;
  }

  private _stepCompletions(
    candidates: ReturnType<typeof findCompletionCandidates>,
    keyword: string,
    line: vscode.TextLine,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    const kwIdx = line.text.indexOf(keyword);
    if (kwIdx === -1) {
      return [];
    }
    const afterKw = line.text.substring(kwIdx + keyword.length);
    const ws = afterKw.length - afterKw.trimStart().length;
    const startCol = kwIdx + keyword.length + ws;

    return candidates.map(def => {
      const snippet = this._toSnippet(def.text, def.lang);
      const item = new vscode.CompletionItem(def.text, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(snippet);
      item.detail = `${def.lang} @${def.type} step`;
      item.documentation = new vscode.MarkdownString(
        `**${keyword}** ${def.text}\n\n` +
          `\`${def.file.fsPath.split('/').pop()}\` (line ${def.decoratorLine + 1})`,
      );
      item.range = new vscode.Range(
        new vscode.Position(position.line, startCol),
        position,
      );
      return item;
    });
  }

  /** Convert pattern placeholders to tab-stop snippets. */
  private _toSnippet(pattern: string, lang: string): string {
    let idx = 1;
    const re =
      lang === 'rust'
        ? /\{(\w*)(?::[^}]*)?\}/g
        : /\{(\w*)(?::[^}]*)?\}/g;
    return pattern.replace(re, (_m, name) => `\${${idx++}:${name || 'value'}}`);
  }
}
