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

function keywordsFor(dialect: ResolvedDialect): { steps: string[]; continuations: string[] } {
  if (!dialect.explicit || !dialect.code) {
    return { steps: ALL_STEP_KEYWORDS, continuations: ALL_CONTINUATION };
  }
  const def = LANGUAGE_DEFS.get(dialect.code.toLowerCase())!;
  const steps = [
    ...new Set([...def.given, ...def.when, ...def.then]),
  ].sort(byLengthDesc);
  const conts = [...new Set([...def.and, ...def.but])].sort(byLengthDesc);
  return { steps, continuations: conts };
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
 * Parse one line as a step line.
 * `dialect` should come from detectDocumentLanguage(documentText).
 */
export function parseStepLine(
  line: string,
  dialect: ResolvedDialect = { explicit: false },
): ParsedStepLine | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  const { steps, continuations } = keywordsFor(dialect);

  for (const kw of [...steps, ...continuations]) {
    if (!trimmed.startsWith(kw)) {
      continue;
    }
    const rest = trimmed.slice(kw.length);
    // Boundary check: end-of-line, whitespace, or CJK-style direct adjacency
    // (cucumber allows the step text to follow a CJK keyword without space).
    const nextCh = rest.charAt(0);
    const boundary =
      rest === '' || /\s/.test(nextCh) || !isAsciiWordChar(nextCh);
    if (!boundary) {
      continue;
    }
    return {
      keyword: kw,
      text: rest.trim(),
      type: KEYWORD_TO_TYPE.get(kw),
    };
  }
  return undefined;
}

function isAsciiWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
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
 */
export function parseScenarioLine(line: string, _dialect?: ResolvedDialect): string | undefined {
  const trimmed = line.trimStart();
  for (const kw of STRUCTURAL_LOOKUP.get('scenarioOutline') ?? []) {
    const re = new RegExp(`^${escapeRe(kw)}\\s*:`);
    const m = trimmed.match(re);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  for (const kw of STRUCTURAL_LOOKUP.get('scenario') ?? []) {
    const re = new RegExp(`^${escapeRe(kw)}\\s*:`);
    const m = trimmed.match(re);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  return undefined;
}

/** Parse a Feature header line; returns the feature title or undefined. */
export function parseFeatureLine(line: string, _dialect?: ResolvedDialect): string | undefined {
  const trimmed = line.trimStart();
  for (const kw of STRUCTURAL_LOOKUP.get('feature') ?? []) {
    const re = new RegExp(`^${escapeRe(kw)}\\s*:`);
    const m = trimmed.match(re);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  return undefined;
}

/** True for any structural keyword line (Feature/Rule/Background/Examples/…). */
export function isStructuralKeyword(line: string): boolean {
  const trimmed = line.trimStart();
  for (const kws of STRUCTURAL_LOOKUP.values()) {
    for (const kw of kws) {
      if (new RegExp(`^${escapeRe(kw)}\\s*:`).test(trimmed)) {
        return true;
      }
    }
  }
  return false;
}

/** Parse a Rule header line ("Rule: x" / "规则: x"); returns title or undefined. */
export function parseRuleLine(line: string): string | undefined {
  return parseStructuralByRole(line, 'rule');
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
  const trimmed = line.trimStart();
  for (const kw of STRUCTURAL_LOOKUP.get(role) ?? []) {
    const re = new RegExp(`^${escapeRe(kw)}\\s*:`);
    const m = trimmed.match(re);
    if (m) {
      return trimmed.slice(m[0].length).trim();
    }
  }
  return undefined;
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
