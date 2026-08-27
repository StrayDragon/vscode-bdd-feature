import * as vscode from 'vscode';
import {
  parseStepLine,
  parseScenarioLine,
  detectDocumentLanguage,
  resolveInheritedStepType,
} from '../gherkin';
import { findMatchingSteps } from '../steps';
import { pytestTestName } from '../testNames';
import { getBindingsForFeature, ensureBindings } from '../bindings';
import { ensureTagIndex, indexedFiles } from '../tagIndex';
import { toggles, cfg } from '../config';

const LANG_ICON: Record<string, string> = { python: '🐍', rust: '🦀' };

/** Hover cards:
 *  - step → definition preview (pattern, kind, source link), ambiguity note
 *  - scenario header → the exact command that will run
 */
export class BddHoverProvider implements vscode.HoverProvider {
  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    if (!toggles.hover()) {
      return undefined;
    }
    const dialect = detectDocumentLanguage(document.getText());
    const line = document.lineAt(position.line);

    const parsed = parseStepLine(line.text, dialect);
    if (parsed) {
      // Resolve type incl. And/But inheritance so CJK/continuation steps work
      const type =
        parsed.type ??
        resolveInheritedStepType(n => document.lineAt(n).text, position.line, dialect);
      return this._stepHover(document, position, parsed.text, type);
    }

    const scenario = parseScenarioLine(line.text, dialect);
    if (scenario !== undefined) {
      await ensureBindings();
      return this._scenarioHover(document.uri.fsPath, scenario);
    }

    // ── `@tag` hover: usage across the workspace ──
    const tag = tagAtPosition(line.text, position.character);
    if (tag) {
      return this._tagHover(tag);
    }
    return undefined;
  }

  private async _tagHover(tag: string): Promise<vscode.Hover | undefined> {
    if (!toggles.tags()) {
      return undefined;
    }
    await ensureTagIndex();

    let scenarios = 0;
    const files = new Set<string>();
    for (const f of indexedFiles()) {
      let counted = false;
      for (const s of f.scenarios) {
        if (s.tags.includes(tag)) {
          scenarios++;
          counted = true;
        }
      }
      if (counted || f.featureTags.includes(tag)) {
        files.add(f.relPath);
      }
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`🏷️ **${tag}**\n\n`);
    if (files.size === 0) {
      md.appendMarkdown('_Not used anywhere yet_');
    } else {
      md.appendMarkdown(
        `${scenarios} scenario${scenarios === 1 ? '' : 's'} · ${files.size} file${files.size === 1 ? '' : 's'}\n\n`,
      );
      md.appendMarkdown(
        `Run all: \`**BDD: Run Scenarios by Tag Expression**\` → \`${tag}\``,
      );
    }
    return new vscode.Hover(md);
  }

  private _stepHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    text: string,
    type: 'given' | 'when' | 'then' | undefined,
  ): vscode.Hover {
    void document;
    const matches = findMatchingSteps(text, type);
    if (matches.length === 0) {
      return new vscode.Hover(
        new vscode.MarkdownString(`⚠️ **No matching definition** for \`${text}\``),
      );
    }
    const md = new vscode.MarkdownString();
    md.appendMarkdown(matches.length > 1 ? `**${matches.length} matching definitions**\n\n` : '');
    for (const def of matches.slice(0, 5)) {
      const file = def.file.path.split('/').pop();
      const openArgs = encodeURIComponent(JSON.stringify([def.file.toString(), def.decoratorLine]));
      md.appendMarkdown(
        `${LANG_ICON[def.lang] ?? ''} \`${def.matcherKind}\` **${def.text}**\n\n` +
          `→ [${file}:${def.decoratorLine + 1}](command:bddFeature._openDefinition?${openArgs} "Go to definition") · @${def.type}\n\n`,
      );
    }
    if (matches.length > 1) {
      md.appendMarkdown('_Ambiguous — multiple definitions match. Check Problems panel for duplicates._');
    }
    const hoveredLine = document.lineAt(position.line).text.length;
    return new vscode.Hover(md, new vscode.Range(position.line, 0, position.line, hoveredLine));
  }

  private _scenarioHover(featureFsPath: string, scenarioName: string): vscode.Hover {
    const bindings = getBindingsForFeature(featureFsPath, scenarioName);
    if (bindings.length === 0) {
      return new vscode.Hover(new vscode.MarkdownString('🔓 _No test binding for this scenario_'));
    }
    const md = new vscode.MarkdownString();
    for (const b of bindings) {
      if (b.lang === 'python') {
        const pytestCmd = cfg('pytestCommand', 'pytest -q').split(/\s+/)[0];
        md.appendMarkdown(`🐍 \`${pytestCmd} "${b.file.path}::${pytestTestName(scenarioName)}"\`\n\n`);
      } else if (b.rustTestFnName) {
        md.appendMarkdown(`🦀 \`cargo test -- --exact ${b.rustTestFnName}\`\n\n`);
      }
    }
    return new vscode.Hover(md);
  }
}

/** The `@token` under the cursor, when the line is a tag line. */
function tagAtPosition(lineText: string, character: number): string | undefined {
  if (!lineText.trimStart().startsWith('@')) {
    return undefined;
  }
  for (const m of lineText.matchAll(/\S+/g)) {
    if (character >= m.index && character < m.index + m[0].length) {
      return m[0].startsWith('@') ? m[0] : undefined;
    }
  }
  return undefined;
}
