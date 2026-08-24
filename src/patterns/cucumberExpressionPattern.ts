/**
 * Cucumber Expression → ES2018 RegExp compiler.
 *
 * Serves string-pattern step definitions from the TypeScript BDD ecosystem
 * (cucumber-js `Given('I have {int} cuke(s)', …)` and playwright-bdd
 * `createBdd()` steps). Semantics follow `@cucumber/cucumber-expressions`
 * (conformance probed against v20.1.0, see core.test.ts):
 *
 *   {int}                → -?\d+
 *   {float}              → -?\d*\.\d+          (NO exponent — upstream parity)
 *   {word}               → [^\s]+
 *   {string}             → 'quoted' or "quoted" (matchers keep the quotes;
 *                          matchCucumberExpression strips them from values)
 *   {}                   → .+?                 — anonymous any-text (lazy)
 *   {custom-name}        → .+?                 — unregistered types degrade lazily
 *   optional text  (s)   → (?:s)?
 *   alternative    a/b   → (?:a|b)             — `/` acts as alternation
 *   \x                   → literal x           — backslash escapes { } ( ) / \
 *   duplicate param names ({int} and {int})    → positional groups, never collide
 *
 * Literal text is regex-escaped, spaces stay literal (no \s+ folding), and the
 * result is anchored ^…$ like upstream CucumberExpression.match.
 * Malformed input degrades to literal matching (never throws).
 */

export interface CompiledCucumberExpression {
  regex: RegExp;
  /** Parameters in declaration order (anonymous/duplicate ones get _0, _1, …). */
  params: Array<{ name: string; type: string }>;
  source: string;
}

const _cache = new Map<string, CompiledCucumberExpression>();

const STRING_RX = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'';

/**
 * Built-in parameter-type regex fragments (mirrors upstream
 * builtin_parameter_type.rb as of cucumber-expressions 20.x).
 * Unknown/custom types degrade to lazy any-text so definitions using
 * user-registered types still resolve by shape.
 */
export function cucumberTypeToRegex(type: string): string {
  switch (type) {
    case '':
      return '.+?'; // {} anonymous
    case 'int':
      return '-?\\d+';
    case 'float':
      return '-?\\d*\\.\\d+'; // upstream has no exponent support
    case 'word':
      return '[^\\s]+';
    case 'string':
      return STRING_RX;
    default:
      return '.+?'; // custom types (defineParameterType) — degrade gracefully
  }
}

export function compileCucumberExpression(expression: string): CompiledCucumberExpression {
  const cached = _cache.get(expression);
  if (cached) {
    return cached;
  }

  const params: Array<{ name: string; type: string }> = [];
  const seenGroupNames = new Set<string>();
  let rx = '';
  let anon = 0;
  let i = 0;

  while (i < expression.length) {
    const ch = expression[i];

    // Backslash escapes the next character literally (\{ \( \/ …)
    if (ch === '\\' && i + 1 < expression.length) {
      rx += escapeRegex(expression[i + 1]);
      i += 2;
      continue;
    }

    if (ch === '{') {
      const close = findClosingBrace(expression, i);
      if (close === -1) {
        // Unbalanced brace — upstream raises; we degrade to literal text.
        rx += escapeRegex(ch);
        i++;
        continue;
      }
      const type = expression.slice(i + 1, close).trim();
      const baseName = type || `_${anon++}`;
      const name = seenGroupNames.has(baseName) ? `_${anon++}_${baseName}` : baseName;
      seenGroupNames.add(name);
      params.push({ name: type || name.replace(/^_\d+_/, ''), type });
      rx += `(?<${groupName(name)}>${cucumberTypeToRegex(type)})`;
      i = close + 1;
      continue;
    }

    // Optional text: (…) → (?:…)?
    if (ch === '(') {
      rx += '(?:';
      i++;
      continue;
    }
    if (ch === ')') {
      rx += ')?';
      i++;
      continue;
    }
    // Alternative text: a/b → a|b
    if (ch === '/') {
      rx += '|';
      i++;
      continue;
    }

    rx += escapeRegex(ch);
    i++;
  }

  let compiled: CompiledCucumberExpression;
  try {
    compiled = { regex: new RegExp(`^${rx}$`, 'u'), params, source: expression };
  } catch {
    compiled = {
      regex: new RegExp(`^${escapeRegex(expression)}$`, 'u'),
      params: [],
      source: expression,
    };
  }
  _cache.set(expression, compiled);
  return compiled;
}

/**
 * Index of the `}` closing the `{` at `open`, honoring escaped braces.
 * -1 when unbalanced (upstream would raise).
 */
function findClosingBrace(expression: string, open: number): number {
  for (let j = open + 1; j < expression.length; j++) {
    if (expression[j] === '\\' && j + 1 < expression.length) {
      j++; // skip escaped char
      continue;
    }
    if (expression[j] === '}') {
      return j;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groupName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^(\d)/, '_$1') || '_'
  );
}

/**
 * Match a feature step against a cucumber expression.
 * Returns captured values with {string} quotes stripped (mirroring how
 * frameworks hand the argument to the step function), else null.
 */
export function matchCucumberExpression(
  featureStep: string,
  expression: string,
): Record<string, string> | null {
  const { regex } = compileCucumberExpression(expression);
  const m = featureStep.match(regex);
  if (!m) {
    return null;
  }
  const groups: Record<string, string> = {};
  for (const [k, v] of Object.entries(m.groups ?? {})) {
    groups[k] =
      v !== undefined && v.length >= 2 &&
      ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        ? v.slice(1, -1)
        : (v ?? '');
  }
  return groups;
}
