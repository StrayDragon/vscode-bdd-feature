/**
 * Gherkin keyword engine driven by the official language spec.
 *
 * The single source of truth is `gherkin-languages.json` (vendored from
 * cucumber/gherkin, MIT). Nothing about any particular natural language is
 * hardcoded here — English, Simplified/Traditional Chinese and ~78 other
 * languages all derive from the data at module load.
 *
 * Matching strategy mirrors cucumber's TokenMatcher:
 *   - If the document declares `# language: <code>`, that dialect's keywords
 *     take priority (longest match first).
 *   - Undeclared documents fall back to a union of ALL languages (longest
 *     match first) so Chinese files without the directive still parse.
 */

import languagesJson from './gherkin-languages.json';

export type StepType = 'given' | 'when' | 'then';

interface LanguageDef {
  name: string;
  native: string;
  feature: string[];
  rule: string[];
  background: string[];
  scenario: string[];
  scenarioOutline: string[];
  examples: string[];
  given: string[];
  when: string[];
  then: string[];
  and: string[];
  but: string[];
}

const LANGS = languagesJson as unknown as Record<string, Record<string, unknown>>;

/** Normalize spec keywords: they may carry trailing spaces (e.g. "* "). */
function normalizeKeywords(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  return [...new Set(list.map(k => String(k).trimEnd()).filter(Boolean))];
}

function buildLanguageDef(code: string, raw: Record<string, unknown>): LanguageDef {
  return {
    name: String(raw.name ?? code),
    native: String(raw.native ?? code),
    feature: normalizeKeywords(raw.feature),
    rule: normalizeKeywords(raw.rule),
    background: normalizeKeywords(raw.background),
    scenario: normalizeKeywords(raw.scenario),
    scenarioOutline: normalizeKeywords(raw.scenarioOutline),
    examples: normalizeKeywords(raw.examples),
    given: normalizeKeywords(raw.given),
    when: normalizeKeywords(raw.when),
    then: normalizeKeywords(raw.then),
    and: normalizeKeywords(raw.and),
    but: normalizeKeywords(raw.but),
  };
}

const LANGUAGE_DEFS = new Map<string, LanguageDef>();
const ORIGINAL_CODE = new Map<string, string>(); // lower → original
for (const [code, raw] of Object.entries(LANGS)) {
  LANGUAGE_DEFS.set(code.toLowerCase(), buildLanguageDef(code, raw));
  ORIGINAL_CODE.set(code.toLowerCase(), code);
}

/** Longest-first sort for prefix matching. */
function byLengthDesc(a: string, b: string): number {
  return b.length - a.length || a.localeCompare(b);
}

// ── Global indexes ──

/** Every step keyword in every language → canonical type. */
const KEYWORD_TO_TYPE = new Map<string, StepType>();
/** Continuation keywords (And/But/*-variants) across languages. */
const CONTINUATION_KEYWORDS = new Set<string>();
/** Structural keyword role → keyword set (union of all languages). */
const STRUCTURAL = new Map<string, Set<string>>();

function addAll(role: keyof LanguageDef, target: Map<string, StepType> | Set<string>, type?: StepType): void {
  for (const def of LANGUAGE_DEFS.values()) {
    for (const kw of def[role] as string[]) {
      if (target instanceof Map) {
        target.set(kw, type!);
      } else {
        target.add(kw);
      }
    }
  }
}

for (const [type, role] of [
  ['given', 'given'],
  ['when', 'when'],
  ['then', 'then'],
] as const) {
  addAll(role, KEYWORD_TO_TYPE, type);
}
addAll('and', CONTINUATION_KEYWORDS);
addAll('but', CONTINUATION_KEYWORDS);

for (const role of ['feature', 'rule', 'scenario', 'scenarioOutline', 'examples', 'background'] as const) {
  const set = new Set<string>();
  addAll(role, set);
  STRUCTURAL.set(role, set);
}

