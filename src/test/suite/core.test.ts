import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

import { matchPythonParsePattern } from '../../patterns/pythonParsePattern';
import { matchRustFormatPattern } from '../../patterns/rustFormatPattern';
import {
  parseStepLine,
  parseScenarioLine,
  parseFeatureLine,
  detectDocumentLanguage,
  supportedLanguages,
  getStepType,
} from '../../gherkin';
import { extractPythonStepDefs, extractPythonScenariosBindings } from '../../scanners/pythonSteps';
import { extractRustStepDefs, extractRustScenarioBindings } from '../../scanners/rustSteps';
import { pytestTestName } from '../../testNames';
import { FeatureDefinitionProvider } from '../../definitionProvider';

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

// ── Provider-level integration (requires vscode workspace) ──

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
    const provider = new FeatureDefinitionProvider();
    const links = await provider.provideDefinition(
      doc,
      new vscode.Position(targetLine, 6),
      new vscode.CancellationTokenSource().token,
    );
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
