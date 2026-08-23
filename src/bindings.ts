import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync } from 'fs';
import type { FeatureBinding } from './model';
import {
  extractPythonScenariosBindings,
  extractPythonScenarioBinding,
} from './scanners/pythonSteps';
import { extractRustScenarioBindings } from './scanners/rustSteps';

/**
 * Index mapping .feature files to the code that binds them:
 *  - Python: `scenarios("features/x.feature")` / `scenario("f", "name")` calls
 *  - Rust:   `#[scenario(path = "specs/x.feature", name = "...")]` attributes
 *
 * Path resolution mirrors each framework:
 *  - pytest-bdd resolves relative to the calling module's directory, or
 *    `<rootdir>/<bdd_features_base_dir>` when set in an ini file.
 *  - rstest-bdd resolves relative to the crate manifest dir (nearest
 *    Cargo.toml ancestor of the binding file).
 */

const EXCLUDE = '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__}/**';

interface IndexState {
  /** fsPath(feature) → bindings */
  byFeature: Map<string, FeatureBinding[]>;
  /** fsPath(binding source file) → feature paths referenced (for refresh) */
  sources: Map<string, string[]>;
}

const state: IndexState = { byFeature: new Map(), sources: new Map() };
let rebuild: Promise<void> | undefined;

export function invalidateBindings(): void {
  state.byFeature.clear();
  state.sources.clear();
}

/** Rebuild the index (debounced/shared like step scanning). */
export function ensureBindings(): Promise<void> {
  if (!rebuild) {
    rebuild = doRebuild().finally(() => {
      rebuild = undefined;
    });
  }
  return rebuild;
}

async function doRebuild(): Promise<void> {
  invalidateBindings();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    return;
  }

  // Optional featuresBaseDir mirrors pytest-bdd's bdd_features_base_dir ini.
  const cfg = vscode.workspace.getConfiguration('bddFeature');
  const baseDir = cfg.get<string | undefined>('featuresBaseDir');

  const pyUris = await vscode.workspace.findFiles('**/*.py', EXCLUDE, 5000);
  for (const uri of pyUris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      if (!text.includes('scenarios') && !text.includes('scenario')) {
        continue;
      }
      const refs: string[] = [];
      const add = (featureArg: string, line: number, scenarioName?: string) => {
        const resolved = resolvePythonFeaturePath(
          root,
          path.dirname(uri.fsPath),
          baseDir,
          featureArg,
        );
        if (!resolved) {
          return;
        }
        refs.push(resolved);
        push(state.byFeature, resolved, {
          lang: 'python',
          file: uri,
          line,
        });
        if (scenarioName !== undefined) {
          push(state.byFeature, `${resolved}::${scenarioName}`, {
            lang: 'python',
            file: uri,
            line,
          });
        }
      };
      for (const b of extractPythonScenariosBindings(text)) {
        add(b.featureArg, b.line);
      }
      for (const b of extractPythonScenarioBinding(text)) {
        add(b.featureArg, b.line, b.scenarioName);
      }
      if (refs.length) {
        state.sources.set(uri.fsPath, refs);
      }
    } catch {
      // skip
    }
  }

  const rsUris = await vscode.workspace.findFiles('**/tests/**/*.rs', EXCLUDE, 5000);
  for (const uri of rsUris) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      if (!text.includes('#[scenario')) {
        continue;
      }
      const crateDir = nearestManifestDir(uri.fsPath);
      for (const b of extractRustScenarioBindings(text)) {
        const resolved = crateDir ? path.join(crateDir, b.featureArg) : undefined;
        if (!resolved || !isFeaturePath(resolved)) {
          continue;
        }
        push(state.byFeature, resolved, {
          lang: 'rust',
          file: uri,
          line: b.attributeLine,
          rustTestFnName: b.fnName,
        });
        push(state.byFeature, `${resolved}::${b.name}`, {
          lang: 'rust',
          file: uri,
          line: b.attributeLine,
          rustTestFnName: b.fnName,
        });
      }
    } catch {
      // skip
    }
  }
}

function push(map: Map<string, FeatureBinding[]>, key: string, value: FeatureBinding): void {
  const arr = map.get(key);
  if (arr) {
    if (!arr.some(x => x.file.fsPath === value.file.fsPath && x.line === value.line)) {
      arr.push(value);
    }
  } else {
    map.set(key, [value]);
  }
}

function isFeaturePath(p: string): boolean {
  return p.endsWith('.feature');
}

/** Resolve a pytest-bdd feature path argument to an absolute fsPath. */
function resolvePythonFeaturePath(
  workspaceRoot: string,
  bindingDir: string,
  configuredBaseDir: string | undefined,
  arg: string,
): string | undefined {
  if (path.isAbsolute(arg)) {
    return isFeaturePath(arg) ? normalize(arg) : undefined;
  }
  const candidates = [
    configuredBaseDir ? path.join(workspaceRoot, configuredBaseDir, arg) : undefined,
    path.join(bindingDir, arg),
    path.join(workspaceRoot, arg),
  ].filter((x): x is string => Boolean(x));
  const existing = candidates.find(c => isFeaturePath(c) && existsSync(c));
  return existing ?? candidates[0] ?? undefined;
}

function normalize(p: string): string {
  // path.normalize keeps platform separators; index keys use fsPath form.
  return path.normalize(p);
}

function nearestManifestDir(fromFile: string): string | undefined {
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, 'Cargo.toml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

/** Bindings registered for a feature file (absolute fsPath key). */
export function getBindingsForFeature(
  featureFsPath: string,
  scenarioName?: string,
): FeatureBinding[] {
  const direct =
    (scenarioName && state.byFeature.get(`${featureFsPath}::${scenarioName}`)) ||
    state.byFeature.get(featureFsPath) ||
    [];
  if (direct.length) {
    return direct;
  }
  if (scenarioName) {
    return state.byFeature.get(featureFsPath) ?? [];
  }
  return [];
}
