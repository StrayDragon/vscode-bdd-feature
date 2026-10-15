import { extractPythonStepDefs } from '../scanners/pythonSteps';
import { extractRustStepDefs } from '../scanners/rustSteps';
import { extractTsStepDefs } from '../scanners/tsSteps';
import type { StepScanContributor } from './types';

export const SCAN_EXCLUDE =
  '**/{node_modules,target,dist,out,.git,.venv,venv,__pycache__,.cargo,.features-gen,bower_components}/**';

export const TS_SKIP_RE = /\.d\.tsx?$|[._](test|spec)\.[cm]?[jt]sx?$/;

export const BUILTIN_SCANNERS: StepScanContributor[] = [
  {
    id: 'pytest-bdd',
    languages: ['python'],
    globs: ['**/*step*.py', '**/test_*.py'],
    shouldSkipFile: () => false,
    filePrefilter: () => true,
    extract: (source) => extractPythonStepDefs(source),
    defaultFrameworkId: 'pytest-bdd',
  },
  {
    id: 'rstest-bdd',
    languages: ['rust'],
    globs: ['**/*.rs'],
    shouldSkipFile: (rel) => /(^|\/)(target|out|dist)(\/|$)/.test(rel),
    filePrefilter: (source) => /^\s*#\s*\[\s*(given|when|then)\s*\(/m.test(source),
    extract: (source) => extractRustStepDefs(source),
    defaultFrameworkId: 'rstest-bdd',
  },
  {
    id: 'cucumber-js',
    languages: ['typescript'],
    globs: ['**/*.ts', '**/*.js'],
    shouldSkipFile: (rel) =>
      /(^|\/)(node_modules|dist|out|\.features-gen)(\/|$)/.test(rel) || TS_SKIP_RE.test(rel),
    filePrefilter: (source) =>
      /\b(Given|When|Then|defineStep)\s*[(@]/.test(source) ||
      /\.(given|when|then|thenStep)\s*\(\s*['"`]/.test(source),
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
