# BDD Feature

Enhanced VS Code extension for pytest-bdd `.feature` files with **Chinese and English** Gherkin support.

## Features

### Syntax Highlighting

Full syntax highlighting for `.feature` files supporting both English and Chinese Gherkin keywords:

```gherkin
# language: zh-CN
功能: 用户管理

  场景: 用户登录
    假设 用户已注册
    当 用户输入正确的用户名和密码
    那么 登录成功
```

- **Step keywords**: `Given`/`假如`/`假设`, `When`/`当`, `Then`/`那么`, `And`/`而且`/`并且`/`同时`, `But`/`但是`
- **Structural keywords**: `Feature`/`功能`, `Scenario`/`场景`/`剧本`, `Rule`/`规则`, `Background`/`背景`, `Examples`/`例子`
- `@tags`, `# comments`, `|tables|`, `<placeholders>`, `"strings"`, `"""docstrings"""`
- Table header row semantic highlighting

### Go to Definition

`Ctrl+Click` on a step in a `.feature` file to jump to the corresponding Python `@given`/`@when`/`@then` definition.

Supports Chinese step text matching:
```gherkin
    假设 用户 90232 订单存在    # → jumps to @given("用户 {uid} 订单存在")
```

### Auto Completion

Type a step keyword and get suggestions from your Python step definitions. Works with Chinese keywords (`假如`, `当`, `那么`, etc.).

### Create Step Definition

Place cursor on a step line and run **BDD: Create Step Definition** to generate a Python step stub:

```python
@given("用户 {uid} 订单存在")
def user_order_exists(uid):
    # TODO: implement step
    pass
```

Supports `string`, `parse`, `cfparse`, and `re` parsers.

### Run & Debug Scenarios

- **Run Scenario** (`Ctrl+Shift+R`): Run the scenario under cursor via pytest
- **Debug Scenario** (`Ctrl+Shift+T`): Debug with Python debugger
- **Run/Debug File**: Run the entire file

### Test Explorer

Native VS Code Test Explorer integration using `vscode.TestController`:
- Auto-discovers scenarios in `.feature` files
- Run/debug individual scenarios or entire features
- Pass/fail/skip status indicators

### Find References

Right-click → **Find References** on a step to see all usages across feature files, or from a Python decorator to find all referencing feature files.

## Commands

| Command | Shortcut | Description |
|---|---|---|
| `BDD: Create Step Definition` | `Ctrl+Shift+C` | Generate Python step stub from current step |
| `BDD: Run Scenario` | `Ctrl+Shift+R` | Run scenario under cursor |
| `BDD: Debug Scenario` | `Ctrl+Shift+T` | Debug scenario under cursor |
| `BDD: Run File` | — | Run current file |
| `BDD: Debug File` | — | Debug current file |
| `BDD: Refresh Step Definitions` | — | Re-scan step definition files |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `bddFeature.parser` | `"string"` | Parser type for step generation (`string`, `parse`, `cfparse`, `re`) |
| `bddFeature.pytestCommand` | `"pytest -q"` | Pytest command for running tests |
| `bddFeature.pytestDebugArgs` | `[]` | Extra args for pytest debug sessions |

## Supported Gherkin Languages

This extension highlights keywords for both English and Chinese (Simplified/Traditional):

| English | 简体中文 | 繁體中文 |
|---|---|---|
| Feature | 功能 | 功能 |
| Rule | 规则 | 規則 |
| Scenario | 场景、剧本 | 場景、劇本 |
| Scenario Outline | 场景大纲、剧本大纲 | 場景大綱、劇本大綱 |
| Background | 背景 | 背景 |
| Examples | 例子 | 例子 |
| Given | 假如、假设、假定 | 假如、假設、假定 |
| When | 当 | 當 |
| Then | 那么 | 那麼 |
| And | 而且、并且、同时 | 而且、並且、同時 |
| But | 但是 | 但是 |

## Acknowledgements

This project is inspired by and builds upon [vscode-pytest-bdd](https://gitlab.com/vtenentes/pytest-bdd) by **Vassilis Tenentes** (`vtenentes@yahoo.gr`). The original extension provided the foundational feature set for pytest-bdd IDE support. This project re-implements the functionality using modern VS Code APIs and adds Chinese Gherkin language support.

## License

MIT
