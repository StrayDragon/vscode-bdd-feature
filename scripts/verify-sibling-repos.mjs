#!/usr/bin/env node
/**
 * Offline scan + undefined-step check for sibling BDD workspaces.
 * Usage: pnpm run verify:repos
 * Env: BDD_VERIFY_ROOT (default: parent of this repo)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { extractPythonStepDefs } from '../out/scanners/pythonSteps.js';
import { extractRustStepDefs } from '../out/scanners/rustSteps.js';
import { extractTsStepDefs } from '../out/scanners/tsSteps.js';
import {
  PY_STEP_GLOBS,
  RS_STEP_GLOBS,
  TS_STEP_GLOBS,
  TS_SKIP_RE,
} from '../out/profiles/builtin.js';
import {
  parseStepLine,
  parseScenarioLine,
  parseRuleLine,
  parseFeatureLine,
  parseBackgroundLine,
  detectDocumentLanguage,
  isStructuralKeyword,
} from '../out/gherkin/index.js';
import { stepMatchesDefinition } from '../out/matching.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

const REPOS = [
  {
    name: 'xylitol (tests/bdd)',
    dir: 'xylitol',
    stacks: ['rstest-bdd'],
    featureDirs: ['tests/bdd'],
  },
  {
    name: 'xylitol (llmanspec)',
    dir: 'xylitol',
    stacks: ['rstest-bdd'],
    featureDirs: ['llmanspec'],
    informational: true,
    note: '2 known missing steps in app-tui-transcript (upstream)',
  },
  {
    name: 'llman-sdd',
    dir: 'llman-sdd',
    stacks: ['member-dsl-bdd'],
    featureDirs: ['llmanspec/specs', 'tests/bdd/features'],
  },
  {
    name: 'crystalith (server bdd)',
    dir: 'crystalith',
    stacks: ['member-dsl-bdd'],
    featureDirs: ['apps/server/tests/bdd/features'],
    informational: true,
    note: 'many feature steps not yet in steps/common.ts (upstream port in progress)',
  },
  {
    name: 'crystalith (llmanspec)',
    dir: 'crystalith',
    stacks: ['member-dsl-bdd'],
    featureDirs: ['llmanspec/specs'],
    informational: true,
    note: 'spec coverage vs steps/common.ts is still incomplete in upstream',
  },
  {
    name: 'scalim',
    dir: 'scalim',
    stacks: [],
    featureDirs: ['llmanspec/specs'],
    informational: true,
    note: 'no pytest-bdd step modules — specs validated via llmanspec tooling',
  },
];

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
]);

function globToRegExp(glob) {
  const parts = glob.split('/');
  let re = '^';
  for (const part of parts) {
    if (part === '**') {
      re += '(?:.*/)?';
    } else {
      re += part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*') + '/';
    }
  }
  re = re.replace(/\/$/, '') + '$';
  return new RegExp(re);
}

const GLOB_RES = {
  py: PY_STEP_GLOBS.map(globToRegExp),
  rs: RS_STEP_GLOBS.map(globToRegExp),
  ts: TS_STEP_GLOBS.map(globToRegExp),
};

function walkFiles(root, rel = '') {
  const out = [];
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    return out;
  }
  for (const name of fs.readdirSync(abs)) {
    if (SKIP_DIR.has(name)) {
      continue;
    }
    const childRel = rel ? `${rel}/${name}` : name;
    const childAbs = path.join(root, childRel);
    let st;
    try {
      st = fs.statSync(childAbs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      out.push(...walkFiles(root, childRel));
    } else {
      out.push(childRel.replace(/\\/g, '/'));
    }
  }
  return out;
}

function matchesAny(rel, regs) {
  return regs.some(re => re.test(rel));
}

