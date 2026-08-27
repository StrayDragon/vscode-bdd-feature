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
import { getStepDefinitions } from '../steps';
import { stepMatchesDefinition } from '../matching';
import { getBindingsForFeature, ensureBindings } from '../bindings';
import { parseFeatureTags } from '../gherkin/tags';
import { ensureTagIndex, getIndexedFile } from '../tagIndex';
import { toggles, cfg } from '../config';
import { readFileText } from '../utils';
import { whenStepsReady } from '../steps';
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
  /** When provided, collects every parsed step text (for unused-def passes) */
  usagesOut?: string[],
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
    usagesOut?.push(parsed.text);
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
    // whenStepsReady joins the save-driven in-flight scan (or uses the fresh
    // cache) instead of starting a competing second workspace sweep.
    // ensureTagIndex is memoized; tag problems are reused from it.
    await Promise.all([whenStepsReady(), ensureBindings(), ensureTagIndex()]);
    const defs = getStepDefinitions();

    // Feature files — single pass: step diagnostics + usage collection for
    // the unused-definitions pass (no second sweep) + tag problems.
    const featureUris = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
    const usages: string[] = [];
    for (const uri of featureUris) {
      try {
        const text = await readFileText(uri);
        const lines = text.split(/\r?\n/);
        const raws = analyzeFeature(lines, defs, getBindingsForFeature(uri.fsPath).length > 0, {
          undefinedSteps: cfg('diagnostics.undefinedSteps', true),
          unboundFeatures: cfg('diagnostics.unboundFeatures', false),
        }, usages);
        if (cfg('diagnostics.tags', true) && toggles.tags()) {
          // Indexed files reuse their parsed problems; anything the index
          // does not cover (e.g. excluded dirs) parses locally.
          const entry = getIndexedFile(uri.fsPath);
          const problems = entry ? entry.problems ?? [] : parseFeatureTags(lines).problems;
          for (const p of problems) {
            raws.push({ range: p.range, severity: p.severity, message: p.message, code: p.code });
          }
        }
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
      tagUnused(perFile, defs, usages);
    }    for (const [fsPath, raws] of perFile) {
      this._collection.set(vscode.Uri.file(fsPath), raws.map(toDiagnostic));
    }
  }
}

/**
 * Mark definitions never referenced by any feature step.
 *
 * Formerly this re-swept every .feature file AND ran an O(defs × usages)
 * matcher loop with uncached regex compilation. Now it consumes the usages
 * collected during the same refresh pass, dedupes them, and fast-paths
 * exact-match definitions through a Set before falling back to the
 * (now memoized) full matcher.
 */
function tagUnused(
  perFile: Map<string, RawDiagnostic[]>,
  defs: StepDefinition[],
  usages: readonly string[],
): void {
  const uniqueUsages = [...new Set(usages)];
  const usageSet = new Set(uniqueUsages);
  for (const def of defs) {
    const used =
      def.matcherKind === 'exact'
        ? usageSet.has(def.text.trim()) || uniqueUsages.some(u => stepMatchesDefinition(u, def))
        : uniqueUsages.some(u => stepMatchesDefinition(u, def));
    if (used) {
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
