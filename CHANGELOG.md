# Change Log

All notable changes to the "vscode-bdd-feature" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.0.1] - 2026-06-05

### Added

- **Syntax Highlighting**: Full TextMate grammar for `.feature` files with Chinese (zh-CN/zh-TW) and English Gherkin keywords
  - Step keywords: `Given`/`假如`/`假设`, `When`/`当`, `Then`/`那么`, `And`/`而且`/`并且`/`同时`, `But`/`但是`
  - Structural keywords: `Feature`/`功能`, `Scenario`/`场景`/`剧本`, `Rule`/`规则`, `Background`/`背景`, `Examples`/`例子`
  - Tags, comments, tables, placeholders, strings, docstrings
  - Semantic token highlighting for table header rows
- **Go to Definition**: Jump from `.feature` step to Python `@given`/`@when`/`@then` definition
- **Auto Completion**: Step suggestions from Python step definitions while typing in `.feature` files
- **Create Step Definition**: Generate Python step stub from feature step line
- **Run/Debug Scenario**: Execute or debug the scenario under cursor via pytest
- **Run/Debug File**: Execute or debug the current file
- **Test Explorer**: Native VS Code Test Controller integration for discovering and running scenarios
- **Find References**: Find all usages of a step across feature files or from Python decorators
- **Language Configuration**: Bracket matching, auto-closing, comment toggling, folding for `.feature` files
- Configuration settings: `bddFeature.parser`, `bddFeature.pytestCommand`, `bddFeature.pytestDebugArgs`
