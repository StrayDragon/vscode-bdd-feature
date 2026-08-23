/**
 * Pure-text scanner for rstest-bdd constructs in Rust source.
 *
 * Step definitions:
 *   #[given("配置了 mock 模型 {name:string}")]
 *   #[when(r#"raw "quoted" pattern"#)]
 *   pub(crate) fn _g_mock(...) { ... }
 *
 * Scenario bindings:
 *   #[scenario(path = "llmanspec/specs/x.feature", name = "session-start")]
 *   async fn test_hooks_wiring_session_start(agent: AgentState) {}
 */

import type { StepMatcherKind, StepType } from '../model';

export interface ExtractedRustStepDef {
  type: StepType;
  /** Pattern text inside the attribute string literal */
  text: string;
  matcherKind: StepMatcherKind;
  decoratorLine: number;
  functionLine?: number;
  functionName?: string;
  /** Inner span of the pattern string (inside quotes). */
  patternSelection?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

export interface ExtractedRustScenarioBinding {
  /** path= value as written */
  featureArg: string;
  name: string;
  attributeLine: number;
  fnName?: string;
}

/**
 * Scan a Rust string or raw-string literal starting at `start`.
 * Supports `r"…"`, `r#"…"#`, `r##"…"##`, and normal `"…"` with escapes.
 */
function scanRustString(
  text: string,
  start: number,
): { end: number; content: string; contentStart: number; raw: boolean } | undefined {
  let i = start;
  let hashes = 0;
  let raw = false;

  if (text[i] === 'r') {
    raw = true;
    i++;
    while (text[i] === '#') {
      hashes++;
      i++;
    }
    if (text[i] !== '"') {
      return undefined;
    }
  } else if (text[i] !== '"') {
    return undefined;
  } else {
    i++;
  }

  const terminator = raw ? '"' + '#'.repeat(hashes) : '"';
  const from = i;
  while (i < text.length) {
    if (!raw && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(terminator, i)) {
      return {
        end: i + terminator.length,
        content: text.slice(from, i),
        contentStart: from,
        raw,
      };
    }
    i++;
  }
  return undefined;
}

const ATTR_KEYWORDS = ['given', 'when', 'then'] as const;

/** Find all rstest-bdd step attributes and their following functions. */
export function extractRustStepDefs(source: string): ExtractedRustStepDef[] {
  const lines = source.split(/\r?\n/);
  const defs: ExtractedRustStepDef[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Attribute must start the trimmed line: #[given("...")] (may span lines)
    for (const kw of ATTR_KEYWORDS) {
      const re = new RegExp(`^\\s*#\\s*\\[\\s*${kw}\\s*\\(`);
      if (!re.test(lines[i])) {
        continue;
      }

      // Join logical attribute text (string-aware brace/paren tracking is
      // unnecessary here: the single argument is a string literal).
      let joined = '';
      let endLine = i;
      let strInfo: ReturnType<typeof scanJoinedString> = undefined;
      for (let j = i; j < Math.min(lines.length, i + 10); j++) {
        joined += lines[j] + '\n';
        strInfo = scanJoinedString(joined);
        if (strInfo) {
          endLine = j;
          break;
        }
      }

      const fn = findRustFnAfter(lines, endLine);
      if (strInfo) {
        const selection = strInfo.selection
          ? {
              ...strInfo.selection,
              // selection lines are relative to the joined text starting at i
              startLine: strInfo.selection.startLine + i,
              endLine: strInfo.selection.endLine + i,
            }
          : undefined;
        defs.push({
          type: kw,
          text: strInfo.content,
          matcherKind: 'parse', // rstest-bdd format placeholders
          decoratorLine: i,
          functionLine: fn?.line ?? endLine + 1,
          functionName: fn?.name,
          patternSelection: selection,
        });
      }
      break; // one keyword per line
    }
  }

  return defs;
}

/** Extract the first string literal inside a joined `#[kw("...")]` body. */
function scanJoinedString(
  joined: string,
): { content: string; selection?: ExtractedRustStepDef['patternSelection'] } | undefined {
  const open = joined.indexOf('(');
  if (open === -1) {
    return undefined;
  }
  // Skip whitespace between '(' and the string literal
  let i = open + 1;
  while (i < joined.length && /\s/.test(joined[i])) {
    i++;
  }
  const s = scanRustString(joined, i);
  if (!s) {
    return undefined;
  }
  // Map absolute offsets in `joined` back to (line, col).
  const before = joined.slice(0, s.contentStart);
  const startLine = before.split('\n').length - 1;
  const lastNl = before.lastIndexOf('\n');
  const startCol = s.contentStart - (lastNl + 1);
  return {
    content: s.raw ? s.content : s.content.replace(/\\"/g, '"'),
    selection: {
      startLine,
      startCol,
      endLine: startLine,
      endCol: startCol + s.content.length,
    },
  };
}

function findRustFnAfter(
  lines: string[],
  fromLine: number,
): { line: number; name?: string } | undefined {
  const limit = Math.min(lines.length, fromLine + 10);
  for (let i = fromLine + 1; i < limit; i++) {
    const m = /^\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/.exec(lines[i]);
    if (m) {
      return { line: i, name: m[1] };
    }
  }
  return undefined;
}

const SCENARIO_ATTR_RE =
  /#\s*\[\s*scenario\s*\(([\s\S]*?)\)\s*\]\s*(?:pub(?:\(crate\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g;

/** Find all #[scenario(path = "...", name = "...")] bindings. */
export function extractRustScenarioBindings(source: string): ExtractedRustScenarioBinding[] {
  const results: ExtractedRustScenarioBinding[] = [];
  let m: RegExpExecArray | null;
  while ((m = SCENARIO_ATTR_RE.exec(source)) !== null) {
    const argsText = m[1];
    const line = source.slice(0, m.index).split('\n').length - 1;
    const pathM = /path\s*=\s*r?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(argsText);
    const nameM = /name\s*=\s*r?(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(argsText);
    if (!pathM) {
      continue;
    }
    results.push({
      featureArg: pathM[1] ?? pathM[2] ?? '',
      name: nameM?.[1] ?? nameM?.[2] ?? '',
      attributeLine: line,
      fnName: m[2],
    });
  }
  return results;
}
