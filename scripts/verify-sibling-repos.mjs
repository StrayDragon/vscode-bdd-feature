#!/usr/bin/env node
/**
 * Generic workspace scan report (search plane validation).
 *
 * Usage:
 *   pnpm run verify:repos                    # default: sibling dirs under parent
 *   pnpm run verify:repos -- /path/a /path/b
 *   BDD_VERIFY_PATHS=xylitol,llman-sdd pnpm run verify:repos
 *
 * Env:
 *   BDD_VERIFY_ROOT — parent directory when using short dir names
 *   BDD_VERIFY_PATHS — comma-separated repo paths (absolute or under ROOT)
 *   --fail-on-undefined — exit 1 if any feature step lacks a definition
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkspaceRoot } from '../out/search/nodeScan.js';
import { collectFeatureRelPaths } from '../out/search/nodeWalk.js';
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
const DEFAULT_PARENT = path.resolve(__dirname, '..', '..');

const failOnUndefined = process.argv.includes('--fail-on-undefined');
const cliPaths = process.argv.slice(2).filter(a => !a.startsWith('--'));

function resolveTargets() {
  if (cliPaths.length > 0) {
    return cliPaths.map(p => path.resolve(p));
  }
  const fromEnv = process.env.BDD_VERIFY_PATHS;
  if (fromEnv) {
    const root = process.env.BDD_VERIFY_ROOT
      ? path.resolve(process.env.BDD_VERIFY_ROOT)
      : DEFAULT_PARENT;
    return fromEnv.split(',').map(s => {
      const t = s.trim();
      return path.isAbsolute(t) ? t : path.join(root, t);
    });
  }
  const parent = process.env.BDD_VERIFY_ROOT
    ? path.resolve(process.env.BDD_VERIFY_ROOT)
    : DEFAULT_PARENT;
  if (!fs.existsSync(parent)) {
    return [];
  }
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => path.join(parent, d.name))
    .filter(abs => collectFeatureRelPaths(abs).length > 0);
}

function analyzeUndefined(lines, defs) {
  const dialect = detectDocumentLanguage(lines.join('\n'));
  let inRuleDescription = false;
  let total = 0;
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
      total++;
    }
  }
  return total;
}

function toStepDefs(extracted) {
  return extracted.map(d => ({
    lang: d.lang,
    frameworkId: d.frameworkId,
    profileId: d.frameworkId,
    type: d.type,
    matcherKind: d.matcherKind,
    text: d.text,
    file: { fsPath: '' },
    decoratorLine: d.decoratorLine,
  }));
}

let anyUndefined = 0;

for (const root of resolveTargets()) {
  if (!fs.existsSync(root)) {
    console.log(`[skip] ${root} (missing)`);
    continue;
  }
  const name = path.basename(root);
  const { definitions, stats, ms, rescanned, reused, usedRipgrep } = await scanWorkspaceRoot(root);
  const defs = toStepDefs(definitions);
  const features = collectFeatureRelPaths(root);
  let undef = 0;
  for (const rel of features) {
    const lines = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
    undef += analyzeUndefined(lines, defs);
  }
  anyUndefined += undef;
  const mbRead = (stats.bytesRead / (1024 * 1024)).toFixed(2);
  console.log(
    `[${name}] defs=${definitions.length} features=${features.length} undefinedSteps=${undef} ` +
      `scanMs=${ms.toFixed(0)} candidates=${stats.candidates} ` +
      `fpSkip=${stats.skippedFingerprint} parsed=${stats.parsed} readMiB=${mbRead} ` +
      `rg=${usedRipgrep} rescanned=${rescanned} reused=${reused}`,
  );
}

if (failOnUndefined && anyUndefined > 0) {
  process.exit(1);
}
