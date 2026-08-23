/**
 * Diagnostics for .feature files and step-definition files.
 *
 * Pure analysis core (`analyzeFeature` / `analyzeDefinitions`) is separated
 * from the vscode collection layer for unit testing.
 */

import * as vscode from 'vscode';
import { parseStepLine, parseFeatureLine, parseScenarioLine, detectDocumentLanguage, isStructuralKeyword } from '../gherkin';
import { compilePythonParsePattern } from '../patterns/pythonParsePattern';
import { compileRustFormatPattern } from '../patterns/rustFormatPattern';
import { getStepDefinitions, scanStepDefinitions } from '../steps';
import { stepMatchesDefinition } from '../matching';
import { getBindingsForFeature, ensureBindings } from '../bindings';
import { toggles, cfg } from '../config';
import type { StepDefinition } from '../model';

export interface RawDiagnostic {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  code: string;
  /** For duplicates/unused: related definition locations */
  related?: Array<{ fsPath: string; line: number; message: string }>;
}

// ── Pure core: feature file analysis ──

export function analyzeFeature(
  lines: string[],
  defs: readonly StepDefinition[],
  isBound: boolean,
  opts: {
    undefinedSteps: boolean;
    unboundFeatures: boolean;
  },
): RawDiagnostic[] {
  const dialect = detectDocumentLanguage(lines.join('\n'));
  const out: RawDiagnostic[] = [];
  let hasScenario = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const scenarioTitle = parseScenarioLine(raw, dialect);
    if (scenarioTitle !== undefined) {
      hasScenario = true;
      continue;
    }
    if (isStructuralKeyword(raw)) {
      continue;
    }
    const parsed = parseStepLine(raw, dialect);
    if (!parsed) {
      continue;
    }
    if (opts.undefinedSteps) {
      const inherited = parsed.type ?? inheritType(lines, i, dialect);
      const matches = countMatches(defs, parsed.text, inherited);
      if (matches === 0) {
        out.push({
          range: spanOf(raw, i, parsed.keyword),
          severity: 'warning',
          message: `Undefined step: no definition matches "${parsed.text}"`,
          code: 'undefinedStep',
        });
      }
    }
  }

  if (opts.unboundFeatures && !isBound && hasScenario) {
    const headerIdx = lines.findIndex(l => parseFeatureLine(l, dialect) !== undefined);
    out.push({
      range: headerIdx >= 0
        ? spanOf(lines[headerIdx], headerIdx)
        : { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
      severity: 'warning',
      message: 'Feature is not bound to any test (no scenarios()/#[scenario] found)',
      code: 'unboundFeature',
    });
  }

  return out;
}

function countMatches(
  defs: readonly StepDefinition[],
  text: string,
  type: 'given' | 'when' | 'then' | undefined,
): number {
  return defs.filter(d => (d.type === 'step' || !type || d.type === type) && stepMatchesDefinition(text, d)).length;
}

function inheritType(
  lines: string[],
  startLine: number,
  dialect: ReturnType<typeof detectDocumentLanguage>,
): 'given' | 'when' | 'then' | undefined {
  for (let i = startLine - 1; i >= 0; i--) {
    const p = parseStepLine(lines[i], dialect);
    if (p?.type) {
      return p.type;
    }
    if (p === undefined && isStructuralKeyword(lines[i])) {
      return undefined;
    }
  }
  return undefined;
}

/** Span covering the step text after the keyword (fallback: whole trimmed line). */
function spanOf(line: string, lineNo: number, keyword?: string): RawDiagnostic['range'] {
  if (keyword) {
    const idx = line.indexOf(keyword);
    if (idx >= 0) {
      const after = line.slice(idx + keyword.length);
      const ws = after.length - after.trimStart().length;
      const start = idx + keyword.length + ws;
      return { startLine: lineNo, startCol: start, endLine: lineNo, endCol: start + after.trim().length };
    }
  }
  const t = line.trimStart();
  const indent = line.length - t.length;
  return { startLine: lineNo, startCol: indent, endLine: lineNo, endCol: indent + t.length };
}

// ── Pure core: definition-side analysis ──

