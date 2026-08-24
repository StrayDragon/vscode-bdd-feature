import * as vscode from 'vscode';
import { toggles } from '../config';
import {
  dialectSkeleton,
  preferredDialect,
  type DialectSkeleton,
} from '../gherkin';

interface SnippetDef {
  label: string;
  detail: string;
  body: (k: DialectSkeleton) => string[];
}

const SNIPPETS: Record<string, SnippetDef> = {
  feature: {
    label: 'feature-skeleton',
    detail: 'Feature with one scenario',
    body: k => [
      `${k.feature}: \${1:Feature title}`,
      '',
      `  ${k.scenario}: \${2:Scenario title}`,
      `    ${k.given} \${3:context}`,
      `    ${k.when} \${4:action}`,
      `    ${k.then} \${5:outcome}`,
    ],
  },
  scenario: {
    label: 'scenario',
    detail: 'Given/When/Then scenario',
    body: k => [
      `${k.scenario}: \${1:title}`,
      `${k.given} \${2:context}`,
      `${k.when} \${3:action}`,
      `${k.then} \${4:outcome}`,
    ],
  },
  outline: {
    label: 'scenario-outline',
    detail: 'Scenario Outline with Examples table',
    body: k => [
      `${k.outline}: \${1:title}`,
      `${k.given} \${2:state} ${/[^\x00-\x7F]/.test(k.given) ? '为' : 'is'} <\${3:key}>`,
      `${k.when} \${4:action}`,
      `${k.then} \${5:outcome}`,
      '',
      `  ${k.examples}:`,
      `    | \${3:key} |`,
      `    | \${6:v1}   |`,
    ],
  },
  background: {
    label: 'background',
    detail: 'Background block',
    body: k => [`${k.background}:`, `  ${k.given} \${1:common context}`],
  },
  rule: {
    label: 'rule',
    detail: 'Rule containing a scenario',
    body: k => [
      `${k.rule}: \${1:rule title}`,
      '',
      `  ${k.scenario}: \${2:title}`,
      `    ${k.then} \${3:outcome}`,
    ],
  },
};

/** Gherkin skeleton snippets at line starts, in the document's dialect. */
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
    const skeleton = dialectSkeleton(preferredDialect(document.getText()));

    return Object.entries(SNIPPETS).map(([name, def]) => {
      const lines = def.body(skeleton).map((l, idx) =>
        idx === 0 ? l : indent > 0 ? ' '.repeat(indent) + l : l,
      );
      const item = new vscode.CompletionItem(def.label, vscode.CompletionItemKind.Snippet);
      item.insertText = new vscode.SnippetString(lines.join('\n'));
      item.detail = `BDD: ${def.detail}`;
      item.sortText = `9_${name}`; // after keywords & steps
      return item;
    });
  }
}
