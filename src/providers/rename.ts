import * as vscode from 'vscode';
import { parseStepLine, parseScenarioLine, detectDocumentLanguage } from '../gherkin';
import { scanStepDefinitions, findMatchingSteps } from '../steps';
import { ensureBindings, getBindingsForFeature } from '../bindings';
import { toggles } from '../config';

/**
 * Rename support:
 *  1. Feature step backed ONLY by exact-match definitions → renames every
 *     definition pattern and every feature occurrence. Parametric matches
 *     are rejected (ambiguous).
 *  2. Scenario title in .feature with Rust bindings → syncs each
 *     #[scenario(name="…")] string.
 *  3. Rust scenario-name string → syncs the matching .feature title.
 */
export class BddRenameProvider implements vscode.RenameProvider {
  prepareRename(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken,
  ): vscode.Range | undefined {
    if (!toggles.rename()) {
      return undefined;
    }
    const line = document.lineAt(position.line);
    const dialect = detectDocumentLanguage(document.getText());

    if (document.languageId === 'feature') {
      const parsed = parseStepLine(line.text, dialect);
      if (parsed) {
        const defs = findMatchingSteps(parsed.text);
        if (defs.length === 0 || !defs.every(d => d.matcherKind === 'exact')) {
          return undefined;
        }
        return this._stepTextRange(line, parsed.keyword);
      }
      const sc = parseScenarioLine(line.text, dialect);
      if (sc !== undefined && this._hasRustBinding(document.uri.fsPath, sc)) {
        return this._scenarioTitleRange(line);
      }
      return undefined;
    }

    if (document.languageId === 'rust') {
      return this._rustNameRange(document, position)?.range;
    }
    return undefined;
  }

  async provideRenameEdits(
    document: vscode.TextDocument,
    position: vscode.Position,
    newName: string,
    _token: vscode.CancellationToken,
  ): Promise<vscode.WorkspaceEdit | undefined> {
    if (!toggles.rename() || !newName.trim()) {
      return undefined;
    }
    newName = newName.trim();
    await Promise.all([scanStepDefinitions(), ensureBindings()]);

    const line = document.lineAt(position.line);
    const dialect = detectDocumentLanguage(document.getText());
    const edit = new vscode.WorkspaceEdit();

    // ── 1. Step rename (feature file) ──
    if (document.languageId === 'feature') {
      const parsed = parseStepLine(line.text, dialect);
      if (parsed) {
        const defs = findMatchingSteps(parsed.text);
        if (defs.length === 0) {
          throw new Error('No definition matches this step');
        }
        if (!defs.every(d => d.matcherKind === 'exact' && d.text.trim() === parsed.text)) {
          throw new Error(
            'Cannot rename parametric steps — edit the pattern in the definition directly',
          );
        }
        for (const def of defs) {
          const r = def.patternSelection
            ? new vscode.Range(
                def.patternSelection.startLine,
                def.patternSelection.startCol,
                def.patternSelection.endLine,
                def.patternSelection.endCol,
              )
            : new vscode.Range(def.decoratorLine, 0, def.decoratorLine + 1, 0);
          edit.replace(def.file, r, newName);
        }
        await this._replaceAllUsages(edit, parsed.text, newName);
        return edit;
      }

      // ── 2. Scenario title rename ──
      const sc = parseScenarioLine(line.text, dialect);
      if (sc !== undefined && this._hasRustBinding(document.uri.fsPath, sc)) {
        for (const b of getBindingsForFeature(document.uri.fsPath, sc)) {
          if (b.lang !== 'rust') {
            continue;
          }
          const doc2 = await vscode.workspace.openTextDocument(b.file);
          const range = findRustNameValueRange(doc2.getText(), sc);
          if (range) {
            edit.replace(b.file, range.range, newName);
          }
        }
        edit.replace(document.uri, this._scenarioTitleRange(line)!, newName);
        return edit;
      }
      return undefined;
    }

    // ── 3. Rust name string rename ──
    if (document.languageId === 'rust') {
      const hit = this._rustNameRange(document, position);
      if (!hit) {
        return undefined;
      }
      const files = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
      let replaced = false;
      for (const uri of files) {
        const fdoc = await vscode.workspace.openTextDocument(uri);
        const fdialect = detectDocumentLanguage(fdoc.getText());
        for (let i = 0; i < fdoc.lineCount; i++) {
          if (parseScenarioLine(fdoc.lineAt(i).text, fdialect) !== hit.text) {
            continue;
          }
          const l = fdoc.lineAt(i).text;
          const kw = l.trimStart().match(/^[^:]+:/)?.[0] ?? ':';
          const start = l.indexOf(kw) + kw.length;
          const after = l.slice(start);
          const ws = after.length - after.trimStart().length;
          const colStart = start + ws;
          edit.replace(uri, new vscode.Range(i, colStart, i, colStart + hit.text.length), newName);
          replaced = true;
        }
      }
      if (!replaced) {
        throw new Error(`No .feature scenario titled "${hit.text}" found`);
      }
      edit.replace(document.uri, hit.range, newName);
      return edit;
    }

    return undefined;
  }

