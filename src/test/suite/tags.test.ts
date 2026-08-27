import * as assert from 'assert';

import {
  parseFeatureTags,
  compileTagExpression,
  TagExpressionError,
  tagExprToPytestMarker,
  tagExprToPlaywrightGrep,
} from '../../gherkin/tags';

const lines = (text: string | string[]): string[] =>
  Array.isArray(text) ? text : text.split('\n');

suite('Tag parsing', () => {
  test('feature + scenario tags with inheritance', () => {
    const parsed = parseFeatureTags(
      lines(
        [
          '@billing @bicker',
          'Feature: Verify billing',
          '',
          '  @important',
          '  Scenario: Missing product description',
          '    Given hello',
          '',
          '  Scenario: Several products',
          '    Given hello',
        ].join('\n'),
      ),
    );
    assert.strictEqual(parsed.featureName, 'Verify billing');
    const [s1, s2] = parsed.scenarios;
    assert.deepStrictEqual(s1!.own.map(t => t.tag), ['@important']);
    // feature tags inherit down
    assert.ok(s1!.effective.includes('@billing'));
    assert.ok(s1!.effective.includes('@important'));
    assert.deepStrictEqual(s2!.effective, ['@billing', '@bicker']);
    assert.strictEqual(parsed.problems.length, 0);
  });

  test('rule inheritance chain: feature → rule → scenario', () => {
    const parsed = parseFeatureTags(
      lines(
        [
          '@root',
          'Feature: F',
          '',
          '  @r1',
          '  Rule: R',
          '',
          '    @s1',
          '    Scenario: S',
          '      Given x',
        ].join('\n'),
      ),
    );
    const rule = parsed.nodes.find(n => n.kind === 'rule');
    const scen = parsed.scenarios[0];
    assert.deepStrictEqual(rule!.effective, ['@root', '@r1']);
    assert.deepStrictEqual(scen!.effective, ['@root', '@r1', '@s1']);
  });

  test('examples tags union into the outline for filtering', () => {
    const parsed = parseFeatureTags(
      lines(
        [
          'Feature: O',
          '  Scenario Outline: eat',
          '    Given eat <c>',
          '',
          '    @mobile',
          '    Examples:',
          '      | c |',
          '      | 1 |',
          '',
          '    @desktop',
          '    Examples:',
          '      | c |',
          '      | 2 |',
        ].join('\n'),
      ),
    );
    const outline = parsed.scenarios[0]!;
    assert.ok(outline.effective.includes('@mobile'));
    assert.ok(outline.effective.includes('@desktop'));
    const examples = parsed.nodes.filter(n => n.kind === 'examples');
    assert.strictEqual(examples.length, 2);
    assert.deepStrictEqual(examples[0]!.own.map(t => t.tag), ['@mobile']);
  });

  test('zh-CN headers and multi-tag lines parse', () => {
    const parsed = parseFeatureTags(
      lines(
        [
          '# language: zh-CN',
          '@计费 @冒烟',
          '功能: 验证账单',
          '',
          '  @重要',
          '  场景: 缺少商品描述',
          '    假设 你好',
        ].join('\n'),
      ),
    );
    assert.deepStrictEqual(parsed.scenarios[0]!.own.map(t => t.tag), ['@重要']);
    assert.ok(parsed.scenarios[0]!.effective.includes('@计费'));
  });

  test('misplaced tag block dissolves before steps; background rejected', () => {
    const parsed = parseFeatureTags(
      lines(
        [
          'Feature: F',
          '',
          '  @orphan',
          '  Given a step directly after tags',
          '',
          '  @bad',
          '  Background:',
          '    Given setup',
          '',
          '  Scenario: ok',
          '    Given x',
        ].join('\n'),
      ),
    );
    assert.strictEqual(parsed.scenarios.length, 1);
    const codes = parsed.problems.map(p => p.code);
    assert.ok(codes.includes('misplacedTag'), `expected misplacedTag, got ${codes}`);
    // the orphan dissolved silently (gherkin behavior) — no node carries it
    assert.ok(!parsed.scenarios[0]!.effective.includes('@orphan'));
  });

  test('duplicate tag on one element is flagged once per repeat', () => {
    const parsed = parseFeatureTags(lines(['Feature: F', '  @a @a', '  Scenario: S', '    Given x']));
    const dup = parsed.problems.find(p => p.code === 'duplicateTag');
    assert.ok(dup, 'expected duplicateTag problem');
    // effective list stays deduped
    assert.strictEqual(parsed.scenarios[0]!.effective.filter(t => t === '@a').length, 1);
  });

  test('invalid tokens produce errors and are skipped', () => {
    const parsed = parseFeatureTags(lines(['Feature: F', '  @@oops @ok', '  Scenario: S', '    Given x']));
    const invalid = parsed.problems.find(p => p.code === 'invalidTag' && p.severity === 'error');
    assert.ok(invalid);
    assert.deepStrictEqual(parsed.scenarios[0]!.own.map(t => t.tag), ['@ok']);
  });

  test('comments between tag lines keep the block attached', () => {
    const parsed = parseFeatureTags(
      lines(['Feature: F', '  # note', '  @a', '  # another', '  @b', '  Scenario: S', '    Given x']),
    );
    assert.deepStrictEqual(parsed.scenarios[0]!.own.map(t => t.tag), ['@a', '@b']);
  });

  test('tag spans carry exact positions', () => {
    const parsed = parseFeatureTags(lines(['@alpha @beta-two', 'Feature: F', 'Scenario: S', 'Given x']));
    const own = parsed.nodes[0]!.own;
    assert.strictEqual(own[0]!.line, 0);
    assert.strictEqual(own[0]!.startCol, 0);
    assert.strictEqual(own[0]!.endCol, 6);
    assert.strictEqual(own[1]!.startCol, 7);
    assert.strictEqual(own[1]!.endCol, 16);
  });
});

