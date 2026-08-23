/**
 * Document/workspace symbols + folding ranges for .feature files.
 * Parsing cores are pure functions over lines for unit testing.
 */

import * as vscode from 'vscode';
import {
  parseFeatureLine,
  parseScenarioLine,
  parseRuleLine,
  parseBackgroundLine,
  parseExamplesLine,
  detectDocumentLanguage,
} from '../gherkin';
import { getStepDefinitions, scanStepDefinitions } from '../steps';
import { toggles } from '../config';

// ── Pure parsing core ──

export interface BlockSpan {
  role: 'feature' | 'rule' | 'scenario' | 'background' | 'examples';
  title: string;
  headerLine: number;
  /** Last line of the block (inclusive), computed by caller context */
  endLine: number;
}

/** Structural header parsers keyed by block role — all spec-driven. */
const ROLE_PARSERS: Array<[BlockSpan['role'], (l: string) => string | undefined]> = [
  ['feature', l => parseFeatureLine(l)],
  ['rule', parseRuleLine],
  ['scenario', l => parseScenarioLine(l)],
  ['background', parseBackgroundLine],
  ['examples', parseExamplesLine],
];

/** Identify the structural block a line belongs to (undefined for others). */
export function classifyHeaderLine(line: string): BlockSpan['role'] | undefined {
  const t = line.trimStart();
  if (!t || !/^[^:]+:/.test(t)) {
    return undefined;
  }
  for (const [role, parser] of ROLE_PARSERS) {
    if (parser(line) !== undefined) {
      return role;
    }
  }
  return undefined;
}

/** Compute block spans with endLines (block ends before next header / EOF). */
export function computeBlockSpans(lines: string[]): BlockSpan[] {
  const dialect = detectDocumentLanguage(lines.join('\n'));
  const headers: BlockSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const role = classifyHeaderLine(lines[i]);
    if (!role) {
      continue;
    }
    const parser = ROLE_PARSERS.find(([r]) => r === role)![1];
    headers.push({ role, title: parser(lines[i]) ?? '', headerLine: i, endLine: lines.length - 1 });
  }
  for (let i = 0; i < headers.length; i++) {
    const next = headers[i + 1];
    let end = next ? next.headerLine - 1 : lines.length - 1;
    while (end > headers[i].headerLine && lines[end].trim() === '') {
      end--;
    }
    headers[i].endLine = end;
  }
  return headers;
}

/** Docstring ranges (""" … """) as [startLine,endLine] pairs. */
export function findDocstrings(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < lines.length; i++) {
    const count = (lines[i].match(/"""/g) ?? []).length;
    for (let k = 0; k < count; k++) {
      if (open === -1) {
        open = i;
      } else {
        out.push([open, i]);
        open = -1;
      }
    }
  }
  return out;
}

// ── Providers ──

export class BddDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    if (!toggles.documentSymbols()) {
      return [];
    }
    const lines = document.getText().split(/\r?\n/);
    const spans = computeBlockSpans(lines);
    const mk = (span: BlockSpan, kind: vscode.SymbolKind): vscode.DocumentSymbol =>
      new vscode.DocumentSymbol(
        span.title || span.role,
        '',
        kind,
        new vscode.Range(span.headerLine, 0, span.endLine, lines[span.endLine]?.length ?? 0),
        new vscode.Range(span.headerLine, 0, span.headerLine, lines[span.headerLine].length),
      );

    const roots: vscode.DocumentSymbol[] = [];
    let currentContainer: vscode.DocumentSymbol | undefined;

    for (const span of spans) {
      switch (span.role) {
        case 'feature': {
          const s = mk(span, vscode.SymbolKind.Package);
          roots.push(s);
          currentContainer = s;
          break;
        }
        case 'rule': {
          const s = mk(span, vscode.SymbolKind.Namespace);
          roots.push(s);
          currentContainer = s;
          break;
        }
        case 'scenario':
        case 'background': {
          const s = mk(span, span.role === 'background' ? vscode.SymbolKind.Interface : vscode.SymbolKind.Method);
          if (currentContainer && currentContainer.range.contains(s.range)) {
            currentContainer.children.push(s);
          } else {
            roots.push(s);
          }
          break;
        }
        case 'examples':
          break; // folded into scenario blocks
      }
    }
    return roots;
  }
}

export class BddWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  async provideWorkspaceSymbols(
    query: string,
    _token: vscode.CancellationToken,
  ): Promise<vscode.SymbolInformation[]> {
    if (!toggles.workspaceSymbols()) {
      return [];
    }
    await scanStepDefinitions();
    const q = query.toLowerCase();
    const results: vscode.SymbolInformation[] = [];

    const files = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const dialect = detectDocumentLanguage(doc.getText());
        let featureName = uri.path.split('/').pop() ?? '';
        const lines = doc.getText().split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const feat = parseFeatureLine(lines[i], dialect);
          if (feat !== undefined && feat.trim()) {
            featureName = feat;
          }
          const sc = parseScenarioLine(lines[i], dialect);
          if (sc !== undefined && matchesQuery(sc, q)) {
            results.push(
              new vscode.SymbolInformation(
                sc,
                vscode.SymbolKind.Method,
                featureName,
                new vscode.Location(uri, new vscode.Range(i, 0, i, lines[i].length)),
              ),
            );
          }
        }
      } catch {
        // skip
      }
    }

    for (const def of getStepDefinitions()) {
      if (matchesQuery(def.text, q)) {
        results.push(
          new vscode.SymbolInformation(
            def.text,
            vscode.SymbolKind.Function,
            `${def.lang}:${def.type}`,
            new vscode.Location(
              def.file,
              new vscode.Range(def.decoratorLine, 0, def.decoratorLine, 120),
            ),
          ),
        );
      }
    }
    return results.slice(0, 300);
  }
}

function matchesQuery(text: string, q: string): boolean {
  return q === '' || text.toLowerCase().includes(q);
}

export class BddFoldingRangeProvider implements vscode.FoldingRangeProvider {
  provideFoldingRanges(
    document: vscode.TextDocument,
    _ctx: unknown,
    _token: vscode.CancellationToken,
  ): vscode.FoldingRange[] {
    if (!toggles.folding()) {
      return [];
    }
    const lines = document.getText().split(/\r?\n/);
    const out: vscode.FoldingRange[] = [];
    for (const span of computeBlockSpans(lines)) {
      if (span.endLine > span.headerLine) {
        out.push(new vscode.FoldingRange(span.headerLine, span.endLine));
      }
    }
    for (const [s, e] of findDocstrings(lines)) {
      out.push(new vscode.FoldingRange(s, e, vscode.FoldingRangeKind.Comment));
    }
    return out;
  }
}
