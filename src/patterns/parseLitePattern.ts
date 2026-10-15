/**
 * Placeholder semantics shared by custom BDD runners (e.g. llman-sdd tests/bdd):
 *   "{name}"   → lazy string capture (runner uses [^"]* in quoted contexts)
 *   "{name:d}" → integer capture
 * Everything else is literal text (parentheses are NOT Cucumber optional groups).
 *
 * Ported from llman-sdd tests/bdd/runner.ts compilePattern (parser-only subset).
 */

export interface ParseLiteMatch {
  groups: Record<string, string>;
}

const COMPILED = new Map<string, RegExp>();
const COMPILED_MAX = 4096;

function compileParseLite(pattern: string): RegExp | null {
  const cached = COMPILED.get(pattern);
  if (cached) {
    return cached;
  }
  let regexSrc = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        regexSrc += '\\{';
        i += 1;
        continue;
      }
      const inner = pattern.slice(i + 1, end);
      const dMatch = inner.match(/^([\w\u4E00-\u9FFF]+):d$/);
      if (dMatch?.[1]) {
        regexSrc += '(\\d+)';
      } else if (/^[\w\u4E00-\u9FFF]+$/.test(inner)) {
        regexSrc += '([\\s\\S]*?)';
      } else {
        regexSrc += pattern.slice(i, end + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      i = end + 1;
    } else {
      regexSrc += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  let re: RegExp | null = null;
  try {
    re = new RegExp(`^${regexSrc}$`, 'u');
  } catch {
    re = null;
  }
  if (COMPILED.size >= COMPILED_MAX) {
    COMPILED.clear();
  }
  COMPILED.set(pattern, re as RegExp);
  return re;
}

/** Match feature step text against a parse-lite pattern; null when no match. */
export function matchParseLitePattern(
  featureStep: string,
  pattern: string,
): ParseLiteMatch | null {
  const re = compileParseLite(pattern);
  if (!re) {
    return null;
  }
  const m = re.exec(featureStep.trim());
  if (!m) {
    return null;
  }
  return { groups: {} };
}
