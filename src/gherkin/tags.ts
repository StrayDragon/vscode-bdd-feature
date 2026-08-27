/**
 * Gherkin tag engine: parsing, inheritance and Cucumber tag expressions.
 *
 * Pure module — no `vscode` import — so everything here is unit-testable
 * and reusable from any provider.
 *
 * Parsing follows the Gherkin spec:
 *   - Tags may be declared above Feature / Rule / Scenario / Scenario Outline
 *     / Examples (never above Background or steps).
 *   - A tag block is one or more consecutive `@tag …` lines immediately
 *     preceding a structural header. Any other non-blank, non-comment line
 *     dissolves a pending block (misplaced tags are ignored, like cucumber).
 *   - Tags inherit downward: Feature → Rule/Scenario/Examples,
 *     Rule → Scenario/Examples, Scenario Outline → Examples.
 *
 * One deliberate extension for *filtering* UX: an outline's effective tags
 * also union its Examples blocks' own tags (`@desktop` on an Examples set
 * selects the whole outline in filters). Native runners still apply
 * row-level precision themselves when actually executing.
 */

import { matchStructuralHeader } from './index';

// ── Model ──

export type TagNodeKind = 'feature' | 'rule' | 'scenario' | 'examples';

/** A single `@tag` occurrence with its exact position (for hover/diagnostics). */
export interface TagSpan {
  /** Includes the leading `@` */
  tag: string;
  /** 0-based line of the tag line */
  line: number;
  startCol: number;
  endCol: number;
}

export interface TagProblem {
  range: { startLine: number; startCol: number; endLine: number; endCol: number };
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: 'invalidTag' | 'duplicateTag' | 'misplacedTag';
}

/** One structural element carrying tags. Flat list, document order. */
export interface TaggedNode {
  kind: TagNodeKind;
  title?: string;
  /** Header keyword line (0-based) */
  line: number;
  own: TagSpan[];
  /**
   * Deduped union: ancestors' inherited tags ∪ own (∪ examples' own when
   * this node is a Scenario Outline — see module docstring).
   */
  effective: string[];
}

export interface ParsedFeatureTags {
  featureName?: string;
  featureLine?: number;
  nodes: TaggedNode[];
  scenarios: TaggedNode[];
  problems: TagProblem[];
}

// ── Tokenizing one tag line ──

const TAG_TOKEN_RE = /\S+/g;

/**
 * Validate one tag token. Cucumber accepts most non-whitespace text; we only
 * hard-reject empty / `@@`-prefixed tokens, and softly flag characters that
 * break downstream tooling (pytest markers, CLI flags).
 */
function classifyTagToken(
  token: string,
  line: number,
  startCol: number,
  problems: TagProblem[],
): string | undefined {
  const body = token.slice(1);
  if (!body || body.startsWith('@')) {
    problems.push({
      range: spanRangeOf(startCol, token.length, line),
      severity: 'error',
      message: `Invalid tag "${token}": expected "@" followed by a name`,
      code: 'invalidTag',
    });
    return undefined;
  }
  if (/[^A-Za-z0-9_.\-/:]/.test(body)) {
    problems.push({
      range: spanRangeOf(startCol, token.length, line),
      severity: 'info',
      message: `Tag "${token}" contains characters outside [A-Za-z0-9_.-/:] — some runners (pytest markers) may not accept it`,
      code: 'invalidTag',
    });
  }
  return token;
}

function spanRangeOf(startCol: number, length: number, line: number): TagProblem['range'] {
  return { startLine: line, startCol, endLine: line, endCol: startCol + length };
}

/** Split a tag line into validated TagSpans (invalid tokens reported, skipped). */
function tokenizeTagLine(line: string, lineNo: number, problems: TagProblem[]): TagSpan[] {
  const spans: TagSpan[] = [];
  TAG_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_TOKEN_RE.exec(line)) !== null) {
    const token = m[0];
    const startCol = m.index;
    if (!token.startsWith('@')) {
      continue; // trailing description after tags — tolerated like gherkin
    }
    const tag = classifyTagToken(token, lineNo, startCol, problems);
    if (tag) {
      spans.push({ tag, line: lineNo, startCol, endCol: startCol + token.length });
    }
  }
  return spans;
}

// ── Document scan ──

/**
 * Parse every tag in a feature document with a single pass over the lines.
 * Hot-path notes: one cheap charCode reject before any regex work, and all
 * structural matching goes through module-cached precompiled alternations,
 * so scanning thousands of files costs O(lines) with near-zero allocation
 * beyond the parsed output itself.
 */
