import * as vscode from 'vscode';
import type { StepDefinition, StepType } from './model';
import { extractPythonStepDefs } from './scanners/pythonSteps';
import { extractRustStepDefs } from './scanners/rustSteps';
import { findMatches } from './matching';

/**
 * Cache of all discovered step definitions across languages
 * (pytest-bdd in Python, rstest-bdd in Rust).
 */

let _stepDefinitions: StepDefinition[] = [];
let _stepFiles: vscode.Uri[] = [];
let _scanPromise: Promise<StepDefinition[]> | undefined;

/** Directories never worth scanning for step definitions. */
const SCAN_EXCLUDE = '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__,.cargo}/**';
const PY_GLOBS = ['**/*step*.py', '**/test_*.py'];
const RS_GLOBS = ['**/*.rs'];

/**
 * Scan the workspace for Python and Rust BDD step definitions.
 * Concurrent calls share one in-flight scan; results are cached.
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

async function doScan(): Promise<StepDefinition[]> {
  const defs: StepDefinition[] = [];
  const files = new Map<string, vscode.Uri>();

  const pyUris = await findFilesUnique(PY_GLOBS);
  for (const uri of pyUris) {
    files.set(uri.fsPath, uri);
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      for (const d of extractPythonStepDefs(doc.getText())) {
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
      const doc = await vscode.workspace.openTextDocument(uri);
      for (const d of extractRustStepDefs(doc.getText())) {
        defs.push({ ...d, lang: 'rust', file: uri });
      }
    } catch {
      // skip
    }
  }

  _stepDefinitions = defs;
  _stepFiles = [...files.values()];
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
 * Refresh on save: any Python or Rust file save triggers a debounced rescan.
 */
export function registerStepRefreshOnSave(disposables: vscode.Disposable[]): void {
  let timer: NodeJS.Timeout | undefined;
  disposables.push(
    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.languageId !== 'python' && doc.languageId !== 'rust') {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void scanStepDefinitions();
      }, 300);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void scanStepDefinitions();
    }),
  );
}
