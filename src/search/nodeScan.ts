import * as path from 'node:path';
import { BUILTIN_SCANNERS } from '../profiles/builtin';
import { matchesAnyGlob } from './globMatch';
import { enumerateCandidateRelPaths } from './rgEnumerate';
import { type ScanPipelineStats } from './pipeline';
import { scanFileAtPath } from './scanFile';
import { IncrementalScanCache } from './incremental';
import type { PipelineExtracted } from './pipeline';
import { clearPatternInternPool } from './intern';

export interface WorkspaceScanReport {
  root: string;
  stats: ScanPipelineStats;
  definitions: PipelineExtracted[];
  ms: number;
  rescanned: number;
  reused: number;
  usedRipgrep: boolean;
}

/** All scan globs flattened (deduped). */
export function allStepGlobs(): string[] {
  const s = new Set<string>();
  for (const c of BUILTIN_SCANNERS) {
    for (const g of c.globs) {
      s.add(g);
    }
  }
  return [...s];
}

export function isScanCandidateRelPath(relPath: string): boolean {
  for (const c of BUILTIN_SCANNERS) {
    if (c.shouldSkipFile(relPath)) {
      continue;
    }
    if (c.globs.some(g => matchesAnyGlob(relPath, [g]))) {
      return true;
    }
  }
  return false;
}

const nodeCache = new IncrementalScanCache<PipelineExtracted>();

/**
 * Generic workspace scan: rg/walk → fingerprint → parse, with incremental reuse.
 */
export async function scanWorkspaceRoot(
  root: string,
  opts?: { fresh?: boolean },
): Promise<WorkspaceScanReport> {
  if (opts?.fresh) {
    nodeCache.clear();
    clearPatternInternPool();
  }
  const globs = allStepGlobs();
  const stats: ScanPipelineStats = {
    candidates: 0,
    skippedPath: 0,
    skippedFingerprint: 0,
    parsed: 0,
    definitions: 0,
    bytesRead: 0,
  };
  const t0 = performance.now();
  const { paths: listed, viaRipgrep } = enumerateCandidateRelPaths(root, globs);
  const files = listed
    .filter(isScanCandidateRelPath)
    .map(rel => ({ absPath: path.join(root, rel), relPath: rel }));
  stats.candidates = files.length;

  const { rescanned, reused } = await nodeCache.reconcile(files, (abs, rel) =>
    scanFileAtPath(abs, rel, BUILTIN_SCANNERS, stats),
  );
  const definitions = nodeCache.flattenDefs();
  stats.definitions = definitions.length;

  return {
    root,
    stats,
    definitions,
    ms: performance.now() - t0,
    rescanned,
    reused,
    usedRipgrep: viaRipgrep,
  };
}
