import * as path from 'path';
import * as vscode from 'vscode';
import { existsSync } from 'fs';
import { cfg } from '../config';
import { MEMBER_DSL_DEFAULTS, MEMBER_DSL_FEATURE_ROOTS } from './builtin';
import type { ResolvedProfile, UserProfileConfig } from './types';

const BUILTIN_PROFILES: Omit<ResolvedProfile, 'enabled'>[] = [
  {
    id: 'pytest-bdd',
    label: 'pytest-bdd (Python)',
    languages: ['python'],
    stepRoots: [],
    featureRoots: [],
  },
  {
    id: 'rstest-bdd',
    label: 'rstest-bdd (Rust)',
    languages: ['rust'],
    stepRoots: [],
    featureRoots: [],
  },
  {
    id: 'cucumber-js',
    label: 'cucumber-js / playwright-bdd / jest-cucumber (TS/JS)',
    languages: ['typescript'],
    stepRoots: [],
    featureRoots: [],
  },
  {
    id: 'member-dsl-bdd',
    label: 'Custom member-DSL runner (bdd.given / when / thenStep)',
    languages: ['typescript'],
    stepRoots: [...MEMBER_DSL_DEFAULTS.stepRoots],
    featureRoots: [...MEMBER_DSL_FEATURE_ROOTS],
    bindingEntry: MEMBER_DSL_DEFAULTS.bindingEntry,
  },
];

let cached: ResolvedProfile[] | undefined;
/** Workspace-relative paths to `tests/bdd/run.test.ts` (incl. monorepo nesting). */
let memberBindingEntries: string[] = [];

export function invalidateProfileResolution(): void {
  cached = undefined;
  memberBindingEntries = [];
}

export function setMemberBindingEntries(entries: string[]): void {
  memberBindingEntries = entries;
}

export function getMemberBindingEntries(): readonly string[] {
  return memberBindingEntries;
}

export function getResolvedProfiles(): ResolvedProfile[] {
  if (cached) {
    return cached;
  }
  const user = cfg<UserProfileConfig[]>('profiles', []);
  const byId = new Map<string, ResolvedProfile>();

  for (const base of BUILTIN_PROFILES) {
    byId.set(base.id, { ...base, enabled: true });
  }

  for (const u of user) {
    if (!u.id) {
      continue;
    }
    const existing = byId.get(u.id);
    const merged: ResolvedProfile = {
      id: u.id,
      label: u.label ?? existing?.label ?? u.id,
      enabled: u.enabled ?? existing?.enabled ?? true,
      languages: existing?.languages ?? ['typescript'],
      stepRoots: u.stepRoots ?? existing?.stepRoots ?? [],
      featureRoots: u.featureRoots ?? existing?.featureRoots ?? [],
      bindingEntry: u.bindingEntry ?? existing?.bindingEntry,
    };
    byId.set(u.id, merged);
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root && memberDslLayoutPresent(root)) {
    const m = byId.get('member-dsl-bdd');
    if (m) {
      m.enabled = true;
    }
  }

  cached = [...byId.values()].filter(p => p.enabled);
  return cached;
}

function memberDslLayoutPresent(workspaceRoot: string): boolean {
  const specs = path.join(workspaceRoot, 'llmanspec', 'specs');
  const bdd = path.join(workspaceRoot, 'tests', 'bdd');
  return existsSync(specs) && existsSync(bdd);
}

/** Workspace-relative path uses forward slashes. */
export function normalizeRelPath(fsPath: string, workspaceRoot: string): string {
  return path.relative(workspaceRoot, fsPath).split(path.sep).join('/');
}

/**
 * True when `rel` is under `rootPrefix` (root may end with `/**`).
 * Also matches nested monorepo layouts (`apps/server/tests/bdd/...` for `tests/bdd`).
 */
export function pathUnderRoot(rel: string, rootPrefix: string): boolean {
  const base = rootPrefix.replace(/\/\*\*$/, '').replace(/\*\*/g, '').replace(/\/$/, '');
  if (!base) {
    return true;
  }
  if (rel === base || rel.startsWith(`${base}/`)) {
    return true;
  }
  const nested = `/${base}/`;
  return rel.includes(nested) || rel.endsWith(`/${base}`);
}