  private async _replaceAllUsages(
    edit: vscode.WorkspaceEdit,
    oldText: string,
    newText: string,
  ): Promise<void> {
    const files = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);
    for (const uri of files) {
      try {
        const doc = await vscode.workspace.openTextDocument(uri);
        const dialect = detectDocumentLanguage(doc.getText());
        for (let i = 0; i < doc.lineCount; i++) {
          const raw = doc.lineAt(i).text;
          const p = parseStepLine(raw, dialect);
          if (p?.text !== oldText) {
            continue;
          }
          // Locate the step text via the keyword offset (lastIndexOf could
          // mis-target when the text appears twice on one line).
          const kwIdx = raw.indexOf(p.keyword);
          if (kwIdx < 0) {
            continue;
          }
          const after = raw.slice(kwIdx + p.keyword.length);
          const ws = after.length - after.trimStart().length;
          const start = kwIdx + p.keyword.length + ws;
          edit.replace(uri, new vscode.Range(i, start, i, start + oldText.length), newText);
        }
      } catch {
        // skip
      }
    }
  }

  private _rustNameRange(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): { range: vscode.Range; text: string } | undefined {
    const re = /name\s*=\s*"((?:[^"\\]|\\.)*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(document.getText())) !== null) {
      const startOffset = m.index + m[0].indexOf('"') + 1;
      const startPos = document.positionAt(startOffset);
      const endPos = document.positionAt(startOffset + m[1].length);
      const range = new vscode.Range(startPos, endPos);
      if (range.contains(position)) {
        return { range, text: m[1] };
      }
    }
    return undefined;
  }

  private _hasRustBinding(fsPath: string, scenario: string): boolean {
    return getBindingsForFeature(fsPath, scenario).some(b => b.lang === 'rust');
  }

  /** Range of the step text after the keyword. */
  private _stepTextRange(line: vscode.TextLine, keyword: string): vscode.Range | undefined {
    const idx = line.text.indexOf(keyword);
    if (idx < 0) {
      return undefined;
    }
    const after = line.text.slice(idx + keyword.length);
    const ws = after.length - after.trimStart().length;
    const start = idx + keyword.length + ws;
    return new vscode.Range(
      line.lineNumber,
      start,
      line.lineNumber,
      start + after.trim().length,
    );
  }

  /** Range of the scenario title (after "Keyword: "). */
  private _scenarioTitleRange(line: vscode.TextLine): vscode.Range | undefined {
    const kwMatch = line.text.trimStart().match(/^[^:]+:\s*/);
    if (!kwMatch) {
      return undefined;
    }
    const start =
      line.text.length - line.text.trimStart().length + kwMatch[0].length;
    let end = line.text.length;
    const hash = line.text.indexOf('#', start);
    if (hash >= 0) {
      end = hash;
    }
    const len = line.text.slice(start, end).trimEnd().length;
    return new vscode.Range(line.lineNumber, start, line.lineNumber, start + len);
  }
}

function findRustNameValueRange(
  source: string,
  scenarioName: string,
): { range: vscode.Range } | undefined {
  const nameRe = /name\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(source)) !== null) {
    if (m[1] !== scenarioName) {
      continue;
    }
    const before = source.slice(0, m.index);
    const lineNo = before.split('\n').length - 1;
    const colStart = before.length - (before.lastIndexOf('\n') + 1) + m[0].indexOf('"') + 1;
    return { range: new vscode.Range(lineNo, colStart, lineNo, colStart + scenarioName.length) };
  }
  return undefined;
}
