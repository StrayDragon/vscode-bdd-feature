# Change Log

All notable changes to the "vscode-bdd-feature" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.2.0] - 2026-08-23

### Added

- **Spec-driven multilingual keywords**: runtime keyword engine built from the official
  cucumber `gherkin-languages.json` (80 languages) — no hardcoded keyword lists.
  Documents with `# language: <code>` match that dialect; undeclared files fall back
  to longest-match across all languages (Chinese works without the directive).
- **Generated syntax highlighting**: `feature.tmLanguage.json` is now generated from the
  same spec data (`pnpm run update-gherkin-languages` refreshes both).
- **rstest-bdd (Rust) support**: `#[given|when|then("...")]` steps (raw strings,
  multi-line attributes), `#[scenario(path, name)]` bindings, faithful placeholder
  semantics (`:string` quote stripping, `u/i/f` numerics), `cargo test` runner.
- **Precise go-to-definition**: jumps land exactly on the pattern text via
  `LocationLink.targetSelectionRange`; scenario headers jump to their binding site.
- **Fixed pytest-bdd matching semantics** (verified against `parse==1.22`): untyped
  `{param}` captures lazily across spaces — multi-word values now resolve.
- **Binding-aware runs**: locates real binding files (`scenarios()` / `#[scenario]`),
  generates pytest-bdd's actual test names (Unicode-aware), resolves Rust test targets.
- **Create step stubs** for Python and Rust targets.

### Fixed

- Step definitions whose decorators span multiple lines or contain parentheses inside
  string literals are scanned correctly.
- Jump positioning no longer lands at column 0 of the decorator.

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
