/**
 * Unified step-text matching engine dispatching on definition kind.
 *
 * pytest-bdd:
 *   exact  → verbatim equality
 *   parse  → Python `parse` format semantics (lazy untyped captures)
 *   cfparse→ same as parse here (cardinality extras degrade gracefully)
 *   re     → regular expression (Python named groups converted)
 * rstest-bdd:
 *   Rust format placeholders ({x}, {x:string}, {x:u32}, ...)
 * cucumber-js / playwright-bdd:
 *   cexpr  → Cucumber Expression ({string}, {int}, {}, …)
 *
 * Scenario-Outline templates: frameworks substitute `<param>` values BEFORE
 * matching, so a template step never matches at runtime-literals level. The
 * editor-side equivalent is a SHAPE match — each `<param>` in the feature
 * text acts as a lazy wildcard compared against the definition's pattern
 * source. This powers go-to-definition/diagnostics on outline template lines.
 */

import { matchPythonParsePattern } from './patterns/pythonParsePattern';
import { matchRustFormatPattern } from './patterns/rustFormatPattern';
import { matchCucumberExpression } from './patterns/cucumberExpressionPattern';
import type { StepDefinition } from './model';

/** Gherkin outline placeholder, e.g. `<user_id>` (no whitespace inside). */
const OUTLINE_PARAM_RE = /<[^<>\s]{1,128}>/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Shape-compare an outline template against a definition pattern:
 * '用户 <uid> 存在' → /^用户 .*? 存在$/ tested over the def text, so
 * `用户 {uid:d} 存在`, `{string}` variants and bare literals all resolve.
 *
 * The shape depends only on the template, so compiled shapes are memoized —
 * this runs per (step, def) pair in hover/goto-def/references/diagnostics
 * match loops.
 */
const OUTLINE_SHAPE_CACHE = new Map<string, RegExp>();
const OUTLINE_SHAPE_CACHE_MAX = 4096;

export function outlineTemplateMatches(templateStep: string, patternText: string): boolean {
  if (!OUTLINE_PARAM_RE.test(templateStep)) {
    return false;
  }
  let shape = OUTLINE_SHAPE_CACHE.get(templateStep);
  if (shape === undefined) {
    try {
      const parts = templateStep.split(/<[^<>]*>/);
      shape = new RegExp(`^${parts.map(escapeRe).join('[\\s\\S]*?')}$`, 'u');
    } catch {
      shape = false as unknown as RegExp; // negative cache
    }
    if (OUTLINE_SHAPE_CACHE.size >= OUTLINE_SHAPE_CACHE_MAX) {
      OUTLINE_SHAPE_CACHE.clear(); // simple eviction; shapes are recomputable
    }
    OUTLINE_SHAPE_CACHE.set(templateStep, shape);
  }
  if (shape === (false as unknown as RegExp)) {
    return false;
  }
  return (shape as RegExp).test(patternText);
}

/**
 * Check whether a feature step text matches a definition.
 * Both inputs are the step text WITHOUT the leading keyword.
 */
export function stepMatchesDefinition(featureStep: string, def: StepDefinition): boolean {
  const feature = featureStep.trim();
  if (!feature) {
    return false;
  }

  switch (def.matcherKind) {
    case 'exact':
      if (def.text.trim() === feature) {
        return true;
      }
      break; // fall through to outline shape matching below
    case 're':
      if (matchRegex(feature, def.text)) {
        return true;
      }
      break;
    case 'cexpr':
      if (matchCucumberExpression(feature, def.text) !== null) {
        return true;
      }
      break;
    case 'cfparse':
    case 'parse': {
      const matched =
        def.lang === 'rust'
          ? matchRustFormatPattern(feature, def.text) !== null
          : matchPythonParsePattern(feature, def.text) !== null;
      if (matched) {
        return true;
      }
      break;
    }
  }
  // Outline template fallback — every kind benefits (runtime substitution).
  return outlineTemplateMatches(feature, def.text);
}

interface CompiledReVariants {
  /** Anchored variants tried in order; null = fails to compile under 'u' */
  anchored: Array<RegExp | null>;
  /** Loose (unanchored) last-resort variant, when applicable */
  loose: RegExp | null;
}

const RE_VARIANT_CACHE = new Map<string, CompiledReVariants>();
const RE_VARIANT_CACHE_MAX = 4096;

function compileReVariants(pattern: string): CompiledReVariants {
  const cached = RE_VARIANT_CACHE.get(pattern);
  if (cached) {
    return cached;
  }
  const jsPattern = pattern.replace(/\(\?P<(\w+)>/g, '(?<$1>');
  // Python f-string interpolations inside re patterns (rf"…{_TAB}…") resolve
  // only at runtime; approximate each identifier-braced hole as lazy any-text.
  // Digit-led braces like \d{1,3} are quantifiers and untouched.
  const hasInterpolation = /\{[A-Za-z_]\w*\}/.test(pattern);
  const sources = hasInterpolation
    ? [jsPattern, jsPattern.replace(/\{[A-Za-z_]\w*\}/g, '(?:[\\s\\S]*?)')]
    : [jsPattern];

  const compiled: CompiledReVariants = { anchored: [], loose: null };
  sources.forEach((src, i) => {
    let anchored: RegExp | null = null;
    try {
      anchored = new RegExp(`^(?:${src})$`, 'u');
    } catch {
      anchored = null; // invalid under 'u' (e.g. raw '{ident}' braces)
    }
    compiled.anchored.push(anchored);
    if (i === sources.length - 1 && !hasInterpolation) {
      try {
        compiled.loose = new RegExp(src, 'u');
      } catch {
        compiled.loose = null;
      }
    }
  });

  if (RE_VARIANT_CACHE.size >= RE_VARIANT_CACHE_MAX) {
    RE_VARIANT_CACHE.clear();
  }
  RE_VARIANT_CACHE.set(pattern, compiled);
  return compiled;
}

function matchRegex(featureStep: string, pattern: string): boolean {
  const compiled = compileReVariants(pattern);
  for (let i = 0; i < compiled.anchored.length; i++) {
    const re = compiled.anchored[i];
    if (!re) {
      continue; // failed to compile under 'u' — try next variant (original semantics)
    }
    if (re.test(featureStep)) {
      return true;
    }
    // Anchored failed but compiled: allow a loose search only as a last
    // resort for partial patterns (author wrote an unanchored fragment).
    if (i === compiled.anchored.length - 1) {
      return compiled.loose ? compiled.loose.test(featureStep) : false;
    }
  }
  return false;
}

/** Find definitions matching a feature step (type-aware). */
export function findMatches<T extends StepDefinition>(
  defs: readonly T[],
  featureStepText: string,
  stepType?: 'given' | 'when' | 'then',
): T[] {
  return defs.filter(def => {
    if (def.type !== 'step' && stepType && def.type !== stepType) {
      return false;
    }
    return stepMatchesDefinition(featureStepText, def);
  });
}
