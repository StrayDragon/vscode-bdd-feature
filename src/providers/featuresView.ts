import * as vscode from 'vscode';
import {
  ensureTagIndex,
  indexedFiles,
  collectTagStats,
  matchingScenarios,
  onTagIndexChange,
  type IndexedFile,
  type IndexedScenario,
  type TagStat,
} from '../tagIndex';
import { compileTagExpression } from '../gherkin/tags';

/**
 * "BDD Features" explorer view — cross-directory management of every
 * `.feature` in the workspace.
 *
 * Grouping modes (switched from the view title bar):
 *   folder — virtual directory tree over feature-containing folders
 *   tag    — every known tag with counts, expandable to carriers
 *   expr   — results of a Cucumber tag-expression filter
 *
 * Performance: zero IO during rendering. All nodes come from the in-memory
 * tag index; children resolve lazily through collapsible states, so huge
 * repos only pay for what the user actually expands.
 *
 * TreeItems double as command payloads: context-menu commands receive the
 * item instance itself and read its typed payload fields.
 */

type Mode = 'folder' | 'tag' | 'expr';

const MODE_KEY = 'bddFeaturesView.mode';
const EXPR_KEY = 'bddFeaturesView.expr';
const CTX_MODE = 'bddFeaturesView.mode';

// ── Payload-bearing items ──

export interface ScenarioRef {
  uriString: string;
  fsPath: string;
  relPath: string;
  name: string;
  line: number;
}

export class FeatureTreeItem extends vscode.TreeItem {
  constructor(
    readonly ref: { uriString: string; fsPath: string; relPath: string },
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible);
  }
}

export class ScenarioTreeItem extends vscode.TreeItem {
  constructor(readonly scenario: ScenarioRef) {
    super(scenario.name || '(untitled)', vscode.TreeItemCollapsibleState.None);
  }
}

export class TagTreeItem extends vscode.TreeItem {
  constructor(readonly tag: string) {
    super(tag, vscode.TreeItemCollapsibleState.Collapsed);
  }
}

type ViewNode =
  | { kind: 'dir'; dir: string; label: string }
  | { kind: 'feature'; entry: IndexedFile; only?: IndexedScenario[] }
  | { kind: 'scenario'; entry: IndexedFile; scenario: IndexedScenario }
  | { kind: 'tag'; stat: TagStat }
  | { kind: 'message'; text: string };

