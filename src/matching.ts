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
 */

import { matchPythonParsePattern } from './patterns/pythonParsePattern';
import { matchRustFormatPattern } from './patterns/rustFormatPattern';
import type { StepDefinition } from './model';

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
      return def.text.trim() === feature;
    case 're':
      return matchRegex(feature, def.text);
    case 'cfparse':
    case 'parse':
      if (def.lang === 'rust') {
        return matchRustFormatPattern(feature, def.text) !== null;
      }
      return matchPythonParsePattern(feature, def.text) !== null;
  }
}

function matchRegex(featureStep: string, pattern: string): boolean {
  try {
    const jsPattern = pattern.replace(/\(\?P<(\w+)>/g, '(?<$1>');
    const anchored = new RegExp(`^(?:${jsPattern})$`, 'u');
    return anchored.test(featureStep);
  } catch {
    // Maybe the author wrote a partial pattern; fall back to search semantics
    try {
      const loose = new RegExp(pattern.replace(/\(\?P<(\w+)>/g, '(?<$1>'), 'u');
      return loose.test(featureStep);
    } catch {
      return false;
    }
  }
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