export function parseFeatureTags(lines: readonly string[]): ParsedFeatureTags {
  const problems: TagProblem[] = [];
  const result: ParsedFeatureTags = { nodes: [], scenarios: [], problems };

  // Inheritance context
  let featureEff: string[] = [];
  let ruleTagNames: string[] = [];
  let outlineIdx = -1; // index into result.nodes of the enclosing Scenario Outline
  let pending: TagSpan[] = [];

  const reportDuplicates = (own: readonly TagSpan[]): void => {
    const firstSeen = new Map<string, TagSpan>();
    for (const span of own) {
      const first = firstSeen.get(span.tag);
      if (first) {
        problems.push({
          range: { ...spanRangeOf(span.startCol, span.endCol - span.startCol, span.line) },
          severity: 'warning',
          message: `Duplicate tag "${span.tag}" on the same element (first at line ${first.line + 1})`,
          code: 'duplicateTag',
        });
      } else {
        firstSeen.set(span.tag, span);
      }
    }
  };

  const effectiveOf = (own: readonly TagSpan[], inherited: readonly string[]): string[] => {
    reportDuplicates(own);
    const eff = [...inherited];
    const seen = new Set(inherited);
    for (const s of own) {
      if (!seen.has(s.tag)) {
        seen.add(s.tag);
        eff.push(s.tag);
      }
    }
    return eff;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmedStart = raw.trimStart();
    if (trimmedStart.length === 0) {
      continue;
    }

    switch (trimmedStart.charCodeAt(0)) {
      case 64: {
        // '@' — tag line extends the pending block
        const spans = tokenizeTagLine(raw, i, problems);
        pending.push(...spans);
        continue;
      }
      case 35:
        // '#' comment — never dissolves a pending tag block
        continue;
      default:
        break;
    }

    // Structural headers — single precompiled-regex test each, longest-first.
    const featureM = matchStructuralHeader(raw, 'feature');
    if (featureM) {
      const own = pending;
      pending = [];
      featureEff = effectiveOf(own, []);
      ruleTagNames = [];
      outlineIdx = -1;
      result.nodes.push({
        kind: 'feature',
        title: featureM.title || undefined,
        line: i,
        own,
        effective: featureEff,
      });
      result.featureName = featureM.title || undefined;
      result.featureLine = i;
      continue;
    }

    const ruleM = matchStructuralHeader(raw, 'rule');
    if (ruleM) {
      const own = pending;
      pending = [];
      ruleTagNames = own.map(s => s.tag);
      outlineIdx = -1;
      result.nodes.push({
        kind: 'rule',
        title: ruleM.title || undefined,
        line: i,
        own,
        effective: uniqMerge(featureEff, ruleTagNames),
      });
      continue;
    }

    const bgM = matchStructuralHeader(raw, 'background');
    if (bgM) {
      if (pending.length > 0) {
        const first = pending[0];
        problems.push({
          range: { ...spanRangeOf(first.startCol, first.endCol - first.startCol, first.line) },
          severity: 'error',
          message: 'Tags are not allowed on Background',
          code: 'misplacedTag',
        });
      }
      pending = [];
      outlineIdx = -1;
      continue;
    }

    // Try outline FIRST — its keywords are supersets-in-conflict with none,
    // but trying outline first lets us know the role without re-checking.
    const outlineM = matchStructuralHeader(raw, 'scenarioOutline');
    const scenM = outlineM ?? matchStructuralHeader(raw, 'scenario');
    if (scenM) {
      const own = pending;
      pending = [];
      const inherited = uniqMerge(featureEff, ruleTagNames);
      const eff = effectiveOf(own, inherited);
      const node: TaggedNode = {
        kind: 'scenario',
        title: scenM.title || undefined,
        line: i,
        own,
        effective: eff,
      };
      result.nodes.push(node);
      result.scenarios.push(node);
      outlineIdx = outlineM ? result.nodes.length - 1 : -1;
      continue;
    }

    const exM = matchStructuralHeader(raw, 'examples');
    if (exM) {
      const own = pending;
      pending = [];
      const parent = outlineIdx >= 0 ? result.nodes[outlineIdx] : undefined;
      const inherited = uniqMerge(
        featureEff,
        ruleTagNames,
        parent?.own.map(s => s.tag),
      );
      const eff = effectiveOf(own, inherited);
      result.nodes.push({
        kind: 'examples',
        title: exM.title || undefined,
        line: i,
        own,
        effective: eff,
      });
      // Filter-oriented union: examples-level tags select their whole outline.
      if (parent) {
        const effSeen = new Set(parent.effective);
        for (const t of eff) {
          if (!effSeen.has(t)) {
            effSeen.add(t);
            parent.effective.push(t);
          }
        }
      }
      continue;
    }

    // Steps / tables / docstrings / descriptions end a pending tag block —
    // those tags belong to nothing (same as cucumber's parser behavior).
    if (pending.length > 0) {
      pending = [];
    }
  }

  return result;
}

