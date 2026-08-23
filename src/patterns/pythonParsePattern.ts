/**
 * Faithful compilation of Python `parse`-library format strings (used by
 * pytest-bdd's `parsers.parse` / `parsers.cfparse`) into ES2018 RegExp.
 *
 * Semantics verified against `parse==1.22.1`:
 *   {} / {name}       → (?<name>.+?)          — LAZY any-text (spans spaces!)
 *   {name:d}          → int                   — [+-]?\d+
 *   {name:w}          → \w+
 *   {name:f}          → float
 *   {{ / }}           → literal braces
 *   literal space     → matches exactly ONE space character (no \s+ folding)
 *
 * This fixes the previous implementation which mapped untyped placeholders to
 * `\S+` and folded spaces to `\s+`, causing missed definition jumps whenever a
 * captured value contained whitespace (e.g. "订单 POST 批量更新 状态为 ok").
 */

/** Parsed parameter info from a format string */
export interface PatternParam {
  /** Parameter name (or `_0`, `_1`... for anonymous) */
  name: string;
  /** Format type specifier (d, f, w, s, ...) */
  type: string;
}

export interface CompiledPythonPattern {
  regex: RegExp;
  params: PatternParam[];
  source: string;
}

const _cache = new Map<string, CompiledPythonPattern>();

/**
 * Compile a Python-parse format string into an anchored RegExp.
 * Falls back to plain escaped literal matching on malformed input so that
 * exact-string definitions containing stray braces still work.
 */
export function compilePythonParsePattern(pattern: string): CompiledPythonPattern {
  const cached = _cache.get(pattern);
  if (cached) {
    return cached;
  }

  const params: PatternParam[] = [];
  let rx = '';
  let anon = 0;
  let i = 0;

  while (i < pattern.length) {
    // Escaped braces
    if (pattern[i] === '{' && pattern[i + 1] === '{') {
      rx += '\\{';
      i += 2;
      continue;
    }
    if (pattern[i] === '}' && pattern[i + 1] === '}') {
      rx += '\\}';
      i += 2;
      continue;
    }

    if (pattern[i] === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        // Malformed → treat as literal (parse would raise; we degrade gracefully)
        rx += escapeRegex(pattern[i]);
        i++;
        continue;
      }
      const placeholder = pattern.slice(i + 1, close);
      const colon = placeholder.indexOf(':');
      const rawName = colon === -1 ? placeholder : placeholder.slice(0, colon);
      const spec = colon === -1 ? '' : placeholder.slice(colon + 1);
      const name = rawName.trim() || `_${anon++}`;
      const type = spec.trim();

      params.push({ name, type });
      rx += `(?<${groupName(name)}>${typeToRegex(type)})`;
      i = close + 1;
      continue;
    }

    // Literal char (space stays a single literal space — faithful to parse)
    rx += escapeRegex(pattern[i]);
    i++;
  }

  let compiled: CompiledPythonPattern;
  try {
    compiled = { regex: new RegExp(`^${rx}$`, 'u'), params, source: pattern };
  } catch {
    // Invalid group names etc. → degrade to literal match
    compiled = {
      regex: new RegExp(`^${escapeRegex(pattern)}$`, 'u'),
      params: [],
      source: pattern,
    };
  }
  _cache.set(pattern, compiled);
  return compiled;
}

/** Translate a parse type specifier into its regex fragment. */
function typeToRegex(spec: string): string {
  switch (spec) {
    case '':
      return '.+?'; // untyped → lazy any-text (parse default)
    case 'd':
      return '[+-]?\\d+'; // int (parse also allows hex/oct/bin; simplified)
    case 'w':
      return '\\w+';
    case 'f':
      return '[-+]?(?:\\d+\\.\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';
    case 'e':
      return '[-+]?(?:\\d+\\.\\d*|\\.\\d+)[eE][+-]?\\d+';
    case 'b':
      return '(?:[Tt]rue|[Ff]alse)';
    case 'x':
      return '0[xX][0-9a-fA-F]+';
    case 'o':
      return '0[oO][0-7]+';
    case 'n':
      return '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?';
    case '%':
      return '[-+]?\\d+(?:\\.\\d+)?%';
    case 'ti':
    case 'te':
      return '[^ ]+(?: [^ ]+)*'; // ISO-ish datetime; kept loose
    default:
      // cfparse cardinality forms like "d+", "d*", "s?" degrade gracefully
      return '.+?';
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function groupName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');
}

export function matchPythonParsePattern(
  featureStep: string,
  definitionPattern: string,
): Record<string, string> | null {
  const { regex } = compilePythonParsePattern(definitionPattern);
  const m = featureStep.match(regex);
  return m ? (m.groups ?? {}) : null;
}
