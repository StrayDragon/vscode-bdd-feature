import * as path from 'path';
import * as vscode from 'vscode';
import type { StepDefinition, StepType } from './model';
import { findMatches } from './matching';
import { invalidateBindings } from './bindings';
import { getWorkspaceRoot } from './utils';
import {
  BUILTIN_SCANNERS,
  SCAN_EXCLUDE,
  definitionsForFeature,
  invalidateProfileResolution,
} from './profiles';
import { setMemberBindingEntries } from './profiles/resolve';
import { allStepGlobs, isScanCandidateRelPath } from './search/nodeScan';
import { enumerateCandidateRelPaths } from './search/rgEnumerate';
import { scanFileAtPath } from './search/scanFile';
import { IncrementalScanCache } from './search/incremental';
import { clearPatternInternPool } from './search/intern';
import type { PipelineExtracted } from './search/pipeline';

/**
 * Cache of all discovered step definitions across framework profiles.
 */

let _stepDefinitions: StepDefinition[] = [];
let _stepFiles: vscode.Uri[] = [];
let _scanPromise: Promise<StepDefinition[]> | undefined;
let _scanned = false;
const _fileCache = new IncrementalScanCache<StepDefinition>();

export { SCAN_EXCLUDE, TS_SKIP_RE } from './profiles/builtin';

export function scanStepDefinitions(): Promise<StepDefinition[]> {
  if (_scanPromise) {
    return _scanPromise;
  }
  _scanPromise = doScan().finally(() => {
    _scanPromise = undefined;
  });
  return _scanPromise;
}

export function whenStepsReady(): Promise<StepDefinition[]> {
  if (_scanned) {
    return Promise.resolve(_stepDefinitions);
  }
  return scanStepDefinitions();
}

function partialsToStepDefs(uri: vscode.Uri, partials: PipelineExtracted[]): StepDefinition[] {
  return partials.map(d => ({
    type: d.type,
    text: d.text,
    matcherKind: d.matcherKind,
    decoratorLine: d.decoratorLine,
    functionLine: d.functionLine ?? d.decoratorLine,
    functionName: d.functionName,
    patternSelection: d.patternSelection,
    lang: d.lang,
    frameworkId: d.frameworkId,
    profileId: d.frameworkId,
    file: uri,
  }));
}

async function scanOneFile(absPath: string, relPath: string): Promise<StepDefinition[]> {
  const uri = vscode.Uri.file(absPath);
  const partials = await scanFileAtPath(absPath, relPath, BUILTIN_SCANNERS);
  return partialsToStepDefs(uri, partials);
}

function syncFromFileCache(): void {
  _stepDefinitions = _fileCache.flattenDefs();
  _stepFiles = _fileCache.absPaths().map(p => vscode.Uri.file(p));
  _scanned = true;
}

async function discoverMemberBindingRelPaths(root: string): Promise<void> {
  const entries = await vscode.workspace.findFiles(
    '**/tests/bdd/run.test.ts',
    SCAN_EXCLUDE,
    32,
  );
  setMemberBindingEntries(
    entries.map(u => path.relative(root, u.fsPath).split(path.sep).join('/')),
  );
}

async function enumerateViaWorkspaceApi(globs: string[]): Promise<vscode.Uri[]> {
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

async function doScan(): Promise<StepDefinition[]> {
  invalidateProfileResolution();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (root) {
    await discoverMemberBindingRelPaths(root);
    const globs = allStepGlobs();
    const { paths } = enumerateCandidateRelPaths(root, globs);
    const files = paths
      .filter(isScanCandidateRelPath)
      .map(rel => ({ absPath: path.join(root, rel), relPath: rel }));
    await _fileCache.reconcile(files, scanOneFile);
  } else {
    _fileCache.clear();
    const files: { absPath: string; relPath: string }[] = [];
    for (const uri of await enumerateViaWorkspaceApi(allStepGlobs())) {
      const relPath = uri.fsPath;
      if (!isScanCandidateRelPath(relPath)) {
        continue;
      }
      files.push({ absPath: uri.fsPath, relPath });
    }
    await _fileCache.reconcile(files, scanOneFile);
  }

  syncFromFileCache();
  return _stepDefinitions;
}

export function getStepDefinitions(): StepDefinition[] {
  return _stepDefinitions;
}

export function getStepFiles(): vscode.Uri[] {
  return _stepFiles;
}

function scopedDefs(featureFsPath?: string): readonly StepDefinition[] {
  if (!featureFsPath) {
    return _stepDefinitions;
  }
  return definitionsForFeature(featureFsPath, _stepDefinitions, getWorkspaceRoot());
}

/** Find definitions matching a feature step text and optional type. */
export function findMatchingSteps(
  featureStepText: string,
  stepType?: 'given' | 'when' | 'then',
  featureFsPath?: string,
): StepDefinition[] {
  return findMatches(scopedDefs(featureFsPath), featureStepText, stepType);
}

/** Prefix/substring candidates for completion. */
export function findCompletionCandidates(
  prefix: string,
  stepType?: StepType | undefined,
  featureFsPath?: string,
): StepDefinition[] {
  const lower = prefix.toLowerCase();
  const pool = scopedDefs(featureFsPath);
  return pool.filter(def => {
    if (def.type !== 'step' && stepType && def.type !== stepType) {
      return false;
    }
    const t = def.text.toLowerCase();
    return t.startsWith(lower) || t.includes(lower) || prefix.length === 0;
  });
}

async function refreshSavedStepFile(doc: vscode.TextDocument): Promise<void> {
  const root = getWorkspaceRoot();
  if (!root) {
    await scanStepDefinitions();
    return;
  }
  const rel = path.relative(root, doc.uri.fsPath).split(path.sep).join('/');
  if (!isScanCandidateRelPath(rel)) {
    return;
  }
  await _fileCache.upsertOne(doc.uri.fsPath, rel, scanOneFile);
  syncFromFileCache();
}

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
        invalidateBindings();
        invalidateProfileResolution();
        void refreshSavedStepFile(doc);
      }, 300);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateBindings();
      invalidateProfileResolution();
      _fileCache.clear();
      clearPatternInternPool();
      _scanned = false;
      void scanStepDefinitions();
    }),
  );
}
