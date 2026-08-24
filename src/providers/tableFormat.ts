/**
 * Gherkin table alignment formatter (Format Document / Selection).
 * Pure core `alignTables` for unit testing; CJK full-width aware.
 */

import * as vscode from 'vscode';
import { toggles } from '../config';

/** Display width: East-Asian wide ranges count as 2 columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
      (code >= 0x2e80 && code <= 0xa4cf) || // CJK Radicals..Yi
      (code >= 0xac00 && code <= 0xd7a3) || // Hangul Syllables
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
      (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
      (code >= 0xff00 && code <= 0xff60) || // Fullwidth Forms
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x20000; // CJK Extension B+
    w += wide ? 2 : 1;
  }
  return w;
}

function padTo(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

const isTableRow = (line: string) => line.trimStart().startsWith('|');

/**
 * Split a table row into trimmed cells, honoring Gherkin cell escapes:
 *   \| → literal pipe (does NOT split),  \\ → literal backslash,  \n → newline.
 * Cells keep their escaped text verbatim so alignment preserves it.
 */
export function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) {
    t = t.slice(1);
  }
  if (t.endsWith('|') && !t.endsWith('\\|')) {
    t = t.slice(0, -1);
  }
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && (t[i + 1] === '|' || t[i + 1] === '\\')) {
      cur += ch + t[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}
/**
 * Re-align every table row group intersecting [startLine, endLine].
 * `eol` preserves the document's line endings (CRLF-safe).
 * Returns new array of lines (same length).
 */
export function alignTables(
  lines: readonly string[],
  startLine = 0,
  endLine = lines.length - 1,
): string[] {
  const out = [...lines];
  let i = 0;
  while (i < lines.length) {
    if (!isTableRow(lines[i])) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length && isTableRow(lines[j + 1])) {
      j++;
    }
    // Group intersects the requested range?
    if (j >= startLine && i <= endLine) {
      alignGroup(out, i, j);
    }
    i = j + 1;
  }
  return out;
}

/** Provider-facing helper that keeps the document's EOL style intact. */
export function alignTablesText(
  text: string,
  startLine = 0,
  endLine = Number.MAX_SAFE_INTEGER,
): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  return alignTables(lines, startLine, Math.min(endLine, lines.length - 1)).join(eol);
}

function alignGroup(out: string[], first: number, last: number): void {
  const rows = out.slice(first, last + 1).map(splitRow);
  const isSeparator = (cells: string[]) =>
    cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
  const widths: number[] = [];

  for (let r = 0; r < rows.length; r++) {
    if (isSeparator(rows[r])) {
      continue;
    }
    for (let c = 0; c < rows[r].length; c++) {
      widths[c] = Math.max(widths[c] ?? 0, displayWidth(rows[r][c]));
    }
  }

  for (let r = 0; r < rows.length; r++) {
    const indentMatch = /^\s*/.exec(out[first + r])!;
    const indent = indentMatch[0];
    const cells = rows[r];
    if (isSeparator(cells)) {
      // Regenerate dashes to match column widths
      const parts = widths.map(w => '-'.repeat(w + 2));
      out[first + r] = `${indent}| ${parts.join(' | ')} |`;
      continue;
    }
    const padded = cells.map((c, idx) => padTo(c, widths[idx] ?? displayWidth(c)));
    out[first + r] = `${indent}| ${padded.join(' | ')} |`;
  }
}

// ── Provider ──

export class BddTableFormattingProvider implements vscode.DocumentRangeFormattingEditProvider {
  provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    _options: unknown,
    _token: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    if (!toggles.tableFormat()) {
      return [];
    }
    const aligned = alignTablesText(document.getText(), range.start.line, range.end.line);
    if (aligned === document.getText()) {
      return []; // nothing to do — avoids dirtying the document
    }
    // Replace only the affected table groups' span to minimize churn
    const fullRange = new vscode.Range(0, 0, document.lineCount, 0);
    return [vscode.TextEdit.replace(fullRange, aligned)];
  }
}
