/**
 * rstest-bdd step pattern → ES2018 RegExp compiler.
 *
 * Faithful port of `rstest-bdd-patterns` semantics (see upstream
 * crates/rstest-bdd-patterns/src/hint.rs and pattern/compiler.rs):
 *
 *   {} / {name}            → (.+?)                — lazy any-text
 *   {name:string}          → quoted string (quotes captured, then stripped)
 *   {name:u8..u128|usize}  → \d+
 *   {name:i8..i128|isize}  → [+-]?\d+
 *   {name:f32|f64}         → float incl. nan/inf
 *   {name:<other>}         → (.+?)                — unknown hints degrade to lazy
 *   {{ / }}                → literal braces
 *
 * Literal text is regex-escaped; spaces match exactly one space; the final
 * regex is anchored ^...$ — matching upstream `build_regex_from_pattern`.
 */

export interface RustPlaceholder {
  name: string;
  hint?: string;
}

export interface CompiledRustPattern {
  regex: RegExp;
  placeholders: RustPlaceholder[];
  source: string;
}

const _cache = new Map<string, CompiledRustPattern>();

const FLOAT_RX =
  '(?:[+-]?(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[eE][+-]?\\d+)?|[nN]a[Nn]|[iI]nf(?:[iI]nity)?)';
const QUOTED_STRING_RX = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'';

/** Port of upstream get_type_pattern(). */
export function rustTypeToRegex(hint: string | undefined): string {
  switch (hint) {
    case 'u8':
    case 'u16':
    case 'u32':
    case 'u64':
    case 'u128':
    case 'usize':
      return '\\d+';
    case 'i8':
    case 'i16':
    case 'i32':
    case 'i64':
    case 'i128':
    case 'isize':
      return '[+-]?\\d+';
    case 'f32':
    case 'f64':
      return FLOAT_RX;
    case 'string':
      return QUOTED_STRING_RX;
    default:
      return '.+?';
  }
}

/**
 * Compile an rstest-bdd pattern into an anchored RegExp.
 * Malformed patterns degrade to literal matching instead of throwing.
 */
export function compileRustFormatPattern(pattern: string): CompiledRustPattern {
  const cached = _cache.get(pattern);
  if (cached) {
    return cached;
  }

  const placeholders: RustPlaceholder[] = [];
  let rx = '';
  let anon = 0;
  let i = 0;

  while (i < pattern.length) {
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
        rx += escapeRegex(pattern[i]);
        i++;
        continue;
      }
      const inner = pattern.slice(i + 1, close);
      const colon = inner.indexOf(':');
      const name = colon === -1 ? inner : inner.slice(0, colon);
      const hint = colon === -1 ? undefined : inner.slice(colon + 1);
      const group =
        name.trim() || `_anon${anon++}`;
      placeholders.push({ name: name.trim(), hint });
      rx += `(?<${groupName(group)}>${rustTypeToRegex(hint?.trim() || undefined)})`;
      i = close + 1;
      continue;
    }
    rx += escapeRegex(pattern[i]);
    i++;
  }

  let compiled: CompiledRustPattern;
  try {
    compiled = { regex: new RegExp(`^${rx}$`, 'u'), placeholders, source: pattern };
  } catch {
    compiled = { regex: new RegExp(`^${escapeRegex(pattern)}$`, 'u'), placeholders, source: pattern };
  }
  _cache.set(pattern, compiled);
  return compiled;
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

export function matchRustFormatPattern(
  featureStep: string,
  definitionPattern: string,
): Record<string, string> | null {
  const { regex } = compileRustFormatPattern(definitionPattern);
  const m = featureStep.match(regex);
  if (!m) {
    return null;
  }
  // Upstream strips surrounding quotes for :string captures.
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
