import * as vscode from 'vscode';
import { parseStepLine, parseScenarioLine, detectDocumentLanguage } from '../gherkin';
import { findMatchingSteps } from '../steps';
import { pytestTestName } from '../testNames';
import { getBindingsForFeature, ensureBindings } from '../bindings';
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
      return this._stepHover(document, position, parsed.text, parsed.keyword);
    }

    const scenario = parseScenarioLine(line.text, dialect);
    if (scenario !== undefined) {
      await ensureBindings();
      return this._scenarioHover(scenario);
    }
    return undefined;
  }

  private _stepHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    text: string,
    keyword: string,
  ): vscode.Hover | undefined {
    void document;
    const type =
      (['Given', 'When', 'Then'].includes(keyword) ? keyword.toLowerCase() : undefined) as
        | 'given' | 'when' | 'then' | undefined;
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
      md.appendMarkdown(
        `${LANG_ICON[def.lang] ?? ''} \`${def.matcherKind}\` **${def.text}**\n\n` +
          `→ [${file}:${def.decoratorLine + 1}](${def.file.with({ fragment: `L${def.decoratorLine + 1}` })}) · @${def.type}\n\n`,
      );
    }
    if (matches.length > 1) {
      md.appendMarkdown('_Ambiguous — multiple definitions match. Check Problems panel for duplicates._');
    }
    const hovered = document.lineAt(position.line);
    return new vscode.Hover(md, new vscode.Range(position.line, 0, position.line, hovered.text.length));
  }

  private async _scenarioHover(scenarioName: string): Promise<vscode.Hover> {
    const bindings = getBindingsForFeature(
      vscode.window.activeTextEditor?.document.uri.fsPath ?? '',
      scenarioName,
    );
    if (bindings.length === 0) {
      return new vscode.Hover(new vscode.MarkdownString('🔓 _No test binding for this scenario_'));
    }
    const md = new vscode.MarkdownString();
    for (const b of bindings) {
      if (b.lang === 'python') {
        const pytestCmd = cfg('pytestCommand', 'pytest -q').split(/\s+/)[0];
        md.appendMarkdown(
          `🐍 \`${pytestCmd} "${b.file.path}::${pytestTestName(scenarioName)}"\`\n\n`,
        );
      } else if (b.rustTestFnName) {
        md.appendMarkdown(`🦀 \`cargo test -- --exact ${b.rustTestFnName}\`\n\n`);
      }
    }
    return new vscode.Hover(md);
  }
}
