import { spawnSync } from 'node:child_process';
import { matchesAnyGlob } from './globMatch';
import { walkRelPaths } from './nodeWalk';

/** Ripgrep negated globs mirroring SCAN_EXCLUDE. */
export const RG_EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/target/**',
  '!**/dist/**',
  '!**/out/**',
  '!**/.git/**',
  '!**/.venv/**',
  '!**/venv/**',
  '!**/__pycache__/**',
  '!**/.cargo/**',
  '!**/.features-gen/**',
  '!**/bower_components/**',
];

/**
 * List workspace-relative paths via `rg --files` (fast on large trees).
 * Returns undefined when ripgrep is missing — caller should fall back to walk.
 */
export function enumerateWithRipgrep(
  root: string,
  includeGlobs: readonly string[],
): string[] | undefined {
  const args = ['--files', '--color=never', '--no-messages', '--no-ignore-vcs'];
  for (const g of RG_EXCLUDE_GLOBS) {
    args.push('--glob', g);
  }
  for (const g of includeGlobs) {
    args.push('--glob', g);
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync('rg', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  if (result.error) {
    return undefined;
  }
  if (result.status !== 0 && result.status !== 1) {
    return undefined;
  }
  const stdout = result.stdout;
  const out = (typeof stdout === 'string' ? stdout : stdout?.toString('utf8') ?? '').trim();
  if (!out) {
    return [];
  }
  return out.split('\n').map((p: string) => p.replace(/\\/g, '/'));
}

export interface EnumerateResult {
  paths: string[];
  viaRipgrep: boolean;
}

/** Ripgrep when available; otherwise synchronous directory walk + glob filter. */
export function enumerateCandidateRelPaths(
  root: string,
  includeGlobs: readonly string[],
): EnumerateResult {
  const fromRg = enumerateWithRipgrep(root, includeGlobs);
  if (fromRg !== undefined) {
    return { paths: fromRg, viaRipgrep: true };
  }
  const out: string[] = [];
  for (const rel of walkRelPaths(root)) {
    if (matchesAnyGlob(rel, includeGlobs)) {
      out.push(rel);
    }
  }
  return { paths: out, viaRipgrep: false };
}
