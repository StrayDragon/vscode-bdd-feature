import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIR = new Set([
  'node_modules',
  'target',
  'dist',
  'out',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.cargo',
  '.features-gen',
  '.pytest_cache',
]);

/** Yield workspace-relative paths (forward slashes) without loading all into one array. */
export function* walkRelPaths(root: string, sub = ''): Generator<string> {
  const abs = path.join(root, sub);
  let entries: string[];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) {
      continue;
    }
    const childRel = sub ? `${sub}/${name}` : name;
    const childAbs = path.join(root, childRel);
    let st: fs.Stats;
    try {
      st = fs.statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walkRelPaths(root, childRel);
    } else {
      yield childRel.replace(/\\/g, '/');
    }
  }
}

export function collectFeatureRelPaths(root: string): string[] {
  const out: string[] = [];
  for (const rel of walkRelPaths(root)) {
    if (rel.endsWith('.feature')) {
      out.push(rel);
    }
  }
  return out;
}
