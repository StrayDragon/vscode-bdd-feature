import type { StepDefinition } from '../model';
import {
  getMemberBindingEntries,
  getResolvedProfiles,
  normalizeRelPath,
  pathUnderRoot,
} from './resolve';

/**
 * Step definitions relevant to a given .feature file.
 *
 * When the feature path falls under a profile's `featureRoots`, only definitions
 * from matching profiles' `stepRoots` (or same profileId) are returned. Otherwise
 * all definitions are visible (test-fixtures, single-stack repos).
 */
export function definitionsForFeature(
  featureFsPath: string,
  allDefs: readonly StepDefinition[],
  workspaceRoot: string | undefined,
): StepDefinition[] {
  if (!workspaceRoot) {
    return [...allDefs];
  }
  const rel = normalizeRelPath(featureFsPath, workspaceRoot);
  const profiles = getResolvedProfiles().filter(p => p.featureRoots.some(r => pathUnderRoot(rel, r)));

  if (profiles.length === 0) {
    return [...allDefs];
  }

  const profileIds = new Set(profiles.map(p => p.id));
  const stepRoots = profiles.flatMap(p => p.stepRoots);

  return allDefs.filter(def => {
    if (def.profileId && profileIds.has(def.profileId)) {
      return true;
    }
    const defRel = normalizeRelPath(def.file.fsPath, workspaceRoot);
    return stepRoots.some(r => pathUnderRoot(defRel, r));
  });
}

export function syntheticBindingForFeature(
  featureFsPath: string,
  workspaceRoot: string | undefined,
): { entryRel: string; line: number } | undefined {
  if (!workspaceRoot) {
    return undefined;
  }
  const rel = normalizeRelPath(featureFsPath, workspaceRoot);
  const inMemberFeature = getResolvedProfiles().some(
    p => p.id === 'member-dsl-bdd' && p.featureRoots.some(r => pathUnderRoot(rel, r)),
  );
  if (!inMemberFeature) {
    return undefined;
  }
  const candidates = [
    ...getMemberBindingEntries(),
    ...getResolvedProfiles()
      .map(p => p.bindingEntry)
      .filter((e): e is string => Boolean(e)),
  ];
  for (const entry of candidates) {
    return { entryRel: entry.replace(/\\/g, '/'), line: 0 };
  }
  return undefined;
}