suite('Tag expressions', () => {
  const set = (...tags: string[]): ReadonlySet<string> => new Set(tags);

  test('single tag & missing tag', () => {
    const pred = compileTagExpression('@fast');
    assert.ok(pred(set('@fast')));
    assert.ok(!pred(set('@slow')));
  });

  test('and / or precedence: "a or b and c" ≡ "a or (b and c)"', () => {
    const pred = compileTagExpression('@a or @b and @c');
    assert.ok(pred(set('@a')));
    assert.ok(pred(set('@b', '@c')));
    assert.ok(!pred(set('@b'))); // b alone doesn't satisfy b∧c
  });

  test('not binds tighter than and', () => {
    const pred = compileTagExpression('@wip and not @slow');
    assert.ok(pred(set('@wip')));
    assert.ok(!pred(set('@wip', '@slow')));
  });

  test('parentheses override precedence', () => {
    const pred = compileTagExpression('(@smoke or @ui) and not @slow');
    assert.ok(pred(set('@smoke')));
    assert.ok(!pred(set('@smoke', '@slow')));
    assert.ok(!pred(set('@other')));
  });

  test('operators are case-insensitive', () => {
    const pred = compileTagExpression('@a AND NOT @b OR @c');
    assert.ok(pred(set('@a')));
    assert.ok(pred(set('@c')));
    assert.ok(!pred(set('@a', '@b')));
  });

  test('legacy ~ negation prefix', () => {
    const pred = compileTagExpression('@wip ~@draft');
    assert.ok(pred(set('@wip')));
    assert.ok(!pred(set('@wip', '@draft')));
  });

  test('bare atoms normalize to @-prefixed tags', () => {
    const pred = compileTagExpression('smoke and not slow');
    assert.ok(pred(set('@smoke')));
    assert.ok(!pred(set('@smoke', '@slow')));
  });

  test('syntax errors report position', () => {
    assert.throws(() => compileTagExpression('(@a and'), TagExpressionError);
    assert.throws(() => compileTagExpression('@a or'), TagExpressionError);
    assert.throws(() => compileTagExpression(''), TagExpressionError);
    // Adjacent terms imply AND (lenient), but dangling operators stay invalid
    try {
      compileTagExpression('@a or or @b');
      assert.fail('expected throw');
    } catch (e) {
      assert.ok(e instanceof TagExpressionError);
      assert.match(e.message, /Expected a tag/);
    }
    // ...while adjacent atoms themselves are accepted
    const implicit = compileTagExpression('@a @b');
    assert.ok(implicit(set('@a', '@b')));
    assert.ok(!implicit(set('@a')));
  });
});

suite('Runner filter translation', () => {
  test('pytest marker expression strips @ and keeps operators', () => {
    assert.strictEqual(tagExprToPytestMarker('@smoke and not @slow'), 'smoke and not slow');
    assert.strictEqual(tagExprToPytestMarker('(@a or @b) and @c'), '( a or b ) and c');
  });

  test('pytest rejects non-identifier tags instead of emitting broken CLI', () => {
    assert.throws(() => tagExprToPytestMarker('@ci-daily'), TagExpressionError);
  });

  test('playwright grep handles and/not/or composition', () => {
    const re = new RegExp(`^${tagExprToPlaywrightGrep('@smoke and not @slow')}`);
    assert.ok(re.test('login works @smoke @core'));
    assert.ok(!re.test('login works @smoke @slow'));
    const orRe = new RegExp(`^${tagExprToPlaywrightGrep('@a or @b')}`);
    assert.ok(orRe.test('x @b'));
    assert.ok(!orRe.test('x @c'));
  });

  test('playwright grep lowers nested not via De Morgan', () => {
    // !(a ∧ b) matches when at least one is absent
    const re = new RegExp(`^${tagExprToPlaywrightGrep('not (@a and @b)')}`);
    assert.ok(re.test('only-a-here @a'));
    assert.ok(re.test('nothing here'));
    assert.ok(!re.test('both @a @b'));
  });

  test('grep regex keeps tags word-bounded', () => {
    const re = new RegExp(`^${tagExprToPlaywrightGrep('@ci')}`);
    assert.ok(re.test('job @ci'));
    assert.ok(!re.test('job @city')); // prefix must not match
  });
});
