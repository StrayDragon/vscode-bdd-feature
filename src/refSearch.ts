import * as vscode from 'vscode';
import { parseStepLine, detectDocumentLanguage } from './gherkin';
import { getStepDefinitions } from './steps';
import { stepMatchesDefinition } from './matching';
import type { StepDefinition } from './model';

export interface StepUsage {
  uri: vscode.Uri;
  line: number;
  startCol: number;
  endCol: number;
  text: string;
}

/**
 * Find every feature-file usage that resolves to any of `defs`.
 * When defs is empty and stepText given, fall back to textual equality.
 */
export async function findStepUsages(
  defs: readonly StepDefinition[],
  opts?: { excludeUri?: vscode.Uri; fallbackText?: string },
): Promise<StepUsage[]> {
  const usages: StepUsage[] = [];
  const files = await vscode.workspace.findFiles('**/*.feature', '**/{node_modules,target}/**', 3000);

  for (const uri of files) {
    if (opts?.excludeUri && uri.fsPath === opts.excludeUri.fsPath) {
      continue;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const dialect = detectDocumentLanguage(doc.getText());
      for (let i = 0; i < doc.lineCount; i++) {
        const raw = doc.lineAt(i).text;
        const parsed = parseStepLine(raw, dialect);
        if (!parsed) {
          continue;
        }
        const matches =
          defs.length > 0
            ? defs.some(d => stepMatchesDefinition(parsed.text, d))
            : opts?.fallbackText !== undefined && parsed.text === opts.fallbackText;
        if (!matches) {
          continue;
        }
        // Column span of the step text after the keyword
        const kwIdx = raw.indexOf(parsed.keyword);
        const after = raw.slice(kwIdx + parsed.keyword.length);
        const ws = after.length - after.trimStart().length;
        const start = kwIdx + parsed.keyword.length + ws;
        usages.push({ uri, line: i, startCol: start, endCol: start + parsed.text.length, text: parsed.text });
      }
    } catch {
      // skip unreadable files
    }
  }
  return usages;
}

/** Definitions declared in a given file (optionally at a specific line). */
export function defsInFile(fsPath: string, line?: number): StepDefinition[] {
  return getStepDefinitions().filter(
    d => d.file.fsPath === fsPath && (line === undefined || d.decoratorLine === line || d.functionLine === line),
  );
}