function uniqMerge(...lists: Array<string[] | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const t of list) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
}

// ── Tag expressions (Cucumber infix boolean syntax) ──

export class TagExpressionError extends Error {
  constructor(
    message: string,
    /** 1-based position in the expression string, when known */
    readonly position?: number,
  ) {
    super(message);
  }
}

type ExprNode =
  | { op: 'tag'; tag: string }
  | { op: 'not'; child: ExprNode }
  | { op: 'and'; children: ExprNode[] }
  | { op: 'or'; children: ExprNode[] };

interface Token {
  kind: 'tag' | 'and' | 'or' | 'not' | '(' | ')';
  text: string;
  pos: number; // 0-based char offset
}

const EXPR_TOKEN_RE = /@[^\s()]+|[^\s()]+|\(|\)/y;

function tokenizeExpression(input: string): Token[] {
  const tokens: Token[] = [];
  // Spec quirk: a FAILED exec on a sticky regex resets lastIndex to 0.
  // Drive the position ourselves and set lastIndex explicitly per attempt.
  let pos = 0;
  while (pos < input.length) {
    EXPR_TOKEN_RE.lastIndex = pos;
    const m = EXPR_TOKEN_RE.exec(input);
    if (!m) {
      pos++;
      continue; // whitespace etc.
    }
    pos = m.index + m[0].length;
    const text = m[0];
    const lower = text.toLowerCase();
    if (text === '(') {
      tokens.push({ kind: '(', text, pos: m.index });
    } else if (text === ')') {
      tokens.push({ kind: ')', text, pos: m.index });
    } else if (lower === 'and') {
      tokens.push({ kind: 'and', text, pos: m.index });
    } else if (lower === 'or') {
      tokens.push({ kind: 'or', text, pos: m.index });
    } else if (lower === 'not') {
      tokens.push({ kind: 'not', text, pos: m.index });
    } else {
      tokens.push({ kind: 'tag', text, pos: m.index });
    }
  }
  return tokens;
}

/**
 * Normalize an atom to canonical `@name` form. Accepts bare names and the
 * legacy `~` negation prefix (`~@fast`, `~fast`).
 */
function normalizeAtom(text: string): { tag: string; negated: boolean } {
  let t = text;
  let negated = false;
  while (t.startsWith('~')) {
    negated = !negated;
    t = t.slice(1);
  }
  return { tag: t.startsWith('@') ? t : `@${t}`, negated };
}

class ExprParser {
  private idx = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    const node = this.parseOr();
    const next = this.tokens[this.idx];
    if (next) {
      throw new TagExpressionError(
        next.kind === ')' ? 'Unexpected ")"' : `Unexpected "${next.text}"`,
        next.pos + 1,
      );
    }
    return node;
  }

  private parseOr(): ExprNode {
    const children = [this.parseAnd()];
    while (this.peek()?.kind === 'or') {
      this.idx++;
      children.push(this.parseAnd());
    }
    return children.length === 1 ? children[0] : { op: 'or', children };
  }

  private parseAnd(): ExprNode {
    const children = [this.parseNot()];
    for (;;) {
      const kind = this.peek()?.kind;
      if (kind === 'and') {
        this.idx++;
        children.push(this.parseNot());
      } else if (kind === 'tag' || kind === 'not' || kind === '(') {
        // Lenient extension: adjacent terms imply conjunction
        // (`@smoke @critical` ≡ `@smoke and @critical`, keeping the legacy
        // `~@draft` style usable without explicit operators).
        children.push(this.parseNot());
      } else {
        break;
      }
    }
    return children.length === 1 ? children[0] : { op: 'and', children };
  }

  private parseNot(): ExprNode {
    if (this.peek()?.kind === 'not') {
      this.idx++;
      return { op: 'not', child: this.parseNot() };
    }
    return this.parseAtom();
  }

  private parseAtom(): ExprNode {
    const tok = this.peek();
    if (!tok) {
      throw new TagExpressionError('Unexpected end of expression');
    }
    if (tok.kind === '(') {
      this.idx++;
      const inner = this.parseOr();
      const close = this.peek();
      if (close?.kind !== ')') {
        throw new TagExpressionError('Missing closing ")"', close ? close.pos + 1 : undefined);
      }
      this.idx++;
      return inner;
    }
    if (tok.kind === ')') {
      throw new TagExpressionError('Unexpected ")"', tok.pos + 1);
    }
    if (tok.kind === 'tag') {
      this.idx++;
      const { tag, negated } = normalizeAtom(tok.text);
      const leaf: ExprNode = { op: 'tag', tag };
      return negated ? { op: 'not', child: leaf } : leaf;
    }
    throw new TagExpressionError(`Expected a tag but found "${tok.text}"`, tok.pos + 1);
  }

  private peek(): Token | undefined {
    return this.tokens[this.idx];
  }
}

