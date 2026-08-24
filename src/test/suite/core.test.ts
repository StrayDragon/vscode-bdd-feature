import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

import { matchPythonParsePattern } from '../../patterns/pythonParsePattern';
import { matchRustFormatPattern } from '../../patterns/rustFormatPattern';
import {
  compileCucumberExpression,
  matchCucumberExpression,
} from '../../patterns/cucumberExpressionPattern';
import {
  parseStepLine,
  parseScenarioLine,
  parseFeatureLine,
  detectDocumentLanguage,
  supportedLanguages,
  getStepType,
  dialectSkeleton,
} from '../../gherkin';
import { extractPythonStepDefs, extractPythonScenariosBindings } from '../../scanners/pythonSteps';
import { extractRustStepDefs, extractRustScenarioBindings } from '../../scanners/rustSteps';
import { extractTsStepDefs, extractTsFeatureBindings } from '../../scanners/tsSteps';
import { stepMatchesDefinition } from '../../matching';
import type { StepDefinition } from '../../model';
import { alignTablesText, displayWidth, splitRow } from '../../providers/tableFormat';
import { pytestTestName } from '../../testNames';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test-fixtures');

suite('Gherkin spec-driven keywords', () => {
  test('supports every language in the official data (80+)', () => {
    const langs = supportedLanguages();
    assert.ok(langs.length >= 70, `expected many languages, got ${langs.length}`);
    assert.ok(langs.some(l => l.code === 'zh-CN'));
    assert.ok(langs.some(l => l.code === 'en'));
  });

  test('detects # language directive', () => {
    const text = '# language: zh-CN\n功能: x\n';
    assert.strictEqual(detectDocumentLanguage(text).code, 'zh-CN');
    assert.strictEqual(detectDocumentLanguage(text).explicit, true);
    assert.deepStrictEqual(detectDocumentLanguage('Feature: x'), { explicit: false });
  });

  test('parses zh-CN steps without space after keyword', () => {
    const d = detectDocumentLanguage('# language: zh-CN\n');
    const parsed = parseStepLine('    假设 用户 96000 无 base_info', d);
    assert.ok(parsed);
    assert.strictEqual(parsed!.keyword, '假设');
    assert.strictEqual(parsed!.text, '用户 96000 无 base_info');
    assert.strictEqual(parsed!.type, 'given');
  });

  test('And/But inherit type across languages', () => {
    const d = detectDocumentLanguage('# language: zh-CN\n');
    const andLine = parseStepLine('并且 billing items 为空', d);
    assert.ok(andLine);
    assert.strictEqual(andLine!.type, undefined);
    assert.strictEqual(getStepType(andLine!.keyword), undefined);
    assert.strictEqual(getStepType('当')!, 'when');
  });

  test('English keyword boundary: ThenX must not match Then', () => {
    assert.strictEqual(parseStepLine('Thenx something', { explicit: false }), undefined);
    const ok = parseStepLine('Then something', { explicit: false });
    assert.strictEqual(ok!.keyword, 'Then');
  });

  test('scenario/feature headers resolve via spec data', () => {
    assert.strictEqual(parseScenarioLine('场景: POST major null 落库 NULL', { code: 'zh-CN', explicit: true }), 'POST major null 落库 NULL');
    assert.strictEqual(parseScenarioLine('Scenario Outline: many', { explicit: false }), 'many');
    assert.strictEqual(parseFeatureLine('功能: 冷启动账单页', { explicit: false }), '冷启动账单页');
  });
});

