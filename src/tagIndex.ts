import * as vscode from 'vscode';
import {
  parseFeatureTags,
  compileTagExpression,
  type TagPredicate,
  type ParsedFeatureTags,
  type TagProblem,
} from './gherkin/tags';
import { readFileText } from './utils';

/**
 * Workspace-wide index of Gherkin tags across every .feature file.
 *
 * Performance contract (designed to stay invisible on huge repos):
 *  - Files are read with `workspace.fs.readFile`, NOT openTextDocument —
 *    scanning never inflates VS Code's document cache / memory.
 *  - One shared in-flight build (`ensureTagIndex`), mirroring steps/bindings.
 *  - Saves & watcher events update ONE file incrementally instead of
 *    rescanning the workspace; bursts are coalesced and batch-capped.
 *  - Parsed state is compact plain data (strings + small arrays); no
 *    TextDocument/TextEditor references are retained.
 */

const EXCLUDE =
  '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__,.features-gen}/**';
const MAX_FILES = 3000;

export interface IndexedScenario {
  name: string;
  /** 0-based header line */
  line: number;
  /** Effective (inherited) tags incl. examples-level union */
  tags: string[];
}

export interface IndexedFile {
  uri: vscode.Uri;
  fsPath: string;
  /** workspace-relative posix path for display/sorting */
  relPath: string;
  dir: string;
  featureName?: string;
  featureLine?: number;
  featureTags: string[];
  scenarios: IndexedScenario[];
  /** union of all tags in the file — O(1) membership for filters */
  tagSet: Set<string>;
  problemCount: number;
  /**
   * Parsed tag problems — stored ONLY when non-empty (the overwhelmingly
   * common healthy-file case costs nothing), so diagnostics can reuse them
   * without re-parsing.
   */
  problems?: TagProblem[];
}

/** Aggregate stats for one known tag. */
export interface TagStat {
  tag: string;
  /** scenario occurrences (incl. inherited) */
  scenarios: number;
  files: number;
}

// ── State ──

const entries = new Map<string, IndexedFile>();
let buildPromise: Promise<void> | undefined;

// ── Change notification ──

type Listener = () => void;
const listeners = new Set<Listener>();
let notifyTimer: NodeJS.Timeout | undefined;

function notifySoon(): void {
  if (notifyTimer) {
    return; // already scheduled — coalesce
  }
  notifyTimer = setTimeout(() => {
    notifyTimer = undefined;
    for (const l of listeners) {
      l();
    }
  }, 300);
}

/** Subscribe to debounced index changes (tree views etc.). */
export function onTagIndexChange(listener: Listener): vscode.Disposable {
  listeners.add(listener);
  return new vscode.Disposable(() => listeners.delete(listener));
}

// ── Public API ──

/**
 * Shared, memoized full scan. The result is cached until an explicit
 * {@link resetTagIndex} / {@link rescanTagIndex} — incremental updates keep
 * it fresh in between. Callers may await this on every access; after the
 * first build it is a resolved promise.
 *
 * (Rebuilding per call here would create a feedback loop with the change
 * notification: scan → notify → view refresh → getChildren → scan …)
 */
export function ensureTagIndex(): Promise<void> {
  if (!buildPromise) {
    buildPromise = doFullScan();
  }
  return buildPromise;
}

/** Force a full rescan (manual refresh button). */
export function rescanTagIndex(): Promise<void> {
  resetTagIndex();
  return ensureTagIndex();
}

export function getIndexedFile(fsPath: string): IndexedFile | undefined {
  return entries.get(fsPath);
}

export function indexedFiles(): IterableIterator<IndexedFile> {
  return entries.values();
}

/**
 * All distinct tags with occurrence stats, sorted by count desc then name.
 * Cached and invalidated on every index mutation — completion calls this per
 * keystroke in tag context, so repeated aggregation over big workspaces is
 * avoided without any staleness risk.
 */
export function collectTagStats(): TagStat[] {
  if (statsCache) {
    return statsCache;
  }
  const perTag = new Map<string, TagStat>();
  for (const f of entries.values()) {
    const countedForFile = new Set<string>();
    for (const s of f.scenarios) {
      for (const t of s.tags) {
        let st = perTag.get(t);
        if (!st) {
          st = { tag: t, scenarios: 0, files: 0 };
          perTag.set(t, st);
        }
        st.scenarios++;
        if (!countedForFile.has(t)) {
          countedForFile.add(t);
        }
      }
    }
    // Feature-only tags still deserve an entry
    for (const t of f.tagSet) {
      if (!perTag.has(t)) {
        perTag.set(t, { tag: t, scenarios: 0, files: 0 });
      }
    }
    for (const t of countedForFile) {
      const st = perTag.get(t)!;
      st.files++;
    }
  }
  return [...perTag.values()].sort(
    (a, b) => b.scenarios - a.scenarios || b.files - a.files || a.tag.localeCompare(b.tag),
  );
}

let statsCache: TagStat[] | undefined;
function invalidateStatsCache(): void {
  statsCache = undefined;
}

export interface ScenarioMatch {
  file: IndexedFile;
  scenario: IndexedScenario;
}

