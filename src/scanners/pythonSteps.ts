/**
 * Pure-text scanner for pytest-bdd step definitions in Python source.
 *
 * Handles:
 *   @given("text")                          — exact match
 *   @given(parsers.parse("fmt {x:d}"))      — parse/cfparse pattern
 *   @when(parsers.re(r"regex (?P<g>\d+)"))  — regex pattern
 *   multi-line decorators with string-aware paren tracking
 *   string prefixes (r/b/f/u), escapes, single/double quotes, triple quotes
 */

import type { StepMatcherKind, StepType } from '../model';

export interface ExtractedPythonStepDef {
  type: StepType;
  /** The step text/pattern inside the decorator */
  text: string;
  matcherKind: StepMatcherKind;
  /** 0-based line of the decorator start */
  decoratorLine: number;
  /** 0-based line of the `def` under the decorator */
  functionLine: number;
  functionName?: string;
  /** Inner span of the pattern string (inside quotes). */
  patternSelection?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

/** Scan a string literal whose opening quote is at `start`. */
function scanStringLiteral(
  text: string,
  start: number,
): { end: number; content: string; quote: string; contentStart: number } | undefined {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  // Triple-quoted?
  if (text.slice(start, start + 3) === quote.repeat(3)) {
    const endIdx = text.indexOf(quote.repeat(3), start + 3);
    if (endIdx === -1) {
      return undefined;
    }
    return {
      end: endIdx + 3,
      content: text.slice(start + 3, endIdx),
      quote,
      contentStart: start + 3,
    };
  }
  let i = start + 1;
  let content = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      content += ch + (next ?? '');
      i += next !== undefined ? 2 : 1;
      continue;
    }
    if (ch === quote || ch === '\n') {
      return ch === quote
        ? { end: i + 1, content, quote, contentStart: start + 1 }
        : undefined;
    }
    content += ch;
    i++;
  }
  return undefined;
}

/**
 * Walk one physical line from index `k`, appending literal/segment info to
 * `segments`, updating paren depth. String contents are captured verbatim.
 */
function walkLine(
  line: string,
  k: number,
  segments: Array<{ kind: 'char'; value: string }>,
  depthRef: { depth: number },
  lineNo: number,
  literals: Array<{ startLine: number; startCol: number; endLine: number; endCol: number }>,
): { closed: boolean; stop: boolean } {
  while (k < line.length) {
    const ch = line[k];
    if (ch === '#' && depthRef.depth === 0) {
      return { closed: false, stop: true }; // comment outside parens ends logical line
    }
    if (ch === '"' || ch === "'") {
      const s = scanStringLiteral(line, k);
      if (!s) {
        // unterminated on this physical line — treat rest as raw chars
        segments.push({ kind: 'char', value: ch });
        k++;
        continue;
      }
      literals.push({
        startLine: lineNo,
        startCol: s.contentStart,
        endLine: lineNo,
        endCol: s.contentStart + s.content.length,
      });
      segments.push({ kind: 'char', value: line.slice(k, k + (s.end - k)) });
      k = s.end;
      continue;
    }
    if (ch === '(') {
      depthRef.depth++;
    } else if (ch === ')') {
      depthRef.depth--;
      segments.push({ kind: 'char', value: ch });
      k++;
      if (depthRef.depth <= 0) {
        return { closed: true, stop: false };
      }
      continue;
    }
    segments.push({ kind: 'char', value: ch });
    k++;
  }
  return { closed: false, stop: false };
}

interface FoundDecorator {
  type: StepType;
  /** Logical decorator text (physical lines joined by space). */
  fullText: string;
  startLine: number;
  endLine: number;
  /** Inner spans of string literals encountered (inside the quotes). */
  literals: Array<{ startLine: number; startCol: number; endLine: number; endCol: number }>;
}

