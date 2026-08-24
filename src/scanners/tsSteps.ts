/**
 * Pure-text scanner for TypeScript/JavaScript BDD step definitions.
 *
 * Supported shapes (cucumber-js, playwright-bdd, jest-cucumber):
 *
 *   // cucumber-js — string = Cucumber Expression
 *   Given('I have {int} cucumbers', function (count) { … });
 *   Then(/^total is (\d+)$/, { timeout: 5000 }, async (n) => { … });
 *
 *   // playwright-bdd — createBdd() destructuring, fixture-first callbacks
 *   export const { Given, When, Then } = createBdd(test);
 *   Given('I open page {string}', async ({ page }, url) => { … });
 *
 *   // playwright-bdd decorators on POM methods
 *   class Pages {
 *     @When('a item {string} exists')
 *     async addItem(item: string) {}
 *   }
 *
 *   // jest-cucumber feature-level binding
 *   defineFeature(loadFeature('./features/login.feature'), ({ Given }) => { … });
 *
 * Matching kinds produced:
 *   string/template-literal pattern → 'cexpr' (Cucumber Expression)
 *   /regex/ literal pattern         → 're'
 */

import type { StepMatcherKind, StepType } from '../model';

export interface ExtractedTsStepDef {
  type: StepType;
  /** Pattern text as written (expression body or regex source). */
  text: string;
  matcherKind: StepMatcherKind;
  /** 0-based line of the call/decorator start */
  decoratorLine: number;
  /** 0-based line of the implementation (best effort — often inline) */
  functionLine: number;
  functionName?: string;
  /** Inner span of the pattern (inside quotes/slashes). */
  patternSelection?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

export interface TsFeatureBinding {
  /** loadFeature() path exactly as written */
  featureArg: string;
  line: number;
}

/** Statement-position calls only — avoids strings/comments containing "Given(". */
const CALL_START_RE =
  /^[\s]*(@)?(Given|When|Then|And|But|Step|defineStep|DefineStep)\s*\(/;

/** Type keyword → canonical step type. And/But are not exported by frameworks; treat as generic. */
const TYPE_BY_NAME: Record<string, StepType> = {
  Given: 'given',
  When: 'when',
  Then: 'then',
  Step: 'step',
  defineStep: 'step',
  DefineStep: 'step',
};

/**
 * Join enough physical lines to cover the full call, then locate the first
 * argument. Returns the joined buffer plus offsets, or undefined when the
 * parentheses never balance within the window.
 */
function joinCall(
  lines: string[],
  startLine: number,
  openParenCol: number,
): { buf: string; argIdx: number } | undefined {
  let buf = '';
  let depth = 0;
  const max = Math.min(lines.length, startLine + 40);
  for (let j = startLine; j < max; j++) {
    const from = j === startLine ? openParenCol : 0;
    buf += lines[j].slice(from) + '\n';
    depth += countTopLevelParens(lines[j].slice(from));
    if (bufDepthAtEnd(buf) <= 0 && depth <= 0) {
      return { buf, argIdx: 0 };
    }
    if (depth <= 0 && j > startLine) {
      return { buf, argIdx: 0 };
    }
  }
  return undefined;
}

/**
 * Count paren delta on one physical chunk while skipping string/template/
 * regex/comment regions — cheap per-line pass; authoritative balance is
 * recomputed by bufDepthAtEnd over the whole buffer.
 */
function countTopLevelParens(chunk: string): number {
  let depth = 0;
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    if (ch === '/' && chunk[i + 1] === '/') {
      break; // line comment
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(chunk, i);
      continue;
    }
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    }
    i++;
  }
  return depth;
}

/** Recompute final depth over the accumulated buffer (handles multi-line strings safely). */
function bufDepthAtEnd(buf: string): number {
  return countTopLevelParens(buf);
}

/** Skip a string literal starting at quote index; returns index after the closing quote. */
function skipString(s: string, start: number): number {
  const quote = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === quote) {
      return i + 1;
    }
    // A single-quoted/double-quoted literal cannot contain a raw newline; if we
    // hit one the quote was likely an apostrophe in prose — bail out.
    if ((quote === '"' || quote === "'") && s[i] === '\n') {
      return i;
    }
    i++;
  }
  return i;
}

interface FirstArg {
  kind: 'cexpr' | 're';
  content: string;
  contentStart: number;
  contentEnd: number;
}

/**
 * Locate and decode the first argument of the call in `buf`
 * (argIdx is the offset just after the opening paren).
 */