/** Union of all step keywords, longest first. */
const ALL_STEP_KEYWORDS = [...KEYWORD_TO_TYPE.keys()].sort(byLengthDesc);
/** Union of continuation keywords ('*' included), longest first. */
const ALL_CONTINUATION = [...CONTINUATION_KEYWORDS].sort(byLengthDesc);
/** All structural keywords with their roles. */
const STRUCTURAL_LOOKUP = (() => {
  // role → regex-ready alternation (longest first)
  const m = new Map<string, string[]>();
  for (const [role, set] of STRUCTURAL) {
    m.set(role, [...set].sort(byLengthDesc));
  }
  return m;
})();

// ── Document language resolution ──

export interface ResolvedDialect {
  /** ISO-ish code from `# language:` or undefined when undeclared */
  code?: string;
  /** true when declared explicitly in the document */
  explicit: boolean;
}

export function detectDocumentLanguage(text: string): ResolvedDialect {
  const m = text.match(/^\s*#\s*language\s*:\s*([A-Za-z0-9_-]+)/m);
  if (!m) {
    return { explicit: false };
  }
  const lower = m[1].toLowerCase();
  if (!LANGUAGE_DEFS.has(lower)) {
    return { explicit: false };
  }
  return { code: ORIGINAL_CODE.get(lower) ?? m[1], explicit: true };
}

// ── Parsing API ──

export interface ParsedStepLine {
  /** The matched keyword, trimmed (e.g. "假设", "Given") */
  keyword: string;
  /** Step text after the keyword */
  text: string;
  /** Canonical type; undefined for And/But/* (inherit from previous step) */
  type?: StepType;
}

/**
 * Precompiled `^[ \t]*(KW1|KW2|…)(?![A-Za-z0-9_])` per dialect, longest-first.
 *
 * One `.exec` replaces the former ~350–550 `startsWith` probes AND the
 * per-call `[...steps, ...continuations]` array allocation. The negative
 * lookahead encodes the original boundary rule: a longer keyword that fails
 * the boundary makes the engine backtrack to shorter alternatives, exactly
 * like the previous explicit loop.
 */
const STEP_LINE_REGEX_CACHE = new Map<string, { steps: RegExp; continuations: RegExp }>();

function stepLineRegexes(dialect: ResolvedDialect): { steps: RegExp; continuations: RegExp } {
  const key = (dialect.explicit && dialect.code ? dialect.code : '__union__').toLowerCase();
  let pair = STEP_LINE_REGEX_CACHE.get(key);
  if (!pair) {
    const build = (kws: string[]): RegExp =>
      new RegExp(`^[ \\t]*(${kws.map(escapeRe).join('|')})(?![A-Za-z0-9_])`);
    if (dialect.explicit && dialect.code) {
      const def = LANGUAGE_DEFS.get(dialect.code.toLowerCase())!;
      pair = {
        steps: build([...new Set([...def.given, ...def.when, ...def.then])].sort(byLengthDesc)),
        continuations: build([...new Set([...def.and, ...def.but])].sort(byLengthDesc)),
      };
    } else {
      pair = { steps: build(ALL_STEP_KEYWORDS), continuations: build(ALL_CONTINUATION) };
    }
    STEP_LINE_REGEX_CACHE.set(key, pair);
  }
  return pair;
}

/**
 * Parse one line as a step line.
 * `dialect` should come from detectDocumentLanguage(documentText).
 */
export function parseStepLine(
  line: string,
  dialect: ResolvedDialect = { explicit: false },
): ParsedStepLine | undefined {
  const { steps, continuations } = stepLineRegexes(dialect);

  // Step keywords first, then continuations — same preference order as the
  // original [...steps, ...continuations] loop.
  const stepsM = steps.exec(line);
  if (stepsM) {
    const keyword = stepsM[1];
    return { keyword, text: line.slice(stepsM[0].length).trim(), type: KEYWORD_TO_TYPE.get(keyword) };
  }
  const contM = continuations.exec(line);
  if (contM) {
    const keyword = contM[1];
    return { keyword, text: line.slice(contM[0].length).trim(), type: undefined };
  }
  return undefined;
}

/** Canonical type of an already-parsed keyword (undefined → inherit). */
export function getStepType(keyword: string): StepType | undefined {
  return KEYWORD_TO_TYPE.get(keyword);
}

export function isContinuationKeyword(keyword: string): boolean {
  return CONTINUATION_KEYWORDS.has(keyword);
}

/**
 * Parse a scenario header line ("场景: xxx" / "Scenario Outline: xxx").
 * Returns the scenario title, or undefined when not a scenario line.
 *
 * Backed by the module-cached precompiled alternations (one `.exec` per
 * role) — this sits on per-line paths in diagnostics, symbols, code lenses.
 */
export function parseScenarioLine(line: string, _dialect?: ResolvedDialect): string | undefined {
  return (
    matchStructuralHeader(line, 'scenarioOutline')?.title ??
    matchStructuralHeader(line, 'scenario')?.title
  );
}

/** Parse a Feature header line; returns the feature title or undefined. */
export function parseFeatureLine(line: string, _dialect?: ResolvedDialect): string | undefined {
  return matchStructuralHeader(line, 'feature')?.title;
}

/** True for any structural keyword line (Feature/Rule/Background/Examples/…). */
export function isStructuralKeyword(line: string): boolean {
  return (
    matchStructuralHeader(line, 'feature') !== undefined ||
    matchStructuralHeader(line, 'rule') !== undefined ||
    matchStructuralHeader(line, 'background') !== undefined ||
    matchStructuralHeader(line, 'scenarioOutline') !== undefined ||
    matchStructuralHeader(line, 'scenario') !== undefined ||
    matchStructuralHeader(line, 'examples') !== undefined
  );
}

/** Parse a Rule header line ("Rule: x" / "规则: x"); returns title or undefined. */
export function parseRuleLine(line: string): string | undefined {
  return parseStructuralByRole(line, 'rule');
}

export type StructuralRole =
  | 'feature'
  | 'rule'
  | 'scenario'
  | 'scenarioOutline'
  | 'background'
  | 'examples';

/**
 * Precompiled `^(?:kw1|kw2|…)\s*:` matcher for a structural role.
 *
 * Unlike parseStructuralByRole (which builds a RegExp per keyword per call),
 * this compiles ONE module-cached alternation per role — hot document scans
 * (tag indexing) pay a single `.exec` per line instead of dozens of
 * regex constructions. Alternatives are longest-first so prefix keywords
 * resolve identically to the per-keyword parsers.
 *
 * Match groups: [1] = keyword, [2] = title text after `:`.
 */
const HEADER_REGEX_CACHE = new Map<StructuralRole, RegExp>();

export function structuralHeaderRegex(role: StructuralRole): RegExp {
  let re = HEADER_REGEX_CACHE.get(role);
  if (!re) {
    const kws = (STRUCTURAL_LOOKUP.get(role) ?? []).map(escapeRe);
    // Longest-first already guaranteed by STRUCTURAL_LOOKUP construction order;
    // enforce again defensively since Map iteration order is insertion-based.
    kws.sort(byLengthDesc);
    // [1] = matched keyword, [2] = title text after ':'
    re = new RegExp(`^[ \\t]*(${kws.join('|')})[ \\t]*:[ \\t]?(.*)$`);
    HEADER_REGEX_CACHE.set(role, re);
  }
  return re;
}

/** One-shot structural header test + capture for hot loops. */
export function matchStructuralHeader(
  line: string,
  role: StructuralRole,
): { keyword: string; title: string } | undefined {
  const m = structuralHeaderRegex(role).exec(line);
  if (!m) {
    return undefined;
  }
  return { keyword: m[1], title: (m[2] ?? '').trim() };
}

/** Parse a Background header line. */
export function parseBackgroundLine(line: string): string | undefined {
  return parseStructuralByRole(line, 'background');
}

/** Parse an Examples header line. */
export function parseExamplesLine(line: string): string | undefined {
  return parseStructuralByRole(line, 'examples');
}

function parseStructuralByRole(
  line: string,
  role: 'feature' | 'rule' | 'scenario' | 'scenarioOutline' | 'background' | 'examples',
): string | undefined {
  return matchStructuralHeader(line, role)?.title;
}

/**
 * Walk upward from a line to resolve inherited Given/When/Then context
 * for And/But/* steps. Stops at structural boundaries.
 */
export function resolveInheritedStepType(
  lineAt: (n: number) => string,
  startLine: number,
  dialect: ResolvedDialect,
): StepType | undefined {
  for (let i = startLine - 1; i >= 0; i--) {
    const parsed = parseStepLine(lineAt(i), dialect);
    if (parsed?.type) {
      return parsed.type;
    }
    if (parsed === undefined && isStructuralKeyword(lineAt(i))) {
      return undefined;
    }
  }
  return undefined;
}

/** Keywords available for completion in a document language. */
export function completionKeywordSets(dialect: ResolvedDialect): {
  structural: Array<{ keyword: string; role: string }>;
  steps: string[];
} {
  const langCode = (dialect.code ?? 'en').toLowerCase();
  const def = LANGUAGE_DEFS.get(langCode) ?? LANGUAGE_DEFS.get('en')!;
  return {
    structural: [
      { keywords: def.feature, role: 'Feature' },
      { keywords: def.rule, role: 'Rule' },
      { keywords: def.scenarioOutline, role: 'Scenario Outline' },
      { keywords: def.scenario, role: 'Scenario' },
      { keywords: def.background, role: 'Background' },
      { keywords: def.examples, role: 'Examples' },
    ].flatMap(r => r.keywords.map(keyword => ({ keyword, role: r.role }))),
    steps: [...new Set([...def.given, ...def.when, ...def.then, ...def.and, ...def.but])],
  };
}

/** All supported language codes (original spec casing). */
export function supportedLanguages(): Array<{ code: string; name: string; native: string }> {
  return [...LANGUAGE_DEFS.entries()].map(([lower, d]) => ({
    code: ORIGINAL_CODE.get(lower) ?? lower,
    name: d.name,
    native: d.native,
  }));
}

/** One preferred keyword alias per structural role + step kinds. */
export interface DialectSkeleton {
  feature: string;
  rule: string;
  scenario: string;
  outline: string;
  examples: string;
  background: string;
  given: string;
  when: string;
  then: string;
  and: string;
  but: string;
}

/**
 * Preferred aliases for snippet generation.
 * Localized (non-ASCII) aliases win so e.g. zh-CN skeletons read 场景/规则,
 * while pure-ASCII languages fall back to their canonical first alias.
 */
export function dialectSkeleton(dialect: ResolvedDialect): DialectSkeleton {
  const langCode = (dialect.code ?? 'en').toLowerCase();
  const def = LANGUAGE_DEFS.get(langCode) ?? LANGUAGE_DEFS.get('en')!;
  const pick = (aliases: string[]): string =>
    aliases.find(k => /[^\x00-\x7F]/.test(k)) ?? aliases[0] ?? '';
  return {
    feature: pick(def.feature),
    rule: pick(def.rule),
    scenario: pick(def.scenario),
    outline: pick(def.scenarioOutline),
    examples: pick(def.examples),
    background: pick(def.background),
    given: pick(def.given.filter(k => k !== '*')),
    when: pick(def.when.filter(k => k !== '*')),
    then: pick(def.then.filter(k => k !== '*')),
    and: pick(def.and.filter(k => k !== '*')),
    but: pick(def.but.filter(k => k !== '*')),
  };
}

/**
 * Best-effort dialect for UI generation on an undeclared document:
 * explicit `# language:` wins; otherwise CJK content suggests zh-CN,
 * mirroring the engine's union-matching leniency for directive-less files.
 */
export function preferredDialect(text: string): ResolvedDialect {
  const declared = detectDocumentLanguage(text);
  if (declared.explicit) {
    return declared;
  }
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(text);
  return { code: cjk ? 'zh-CN' : 'en', explicit: false };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