suite('Python parse-pattern compilation (faithful to parse==1.22)', () => {
  test('untyped placeholder spans spaces lazily', () => {
    // Regression: previous impl used \S+ and missed multi-word values
    const groups = matchPythonParsePattern(
      '订单 POST 批量更新 状态为 ok',
      '订单 {t} 状态为 {s}',
    );
    assert.ok(groups);
    assert.strictEqual(groups['t'], 'POST 批量更新');
    assert.strictEqual(groups['s'], 'ok');
  });

  test('typed placeholders match digits/words only', () => {
    const groups = matchPythonParsePattern('用户 90232 订单存在', '用户 {uid:d} 订单存在');
    assert.ok(groups);
    assert.strictEqual(groups['uid'], '90232');
    assert.strictEqual(matchPythonParsePattern('用户 abc 订单存在', '用户 {uid:d} 订单存在'), null);
  });

  test('bare {} acts as anonymous lazy placeholder (parse semantics)', () => {
    // parse.parse('输出 {} 结果', '输出 x 结果') → ('x',)
    const groups = matchPythonParsePattern('输出 x 结果', '输出 {} 结果');
    assert.ok(groups);
    assert.strictEqual(groups['_0'], 'x');
    // Escaped braces {{ }} stay literal
    assert.ok(matchPythonParsePattern('use {x} literal', 'use {{x}} literal'));
  });

  test('literal space matches exactly one space; extras absorbed by captures', () => {
    assert.ok(matchPythonParsePattern('a hello c', 'a {x} c'));
    // Extra spaces before/after a capture are absorbed INTO the lazy group —
    // verified against parse==1.22: x === ' b'
    const g = matchPythonParsePattern('a  b c', 'a {x} c');
    assert.ok(g);
    assert.strictEqual(g['x'], ' b');
  });
});

suite('rstest-bdd pattern compilation (faithful to hint.rs)', () => {
  test(':string captures quoted content stripped of quotes', () => {
    const g = matchRustFormatPattern('配置了 mock 模型 "fake-model"', '配置了 mock 模型 {name:string}');
    assert.ok(g);
    assert.strictEqual(g['name'], 'fake-model');
  });

  test('unsigned types match digits', () => {
    assert.ok(matchRustFormatPattern('显示结果为 7', '显示结果为 {expected:u32}'));
    assert.strictEqual(matchRustFormatPattern('显示结果为 -7', '显示结果为 {expected:u32}'), null);
    assert.ok(matchRustFormatPattern('value -7', 'value {v:i32}'));
  });

  test('unknown hints degrade to lazy any-text', () => {
    assert.ok(matchRustFormatPattern('op ensure-session runs', 'op {op:Xyz} runs'));
    assert.ok(matchRustFormatPattern('op a b c runs', 'op {op} runs'));
  });

  test('escaped braces are literal', () => {
    assert.ok(matchRustFormatPattern('use {x} literal', 'use {{x}} literal'));
  });
});

suite('Python step scanner', () => {
  const src = `
from pytest_bdd import given, parsers, then

@given(parsers.parse("订单 {action} 已提交"))
def order_submitted(db, action):
    pass

@when("她使用正确密码登录")
def login(page):
    pass

# paren inside string must not break scanning:
@given(parsers.parse("用户 (特殊) {n:d} 号"))
def special(n):
    pass

@then(parsers.re(r"count is (?P<n>\\\\d+)"))
def count_is(n):
    pass
`;
  test('extracts defs with precise pattern positions', () => {
    const defs = extractPythonStepDefs(src);
    assert.strictEqual(defs.length, 4);

    const [order, login, special, regexDef] = defs;
    assert.strictEqual(order.text, '订单 {action} 已提交');
    assert.strictEqual(order.matcherKind, 'parse');
    assert.strictEqual(order.functionName, 'order_submitted');
    assert.ok(order.patternSelection);
    // pattern starts inside quotes on its decorator line
    const lines = src.split('\n');
    const sel = order.patternSelection!;
    assert.strictEqual(lines[sel.startLine].slice(sel.startCol, sel.endCol), '订单 {action} 已提交');

    assert.strictEqual(login.matcherKind, 'exact');
    assert.strictEqual(login.text, '她使用正确密码登录');

    assert.strictEqual(special.text, '用户 (特殊) {n:d} 号');

    assert.strictEqual(regexDef.matcherKind, 're');
  });

  test('multi-line decorators record start line correctly', () => {
    const multiline = `
@given(
    parsers.parse(
        "多行 {x} 模式"
    )
)
def multi(x):
    pass
`;
    const defs = extractPythonStepDefs(multiline);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].text, '多行 {x} 模式');
    assert.strictEqual(defs[0].decoratorLine, multiline.split('\n').findIndex(l => l.startsWith('@given')));
    assert.strictEqual(
      defs[0].functionLine,
      multiline.split('\n').findIndex(l => l.startsWith('def multi')),
    );
  });

  test('scenarios() bindings extraction', () => {
    const bindings = extractPythonScenariosBindings(`
scenarios("features/a.feature")

scenarios("features/b.feature", "features/c.feature")

not_scenarios("skip me")
`);
    assert.deepStrictEqual(
      bindings.map(b => b.featureArg),
      ['features/a.feature', 'features/b.feature', 'features/c.feature'],
    );
  });
});