export class BddFeaturesView implements vscode.TreeDataProvider<ViewNode> {
  private readonly _emitter = new vscode.EventEmitter<ViewNode | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly state: vscode.Memento) {}

  /** Fire a refresh (index changes / explicit commands). */
  refresh(): void {
    this._emitter.fire();
  }

  /** Subscribe the provider to debounced index changes. */
  watch(disposables: vscode.Disposable[]): void {
    disposables.push(onTagIndexChange(() => this.refresh()));
  }

  /** Push the current mode into `when`-clause context. Call once at startup. */
  async syncModeContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', CTX_MODE, this.mode());
  }

  mode(): Mode {
    return this.state.get<Mode>(MODE_KEY, 'folder');
  }

  async toggleGrouping(): Promise<void> {
    const next: Mode = this.mode() === 'folder' ? 'tag' : 'folder';
    await this.state.update(MODE_KEY, next);
    await this.syncModeContext();
    this.refresh();
  }

  async filterByExpression(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'BDD Features: Filter by Tag Expression',
      value: this.state.get<string>(EXPR_KEY, ''),
      placeHolder: '@smoke and not @slow',
      prompt: 'Scenarios matching the expression are listed under each feature.',
      validateInput: text => validateExpr(text),
    });
    if (value === undefined) {
      return;
    }
    await this.applyMode(value.trim() ? 'expr' : 'folder');
  }

  async clearFilter(): Promise<void> {
    await this.applyMode('folder');
  }

  /** Re-run the stored expression against fresh index data. */
  rerunFilter(): void {
    if (this.mode() === 'expr') {
      this.refresh();
    }
  }

  private async applyMode(mode: Mode): Promise<void> {
    if (mode === 'expr') {
      const value = this.state.get<string>(EXPR_KEY, '');
      if (value) {
        await this.state.update(MODE_KEY, 'expr');
      } else {
        return; // nothing to filter on
      }
    } else {
      await this.state.update(EXPR_KEY, '');
      await this.state.update(MODE_KEY, mode);
    }
    await this.syncModeContext();
    this.refresh();
  }

  // ── TreeDataProvider ──

  getTreeItem(node: ViewNode): vscode.TreeItem {
    switch (node.kind) {
      case 'dir': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = vscode.ThemeIcon.Folder;
        item.contextValue = 'bddViewDir';
        item.tooltip = `${node.dir}/`;
        return item;
      }
      case 'feature': {
        const scenarios = node.only ?? node.entry.scenarios;
        const item = new FeatureTreeItem(
          {
            uriString: node.entry.uri.toString(),
            fsPath: node.entry.fsPath,
            relPath: node.entry.relPath,
          },
          node.entry.featureName ?? basename(node.entry.relPath),
          scenarios.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        item.iconPath = new vscode.ThemeIcon('file');
        item.contextValue = 'bddViewFeature';
        item.description =
          node.only !== undefined
            ? `${node.entry.relPath} (${scenarios.length})`
            : node.entry.relPath;
        item.tooltip = featureTooltip(node.entry);
        if (node.entry.featureLine !== undefined) {
          item.command = {
            command: 'bddFeature._openDefinition',
            title: 'Open Feature',
            arguments: [node.entry.uri.toString(), node.entry.featureLine],
          };
        }
        return item;
      }
      case 'scenario': {
        const item = new ScenarioTreeItem({
          uriString: node.entry.uri.toString(),
          fsPath: node.entry.fsPath,
          relPath: node.entry.relPath,
          name: node.scenario.name,
          line: node.scenario.line,
        });
        item.iconPath = new vscode.ThemeIcon('beaker');
        item.contextValue = 'bddViewScenario';
        item.description = node.scenario.tags.join(' ');
        item.tooltip = scenarioTooltip(node.scenario);
        item.command = {
          command: 'bddFeature._openDefinition',
          title: 'Open Scenario',
          arguments: [node.entry.uri.toString(), node.scenario.line],
        };
        return item;
      }
      case 'tag': {
        const s = node.stat;
        const item = new TagTreeItem(s.tag);
        item.iconPath = new vscode.ThemeIcon('tag');
        item.contextValue = 'bddViewTag';
        item.description = `${s.scenarios} scenario${s.scenarios === 1 ? '' : 's'} · ${s.files} file${s.files === 1 ? '' : 's'}`;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'bddViewMessage';
        return item;
      }
    }
  }

  async getChildren(element?: ViewNode): Promise<ViewNode[]> {
    await ensureTagIndex();

    if (!element) {
      return this._roots();
    }
    switch (element.kind) {
      case 'dir':
        return this._dirChildren(element.dir);
      case 'feature': {
        const scenarios = element.only ?? element.entry.scenarios;
        return scenarios.map(scenario => ({ kind: 'scenario', entry: element.entry, scenario }));
      }
      case 'tag': {
        const tag = element.stat.tag;
        return [...indexedFiles()]
          .filter(f => f.tagSet.has(tag))
          .sort((a, b) => a.relPath.localeCompare(b.relPath))
          .map(entry => ({
            kind: 'feature' as const,
            entry,
            only: entry.scenarios.filter(s => s.tags.includes(tag)),
          }));
      }
      default:
        return [];
    }
  }

  private _roots(): ViewNode[] {
    switch (this.mode()) {
      case 'tag': {
        const stats = collectTagStats();
        return stats.length > 0
          ? stats.map(stat => ({ kind: 'tag' as const, stat }))
          : [{ kind: 'message', text: 'No tags yet — add "@smoke" above a Scenario' }];
      }
      case 'expr': {
        const raw = this.state.get<string>(EXPR_KEY, '');
        if (!raw) {
          return [{ kind: 'message', text: 'No filter set — use the funnel button' }];
        }
        try {
          return groupMatchesByFile(matchingScenarios(compileTagExpression(raw)));
        } catch {
          return [{ kind: 'message', text: `Invalid expression: ${raw}` }];
        }
      }
      default:
        return this._rootDirs();
    }
  }

  private _rootDirs(): ViewNode[] {
    const top = new Set<string>();
    for (const f of indexedFiles()) {
      top.add(topSegment(f.dir));
    }
    if (top.size === 0) {
      return [{ kind: 'message', text: 'No .feature files found' }];
    }
    return [...top].sort().map(dir => ({
      kind: 'dir' as const,
      dir,
      label: dir === '.' ? '(workspace root)' : `${dir}/`,
    }));
  }

  private _dirChildren(dir: string): ViewNode[] {
    const features: IndexedFile[] = [];
    const childDirs = new Set<string>();
    const prefix = dir === '.' ? '' : `${dir}/`;

    for (const f of indexedFiles()) {
      if (!(f.dir === dir || (prefix && f.dir.startsWith(prefix)))) {
        continue;
      }
      if (f.dir === dir) {
        features.push(f);
      } else {
        childDirs.add(f.dir.slice(prefix.length).split('/')[0]);
      }
    }
    const dirNodes = [...childDirs].sort().map(d => ({
      kind: 'dir' as const,
      dir: prefix ? `${prefix}${d}` : d,
      label: d,
    }));
    const featureNodes = features
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map(entry => ({ kind: 'feature' as const, entry }));
    return [...dirNodes, ...featureNodes];
  }
}

// ── Helpers ──

function validateExpr(text: string): string | undefined {
  if (!text.trim()) {
    return undefined;
  }
  try {
    compileTagExpression(text);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function groupMatchesByFile(matches: ReturnType<typeof matchingScenarios>): ViewNode[] {
  const byFile = new Map<string, { entry: IndexedFile; scenarios: IndexedScenario[] }>();
  for (const m of matches) {
    let bucket = byFile.get(m.file.fsPath);
    if (!bucket) {
      bucket = { entry: m.file, scenarios: [] };
      byFile.set(m.file.fsPath, bucket);
    }
    bucket.scenarios.push(m.scenario);
  }
  return [...byFile.values()]
    .sort((a, b) => a.entry.relPath.localeCompare(b.entry.relPath))
    .map(g => ({ kind: 'feature' as const, entry: g.entry, only: g.scenarios }));
}

function topSegment(dir: string): string {
  return dir ? dir.split('/')[0] : '.';
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function featureTooltip(f: IndexedFile): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${f.featureName ?? basename(f.relPath)}**\n\n\`${f.relPath}\``);
  if (f.featureTags.length > 0) {
    md.appendMarkdown(`\n\n${f.featureTags.map(t => `\`${t}\``).join(' ')}`);
  }
  return md;
}

function scenarioTooltip(s: IndexedScenario): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${s.name || '(untitled)'}**`);
  md.appendMarkdown(s.tags.length > 0 ? `\n\n${s.tags.map(t => `\`${t}\``).join(' ')}` : '\n\n_No tags_');
  return md;
}
