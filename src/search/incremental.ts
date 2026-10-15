import type { FileIdentity } from './fileStat';
import { identityUnchanged, statIdentity } from './fileStat';

export interface CachedFileScan<TDef> {
  identity: FileIdentity;
  defs: TDef[];
}

/**
 * Per-file scan cache keyed by absolute path. Reuses defs when mtime+size match.
 */
export class IncrementalScanCache<TDef> {
  private readonly byPath = new Map<string, CachedFileScan<TDef>>();

  size(): number {
    return this.byPath.size;
  }

  clear(): void {
    this.byPath.clear();
  }

  delete(absPath: string): void {
    this.byPath.delete(absPath);
  }

  /** Drop entries for files no longer in the candidate set. */
  prune(keepAbsPaths: ReadonlySet<string>): void {
    for (const p of this.byPath.keys()) {
      if (!keepAbsPaths.has(p)) {
        this.byPath.delete(p);
      }
    }
  }

  flattenDefs(): TDef[] {
    const out: TDef[] = [];
    for (const v of this.byPath.values()) {
      out.push(...v.defs);
    }
    return out;
  }

  absPaths(): string[] {
    return [...this.byPath.keys()];
  }

  /** Rescan a single file and refresh its cache entry (e.g. on save). */
  async upsertOne(
    absPath: string,
    relPath: string,
    scanOne: (absPath: string, relPath: string) => Promise<TDef[]>,
  ): Promise<void> {
    const id = await statIdentity(absPath);
    const defs = await scanOne(absPath, relPath);
    this.byPath.set(absPath, { identity: id, defs });
  }

  /**
   * Scan only changed/new files; reuse cached defs for stable files.
   */
  async reconcile(
    files: ReadonlyArray<{ absPath: string; relPath: string }>,
    scanOne: (absPath: string, relPath: string) => Promise<TDef[]>,
  ): Promise<{ rescanned: number; reused: number }> {
    const keep = new Set(files.map(f => f.absPath));
    this.prune(keep);
    let rescanned = 0;
    let reused = 0;
    for (const { absPath, relPath } of files) {
      const id = await statIdentity(absPath);
      const prev = this.byPath.get(absPath);
      if (prev && identityUnchanged(prev.identity, id)) {
        reused++;
        continue;
      }
      const defs = await scanOne(absPath, relPath);
      this.byPath.set(absPath, { identity: id, defs });
      rescanned++;
    }
    return { rescanned, reused };
  }
}