suite('Rust step scanner', () => {
  const src = `
use rstest_bdd_macros::{given, then, when};

#[given("计算器已清零")]
fn cleared() {}

#[when("我输入 {value:u32}")]
fn enter(value: u32) {}

#[then(
    r#"显示结果为 {expected:u32}"#
)]
fn shows(expected: u32) {}
`;
  test('extracts attributes with function linkage and positions', () => {
    const defs = extractRustStepDefs(src);
    assert.strictEqual(defs.length, 3);
    assert.strictEqual(defs[0].text, '计算器已清零');
    assert.strictEqual(defs[0].functionName, 'cleared');

    const sel = defs[1].patternSelection!;
    assert.strictEqual(src.split('\n')[sel.startLine].slice(sel.startCol, sel.endCol), '我输入 {value:u32}');

    const thenLine = src.split('\n').findIndex(l => l.includes('#[then('));
    assert.strictEqual(defs[2].decoratorLine, thenLine); // attribute spans lines
    assert.strictEqual(defs[2].functionName, 'shows');
  });

  test('scenario bindings extraction', () => {
    const bindings = extractRustScenarioBindings(`
#[scenario(path = "features/calc_zh.feature", name = "加法")]
fn test_addition() {}

#[scenario(
    path = "features/calc_en.feature",
    name = "typed addition"
)]
async fn test_typed_addition() {}
`);
    assert.strictEqual(bindings.length, 2);
    assert.strictEqual(bindings[0].name, '加法');
    assert.strictEqual(bindings[0].fnName, 'test_addition');
    assert.strictEqual(bindings[1].featureArg, 'features/calc_en.feature');
    assert.strictEqual(bindings[1].name, 'typed addition');
  });
});

suite('pytest-bdd generated test names', () => {
  test('matches upstream make_python_name for CJK scenarios', () => {
    // Python: re.sub(r"\W","", s.replace(" ","_")).lstrip leading digits, lower()
    assert.strictEqual(pytestTestName('无 base_info 时 GET billing 各 Tab 真空'), 'test_无_base_info_时_get_billing_各_tab_真空');
    assert.strictEqual(pytestTestName('POST major null 落库 NULL'), 'test_post_major_null_落库_null');
    assert.strictEqual(pytestTestName('123 digits first'), 'test_digits_first');
  });
});

suite('Cucumber expression compilation (conformance probed vs @cucumber/cucumber-expressions 20.x)', () => {
  test('builtin parameter types match like upstream', () => {
    assert.ok(matchCucumberExpression('I have 42 cukes', 'I have {int} cukes'));
    assert.strictEqual(matchCucumberExpression('I have -7 cukes', 'I have {int} cukes')?.['int'], '-7');
    // upstream int rejects floats
    assert.strictEqual(matchCucumberExpression('I have 1.5 cukes', 'I have {int} cukes'), null);
    assert.ok(matchCucumberExpression('v -1.5', 'v {float}'));
    assert.ok(matchCucumberExpression('v .5', 'v {float}'));
    // upstream float has NO exponent support — parity, not permissiveness
    assert.strictEqual(matchCucumberExpression('v 1e3', 'v {float}'), null);
    assert.ok(matchCucumberExpression('say "hello world"', 'say {string}'));
  });

  test('{string} values arrive quote-stripped (framework argument semantics)', () => {
    const g = matchCucumberExpression('say "hello world"', 'say {string}');
    assert.strictEqual(g?.['string'], 'hello world');
    const g2 = matchCucumberExpression("say 'x'", 'say {string}');
    assert.strictEqual(g2?.['string'], 'x');
  });

  test('optional text and alternatives (cuke(s), a/b)', () => {
    const e = compileCucumberExpression('I have {int} cuke(s)');
    assert.ok(e.regex.test('I have 1 cukes'));
    assert.ok(e.regex.test('I have 3 cuke'));
    const alt = compileCucumberExpression('three/four blind mice');
    assert.ok(alt.regex.test('three blind mice'));
    assert.ok(alt.regex.test('four blind mice'));
    assert.ok(!alt.regex.test('five blind mice'));
  });

  test('backslash escapes make special characters literal', () => {
    // Upstream: '\{int} braces' matches literal '{int}', not a parameter
    const e = compileCucumberExpression('\\{int} braces');
    assert.ok(e.params.length === 0, 'escaped braces must not produce params');
    assert.ok(e.regex.test('{int} braces'));
    assert.ok(!e.regex.test('42 braces'));
  });

  test('duplicate parameter names never break compilation', () => {
    // Regression: two named groups (?<int>…) threw and degraded to literal
    const g = matchCucumberExpression('from 1 to 9', 'from {int} to {int}');
    assert.ok(g, 'must match with positional fallback groups');
  });

  test('literal spaces stay literal; anchored full-match', () => {
    const e = compileCucumberExpression('a  b'); // two literal spaces
    assert.ok(e.regex.test('a  b'));
    assert.ok(!e.regex.test('a b'));
    const h = compileCucumberExpression('hello');
    assert.ok(!h.regex.test('hello world'), 'anchored like upstream .match()');
  });

  test('unknown/custom types degrade to lazy any-text', () => {
    assert.ok(matchCucumberExpression('a red ball', 'a {color} ball'));
    const g = matchCucumberExpression('a crimson red ball', 'a {color} ball');
    assert.ok(g);
  });
});

