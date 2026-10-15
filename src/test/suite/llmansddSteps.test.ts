/**
 * Verification against the REAL sibling llman-sdd repository (when present).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { extractTsStepDefs } from '../../scanners/tsSteps';
import { analyzeFeature } from '../../providers/diagnostics';
import { BUILTIN_SCANNERS, TS_SKIP_RE } from '../../profiles/builtin';
import type { StepDefinition } from '../../model';

function locateLlmanSdd(): string | undefined {
  const baseCandidates = [
    process.env.LLMAN_SDD_PATH,
    path.resolve(__dirname, '..', '..', '..', '..'),
    process.cwd(),
    process.cwd() ? path.dirname(process.cwd()) : '',
  ].filter((p): p is string => Boolean(p));

  for (const base of baseCandidates) {
    for (const sub of ['', 'llman-sdd']) {
      const candidate = path.join(base, sub);
      if (
        fs.existsSync(path.join(candidate, 'package.json')) &&
        fs.existsSync(path.join(candidate, 'llmanspec', 'specs'))
      ) {
        return candidate;
      }
    }
  }
  return undefined;
}

function walkFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      out.push(...walkFiles(p, ext));
    } else if (name.endsWith(ext)) {
      out.push(p);
    }
  }
  return out;
}

const tsContributor = BUILTIN_SCANNERS.find(s => s.id === 'cucumber-js')!;

function isTsStepModuleCandidate(relPath: string): boolean {
  return tsContributor.globs.some(g => globMatch(g, relPath)) && !TS_SKIP_RE.test(relPath);
}

function globMatch(pattern: string, relPath: string): boolean {
  const parts = pattern.split('/');
  const segments = relPath.split('/');
  let dp = new Array<boolean>(segments.length + 1).fill(false);
  dp[0] = true;
  for (const part of parts) {
    const next = new Array<boolean>(segments.length + 1).fill(false);
    for (let i = 0; i <= segments.length; i++) {
      if (!dp[i]) {
        continue;
      }
      if (part === '**') {
        for (let j = i; j <= segments.length; j++) {
          next[j] = true;
        }
        continue;
      }
      const segRe = new RegExp(`^${part.replace(/\./g, '\\.').replace(/\*/g, '[^/]*')}$`);
      if (i < segments.length && segRe.test(segments[i])) {
        next[i + 1] = true;
      }
    }
    dp = next;
  }
  return dp[segments.length] === true;
}

function toStepDefinitions(file: string, source: string): StepDefinition[] {
  return extractTsStepDefs(source).map(d => ({
    lang: 'typescript',
    frameworkId: d.matcherKind === 'parse-lite' ? 'member-dsl-bdd' : 'cucumber-js',
    profileId: d.matcherKind === 'parse-lite' ? 'member-dsl-bdd' : 'cucumber-js',
    type: d.type,
    matcherKind: d.matcherKind,
    text: d.text,
    file: vscode.Uri.file(file),
    decoratorLine: d.decoratorLine,
    functionLine: d.functionLine,
    functionName: d.functionName,
    patternSelection: d.patternSelection,
  }));
}

suite('llman-sdd real-repo verification (sibling checkout)', function () {
  const repo = locateLlmanSdd();

  test('locates the sibling ../llman-sdd repository (set LLMAN_SDD_PATH to override)', function () {
    if (!repo) {
      this.skip();
    }
  });

  if (!repo) {
    return;
  }

  const specsDir = path.join(repo, 'llmanspec', 'specs');
  const bddDir = path.join(repo, 'tests', 'bdd');

  if (!fs.existsSync(bddDir)) {
    test('tests/bdd exists in the sibling repo', function () {
      this.skip();
    });
    return;
  }

  const stepFiles = walkFiles(bddDir, '.ts').sort();
  const stepModuleFiles = stepFiles.filter(
    f => f.includes(`${path.sep}steps${path.sep}`) && !f.endsWith(`${path.sep}shared.ts`),
  );
  const featureFiles = fs
    .readdirSync(specsDir)
    .filter(f => f.endsWith('.feature'))
    .sort();

  assert.ok(featureFiles.length > 0, `no .feature files found under ${specsDir}`);
  assert.ok(stepModuleFiles.length > 0, `no step modules found under ${bddDir}/steps`);

  suite('discovery — llman-sdd step modules must be scan candidates', () => {
    test('every step module passes TS globs + TS_SKIP_RE', () => {
      const rejected = stepModuleFiles.filter(
        f => !isTsStepModuleCandidate(path.relative(repo, f).split(path.sep).join('/')),
      );
      assert.deepStrictEqual(
        rejected,
        [],
        `step modules the extension would never scan:\n${rejected.map(f => path.relative(repo, f)).join('\n')}`,
      );
    });
  });

  suite('extraction — real TS step files must yield definitions', () => {
    test('every step module extracts ≥1 definition', () => {
      const empty = stepModuleFiles.filter(
        f => extractTsStepDefs(fs.readFileSync(f, 'utf8')).length === 0,
      );
      assert.deepStrictEqual(empty, []);
    });

    test('validation.ts extracts every bdd.* registration site', () => {
      const validation = stepModuleFiles.find(f => f.endsWith(`${path.sep}validation.ts`));
      assert.ok(validation);
      const src = fs.readFileSync(validation, 'utf8');
      const sites = (src.match(/bdd\.(given|when|thenStep)\s*\(/g) ?? []).length;
      assert.strictEqual(extractTsStepDefs(src).length, sites);
    });
  });

  suite('matching — llmanspec/specs steps resolve (parse-lite)', () => {
    const defs = stepFiles.flatMap(f => toStepDefinitions(f, fs.readFileSync(f, 'utf8')));

    test('substantial definition set from tests/bdd', () => {
      assert.ok(defs.length >= 20, `expected ≥20 definitions, got ${defs.length}`);
    });

    for (const featureFile of featureFiles) {
      test(`${featureFile}: no undefined-step diagnostics`, () => {
        const lines = fs.readFileSync(path.join(specsDir, featureFile), 'utf8').split(/\r?\n/);
        const diags = analyzeFeature(lines, defs, true, {
          undefinedSteps: true,
          unboundFeatures: false,
        });
        const undefinedSteps = diags.filter(d => d.code === 'undefinedStep');
        assert.strictEqual(
          undefinedSteps.length,
          0,
          `steps without definition in ${featureFile} (${undefinedSteps.length}):\n` +
            `${undefinedSteps.map(d => lines[d.range.startLine]).join('\n')}`,
        );
      });
    }
  });
});
