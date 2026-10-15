import * as path from 'path';
import * as vscode from 'vscode';
import type { StepDefinition, StepType } from './model';
import { findMatches } from './matching';
import { invalidateBindings } from './bindings';
import { readFileText, getWorkspaceRoot } from './utils';
import {
  BUILTIN_SCANNERS,
  SCAN_EXCLUDE,
  definitionsForFeature,
  invalidateProfileResolution,
} from './profiles';
import type { ExtractedStepPartial, ProfileId } from './profiles';

/**
 * Cache of all discovered step definitions across framework profiles.
 */

let _stepDefinitions: StepDefinition[] = [];
let _stepFiles: vscode.Uri[] = [];
let _scanPromise: Promise<StepDefinition[]> | undefined;
let _scanned = false;

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

function frameworkForPartial(contributorId: ProfileId, partial: ExtractedStepPartial): ProfileId {
  if (partial.matcherKind === 'parse-lite') {
    return 'member-dsl-bdd';
  }
  return contributorId;
}

async function doScan(): Promise<StepDefinition[]> {
  invalidateProfileResolution();
  const defs: StepDefinition[] = [];
  const files = new Map<string, vscode.Uri>();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  for (const contributor of BUILTIN_SCANNERS) {
    const uris = await findFilesUnique(contributor.globs);
    for (const uri of uris) {
      const relPath = root ? path.relative(root, uri.fsPath).split(path.sep).join('/') : uri.fsPath;
      if (contributor.shouldSkipFile(relPath)) {
        continue;
      }
      files.set(uri.fsPath, uri);
      try {
        const text = await readFileText(uri);
        if (!contributor.filePrefilter(text)) {
          continue;
        }
        for (const d of contributor.extract(text, relPath)) {
          const frameworkId = frameworkForPartial(contributor.id, d);
          const lang = contributor.languages[0];
          defs.push({
            ...d,
            lang,
            frameworkId,
            profileId: frameworkId,
            file: uri,
            functionLine: d.functionLine ?? d.decoratorLine,
          });
        }
      } catch {
        // unreadable file — skip
      }
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
        void scanStepDefinitions();
      }, 300);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      invalidateBindings();
      invalidateProfileResolution();
      void scanStepDefinitions();
    }),
  );
}