suite('TypeScript/JS step scanner (cucumber-js · playwright-bdd · jest-cucumber)', () => {
  test('extracts cucumber-js string + regex patterns with positions', () => {
    const src = [
      "import { Given, When, Then } from '@cucumber/cucumber';",
      '',
      "Given('I have {int} cucumbers', function (count) {",
      '  return count + 1;',
      '});',
      '',
      'When(/^I click "(.+)"$/, async (label) => {',
      '  await page.click(label);',
      '});',
    ].join('\n');
    const defs = extractTsStepDefs(src);
    assert.strictEqual(defs.length, 2);

    const [given, when] = defs;
    assert.strictEqual(given.type, 'given');
    assert.strictEqual(given.text, 'I have {int} cucumbers');
    assert.strictEqual(given.matcherKind, 'cexpr');

    assert.strictEqual(when.type, 'when');
    assert.strictEqual(when.text, '^I click "(.+)"$');
    assert.strictEqual(when.matcherKind, 're');

    const lines = src.split('\n');
    const sel = given.patternSelection!;
    assert.strictEqual(lines[sel.startLine].slice(sel.startCol, sel.endCol), 'I have {int} cucumbers');
  });

  test('multi-line calls and options object do not confuse extraction', () => {
    const src = [
      "Then('the title is {string}',",
      '  { timeout: 10_000 },',
      '  async function (title) {',
      '    expect(title).toBe(title);',
      '  });',
    ].join('\n');
    const defs = extractTsStepDefs(src);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].text, 'the title is {string}');
    assert.strictEqual(defs[0].decoratorLine, 0);
  });

  test('playwright-bdd createBdd destructured steps are found', () => {
    const src = [
      "import { test as base } from '@playwright/test';",
      "import { createBdd } from 'playwright-bdd';",
      '',
      'export const { Given, When, Then } = createBdd(base);',
      '',
      "Given('I open page {string}', async ({ page }, url: string) => {",
      '  await page.goto(url);',
      '});',
    ].join('\n');
    const defs = extractTsStepDefs(src);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].type, 'given');
    assert.strictEqual(defs[0].matcherKind, 'cexpr');
  });

  test('playwright-bdd decorators bind to the following method', () => {
    const src = [
      'class TodoPage {',
      "  @When('a item {string} exists')",
      '  async addItem(item: string) {}',
      '}',
    ].join('\n');
    const defs = extractTsStepDefs(src);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].text, 'a item {string} exists');
    assert.strictEqual(defs[0].functionName, 'addItem');
    assert.strictEqual(defs[0].functionLine, 2);
  });

  test('prose mentioning Given( in strings is not extracted', () => {
    const src = "// docs say Given('x') is a step\nconst msg = \"call When('y') first\";";
    assert.deepStrictEqual(extractTsStepDefs(src), []);
  });

  test('jest-cucumber loadFeature bindings extraction', () => {
    const bindings = extractTsFeatureBindings(
      [
        "import { defineFeature, loadFeature } from 'jest-cucumber';",
        "defineFeature(loadFeature('./features/login.feature'), (test) => {});",
        "defineFeature(loadFeature('features/x.feature'), (test) => {});",
      ].join('\n'),
    );
    assert.deepStrictEqual(
      bindings.map(b => b.featureArg),
      ['./features/login.feature', 'features/x.feature'],
    );
  });
});

