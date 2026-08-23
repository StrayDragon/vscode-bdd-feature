import * as vscode from 'vscode';
import { toggles } from '../config';

interface SnippetDef {
  label: string;
  detail: string;
  body: string[];
}

const SNIPPETS: Record<string, SnippetDef> = {
  feature: {
    label: 'feature-skeleton',
    detail: 'Feature with one scenario',
    body: ['功能: ${1:Feature title}', '', '  场景: ${2:Scenario title}', '    假如 ${3:context}', '    当 ${4:action}', '    那么 ${5:outcome}'],
  },
  scenario: {
    label: 'scenario',
    detail: 'Given/When/Then scenario',
    body: ['场景: ${1:title}', '假如 ${2:context}', '当 ${3:action}', '那么 ${4:outcome}'],
  },
  outline: {
    label: 'scenario-outline',
    detail: 'Scenario Outline with Examples table',
    body: [
      '场景大纲: ${1:title}',
      '假如 ${2:state} 为 <${3:key}>',
      '当 ${4:action}',
      '那么 ${5:outcome}',
      '',
      '  例子:',
      '    | ${3:key} |',
      '    | ${6:v1}   |',
    ],
  },
  background: {
    label: 'background',
    detail: 'Background block',
    body: ['背景:', '  假如 ${1:common context}'],
  },
  rule: {
    label: 'rule',
    detail: 'Rule containing a scenario',
    body: ['规则: ${1:rule title}', '', '  场景: ${2:title}', '    那么 ${3:outcome}'],
  },
};

/** Gherkin skeleton snippets at line starts (English keyword variants too). */
export class BddSnippetProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    if (!toggles.snippets()) {
      return [];
    }
    const before = document.lineAt(position.line).text.substring(0, position.character);
    if (before.trim() !== '') {
      return []; // line-start only
    }
    const indent = before.length;

    return Object.entries(SNIPPETS).map(([name, def]) => {
      const item = new vscode.CompletionItem(def.label, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(def.body.map(l => l).join('\n'));
      item.detail = `BDD: ${def.detail}`;
      item.sortText = `9_${name}`; // after keywords & steps
      // Indent continuation lines to match the current indent
      if (indent > 0) {
        item.insertText = new vscode.SnippetString(
          def.body.map((l, idx) => (idx === 0 ? l : ' '.repeat(indent) + l)).join('\n'),
        );
      }
      return item;
    });
  }
}