export type TagPredicate = (tags: ReadonlySet<string>) => boolean;

/**
 * Compile a Cucumber tag expression (`@a and not @b`, `(x or y) and not z`,
 * legacy `~@a`) into a reusable predicate. Operator precedence follows
 * cucumber: `not` > `and` > `or`; parentheses override; operators are
 * case-insensitive. As a lenient extension, adjacent terms imply
 * conjunction (`@smoke @critical` ≡ `@smoke and @critical`). Throws
 * {@link TagExpressionError} with a user-facing message on syntax errors.
 */
export function compileTagExpression(expression: string): TagPredicate {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new TagExpressionError('Tag expression is empty');
  }
  const root = new ExprParser(tokenizeExpression(trimmed)).parse();
  const evalNode = (node: ExprNode, tags: ReadonlySet<string>): boolean => {
    switch (node.op) {
      case 'tag':
        return tags.has(node.tag);
      case 'not':
        return !evalNode(node.child, tags);
      case 'and':
        return node.children.every(c => evalNode(c, tags));
      case 'or':
        return node.children.some(c => evalNode(c, tags));
    }
  };
  return tags => evalNode(root, tags);
}

// ── Runner-native filter translation ──

/**
 * Render an expression as a pytest `-m` marker expression.
 * pytest-bdd converts Gherkin tags to pytest marks verbatim minus `@`
 * (`@smoke and not @slow` → `smoke and not slow`). Throws
 * {@link TagExpressionError} for atoms pytest identifiers cannot carry —
 * callers should fall back to scenario selection in that case.
 */
export function tagExprToPytestMarker(expression: string): string {
  const out: string[] = [];
  for (const t of tokenizeExpression(expression.trim())) {
    switch (t.kind) {
      case 'and':
      case 'or':
      case 'not':
      case '(':
      case ')':
        out.push(t.kind);
        break;
      case 'tag': {
        const { tag, negated } = normalizeAtom(t.text);
        const name = tag.slice(1);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          throw new TagExpressionError(
            `"${t.text}" cannot be used as a pytest marker name`,
          );
        }
        out.push(negated ? `not ${name}` : name);
        break;
      }
    }
  }
  return out.join(' ');
}

/**
 * Translate an expression into a JavaScript regex source usable with
 * playwright's `--grep` (matched against test titles, where playwright-bdd
 * appends space-separated tags). Fully general: `not` is lowered to tag
 * level via De Morgan, `and` concatenates zero-width lookarounds, `or`
 * becomes alternation. Throws {@link TagExpressionError} on syntax errors
 * or over-complex results.
 */
export function tagExprToPlaywrightGrep(expression: string): string {
  const trimmed = expression.trim();
  if (!trimmed) {
    throw new TagExpressionError('Tag expression is empty');
  }
  const root = new ExprParser(tokenizeExpression(trimmed)).parse();

  /** Zero-width clause asserting the title contains ` @tag ` bounded. */
  const containsTag = (tag: string): string =>
    `(?=[\\s\\S]*(?:^|\\s)${escapeRe(tag)}(?:\\s|$))`;
  const notContainsTag = (tag: string): string =>
    `(?![\\s\\S]*(?:^|\\s)${escapeRe(tag)}(?:\\s|$))`;

  const render = (node: ExprNode): string => {
    switch (node.op) {
      case 'tag':
        return containsTag(node.tag);
      case 'and':
        return node.children.map(render).join('');
      case 'or':
        return `(?:${node.children.map(render).join('|')})`;
      case 'not': {
        switch (node.child.op) {
          case 'tag':
            return notContainsTag(node.child.tag);
          case 'not':
            return render(node.child.child);
          case 'and': // !(a∧b…) = ¬a∨¬b…
            return render({
              op: 'or',
              children: node.child.children.map(c => ({ op: 'not', child: c })),
            });
          case 'or': // !(a∨b…) = ¬a∧¬b…
            return render({
              op: 'and',
              children: node.child.children.map(c => ({ op: 'not', child: c })),
            });
        }
      }
    }
  };

  const src = render(root);
  if (src.length > 8000) {
    throw new TagExpressionError('Expression too complex for --grep translation');
  }
  return src;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
