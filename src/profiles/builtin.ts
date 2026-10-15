import { extractPythonStepDefs } from '../scanners/pythonSteps';
import { extractRustStepDefs } from '../scanners/rustSteps';
import { extractTsStepDefs } from '../scanners/tsSteps';
import { mightContainStepDefs } from '../search/fingerprints';
import type { StepScanContributor } from './types';

export const SCAN_EXCLUDE =
  '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__,.cargo,.features-gen,bower_components}/**';

export const TS_SKIP_RE = /\.d\.tsx?$|[._](test|spec)\.[cm]?[jt]sx?$/;

/** Narrow globs — avoid reading every source file in large monorepos. */
export const PY_STEP_GLOBS = [
  '**/*step*.py',
  '**/steps/**/*.py',
  '**/tests/**/test_*.py',
  '**/conftest.py',
];
export const RS_STEP_GLOBS = ['**/tests/**/*.rs', '**/benches/**/*.rs', '**/examples/**/*.rs'];
export const TS_STEP_GLOBS = [
  '**/tests/bdd/**/*.ts',
  '**/tests/bdd/**/*.js',
  '**/*[Ss]tep*.ts',
  '**/*[Ss]tep*.js',
  '**/features/**/*.ts',
  '**/features/**/*.js',
  '**/*.steps.ts',
  '**/*.steps.js',
];

export const BUILTIN_SCANNERS: StepScanContributor[] = [
  {
    id: 'pytest-bdd',
    languages: ['python'],
    globs: PY_STEP_GLOBS,
    shouldSkipFile: () => false,
    filePrefilter: (source, relPath) => mightContainStepDefs(relPath ?? '', source),
    extract: (source) => extractPythonStepDefs(source),
    defaultFrameworkId: 'pytest-bdd',
  },
  {
    id: 'rstest-bdd',
    languages: ['rust'],
    globs: RS_STEP_GLOBS,
    shouldSkipFile: (rel) => /(^|\/)(target|out|dist)(\/|$)/.test(rel),
    filePrefilter: (source, relPath) => mightContainStepDefs(relPath ?? '', source),
    extract: (source) => extractRustStepDefs(source),
    defaultFrameworkId: 'rstest-bdd',
  },
  {
    id: 'cucumber-js',
    languages: ['typescript'],
    globs: TS_STEP_GLOBS,
    shouldSkipFile: (rel) => {
      if (/(^|\/)tests\/bdd\//.test(rel)) {
        return /(^|\/)(node_modules|dist|out|\.features-gen)(\/|$)/.test(rel);
      }
      return (
        /(^|\/)(node_modules|dist|out|\.features-gen)(\/|$)/.test(rel) || TS_SKIP_RE.test(rel)
      );
    },
    filePrefilter: (source, relPath) => mightContainStepDefs(relPath ?? '', source),
    extract: (source) => extractTsStepDefs(source),
    defaultFrameworkId: 'cucumber-js',
  },
];

/** Default path scopes for the member-DSL runner family (llman-sdd and similar). */
export const MEMBER_DSL_DEFAULTS = {
  stepRoots: ['tests/bdd'],
  featureRoots: ['llmanspec/specs', 'tests/bdd/features'],
  bindingEntry: 'tests/bdd/run.test.ts',
} as const;

/** Member-DSL feature roots (incl. nested monorepo tests/bdd/features trees). */
export const MEMBER_DSL_FEATURE_ROOTS = [
  'llmanspec/specs',
  'tests/bdd/features',
] as const;
