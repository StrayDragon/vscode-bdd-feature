# Change Log

All notable changes to the "vscode-bdd-feature" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Fixed

- **BDD Features view feedback loop** (high CPU, endless loading): the tree's
  `getChildren` triggered a full workspace tag rescan on every call, and each
  scan notified the view to refresh — an endless scan→notify→refresh cycle.
  `ensureTagIndex` now memoizes until an explicit reset/rescan (incremental
  updates keep it fresh in between), with a generation guard superseding
  in-flight scans.
- **`ensureBindings` rebuilt on every call** (scenario hover, test-item
  resolution each swept the whole workspace): now cached per invalidation;
  binding-source saves and workspace-folder changes invalidate via the
  existing refresh hook.
- **"Actual command not found" on tree clicks**: a side effect of the ext
  host being starved/restarted by the loop above — hardened regardless:
  `bddFeature._openDefinition` is now a contributed command, clamps stale
  out-of-range line numbers, and swallows unopenable-target errors instead
  of error-notifying from background tree clicks.

### Added

- **Gherkin `@tag` engine** (`enableTags`):
  - Spec-faithful tag parsing (Feature / Rule / Scenario / Scenario Outline /
    Examples; inheritance resolves downward; duplicate, misplaced and invalid
    tags surface as diagnostics — `bddFeature.diagnostics.tags`).
  - **Cucumber tag expressions**: `BDD: Run Scenarios by Tag Expression`
    evaluates full infix boolean syntax (`@smoke and not @wip`,
    `(@a or @b) and not @c`, legacy `~@draft`) with live input validation.
  - Native runner dispatch: pytest-bdd → `pytest -m "<markers>"`,
    cucumber-js → `--tags`, playwright-bdd → `--grep` (boolean expression
    auto-translated to a lookahead regex); rust/unknown runners fall back to a
    pre-filtered scenario QuickPick reusing the per-scenario run plumbing.
  - **Test Explorer integration**: every effective Gherkin tag becomes a
    test tag alongside the binding-language tag — filterable via the built-in
    test-explorer filter UI.
  - Tag completion in `@tag` context (ranked by usage) and hover cards with
    workspace usage stats.
- **BDD Features explorer view** (`enableFeaturesView`): cross-directory view
  over every `.feature` in the Explorer sidebar with three modes — folder
  tree, tag inventory (with scenario/file counts), and persisted tag-expression
  filter. Context menus run/debug scenarios or all scenarios matching a tag;
  clicks reveal the source line.
- Shared run-target module (`runTarget.ts`) extracted from the test controller
  so single-scenario execution and batch-by-tag runs use identical command
  building.

## [0.3.0] - 2026-08-24

### Added

- **TypeScript / JavaScript BDD support** (cucumber-js, playwright-bdd, jest-cucumber):
  - Step scanning for `Given/When/Then/Step` calls — string patterns compile as
    **Cucumber Expressions** (`{string}`, `{int}`, `{float}`, `{word}`, `{}`,
    optional `(s)` and alternative `a/b` text, `\` escapes), `/regex/` literals
    as regular expressions; playwright-bdd `createBdd()` destructuring and
    `@When(...)` decorators are recognized.
  - Cucumber-expression engine hand-ported with conformance tests probed against
    `@cucumber/cucumber-expressions` 20.x (kept dependency-free by design).
  - jest-cucumber `defineFeature(loadFeature("…"))` bindings indexed for
    scenario-header navigation.
  - Runner integration: cucumber-js (`<feature> --name <scenario>`) and
    playwright-bdd (`-g <scenario>`) auto-detected from the workspace even
    without code bindings; configurable via `bddFeature.cucumberCommand` /
    `bddFeature.playwrightCommand`.
  - TS step stub generation (`Create Step Definition`), CodeLens usage counts,
    references, Test Explorer tags.
- **Diagnostics** (`enableDiagnostics`): undefined steps, duplicate/invalid/unused
  definitions (parametric-aware), unbound features — with related-information links.
  Sub-toggles under `bddFeature.diagnostics.*`.
- **Quick Fixes** (`enableCodeActions`): create missing step stub; bind feature
  via new `BDD: Bind this feature to a test` command (`scenarios()` / `#[scenario]`).
- **CodeLens** (`enableCodeLens`): Run/Debug per scenario, Run All per feature,
  reference counts above step definitions.
- **Document Symbols** (`enableDocumentSymbols`): Feature→Rule→Scenario outline &
  breadcrumbs; **Workspace Symbols** (`enableWorkspaceSymbols`): `#` search across
  scenarios and step patterns.
- **Folding Ranges** (`enableFoldingRanges`): scenario/rule/background/docstring blocks.
- **Hover** (`enableHover`): definition preview cards on steps (with jump link);
  exact pytest/cargo command on scenario headers.
- **Table Formatting** (`enableTableFormatting`): CJK-width-aware pipe alignment.
- **Rename** (`enableRename`): exact-match steps across definition + features;
  scenario titles sync with Rust `#[scenario(name=…)]` in both directions.
- **Snippets** (`enableSnippets`): gherkin skeletons at line start.
- **Test Explorer**: lazy discovery, `python`/`rust`/`unbound` tags, Continuous Run.

### Fixed

- Hover resolves step type through And/But inheritance (Chinese steps no longer
  report "no definition").
- Table formatting preserves CRLF line endings.
- Unused-definition detection understands parametric patterns.
- **Spec fidelity**: table cell escapes (`\|`, `\\`) no longer split cells during
  alignment; docstrings support ``` ``` ``` delimiters and content-type
  annotations; comments only match at line start (per Gherkin spec).
- Python stubs use pytest-bdd's exact reserved argument names
  (`datatable`/`docstring`); docstring-bearing steps now emit a `docstring` param.
- Snippets follow the document dialect (English files get English skeletons).
- Integration tests no longer race the esbuild bundle's module state (run via
  VS Code commands).
- **Scenario Outline templates resolve to definitions**: `<param>` placeholders
  now participate in shape matching (frameworks substitute values before
  matching; editor-side equivalent), powering goto-def/diagnostics on outlines.
- **Raw-string Rust patterns** (`r#"…"#`, `r##…"##`) no longer keep a stray
  leading quote — extracted text and jump landing positions were off-by-one.
- f-string interpolated regex patterns (`rf"…{TABLE}…"`) approximate
  identifier-braced holes so runtime-assembled matchers still resolve.

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