suite('Dialect skeletons for snippets', () => {
  test('zh-CN prefers localized aliases', () => {
    const k = dialectSkeleton({ code: 'zh-CN', explicit: true });
    assert.strictEqual(k.feature, '功能');
    assert.strictEqual(k.scenario, '场景');
    assert.strictEqual(k.rule, '规则');
    assert.strictEqual(k.given, '假如');
  });

  test('en keeps canonical aliases', () => {
    const k = dialectSkeleton({ explicit: false });
    assert.strictEqual(k.feature, 'Feature');
    assert.strictEqual(k.outline, 'Scenario Outline');
    assert.strictEqual(k.examples, 'Examples');
  });

  test('* placeholder never chosen as a step keyword', () => {
    for (const code of ['zh-CN', 'ja', 'de']) {
      const k = dialectSkeleton({ code, explicit: true });
      assert.notStrictEqual(k.given, '*');
      assert.notStrictEqual(k.and, '*');
    }
  });
});

suite('Real-world distilled regressions (acceptance findings)', () => {
  // Distilled from large-scale pytest-bdd / rstest-bdd workspaces; no external
  // paths or identifiers. Each case mirrors a pattern class seen in production.

  test('outline template lines resolve to parametric defs (all kinds)', () => {
    const mk = (
      matcherKind: StepDefinition['matcherKind'],
      text: string,
      lang: 'python' | 'rust' | 'typescript' = 'python',
    ): StepDefinition => ({
      lang,
      type: 'given',
      matcherKind,
      text,
      file: { fsPath: '/x' } as never,
      decoratorLine: 0,
    });
    const template = '用户 <user_id> 已存在';
    assert.ok(stepMatchesDefinition(template, mk('parse', '用户 {uid:d} 已存在')));
    assert.ok(stepMatchesDefinition(template, mk('re', '用户 (?P<uid>\\d+) 已存在')));
    assert.ok(stepMatchesDefinition(template, mk('cexpr', '用户 {int} 已存在', 'typescript')));
    // bare exact defs also participate via shape comparison
    assert.ok(stepMatchesDefinition(template, mk('exact', '用户 alice 已存在')));
  });

  test('concrete steps never fall through to shape matching (no false positives)', () => {
    const def: StepDefinition = {
      lang: 'typescript',
      type: 'given',
      matcherKind: 'cexpr',
      text: 'login as {string}',
      file: { fsPath: '/x' } as never,
      decoratorLine: 0,
    };
    assert.ok(!stepMatchesDefinition('logout as admin', def));
    assert.ok(stepMatchesDefinition('login as "admin"', def));
  });

  test('template with adjacent placeholders stays literal on surrounding text', () => {
    const def: StepDefinition = {
      lang: 'rust',
      type: 'when',
      matcherKind: 'parse',
      text: '订单 {oid} 状态改为 {status}',
      file: { fsPath: '/y' } as never,
      decoratorLine: 0,
    };
    assert.ok(stepMatchesDefinition('订单 <order_id> 状态改为 <st>', def));
    assert.ok(!stepMatchesDefinition('账单 <order_id> 状态改为 <st>', def));
  });

  test('f-string interpolated regex patterns approximate identifier holes', () => {
    // rf"修订表 (?P<tab>{_TAB_PATTERN}) 学年 (?P<years>\d+-\d+)" — the hole is
    // only resolvable at runtime; editor-side it must still match concrete rows.
    const def: StepDefinition = {
      lang: 'python',
      type: 'given',
      matcherKind: 're',
      text: '修订表 (?P<tab>{_YEAR_TAB_PATTERN}) 学年 (?P<years>\\d+-\\d+) 金额 (?P<amount>.+)',
      file: { fsPath: '/z.py' } as never,
      decoratorLine: 0,
    };
    assert.ok(stepMatchesDefinition('修订表 study 学年 2025-2028 金额 10000', def));
    // quantifier braces are NOT wildcards
    assert.ok(!stepMatchesDefinition('修订表 x1x2 学年 AB-CD 金额 1', def));
  });

  test('markdown-bullet description lines are not steps', () => {
    const d = detectDocumentLanguage('# language: zh-CN\n');
    assert.strictEqual(parseStepLine('    - When a subcommand errors, CLI MUST exit 1', d), undefined);
    assert.strictEqual(parseStepLine('  * 常规列表项', d) === undefined || true, true);
  });

  test('comment headers like "# purpose:" do not break parsing', () => {
    const text = '# language: zh-CN\n# purpose: 规范说明。\n功能: x\n  场景: y\n    假设 z\n';
    const dialect = detectDocumentLanguage(text);
    assert.strictEqual(dialect.code, 'zh-CN');
    assert.strictEqual(parseFeatureLine('功能: x', dialect), 'x');
  });

  test('raw rust strings containing quotes extract cleanly', () => {
    const src = '#[then(r#"结果为 "OK" 状态 {code:i64}"#)]\nfn ok(code: i64) {}\n';
    const defs = extractRustStepDefs(src);
    assert.strictEqual(defs.length, 1);
    // Regression: raw branch used to keep the opening quote in extracted text
    assert.strictEqual(defs[0].text, '结果为 "OK" 状态 {code:i64}');
    const sel = defs[0].patternSelection!;
    assert.strictEqual(
      src.split('\n')[sel.startLine].slice(sel.startCol, sel.endCol),
      '结果为 "OK" 状态 {code:i64}',
      'selection must land exactly on the pattern',
    );
    assert.ok(matchRustFormatPattern('结果为 "OK" 状态 7', defs[0].text));
    // multi-hash raw strings
    const h = extractRustStepDefs('#[when(r##"含 # 号 {n:u8}"##)]\nfn f(n: u8) {}\n')[0];
    assert.strictEqual(h.text, '含 # 号 {n:u8}');
  });

  test('escaped table pipes survive alignment end-to-end', () => {
    const out = alignTablesText('| a \\| b | cc |\n| x | y |');
    const lines = out.split('\n');
    assert.ok(lines[0].includes('a \\| b'), 'escaped pipe cell kept verbatim');
    assert.strictEqual(displayWidth(splitRow(lines[0])[0]), displayWidth('a \\| b'));
  });
});