export function analyzeDefinitions(defs: readonly StepDefinition[]): Map<string, RawDiagnostic[]> {
  const perFile = new Map<string, RawDiagnostic[]>();
  const push = (fsPath: string, d: RawDiagnostic) => {
    const arr = perFile.get(fsPath) ?? [];
    arr.push(d);
    perFile.set(fsPath, arr);
  };

  // Pattern syntax validation
  for (const def of defs) {
    let invalid: string | undefined;
    try {
      if (def.matcherKind === 'parse') {
        compilePythonParsePattern(def.text); // degrades gracefully; kept for parity
      }
      if (def.lang === 'rust') {
        compileRustFormatPattern(def.text);
      }
      if (def.matcherKind === 're') {
        new RegExp(def.text.replace(/\(\?P<(\w+)>/g, '(?<$1>'), 'u');
      }
    } catch (e) {
      invalid = e instanceof Error ? e.message : String(e);
    }
    if (invalid) {
      push(def.file.fsPath, {
        range: rangeOfDef(def),
        severity: 'error',
        message: `Invalid step pattern: ${invalid}`,
        code: 'invalidPattern',
      });
    }
  }

  // Duplicate texts (same lang+kind+text)
  if (cfg('diagnostics.duplicateDefinitions', true)) {
    const seen = new Map<string, StepDefinition>();
    for (const def of defs) {
      if (def.matcherKind === 'exact') {
        continue; // exact dupes are legal across suites? still confusing — include them too:
      }
      const key = `${def.lang}|${def.matcherKind}|${def.type}|${def.text}`;
      const first = seen.get(key);
      if (first) {
        push(def.file.fsPath, {
          range: rangeOfDef(def),
          severity: 'info',
          message: `Duplicate step pattern (also defined at ${first.file.path.split('/').pop()}:${first.decoratorLine + 1})`,
          code: 'duplicateDefinition',
          related: [{ fsPath: first.file.fsPath, line: first.decoratorLine, message: 'First definition' }],
        });
      } else {
        seen.set(key, def);
      }
    }
  }

  return perFile;
}

export function rangeOfDef(def: StepDefinition): RawDiagnostic['range'] {
  const sel = def.patternSelection;
  if (sel) {
    return { startLine: sel.startLine, startCol: sel.startCol, endLine: sel.endLine, endCol: sel.endCol };
  }
  return { startLine: def.decoratorLine, startCol: 0, endLine: def.decoratorLine, endCol: 120 };
}

// ── Collection layer ──

export class BddDiagnostics {
  private _collection = vscode.languages.createDiagnosticCollection('bddFeature');
  private _timer: NodeJS.Timeout | undefined;

  dispose(): void {
    this._collection.dispose();
  }

  clear(): void {
    this._collection.clear();
  }

  requestRefresh(): void {
    if (this._timer) {
      clearTimeout(this._timer);
    }
    this._timer = setTimeout(() => void this.refresh(), 400);
  }

  async refresh(): Promise<void> {
    this._collection.clear();
    if (!toggles.diagnostics()) {
      return;
    }
    await Promise.all([scanStepDefinitions(), ensureBindings()]);
    const defs = getStepDefinitions();

    // Feature files
    const featureUris = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
    for (const uri of featureUris) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const lines = doc.getText().split(/\r?\n/);
        const raws = analyzeFeature(lines, defs, getBindingsForFeature(uri.fsPath).length > 0, {
          undefinedSteps: cfg('diagnostics.undefinedSteps', true),
          unboundFeatures: cfg('diagnostics.unboundFeatures', false),
        });
        if (raws.length) {
          this._collection.set(uri, raws.map(r => toDiagnostic(r)));
        }
      } catch {
        // skip
      }
    }

    // Definition files (pattern errors / duplicates / unused)
    const perFile = analyzeDefinitions(defs);
    if (cfg('diagnostics.unusedDefinitions', false)) {
      await tagUnused(perFile, defs);
    }
    for (const [fsPath, raws] of perFile) {
      this._collection.set(vscode.Uri.file(fsPath), raws.map(toDiagnostic));
    }
  }
}

async function tagUnused(perFile: Map<string, RawDiagnostic[]>, defs: StepDefinition[]): Promise<void> {
  // Collect every parsed step usage across features (parametric-aware:
  // a definition counts as used when ANY usage text resolves to it).
  const files = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
  const usages: string[] = [];
  for (const uri of files) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const dialect = detectDocumentLanguage(doc.getText());
      for (const line of doc.getText().split(/\r?\n/)) {
        const p = parseStepLine(line, dialect);
        if (p) {
          usages.push(p.text);
        }
      }
    } catch {
      // skip
    }
  }
  for (const def of defs) {
    if (usages.some(u => stepMatchesDefinition(u, def))) {
      continue;
    }
    const arr = perFile.get(def.file.fsPath) ?? [];
    arr.push({
      range: rangeOfDef(def),
      severity: 'hint',
      message: 'Unused step definition (no matching usage in any .feature)',
      code: 'unusedDefinition',
    });
    perFile.set(def.file.fsPath, arr);
  }
}

function toDiagnostic(r: RawDiagnostic): vscode.Diagnostic {
  const d = new vscode.Diagnostic(
    new vscode.Range(r.range.startLine, r.range.startCol, r.range.endLine, r.range.endCol),
    r.message,
    {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information,
      hint: vscode.DiagnosticSeverity.Hint,
    }[r.severity],
  );
  d.code = r.code;
  d.source = 'BDD Feature';
  if (r.related?.length) {
    d.relatedInformation = r.related.map(rel =>
      new vscode.DiagnosticRelatedInformation(
        new vscode.Location(vscode.Uri.file(rel.fsPath), new vscode.Position(rel.line, 0)),
        rel.message,
      ),
    );
  }
  return d;
}