function scanRepo(repoRoot, stacks) {
  const all = walkFiles(repoRoot);
  const t0 = performance.now();
  const defs = [];
  let filesRead = 0;
  let filesMatched = 0;

  for (const rel of all) {
    if (stacks.includes('pytest-bdd') && rel.endsWith('.py') && matchesAny(rel, GLOB_RES.py)) {
      filesMatched++;
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      filesRead++;
      for (const d of extractPythonStepDefs(text)) {
        defs.push({
          lang: 'python',
          frameworkId: 'pytest-bdd',
          profileId: 'pytest-bdd',
          ...d,
        });
      }
    }
    if (stacks.includes('rstest-bdd') && rel.endsWith('.rs') && matchesAny(rel, GLOB_RES.rs)) {
      if (!/^\s*#\s*\[\s*(given|when|then)\s*\(/m.test(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))) {
        continue;
      }
      filesMatched++;
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      filesRead++;
      for (const d of extractRustStepDefs(text)) {
        defs.push({
          lang: 'rust',
          frameworkId: 'rstest-bdd',
          profileId: 'rstest-bdd',
          ...d,
        });
      }
    }
    if (
      stacks.includes('member-dsl-bdd') &&
      (rel.endsWith('.ts') || rel.endsWith('.js')) &&
      matchesAny(rel, GLOB_RES.ts) &&
      (!TS_SKIP_RE.test(rel) || /(^|\/)tests\/bdd\//.test(rel))
    ) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      if (
        !/\b(Given|When|Then|defineStep)\s*[(@]|\.(given|when|then|thenStep)\s*\(\s*['"`]/.test(
          text,
        )
      ) {
        continue;
      }
      filesMatched++;
      filesRead++;
      for (const d of extractTsStepDefs(text)) {
        const fw = d.matcherKind === 'parse-lite' ? 'member-dsl-bdd' : 'cucumber-js';
        defs.push({
          lang: 'typescript',
          frameworkId: fw,
          profileId: fw,
          ...d,
        });
      }
    }
  }
  const ms = performance.now() - t0;
  return { defs, ms, filesRead, filesMatched };
}

function analyzeUndefined(lines, defs) {
  const dialect = detectDocumentLanguage(lines.join('\n'));
  let inRuleDescription = false;
  const undef = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (parseFeatureLine(raw, dialect) !== undefined) {
      inRuleDescription = false;
      continue;
    }
    if (parseRuleLine(raw) !== undefined) {
      inRuleDescription = true;
      continue;
    }
    if (parseScenarioLine(raw, dialect) !== undefined) {
      inRuleDescription = false;
      continue;
    }
    if (parseBackgroundLine(raw) !== undefined) {
      inRuleDescription = false;
      continue;
    }
    if (isStructuralKeyword(raw) || inRuleDescription) {
      continue;
    }
    const parsed = parseStepLine(raw, dialect);
    if (!parsed) {
      continue;
    }
    let type = parsed.type;
    if (!type) {
      for (let j = i - 1; j >= 0; j--) {
        const p = parseStepLine(lines[j], dialect);
        if (p?.type) {
          type = p.type;
          break;
        }
        if (p === undefined && isStructuralKeyword(lines[j])) {
          break;
        }
      }
    }
    const n = defs.filter(
      d =>
        (d.type === 'step' || !type || d.type === type) &&
        stepMatchesDefinition(parsed.text, d),
    ).length;
    if (n === 0) {
      undef.push({ line: i, text: parsed.text });
    }
  }
  return undef;
}

function collectFeatures(repoRoot, featureDirs) {
  const features = [];
  for (const dir of featureDirs) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) {
      continue;
    }
    for (const rel of walkFiles(abs)) {
      if (rel.endsWith('.feature')) {
        features.push(path.join(dir, rel).replace(/\\/g, '/'));
      }
    }
  }
  return features.sort();
}

const verifyRoot = process.env.BDD_VERIFY_ROOT
  ? path.resolve(process.env.BDD_VERIFY_ROOT)
  : DEFAULT_ROOT;

let failed = false;
console.log(`BDD verify root: ${verifyRoot}\n`);

for (const repo of REPOS) {
  const repoRoot = path.join(verifyRoot, repo.dir);
  if (!fs.existsSync(repoRoot)) {
    console.log(`[${repo.name}] SKIP — not found: ${repoRoot}`);
    continue;
  }
  const { defs, ms, filesRead } = scanRepo(repoRoot, repo.stacks);
  const features = collectFeatures(repoRoot, repo.featureDirs);
  let totalUndef = 0;
  const samples = [];
  for (const f of features) {
    const lines = fs.readFileSync(path.join(repoRoot, f), 'utf8').split(/\r?\n/);
    const u = analyzeUndefined(lines, defs);
    totalUndef += u.length;
    if (u.length && samples.length < 3) {
      samples.push({ file: f, step: u[0].text.slice(0, 80) });
    }
  }
  const gate = repo.skipUndefinedCheck || repo.informational;
  const status = totalUndef === 0 ? 'OK' : gate ? 'INFO' : 'FAIL';
  if (totalUndef !== 0 && !gate) {
    failed = true;
  }
  console.log(
    `[${repo.name}] ${status} — defs=${defs.length} features=${features.length} undefinedSteps=${totalUndef} scanMs=${ms.toFixed(0)} filesRead=${filesRead}${repo.note ? ` (${repo.note})` : ''}`,
  );
  for (const s of samples) {
    console.log(`    e.g. ${s.file}: ${s.step}…`);
  }
  if (defs.length === 0 && features.length > 0) {
    console.log(`    warn: no step definitions extracted (stack ${repo.stacks.join(',')})`);
  }
}

process.exit(failed ? 1 : 0);
