/**
 * pytest-bdd format pattern → RegExp converter.
 *
 * Converts Python `parse` library style format strings to ES2018 RegExp
 * with named capture groups. Supports Chinese and English text.
 *
 * Supported format specifiers (from pytest-bdd / Python `parse`):
 *   {name}        → (?<name>\S+)          — any non-whitespace
 *   {name:d}      → (?<name>\d+)          — integer
 *   {name:f}      → (?<name>[\d.]+)       — float
 *   {name:s}      → (?<name>\S+)          — string (same as default)
 *   {name:5s}     → (?<name>.{1,5})       — max width string
 *   {name:.2f}    → (?<name>\d+\.\d{1,2}) — float with precision
 *   {}            → (?<_0>\S+)            — anonymous (positional)
 *   {{ / }}       → literal { / }         — escaped braces
 *
 * Example:
 *   "用户 {user_id:d} 订单 {order_type} header 专业为 {major}"
 *   → /^用户\s+(?<user_id>\d+)\s+订单\s+(?<order_type>\S+)\s+header\s+专业为\s+(?<major>\S+)$/u
 */

/** Parsed parameter info from a format string */
export interface PatternParam {
  /** Parameter name (or `_0`, `_1`... for anonymous) */
  name: string;
  /** Format type specifier (d, f, s, etc.) */
  type: string;
  /** Full format spec (e.g. `.2f`, `5s`) */
  spec: string;
  /** Position in the original pattern string */
  index: number;
}

/** Compiled pattern with regex and metadata */
export interface CompiledPattern {
  /** The compiled RegExp with named capture groups */
  regex: RegExp;
  /** Extracted parameter definitions */
  params: PatternParam[];
  /** Original format string */
  source: string;
}

// Cache for compiled patterns
const _cache = new Map<string, CompiledPattern>();

// Counter for anonymous parameters
let _anonCounter = 0;

/**
 * Compile a pytest-bdd format string into a RegExp.
 * Results are cached for performance.
 */
export function compilePattern(pattern: string): CompiledPattern {
  const cached = _cache.get(pattern);
  if (cached) {
    return cached;
  }

  const params: PatternParam[] = [];
  let regexSource = '';
  let i = 0;
  let anonIndex = 0;

  while (i < pattern.length) {
    // Handle escaped braces: {{ → literal {
    if (pattern[i] === '{' && pattern[i + 1] === '{') {
      regexSource += '\\{';
      i += 2;
      continue;
    }
    if (pattern[i] === '}' && pattern[i + 1] === '}') {
      regexSource += '\\}';
      i += 2;
      continue;
    }

    // Handle placeholder: {name} or {name:spec}
    if (pattern[i] === '{') {
      const closeIdx = pattern.indexOf('}', i);
      if (closeIdx === -1) {
        // Malformed, treat as literal
        regexSource += escapeRegex(pattern[i]);
        i++;
        continue;
      }

      const placeholder = pattern.slice(i + 1, closeIdx);
      let name: string;
      let spec = '';

      if (placeholder.includes(':')) {
        const colonIdx = placeholder.indexOf(':');
        name = placeholder.slice(0, colonIdx).trim();
        spec = placeholder.slice(colonIdx + 1).trim();
      } else {
        name = placeholder.trim();
      }

      // Anonymous parameter
      if (!name) {
        name = `_${anonIndex++}`;
      }

      const type = spec.replace(/[^a-zA-Z]/g, '') || 's';

      params.push({ name, type, spec, index: i });

      regexSource += `(?<${escapeGroupName(name)}>${specToRegex(spec, type)})`;
      i = closeIdx + 1;
      continue;
    }

    // Regular character — escape for regex
    regexSource += escapeRegex(pattern[i]);
    i++;
  }

  // Build final regex with flexible whitespace
  // Replace literal spaces with \s+ for flexible matching
  const flexibleSource = regexSource.replace(/ /g, '\\s+');

  const regex = new RegExp(`^${flexibleSource}$`, 'u');
  const compiled: CompiledPattern = { regex, params, source: pattern };
  _cache.set(pattern, compiled);
  return compiled;
}

/**
 * Match a feature step text against a compiled pattern.
 * Returns named groups if matched (empty object if no params), null otherwise.
 */
export function matchPattern(
  featureStep: string,
  definitionPattern: string,
): Record<string, string> | null {
  const { regex } = compilePattern(definitionPattern);
  const match = featureStep.trim().match(regex);
  if (!match) {
    return null;
  }
  return match.groups ?? {};
}

/**
 * Check if a feature step matches a definition pattern.
 */
export function patternMatches(
  featureStep: string,
  definitionPattern: string,
): boolean {
  return matchPattern(featureStep, definitionPattern) !== null;
}

/**
 * Extract parameter definitions from a format string without compiling.
 */
export function extractParams(pattern: string): PatternParam[] {
  return compilePattern(pattern).params;
}

/**
 * Convert a format spec to a regex pattern.
 */
function specToRegex(spec: string, type: string): string {
  // Parse width and precision from spec (e.g. ".2f", "5s", "d")
  const widthMatch = spec.match(/^(\d+)?(?:\.(\d+))?[a-zA-Z]?$/);
  const width = widthMatch?.[1] ? parseInt(widthMatch[1]) : undefined;
  const precision = widthMatch?.[2] ? parseInt(widthMatch[2]) : undefined;

  switch (type) {
    case 'd':
      // Integer: \d+ (with optional width)
      return width ? `\\d{1,${width}}` : '\\d+';
    case 'f':
      // Float: digits with optional decimal
      if (precision !== undefined) {
        return `\\d+\\.\\d{1,${precision}}`;
      }
      return '[\\d.]+';
    case 'e':
      // Scientific notation
      return '[\\d.eE+-]+';
    case 'b':
      // Binary
      return '0[bB][01]+';
    case 'o':
      // Octal
      return '0[oO][0-7]+';
    case 'x':
      // Hex
      return '0[xX][0-9a-fA-F]+';
    case 'n':
      // Number with thousands separator
      return '[\\d,]+';
    case '%':
      // Percentage
      return '[\\d.]+%';
    case 's':
    default:
      // String: non-whitespace (with optional width)
      if (width) {
        return `.{1,${width}}`;
      }
      return '\\S+';
  }
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape a string for use as a regex named capture group name.
 * ES2018 named groups require valid identifiers.
 */
function escapeGroupName(name: string): string {
  // Replace invalid identifier chars with underscore
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Clear the pattern cache (for testing).
 */
export function _clearCache(): void {
  _cache.clear();
  _anonCounter = 0;
}
