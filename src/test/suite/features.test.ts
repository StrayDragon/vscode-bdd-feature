import * as assert from 'assert';
import { alignTables, displayWidth, splitRow, alignTablesText } from '../../providers/tableFormat';
import { computeBlockSpans, findDocstrings } from '../../providers/symbols';
import { analyzeFeature } from '../../providers/diagnostics';

suite('Table alignment (CJK-width aware)', () => {
  test('displayWidth counts wide chars as 2', () => {
    assert.strictEqual(displayWidth('abc'), 3);
    assert.strictEqual(displayWidth('金牌'), 4);
    assert.strictEqual(displayWidth('a金b'), 4);
  });

  test('preserves CRLF line endings', () => {
    // Regression: joining with \n corrupted CRLF documents
    const text = '功能: x\r\n  | a | bb |\r\n  | 金牌 | 1 |';
    const out = alignTablesText(text);
    assert.ok(out.includes('\r\n'), 'must keep CRLF endings');
    assert.strictEqual((out.match(/\r\n/g) ?? []).length, 2);
    // and still aligns
    assert.ok(out.includes('| a    | bb |') || out.includes('| a   | bb '), out);
  });

  test('splitRow trims cells and outer pipes', () => {
    assert.deepStrictEqual(splitRow('  | a | b c | '), ['a', 'b c']);
  });

  test('aligns columns by display width', () => {
    const lines = [
      '功能: x',
      '  | level | amount |',
      '  | 金牌 | 100 |',
      '  | silver | 5 |',
    ];
    const out = alignTables(lines);
    assert.deepStrictEqual(out.slice(1), [
      '  | level  | amount |',
      '  | 金牌   | 100    |',
      '  | silver | 5      |',
    ]);
    // visual width of each data row must match header
    const w = (s: string) => displayWidth(s);
    assert.strictEqual(w(out[1]), w(out[2]));
    assert.strictEqual(w(out[1]), w(out[3]));
  });

  test('regenerates separator rows to match widths', () => {
    const lines = ['| a | bb |', '|-|--|', '| x | y |'];
    const out = alignTables(lines);
    // separator dashes span the column's display width + 2 padding spaces
    assert.strictEqual(out[1], '| --- | ---- |');
  });

  test('only touches groups intersecting the range', () => {
    const lines = ['| a |', '', '| b |'];
    const out = alignTables(lines, 2, 2);
    assert.strictEqual(out[0], '| a |'); // untouched single-row group
    assert.strictEqual(out[2], '| b |');
  });
});

suite('Block spans & folding core', () => {
  const lines = [
    '# language: zh-CN',
    '功能: 登录',
    '  说明文字',
    '',
    '  背景:',
    '    假如 已初始化',
    '',
    '  场景: 成功登录',
    '    假如 用户存在',
    '',
    '  场景大纲: 折扣 <d>',
    '    那么 应付 <p>',
    '',
    '  """docstring start',
    '  more',
    '  """ end',
    '',
  ];

  test('classifies headers and computes block ends before next header', () => {
    const spans = computeBlockSpans(lines);
    const roles = spans.map(s => s.role);
    assert.deepStrictEqual(roles, ['feature', 'background', 'scenario', 'scenario']);
    const bg = spans.find(s => s.role === 'background')!;
    assert.strictEqual(bg.endLine, 5); // trailing blank trimmed
    const sc1 = spans.filter(s => s.role === 'scenario')[0];
    assert.strictEqual(sc1.endLine, 8);
    assert.strictEqual(sc1.title, '成功登录');
  });

  test('finds docstring ranges', () => {
    assert.deepStrictEqual(findDocstrings(lines), [[13, 15]]);
  });

  test('zh-TW structural keywords resolve via spec data (no hardcoding)', () => {
    // Per official gherkin-languages.json, zh-TW rule keyword is "Rule"
    // (unlike zh-CN which adds 规则) — the engine follows the data.
    const tw = ['功能: 測試', '', '  Rule: 規則一', '    場景: 登入', '      假如 已註冊'];
    const spans = computeBlockSpans(tw);
    assert.deepStrictEqual(
      spans.map(s => s.role),
      ['feature', 'rule', 'scenario'],
    );
    assert.strictEqual(spans[1].title, '規則一');
  });
});

suite('Diagnostics analysis core', () => {
  const defs = [
    {
      lang: 'python' as const,
      type: 'given' as const,
      matcherKind: 'exact' as const,
      text: '已初始化的系统',
      file: { fsPath: '/x.py' } as never,
      decoratorLine: 0,
    },
    {
      lang: 'python' as const,
      type: 'given' as const,
      matcherKind: 'parse' as const,
      text: '用户 {uid:d} 存在',
      file: { fsPath: '/x.py' } as never,
      decoratorLine: 4,
    },
  ];

  test('flags undefined steps and inherits And/But types', () => {
    const lines = ['功能: t', '场景: s', '假如 已初始化的系统', '并且 系统运行中', '当 未定义动作'];
    const out = analyzeFeature(lines, defs, true, { undefinedSteps: true, unboundFeatures: false });
    // 并且 inherits given → 已定义? no def matches "系统运行中" → undefined too
    const texts = out.map(d => d.message);
    assert.ok(texts.some(m => m.includes('系统运行中')));
    assert.ok(texts.some(m => m.includes('未定义动作')));
    assert.ok(!texts.some(m => m.includes('已初始化的系统')));
  });

  test('typed param step resolves via parse definition', () => {
    const lines = ['功能: t', '场景: s', '假如 用户 42 存在'];
    const out = analyzeFeature(lines, defs, true, { undefinedSteps: true, unboundFeatures: false });
    assert.strictEqual(out.length, 0);
  });

  test('unbound warning only when toggle on and scenarios exist', () => {
    const lines = ['功能: t', '场景: s', '假如 x'];
    void defs;
    const off = analyzeFeature(lines, [], false, { undefinedSteps: false, unboundFeatures: false });
    assert.strictEqual(off.length, 0);
    const on = analyzeFeature(lines, [], false, { undefinedSteps: false, unboundFeatures: true });
    assert.strictEqual(on.length, 1);
    assert.strictEqual(on[0].code, 'unboundFeature');
  });

  test('table row containing a colon does not break And/But inheritance', () => {
    // Regression: ad-hoc structural regex treated "| time: x" as a boundary
    const lines = [
      'Feature: t',
      'Scenario: s',
      'Given an approved merchant',
      '| time: noon |',
      'And the queue is empty',
    ];
    const out = analyzeFeature(lines, defs, true, { undefinedSteps: true, unboundFeatures: false });
    // "the queue is empty" inherits given → no exact def matches it
    const msgs = out.map(d => d.message);
    assert.ok(msgs.some(m => m.includes('the queue is empty')));
  });
});
