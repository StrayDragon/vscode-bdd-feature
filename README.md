# BDD Feature

Enhanced VS Code extension for BDD `.feature` files with **spec-driven, multilingual** Gherkin support (80+ languages from the official `gherkin-languages.json`, including English / 简体中文 / 繁體中文), step navigation for **pytest-bdd (Python)**, **rstest-bdd (Rust)** and **cucumber-js / playwright-bdd / jest-cucumber (TypeScript & JavaScript)**, and test integration.

> 版本标注约定:各 feature 首次引入的版本随标题标注;`HEAD` 表示尚未发布(下个版本交付)。完整变更见 [CHANGELOG.md](CHANGELOG.md)。

## Gherkin Spec Coverage

Conformance against the [official Gherkin reference](https://cucumber.io/docs/gherkin/reference/):

| Official construct | Support | Notes |
|---|---|---|
| `Feature` (+ `Business Need`/`Ability`) | ✅ | spec-data driven, all 80+ languages |
| `Rule` (Gherkin 6+) | ✅ | symbols, folding, zh-CN `规则` |
| `Example`/`Scenario` (+aliases) | ✅ | |
| `Given/When/Then/And/But/*` | ✅ | And/But/* inherit the previous keyword's type |
| `Background` (feature & Rule level) | ✅ | |
| `Scenario Outline`/`Scenario Template` | ✅ | `<param>` placeholders highlighted & completion-aware |
| `Examples`/`Scenarios` tables | ✅ | CJK-width-aware alignment formatting |
| Doc Strings `"""` and <code>```</code> | ✅ HEAD | backtick delimiters + content-type (`"""json`) |
| Data Tables incl. `\|` `\\` `\n` escapes | ✅ HEAD | escaped cells survive table alignment |
| Tags `@tag` | ✅ | feature/scenario/examples level |
| Comments (line-start only) | ✅ HEAD | mid-line `#` in steps/cells no longer swallowed |
| `# language: <code>` header | ✅ | dialect-priority matching; union fallback when undeclared |
| Spoken languages | ✅ 80+ | single source of truth: vendored `gherkin-languages.json` |

## Features

### Syntax Highlighting *(v0.0.1;规范数据驱动生成自 v0.2.0)*

`syntaxes/feature.tmLanguage.json` is **generated** from the vendored official
language data — every language cucumber supports is highlighted:

```gherkin
# language: zh-CN
功能: 用户管理

  场景: 用户登录
    假设 用户已注册
    当 用户输入正确的用户名和密码
    那么 登录成功
```

- Step keywords (`Given`/`假如`/`假设`/…), structural keywords (`Feature`/`功能`/`Rule`/`规则`/…), tags, comments, tables, docstrings and `<placeholders>`
- Table header row semantic highlighting
- Refresh the spec data anytime: `pnpm run update-gherkin-languages`

Keyword parsing is **never hardcoded**: the runtime engine (`src/gherkin/`) builds keyword indexes from `src/gherkin/gherkin-languages.json` (cucumber/gherkin, MIT). Documents declaring `# language: <code>` match that dialect; undeclared documents fall back to a longest-match across all languages — so Chinese files without the directive still resolve.

### Go to Definition *(v0.0.1 基础跳转;精确定位 + 双语言自 v0.2.0)*

`Ctrl+Click` on a step jumps to its definition **landing exactly on the pattern text**, via `LocationLink.targetSelectionRange`:

- Python: `@given(parsers.parse("订单 {action} 已提交"))` (exact / parse / cfparse / re matchers)
- Rust: `#[given("配置了 mock 模型 {name:string}")]`
- Scenario headers jump to their binding site (`scenarios("...")` call or `#[scenario(...)]` attribute)

Matching semantics are faithful to the underlying frameworks *(v0.2.0)*:

| Framework | Matcher | Behavior |
|---|---|---|
| pytest-bdd | bare string | exact equality |
| pytest-bdd | `parsers.parse/cfparse` | Python `parse` semantics — `{x}` is lazy any-text (**spans spaces**), `{x:d}` digits, literal spaces match one space |
| pytest-bdd | `parsers.re` | regex incl. `(?P<name>…)` groups |
| rstest-bdd | format pattern | `{}`/unknown → lazy, `{x:string}` quoted-string (quotes stripped), `{x:u32/i32/f64}` numeric |
| cucumber-js / playwright-bdd | Cucumber Expression | `{string}` quoted, `{int}`, `{float}`, `{word}`, `{}` lazy; optional `(s)` & alternative `a/b`; `\` escapes; duplicate param names safe |
| cucumber-js / playwright-bdd | `/regex/` literal | regular expression |

Multi-line decorators/attributes with parens inside string literals are handled by a string-aware scanner. The cucumber-expression engine is a hand-ported, dependency-free compiler with conformance tests probed against `@cucumber/cucumber-expressions` 20.x (see `src/patterns/cucumberExpressionPattern.ts`).

### Auto Completion *(v0.0.1;Rust 定义与方言关键词自 v0.2.0)*

Keyword + step suggestions in your document language, from Python, Rust and TypeScript/JavaScript step definitions, with snippet placeholders for parameters.

### Create Step Definition *(Python v0.0.1;Rust v0.2.0;TypeScript HEAD)*

Generates a stub into an existing step file (Python, Rust or TS/JS), e.g.:

```python
@given(parsers.parse("用户 {name} 已经注册"))
def user_name_already_registered(name):
    """TODO: implement step."""
    ...
```

```rust
#[given("配置了 mock 模型 {name}")]
fn configured_mock_model(name: String) {
    // TODO: implement step
}
```

```ts
Given('用户 {string} 已经注册', function userNameAlreadyRegistered(name: string) {
  // TODO: implement step
  throw new Error('unimplemented');
});
```

### Run & Debug Scenarios *(v0.0.1;绑定感知 + 忠实命名自 v0.2.0;TS 运行器自 HEAD)*

- Locates the binding for the current feature/scenario:
  - Python: files calling `scenarios()` / `scenario()` (paths resolved like pytest-bdd; honors `bdd_features_base_dir` via `bddFeature.featuresBaseDir`)
  - Rust: `#[scenario(path = "...", name = "...")]` (paths resolved against the crate manifest dir)
  - TS: `defineFeature(loadFeature("..."))` (jest-cucumber)
- Without code bindings, TS projects run via auto-detected runners:
  - cucumber-js — `npx cucumber-js <file> --name "<scenario>"`
  - playwright-bdd — `npx playwright test -g "<scenario>"` (detected via `playwright.config.*` / package.json)
- Runs `pytest <binding>.py::test_<python_name>` using pytest-bdd's **actual** name-generation rules (Unicode-aware), or `cargo test --test <target> <fn_name>` for Rust
- Debug uses debugpy for Python scenarios

### Test Explorer *(v0.0.1 基础;懒加载/标签/Continuous Run 自 HEAD)*

Native `vscode.TestController`:
- **Lazy discovery** — feature nodes resolve scenarios on demand (fast on large repos)
- **Tags** — each scenario is tagged `python` / `rust` / `typescript` / `unbound`; filter in the UI
- **Continuous Run** — enable the built-in toggle; watched `.feature/.py/.rs/.ts/.js` changes re-run automatically

### Diagnostics, Quick Fixes & UX Mechanisms *(HEAD;each independently toggleable)*

| Mechanism | What you get | Toggle |
|---|---|---|
| Problems | undefined steps, duplicate/invalid/unused definitions, unbound features (with related-info jumps) | `bddFeature.enableDiagnostics` (+ sub-switches) |
| Quick Fixes | 💡 create missing step stub; 💡 generate feature binding (`scenarios()` / `#[scenario]`) | `bddFeature.enableCodeActions` |
| CodeLens | ▶ Run / 🐞 Debug above scenarios, Run All on the feature header, reference counts above definitions | `bddFeature.enableCodeLens` |
| Outline & Search | Feature→Rule→Scenario document symbols (breadcrumbs), workspace-wide `#` symbol search incl. step patterns | `enableDocumentSymbols` / `enableWorkspaceSymbols` |
| Folding | fold scenarios/rules/backgrounds/docstrings | `bddFeature.enableFoldingRanges` |
| Hover | definition preview cards on steps; the exact pytest/cargo command a scenario will run | `bddFeature.enableHover` |
| Formatting | CJK-width-aware Gherkin table pipe alignment via Format Document/Selection | `bddFeature.enableTableFormatting` |
| Rename | rename exact-match steps across definition + all features; scenario titles sync Rust `#[scenario(name=…)]` both ways | `bddFeature.enableRename` |
| Snippets | `feature`/`scenario`/`outline`/`background`/`rule` skeletons at line start | `bddFeature.enableSnippets` |

All toggles live under the `bddFeature.*` configuration section and apply instantly.

### Find References *(v0.0.1;参数化感知 + Rust 方向自 v0.2.0)*

From a feature step → all other usages resolving to the same definition(s); from a Python decorator / Rust attribute → all feature steps referencing it.

## Commands

| Command | Shortcut | Description | Since |
|---|---|---|---|
| `BDD: Create Step Definition` | `Ctrl+Shift+C` | Generate a Python/Rust step stub | v0.0.1(Rust 自 v0.2.0) |
| `BDD: Run Scenario` | `Ctrl+Shift+R` | Run scenario under cursor via its binding | v0.0.1(绑定感知自 v0.2.0) |
| `BDD: Debug Scenario` | `Ctrl+Shift+T` | Debug scenario under cursor | v0.0.1(绑定感知自 v0.2.0) |
| `BDD: Run File` / `Debug File` | — | Run whole file | v0.0.1 |
| `BDD: Refresh Step Definitions` | — | Re-scan definitions & bindings | v0.0.1 |
| `BDD: Bind this feature to a test` | — | Quick fix/command generating a binding stub | HEAD |

## Configuration

| Setting | Default | Description | Since |
|---|---|---|---|
| `bddFeature.parser` | `"parse"` | Stub generation parser (`string`, `parse`, `cfparse`, `re`) | v0.0.1 |
| `bddFeature.pytestCommand` | `"pytest -q"` | Pytest command for running tests | v0.0.1 |
| `bddFeature.pytestDebugArgs` | `[]` | Extra args for pytest debug sessions | v0.0.1 |
| `bddFeature.cargoTestCommand` | `"cargo test"` | Cargo command for rstest-bdd runs | v0.2.0 |
| `bddFeature.featuresBaseDir` | `null` | Base dir for feature paths in `scenarios()` (mirrors pytest-bdd's ini) | v0.2.0 |
| `bddFeature.cucumberCommand` | `"npx cucumber-js"` | Base command for cucumber-js runs (file + `--name` appended) | HEAD |
| `bddFeature.playwrightCommand` | `"npx playwright test"` | Base command for playwright-bdd runs (`-g <scenario>` appended) | HEAD |
| `bddFeature.enable*` / `diagnostics.*` | 见上方机制表 | Per-mechanism toggles (diagnostics, code lens, symbols, hover, …) | HEAD |

## Architecture Notes *(v0.2.0 重构确立;`providers/` 自 HEAD)*

- `src/gherkin/` — spec-driven keyword engine (`gherkin-languages.json` is the single source of truth; regenerate grammar with `node scripts/generate-grammar.mjs`)
- `src/patterns/` — faithful pattern compilers (Python `parse`, Rust format placeholders, Cucumber Expression)
- `src/scanners/` — pure-text scanners for Python / Rust / TS&JS step definitions and scenario bindings
- `src/tsBdd.ts` — cucumber-js vs playwright-bdd runner detection (memoized)
- `src/bindings.ts` — feature → binding index powering navigation and test running
- `src/providers/` — toggleable UX mechanisms (diagnostics, code lens, symbols, hover, …)
- `test-fixtures/` — self-contained example workspaces (Python + Rust + TypeScript) used by the unit tests

## Acknowledgements

- Keyword data: [cucumber/gherkin](https://github.com/cucumber/gherkin) (`gherkin-languages.json`, MIT)
- Inspired by [vscode-pytest-bdd](https://gitlab.com/vtenentes/pytest-bdd) by Vassilis Tenentes
- Rust semantics modeled on [rstest-bdd](https://github.com/leynos/rstest-bdd) (ISC)

## License

MIT
