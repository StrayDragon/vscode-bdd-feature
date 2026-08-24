import * as vscode from 'vscode';

/**
 * Detect which TypeScript BDD runner a workspace uses, so scenarios in
 * .feature files can be executed even without per-feature code bindings
 * (cucumber-js and playwright-bdd discover features themselves).
 *
 * Detection order:
 *   1. playwright.config.{ts,js,mjs,cjs} anywhere in the workspace → playwright-bdd
 *   2. package.json dependencies containing playwright-bdd         → playwright-bdd
 *   3. package.json dependencies containing @cucumber/cucumber     → cucumber-js
 *
 * Result is memoized for the session and invalidated when workspace folders
 * change (projects rarely switch otherwise).
 */
export type TsBddRunner = 'playwright-bdd' | 'cucumber-js';

let cached: TsBddRunner | undefined;
let probed = false;

/** Reset the memo (exposed for tests / workspace-folder changes). */
export function resetTsBddDetection(): void {
  probed = false;
  cached = undefined;
}

export async function detectTsBddRunner(): Promise<TsBddRunner | undefined> {
  if (probed) {
    return cached;
  }
  probed = true;
  try {
    const pwConfigs = await vscode.workspace.findFiles(
      '**/playwright.config.{ts,js,mjs,cjs}',
      '**/{node_modules,dist,out,.git}/**',
      1,
    );
    if (pwConfigs.length > 0) {
      cached = 'playwright-bdd';
      return cached;
    }
    const rootUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!rootUri) {
      return undefined;
    }
    const pkgDoc = await vscode.workspace.openTextDocument(
      vscode.Uri.joinPath(rootUri, 'package.json'),
    );
    const pkg = JSON.parse(pkgDoc.getText()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('playwright-bdd' in deps) {
      cached = 'playwright-bdd';
    } else if ('@cucumber/cucumber' in deps) {
      cached = 'cucumber-js';
    }
    return cached;
  } catch {
    return undefined;
  }
}

/** Configured command lines (kept here so callers share defaults). */
export function cucumberCommand(): string {
  return vscode.workspace.getConfiguration('bddFeature').get<string>('cucumberCommand', 'npx cucumber-js');
}

export function playwrightCommand(): string {
  return vscode.workspace
    .getConfiguration('bddFeature')
    .get<string>('playwrightCommand', 'npx playwright test');
}

/** Escape a literal for use inside a regex (--name/-g filters take patterns). */
export function escapeRegExpLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