/** Evaluate a compiled predicate against every scenario's effective tags. */
export function matchingScenarios(predicate: TagPredicate): ScenarioMatch[] {
  const out: ScenarioMatch[] = [];
  const set = new Set<string>();
  for (const f of entries.values()) {
    for (const s of f.scenarios) {
      set.clear();
      for (const t of s.tags) {
        set.add(t);
      }
      if (predicate(set)) {
        out.push({ file: f, scenario: s });
      }
    }
  }
  return out;
}

/** Re-parse a single file after save/change; fires a debounced notification. */
export async function updateIndexedFile(uri: vscode.Uri): Promise<void> {
  try {
    applyParsed(uri, parseFeatureTags((await readFileText(uri)).split(/\r?\n/)));
    notifySoon();
  } catch {
    removeIndexedFile(uri.fsPath);
  }
}

export function removeIndexedFile(fsPath: string): void {
  if (entries.delete(fsPath)) {
    invalidateStatsCache();
    notifySoon();
  }
}

/** Drop all state (workspace folder change / tests); next ensure rebuilds. */
export function resetTagIndex(): void {
  entries.clear();
  buildPromise = undefined;
  invalidateStatsCache();
}

// ── Internals ──

/** Supersedes in-flight scans when reset/rescan happens mid-flight. */
let scanGeneration = 0;

async function doFullScan(): Promise<void> {
  const gen = ++scanGeneration;
  entries.clear();
  invalidateStatsCache();
  const uris = await vscode.workspace.findFiles('**/*.feature', EXCLUDE, MAX_FILES);
  // Bounded parallelism: keep event loop responsive on cold start without
  // serializing thousands of tiny reads.
  const BATCH = 64;
  for (let i = 0; i < uris.length; i += BATCH) {
    if (gen !== scanGeneration) {
      return; // superseded by a newer scan/reset
    }
    await Promise.all(uris.slice(i, i + BATCH).map(readAndStore));
  }
  if (gen === scanGeneration) {
    notifySoon();
  }
}

async function readAndStore(uri: vscode.Uri): Promise<void> {
  try {
    applyParsed(uri, parseFeatureTags((await readFileText(uri)).split(/\r?\n/)));
  } catch {
    // unreadable/deleted mid-scan — skip
  }
}

function applyParsed(uri: vscode.Uri, parsed: ParsedFeatureTags): void {
  const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
  const dirParts = rel.split('/');
  dirParts.pop();
  const scenarios: IndexedScenario[] = parsed.scenarios.map(s => ({
    name: s.title ?? '',
    line: s.line,
    tags: s.effective,
  }));
  const tagSet = new Set<string>();
  for (const n of parsed.nodes) {
    for (const t of n.effective) {
      tagSet.add(t);
    }
  }

  entries.set(uri.fsPath, {
    uri,
    fsPath: uri.fsPath,
    relPath: rel,
    dir: dirParts.join('/'),
    featureName: parsed.featureName,
    featureLine: parsed.featureLine,
    featureTags: parsed.nodes[0]?.kind === 'feature' ? [...parsed.nodes[0].effective] : [],
    scenarios,
    tagSet,
    problemCount: parsed.problems.length,
    ...(parsed.problems.length > 0 ? { problems: parsed.problems } : {}),
  });
  invalidateStatsCache();
}

// ── Watchers ──

/**
 * Incremental maintenance: watcher events are coalesced into a pending set
 * and flushed as bounded batches so `git checkout` storms or multi-file
 * saves never block the extension host.
 */
export function registerTagIndexWatchers(disposables: vscode.Disposable[]): void {
  const pendingUpdates = new Map<string, vscode.Uri>();
  let flushTimer: NodeJS.Timeout | undefined;
  const FLUSH_DELAY_MS = 300;
  const BATCH_CAP = 150;

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flushBatch();
    }, FLUSH_DELAY_MS);
  };

  const flushBatch = async (): Promise<void> => {
    if (pendingUpdates.size === 0) {
      return;
    }
    const batch = [...pendingUpdates.values()].slice(0, BATCH_CAP);
    for (const uri of batch) {
      pendingUpdates.delete(uri.fsPath);
    }
    await Promise.all(batch.map(updateIndexedFile));
    if (pendingUpdates.size > 0) {
      scheduleFlush(); // leftover from the cap — continue quietly
    }
  };

  disposables.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId === 'feature' && doc.uri.scheme === 'file') {
        pendingUpdates.set(doc.uri.fsPath, doc.uri);
        scheduleFlush();
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.feature');
  const enqueue = (uri: vscode.Uri): void => {
    if (/[/\\](node_modules|target|dist|out|\.git|\.venv|venv|__pycache__)[/\\]/.test(uri.fsPath)) {
      return;
    }
    pendingUpdates.set(uri.fsPath, uri);
    scheduleFlush();
  };
  disposables.push(
    watcher.onDidChange(enqueue),
    watcher.onDidCreate(enqueue),
    watcher.onDidDelete(uri => removeIndexedFile(uri.fsPath)),
    watcher,
  );

  disposables.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resetTagIndex();
      void ensureTagIndex();
    }),
  );
}
