# BDD Feature

Enhanced VS Code extension for BDD `.feature` files with **spec-driven, multilingual** Gherkin support (80+ languages from the official `gherkin-languages.json`, including English / 简体中文 / 繁體中文), step navigation for **pytest-bdd (Python)** and **rstest-bdd (Rust)**, and test integration.

## Features

### Syntax Highlighting (generated from the official Gherkin spec)

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

### Go to Definition (precise landing)

`Ctrl+Click` on a step jumps to its definition **landing exactly on the pattern text**, via `LocationLink.targetSelectionRange`:

- Python: `@given(parsers.parse("订单 {action} 已提交"))` (exact / parse / cfparse / re matchers)
- Rust: `#[given("配置了 mock 模型 {name:string}")]`
- Scenario headers jump to their binding site (`scenarios("...")` call or `#[scenario(...)]` attribute)

Matching semantics are faithful to the underlying frameworks:

| Framework | Matcher | Behavior |
|---|---|---|
| pytest-bdd | bare string | exact equality |
| pytest-bdd | `parsers.parse/cfparse` | Python `parse` semantics — `{x}` is lazy any-text (**spans spaces**), `{x:d}` digits, literal spaces match one space |
| pytest-bdd | `parsers.re` | regex incl. `(?P<name>…)` groups |
| rstest-bdd | format pattern | `{}`/unknown → lazy, `{x:string}` quoted-string (quotes stripped), `{x:u32/i32/f64}` numeric |

Multi-line decorators/attributes with parens inside string literals are handled by a string-aware scanner.

### Auto Completion

Keyword + step suggestions in your document language, from both Python and Rust step definitions, with snippet placeholders for parameters.

### Create Step Definition

Generates a stub into an existing step file (Python or Rust), e.g.:

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

### Run & Debug Scenarios (binding-aware)

- Locates the binding for the current feature/scenario:
  - Python: files calling `scenarios()` / `scenario()` (paths resolved like pytest-bdd; honors `bdd_features_base_dir` via `bddFeature.featuresBaseDir`)
  - Rust: `#[scenario(path = "...", name = "...")]` (paths resolved against the crate manifest dir)
- Runs `pytest <binding>.py::test_<python_name>` using pytest-bdd's **actual** name-generation rules (Unicode-aware), or `cargo test --test <target> <fn_name>` for Rust
- Debug uses debugpy for Python scenarios

### Test Explorer

Native `vscode.TestController`: scenarios per feature file, run individually or per file through discovered bindings.

### Find References

From a feature step → all other usages resolving to the same definition(s); from a Python decorator / Rust attribute → all feature steps referencing it.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `BDD: Create Step Definition` | `Ctrl+Shift+C` | Generate a Python/Rust step stub |
| `BDD: Run Scenario` | `Ctrl+Shift+R` | Run scenario under cursor via its binding |
| `BDD: Debug Scenario` | `Ctrl+Shift+T` | Debug scenario under cursor |
| `BDD: Run File` / `Debug File` | — | Run whole file |
| `BDD: Refresh Step Definitions` | — | Re-scan definitions & bindings |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `bddFeature.parser` | `"parse"` | Stub generation parser (`string`, `parse`, `cfparse`, `re`) |
| `bddFeature.pytestCommand` | `"pytest -q"` | Pytest command for running tests |
| `bddFeature.pytestDebugArgs` | `[]` | Extra args for pytest debug sessions |
| `bddFeature.cargoTestCommand` | `"cargo test"` | Cargo command for rstest-bdd runs |
| `bddFeature.featuresBaseDir` | `null` | Base dir for feature paths in `scenarios()` (mirrors pytest-bdd's ini) |

## Architecture Notes

- `src/gherkin/` — spec-driven keyword engine (`gherkin-languages.json` is the single source of truth; regenerate grammar with `node scripts/generate-grammar.mjs`)
- `src/patterns/` — faithful pattern compilers (Python `parse`, Rust format placeholders)
- `src/scanners/` — pure-text scanners for Python/Rust step definitions and scenario bindings
- `src/bindings.ts` — feature → binding index powering navigation and test running
- `test-fixtures/` — self-contained example workspaces (Python + Rust) used by the unit tests

## Acknowledgements

- Keyword data: [cucumber/gherkin](https://github.com/cucumber/gherkin) (`gherkin-languages.json`, MIT)
- Inspired by [vscode-pytest-bdd](https://gitlab.com/vtenentes/pytest-bdd) by Vassilis Tenentes
- Rust semantics modeled on [rstest-bdd](https://github.com/leynos/rstest-bdd) (ISC)

## License

MIT
