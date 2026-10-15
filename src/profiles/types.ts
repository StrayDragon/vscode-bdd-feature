/**
 * Framework profiles: separate Gherkin (spec-driven, src/gherkin/) from
 * per-stack step discovery, pattern matching, and feature binding.
 */

import type { StepLang, StepMatcherKind, StepType } from '../model';

/** Built-in + user-defined profile identifiers. */
export type ProfileId =
  | 'pytest-bdd'
  | 'rstest-bdd'
  | 'cucumber-js'
  | 'playwright-bdd'
  | 'jest-cucumber'
  | 'member-dsl-bdd'
  | (string & {});

export interface ExtractedStepPartial {
  type: StepType;
  text: string;
  matcherKind: StepMatcherKind;
  decoratorLine: number;
  functionLine?: number;
  functionName?: string;
  patternSelection?: {
    startLine: number;
    startCol: number;
    endLine: number;
    endCol: number;
  };
}

/** User override from `bddFeature.profiles` (merged onto builtins by id). */
export interface UserProfileConfig {
  id: string;
  enabled?: boolean;
  label?: string;
  stepRoots?: string[];
  featureRoots?: string[];
  /** Relative path to the test entry that loads features (synthetic binding). */
  bindingEntry?: string;
  stepGlobs?: string[];
  /** When set, only scan files whose content matches this RegExp. */
  fileFingerprint?: string;
}

export interface ResolvedProfile {
  id: ProfileId;
  label: string;
  enabled: boolean;
  languages: StepLang[];
  /** Workspace-relative directory prefixes (no leading slash). */
  stepRoots: string[];
  featureRoots: string[];
  bindingEntry?: string;
}

export interface StepScanContributor {
  id: ProfileId;
  languages: StepLang[];
  globs: string[];
  shouldSkipFile: (relPath: string) => boolean;
  filePrefilter: (source: string, relPath: string) => boolean;
  extract: (source: string, relPath: string) => ExtractedStepPartial[];
  defaultFrameworkId: ProfileId;
}