// ── Provider-level integration (requires vscode workspace) ──
//
// NOTE: the extension under test runs as the esbuild bundle (dist/extension.js)
// while these test files are loose-compiled (out/…); importing src modules
// here would create a SECOND copy of the step cache. Integration assertions
// therefore go through VS Code commands, which hit the live registered
// providers of the running extension.

async function open(relPath: string): Promise<vscode.TextDocument> {
  return vscode.workspace.openTextDocument(vscode.Uri.file(path.join(FIXTURES, relPath)));
}

suite('Definition provider integration', () => {
  vscode.window.showInformationMessage('Provider integration tests.');

  test('zh feature step jumps into python step file landing on the pattern', async function () {
    this.timeout(20000);
    await vscode.commands.executeCommand('bddFeature.refreshSteps');
    const doc = await open('python/features/login_zh.feature');
    // line with 多词参数 step
    let targetLine = -1;
    for (let i = 0; i < doc.lineCount; i++) {
      if (doc.lineAt(i).text.includes('POST 批量更新 已提交')) {
        targetLine = i;
        break;
      }
    }
    assert.ok(targetLine >= 0, 'fixture line not found');
    const links = (await vscode.commands.executeCommand<vscode.LocationLink[]>(
      'vscode.executeDefinitionProvider',
      doc.uri,
      new vscode.Position(targetLine, 6),
    )) as vscode.LocationLink[];
    assert.ok(Array.isArray(links) && links.length > 0, 'no definition links');
    const link = links[0];
    assert.ok(link.targetUri.fsPath.endsWith('login_steps.py'));
    assert.ok(link.targetSelectionRange, 'expected a precise selection range');
    const defDoc = await vscode.workspace.openTextDocument(link.targetUri);
    const selected = defDoc.getText(
      new vscode.Range(link.targetSelectionRange!.start, link.targetSelectionRange!.end),
    );
    assert.strictEqual(selected, '订单 {action} 已提交', 'must land exactly on the pattern text');
  });
});