function extractFirstArg(buf: string): FirstArg | undefined {
  let i = buf.indexOf('(');
  if (i === -1) {
    return undefined;
  }
  i++;
  while (i < buf.length && /\s/.test(buf[i])) {
    i++;
  }
  const ch = buf[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    const end = skipString(buf, i);
    if (end >= buf.length || buf[end - 1] !== ch) {
      return undefined;
    }
    const content = buf.slice(i + 1, end - 1);
    return { kind: 'cexpr', content, contentStart: i + 1, contentEnd: end - 1 };
  }
  if (ch === '/') {
    // Regex literal: honor escapes and character classes.
    let j = i + 1;
    let inClass = false;
    while (j < buf.length) {
      const c = buf[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '[') {
        inClass = true;
      } else if (c === ']') {
        inClass = false;
      } else if (c === '/' && !inClass) {
        return { kind: 're', content: buf.slice(i + 1, j), contentStart: i + 1, contentEnd: j };
      } else if (c === '\n') {
        return undefined;
      }
      j++;
    }
    return undefined;
  }
  return undefined;
}

/** Offset in the joined buffer → absolute [line, col] pair. */
function offsetToPos(buf: string, offset: number, baseLine: number, baseCol: number): {
  line: number;
  col: number;
} {
  const nlCount = (buf.slice(0, offset).match(/\n/g) ?? []).length;
  if (nlCount === 0) {
    return { line: baseLine, col: baseCol + offset };
  }
  const lastNl = buf.lastIndexOf('\n', offset - 1);
  return { line: baseLine + nlCount, col: offset - (lastNl + 1) };
}

/** Best-effort implementation linkage for inline arrow/function styles. */
function findImplementation(
  lines: string[],
  startLine: number,
  endLine: number,
  callText: string,
  isDecorator: boolean,
): { line: number; name?: string } {
  const fnInline = /\bfunction\b\s*([A-Za-z_$][\w$]*)?\s*\(/.exec(callText);
  if (fnInline?.[1]) {
    return { line: startLine, name: fnInline[1] };
  }
  const limit = Math.min(lines.length, endLine + 12);
  for (let i = isDecorator ? endLine : startLine; i < limit; i++) {
    const m =
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i]) ??
      /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:abstract\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/.exec(
        lines[i],
      );
    if (m) {
      return { line: i, name: m[1] };
    }
    if (!isDecorator && /=>/.test(lines[i])) {
      return { line: startLine };
    }
  }
  return { line: endLine };
}

/** Extract all TS/JS step definitions from source text. */
export function extractTsStepDefs(source: string): ExtractedTsStepDef[] {
  const lines = source.split(/\r?\n/);
  const defs: ExtractedTsStepDef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = CALL_START_RE.exec(lines[i]);
    if (!m) {
      continue;
    }
    const isDecorator = m[1] === '@';
    const typeName = m[2];
    const openParenCol = lines[i].indexOf('(');

    const joined = joinCall(lines, i, openParenCol);
    if (!joined) {
      continue;
    }

    const arg = extractFirstArg(joined.buf);
    if (!arg) {
      continue;
    }

    const startPos = offsetToPos(joined.buf, arg.contentStart, i, openParenCol);
    const endPos = offsetToPos(joined.buf, arg.contentEnd, i, openParenCol);
    const impl = findImplementation(lines, i, startPos.line, joined.buf, isDecorator);

    defs.push({
      type: TYPE_BY_NAME[typeName] ?? 'step',
      text: arg.content,
      matcherKind: arg.kind,
      decoratorLine: i,
      functionLine: impl.line,
      functionName: impl.name,
      patternSelection: {
        startLine: startPos.line,
        startCol: startPos.col,
        endLine: endPos.line,
        endCol: endPos.col,
      },
    });
  }

  return defs;
}

const DEFINE_FEATURE_RE =
  /(?:^|[^\w.])defineFeature\s*\(\s*loadFeature\s*\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g;

/** Find jest-cucumber `defineFeature(loadFeature("…"))` feature references. */
export function extractTsFeatureBindings(source: string): TsFeatureBinding[] {
  const out: Array<TsFeatureBinding> = [];
  let m: RegExpExecArray | null;
  DEFINE_FEATURE_RE.lastIndex = 0;
  while ((m = DEFINE_FEATURE_RE.exec(source)) !== null) {
    const line = source.slice(0, m.index).split('\n').length - 1;
    out.push({ featureArg: m[2], line });
  }
  return out;
}
