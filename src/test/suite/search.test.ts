import * as assert from 'assert';

import { mightContainStepDefs } from '../../search/fingerprints';
import { matchesAnyGlob } from '../../search/globMatch';
import { extractFromSource } from '../../search/pipeline';
import { BUILTIN_SCANNERS } from '../../profiles/builtin';

suite('Search plane (fingerprint → parse)', () => {
  test('fingerprint rejects files without registration shapes', () => {
    assert.ok(!mightContainStepDefs('src/util.ts', 'export function foo() {}'));
    assert.ok(mightContainStepDefs('steps/x.py', '@given("a")\ndef f(): pass'));
  });

  test('glob matcher supports ** segments', () => {
    assert.ok(matchesAnyGlob('tests/bdd/steps/a.ts', ['**/tests/bdd/**/*.ts']));
    assert.ok(!matchesAnyGlob('src/a.ts', ['**/tests/bdd/**/*.ts']));
  });

  test('pipeline extracts member DSL via language fingerprint', () => {
    const src = `bdd.given('hello', (ctx) => {});\n`;
    const defs = extractFromSource('tests/bdd/steps/x.ts', src, BUILTIN_SCANNERS);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].matcherKind, 'parse-lite');
  });
});