const DECORATOR_RE = /^@(given|when|then|step)\s*\(/;

/** Find all step decorators with string-aware multi-line joining. */
export function findDecorators(lines: string[]): FoundDecorator[] {
  const results: FoundDecorator[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = DECORATOR_RE.exec(lines[i].trimStart());
    if (!m) {
      continue;
    }

    const depthRef = { depth: 0 };
    const segments: Array<{ kind: 'char'; value: string }> = [];
    const literals: FoundDecorator['literals'] = [];
    let j = i;
    let closed = false;

    for (; j < Math.min(lines.length, i + 20); j++) {
      const lineStart = j === i ? lines[j].indexOf('@') : 0;
      const res = walkLine(lines[j], lineStart, segments, depthRef, j, literals);
      if (res.closed) {
        closed = true;
        j++;
        break;
      }
      if (res.stop) {
        break;
      }
    }

    if (closed) {
      results.push({
        type: m[1] as StepType,
        fullText: segments.map(s => s.value).join(''),
        startLine: i,
        endLine: j - 1,
        literals,
      });
    }
  }

  return results;
}

/**
 * Match `<parserFn>( "pattern" )` inside the joined decorator body,
 * where parserFn ∈ parse|cfparse|re (with optional `parsers.` prefix).
 */
const PARSER_ARG_RE =
  /(?:parsers\.)?(parse|cfparse|re)\s*\(\s*([rbfuRBFU]{0,2})("""|'''|"|')((?:\\.|(?!\3)[\s\S])*?)\3/;

const BARE_STRING_RE =
  /^\s*@\w+\s*\(\s*[rbfuRBFU]{0,2}("""|'''|"|')((?:\\.|(?!\1)[\s\S])*?)\1\s*\)/;

function findFunctionAfter(
  lines: string[],
  fromLine: number,
): { line: number; name?: string } | undefined {
  const limit = Math.min(lines.length, fromLine + 10);
  for (let i = fromLine + 1; i < limit; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed) {
      continue;
    }
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(trimmed);
    if (m) {
      return { line: i, name: m[1] };
    }
    if (!trimmed.startsWith('@')) {
      break; // plain code before any def
    }
  }
  return undefined;
}

/** Decode common Python escapes in non-raw strings. */
function unescapePy(s: string): string {
  return s.replace(/\\(['"\\nrt])/g, (_all, c: string) => {
    switch (c) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return c;
    }
  });
}

/** Extract all pytest-bdd step definitions from Python source text. */
export function extractPythonStepDefs(source: string): ExtractedPythonStepDef[] {
  const lines = source.split(/\r?\n/);
  const defs: ExtractedPythonStepDef[] = [];

  for (const dec of findDecorators(lines)) {
    const body = dec.fullText.replace(/\n/g, ' ');
    const fnInfo = findFunctionAfter(lines, dec.endLine);
    // First literal = the pattern argument (typical decorators carry one).
    const lit = dec.literals[0];

    const parserMatch = PARSER_ARG_RE.exec(body);
    if (parserMatch) {
      const parserFn = parserMatch[1];
      const isRaw = parserMatch[2].toLowerCase().includes('r');
      const content = parserMatch[4];
      const matcherKind: StepMatcherKind =
        parserFn === 're' ? 're' : parserFn === 'cfparse' ? 'cfparse' : 'parse';
      defs.push({
        type: dec.type,
        text: isRaw ? content : unescapePy(content),
        matcherKind,
        decoratorLine: dec.startLine,
        functionLine: fnInfo?.line ?? dec.endLine + 1,
        functionName: fnInfo?.name,
        patternSelection: lit
          ? { startLine: lit.startLine, startCol: lit.startCol, endLine: lit.endLine, endCol: lit.endCol }
          : undefined,
      });
      continue;
    }

    const bareMatch = BARE_STRING_RE.exec(body);
    if (bareMatch) {
      const prefix = body.slice(body.indexOf('('), body.search(/["']/));
      const isRaw = /r/i.test(prefix);
      const content = bareMatch[2];
      defs.push({
        type: dec.type,
        text: isRaw ? content : unescapePy(content),
        matcherKind: 'exact',
        decoratorLine: dec.startLine,
        functionLine: fnInfo?.line ?? dec.endLine + 1,
        functionName: fnInfo?.name,
        patternSelection: lit
          ? { startLine: lit.startLine, startCol: lit.startCol, endLine: lit.endLine, endCol: lit.endCol }
          : undefined,
      });
    }
  }

  return defs;
}

export interface PythonScenarioBinding {
  /** Feature path argument exactly as written in source */
  featureArg: string;
  /** For scenario(): explicit scenario name (undefined for scenarios()) */
  scenarioName?: string;
  line: number;
}

/**
 * Find `scenarios("a.feature", "b.feature", ...)` calls.
 * Returns one binding per feature path argument.
 */
export function extractPythonScenariosBindings(source: string): PythonScenarioBinding[] {
  const bindings: PythonScenarioBinding[] = [];
  const callRe = /(^|[^\w.])scenarios\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const argsText = m[2];
    const line = source.slice(0, m.index).split('\n').length - 1;
    const argRe = /([rbfuRBFU]{0,2})("""|'''|"|')((?:\\.|(?!\2)[\s\S])*?)\2/g;
    let a: RegExpExecArray | null;
    while ((a = argRe.exec(argsText)) !== null) {
      bindings.push({ featureArg: a[3], line });
    }
  }
  return bindings;
}

/** Find single `scenario("f.feature", "scenario name")` calls. */
export function extractPythonScenarioBinding(source: string): PythonScenarioBinding[] {
  const bindings: PythonScenarioBinding[] = [];
  const re = /(^|[^\w.])scenario\s*\(\s*(["'])((?:\\.|(?!\2)[\s\S])*?)\2\s*,\s*(["'])((?:\\.|(?!\4)[\s\S])*?)\4/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length - 1;
    bindings.push({ featureArg: m[3], scenarioName: m[5], line });
  }
  return bindings;
}
