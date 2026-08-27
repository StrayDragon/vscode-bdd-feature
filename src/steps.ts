import * as vscode from 'vscode';
import type { StepDefinition, StepType } from './model';
import { extractPythonStepDefs } from './scanners/pythonSteps';
import { extractRustStepDefs } from './scanners/rustSteps';
import { extractTsStepDefs } from './scanners/tsSteps';
import { findMatches } from './matching';
import { invalidateBindings } from './bindings';
import { readFileText } from './utils';

/**
 * Cache of all discovered step definitions across languages
 * (pytest-bdd in Python, rstest-bdd in Rust,
 *  cucumber-js / playwright-bdd / jest-cucumber in TS & JS).
 */

let _stepDefinitions: StepDefinition[] = [];
let _stepFiles: vscode.Uri[] = [];
let _scanPromise: Promise<StepDefinition[]> | undefined;
let _scanned = false;

/** Directories never worth scanning for step definitions. */
const SCAN_EXCLUDE =
  '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__,.cargo,.features-gen,bower_components}/**';
const PY_GLOBS = ['**/*step*.py', '**/test_*.py'];
const RS_GLOBS = ['**/*.rs'];
const TS_GLOBS = [
  '**/*[Ss]tep*.ts',
  '**/*[Ss]tep*.js',
  '**/features/**/*.ts',
  '**/features/**/*.js',
];
const TS_SKIP_RE = /\.d\.tsx?$|[._](test|spec)\.[cm]?[jt]sx?$/;

/**
 * Scan the workspace for Python and Rust BDD step definitions.
 * Concurrent calls share one in-flight scan; results are cached.
 *
 * Intentional-refresh API — use {@link whenStepsReady} in read paths.
 */
export function scanStepDefinitions(): Promise<StepDefinition[]> {
  if (_scanPromise) {
    return _scanPromise;
  }
  _scanPromise = doScan().finally(() => {
    _scanPromise = undefined;
  });
  return _scanPromise;
}

/**
 * Read-path freshness guarantee: resolves with the cached definitions once
 * any scan has completed, joining an in-flight scan when one is running.
 *
 * Read paths (workspace symbols per keystroke, find-references, quick
 * fixes…) previously called scanStepDefinitions — starting a full
 * workspace sweep per invocation. Freshness after saves is already owned
 * by registerStepRefreshOnSave's debounced rescan, so read paths only
 * need "data exists".
 */
export function whenStepsReady(): Promise<StepDefinition[]> {
  if (_scanned) {
    return Promise.resolve(_stepDefinitions);
  }
  return scanStepDefinitions();
}

async function doScan(): Promise<StepDefinition[]> {
  const defs: StepDefinition[] = [];
  const files = new Map<string, vscode.Uri>();

  const pyUris = await findFilesUnique(PY_GLOBS);
  for (const uri of pyUris) {
    files.set(uri.fsPath, uri);
    try {
      // Raw read: scanning must not pin thousands of documents in the
      // editor's document cache (memory) the way openTextDocument did.
      const text = await readFileText(uri);
      for (const d of extractPythonStepDefs(text)) {
        defs.push({ ...d, lang: 'python', file: uri });
      }
    } catch {
      // unreadable file — skip
    }
  }

  const rsUris = await findFilesUnique(RS_GLOBS);
  for (const uri of rsUris) {
    // Skip generated/build artifacts that slip past exclude globs
    const p = uri.fsPath;
    if (/[/\\](target|out|dist)[/\\]/.test(p)) {
      continue;
    }
    files.set(uri.fsPath, uri);
    try {
      const text = await readFileText(uri);
      // Cheap pre-filter mirrors the TS branch: skip files without any
      // rstest-bdd attribute shape before running the line parser.
      if (!/^\s*#\s*\[\s*(given|when|then)\s*\(/m.test(text)) {
        continue;
      }
      for (const d of extractRustStepDefs(text)) {
        defs.push({ ...d, lang: 'rust', file: uri });
      }
    } catch {
      // skip
    }
  }

  // TypeScript / JavaScript (cucumber-js, playwright-bdd, jest-cucumber).
  // Cheap pre-filter avoids opening every features/**/*.ts in big repos.
  const tsUris = await findFilesUnique(TS_GLOBS);
  for (const uri of tsUris) {
    const p = uri.fsPath;
    if (/[/\\](node_modules|dist|out|.features-gen)[/\\]/.test(p) || TS_SKIP_RE.test(p)) {
      continue;
    }
    files.set(uri.fsPath, uri);
    try {
      const text = await readFileText(uri);
      // Cheap pre-filter: skip files without step-call shapes entirely.
      if (!/\b(Given|When|Then|defineStep)\s*[(@]/.test(text)) {
        continue;
      }
      for (const d of extractTsStepDefs(text)) {
        defs.push({ ...d, lang: 'typescript', file: uri });
      }
    } catch {
      // skip
    }
  }

  _stepDefinitions = defs;
  _stepFiles = [...files.values()];
  _scanned = true;
  return defs;
}

async function findFilesUnique(globs: string[]): Promise<vscode.Uri[]> {
  const seen = new Set<string>();
  const out: vscode.Uri[] = [];
  for (const g of globs) {
    const found = await vscode.workspace.findFiles(g, SCAN_EXCLUDE, 2000);
    for (const f of found) {
      if (!seen.has(f.fsPath)) {
        seen.add(f.fsPath);
        out.push(f);
      }
    }
  }
  return out;
}

/** Cached definitions (may be empty before first scan). */
export function getStepDefinitions(): StepDefinition[] {
  return _stepDefinitions;
}

export function getStepFiles(): vscode.Uri[] {
  return _stepFiles;
}

/** Find definitions matching a feature step text and optional type. */
export function findMatchingSteps(
  featureStepText: string,
  stepType?: 'given' | 'when' | 'then',
): StepDefinition[] {
  return findMatches(_stepDefinitions, featureStepText, stepType);
}

/** Prefix/substring candidates for completion. */
export function findCompletionCandidates(
  prefix: string,
  stepType?: StepType | undefined,
): StepDefinition[] {
  const lower = prefix.toLowerCase();
  return _stepDefinitions.filter(def => {
    if (def.type !== 'step' && stepType && def.type !== stepType) {
      return false;
    }
    const t = def.text.toLowerCase();
    return t.startsWith(lower) || t.includes(lower) || prefix.length === 0;
  });
}

/**
 * Refresh on save: any Python, Rust or TS/JS file save triggers a debounced rescan.
 */
export function registerStepRefreshOnSave(disposables: vscode.Disposable[]): void {
  let timer: NodeJS.Timeout | undefined;
  const watched = new Set(['python', 'rust', 'typescript', 'javascript']);
  disposables.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (!watched.has(doc.languageId)) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        invalidateBindings(); // bindings sweep reruns on next ensure
        void scanStepDefinitions();
      }, 300);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateBindings();
      void scanStepDefinitions();
    }),
  );
}
