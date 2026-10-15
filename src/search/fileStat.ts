import { stat } from 'node:fs/promises';

/** Cheap change detection — no content hash unless mtime+size collide. */
export interface FileIdentity {
  mtimeMs: number;
  size: number;
}

export function identityKey(id: FileIdentity): string {
  return `${id.mtimeMs}:${id.size}`;
}

export async function statIdentity(absPath: string): Promise<FileIdentity> {
  const st = await stat(absPath);
  return { mtimeMs: st.mtimeMs, size: st.size };
}

export function identityUnchanged(a: FileIdentity, b: FileIdentity): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
