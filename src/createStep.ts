import * as vscode from 'vscode';
import * as path from 'path';
import { parseStepLine, detectDocumentLanguage, resolveInheritedStepType } from './gherkin';
import { getWorkspaceRoot } from './utils';
import { getStepDefinitions, scanStepDefinitions } from './steps';

/**
 * Create a step-definition stub from the step under the cursor.
 * Generates Python (pytest-bdd) or Rust (rstest-bdd) syntax depending on the
 * chosen target file.
 */
export async function createStepDefinition(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'feature') {
    return;
  }

  const document = editor.document;
  const line = document.lineAt(editor.selection.start.line);
  const dialect = detectDocumentLanguage(document.getText());
  const parsed = parseStepLine(line.text, dialect);
  if (!parsed) {
    vscode.window.showWarningMessage('Place cursor on a step line');
    return;
  }

  let stepType =
    parsed.type ??
    resolveInheritedStepType(n => document.lineAt(n).text, line.lineNumber, dialect);

  const hasTable =
    line.lineNumber + 1 < document.lineCount &&
    document.lineAt(line.lineNumber + 1).text.trimStart().startsWith('|');

  await scanStepDefinitions();
  const targetFile = await _selectTargetFile();
  if (!targetFile) {
    return;
  }

  const isRust = targetFile.fsPath.endsWith('.rs');
  const config = vscode.workspace.getConfiguration('bddFeature');
  const parserStyle = config.get<string>('parser', 'parse') as
    | 'string'
    | 'parse'
    | 'cfparse'
    | 're';

  // Build pattern text from quoted params in the feature step.
  const params: string[] = [];
  const quoted = /"([^"]+)"|'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(parsed.text)) !== null) {
    params.push(m[1] ?? m[2]);
  }
  let patternText = parsed.text;
  for (const p of params) {
    patternText = patternText.replace(`"${p}"`, `{${p}}`).replace(`'${p}'`, `{${p}}`);
  }

  const fnName = makeFunctionName(parsed.text);

  const snippetLines = isRust
    ? rustStub(stepType ?? 'given', patternText, fnName, params)
    : pythonStub(stepType ?? 'given', patternText, parserStyle, fnName, params, hasTable);

  const doc = await vscode.workspace.openTextDocument(targetFile);
  const edit = new vscode.WorkspaceEdit();
  const insertPos = new vscode.Position(doc.lineCount, 0);
  edit.insert(
    targetFile,
    insertPos,
    '\n' + snippetLines.join('\n') + '\n',
  );
  await vscode.workspace.applyEdit(edit);

  const newDoc = await vscode.workspace.openTextDocument(targetFile);
  const newEditor = await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside);
  const insertedLine = doc.lineCount;
  newEditor.revealRange(new vscode.Range(insertedLine, 0, insertedLine + snippetLines.length, 0));
}

function pythonStub(
  type: string,
  pattern: string,
  parserStyle: string,
  fnName: string,
  params: string[],
  hasTable: boolean,
): string[] {
  const decoratorArg =
    parserStyle === 'string' ? `"${pattern}"` : `parsers.${parserStyle}("${pattern}")`;
  const sigParams = [...params];
  if (hasTable) {
    sigParams.push('data_table');
  }
  return [
    `@${type}(${decoratorArg})`,
    `def ${fnName}(${sigParams.join(', ')}):`,
    `    """TODO: implement step."""`,
    `    ...`,
  ];
}

function rustStub(type: string, pattern: string, fnName: string, params: string[]): string[] {
  const typedParams = params.map(p => `${p}: String`);
  return [
    `#[${type}("${pattern}")]`,
    `#[allow(dead_code)]`,
    `fn ${fnName}(${typedParams.join(', ')}) {`,
    `    // TODO: implement step`,
    `    unimplemented!()`,
    `}`,
  ];
}

function makeFunctionName(stepText: string): string {
  return (
    stepText
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_]+/gu, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'new_step'
  );
}

async function _selectTargetFile(): Promise<vscode.Uri | undefined> {
  void getStepDefinitions; // definitions already warmed by scanStepDefinitions()
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }

  const pyFiles = await vscode.workspace.findFiles(
    '**/*step*.py',
    '**/{node_modules,target,__pycache__}/**',
    500,
  );
  const rsFiles = await vscode.workspace.findFiles(
    '**/tests/**/*step*.rs',
    '**/{node_modules,target}/**',
    500,
  );
  const candidates = [...pyFiles.filter(f => !f.fsPath.endsWith('__init__.py')), ...rsFiles];

  if (candidates.length === 0) {
    const pick = await vscode.window.showQuickPick(['Python (pytest-bdd)', 'Rust (rstest-bdd)'], {
      placeHolder: 'No step files found — choose language to bootstrap',
    });
    if (!pick) {
      return undefined;
    }
    return bootstrapStepFile(root, pick.startsWith('Python'));
  }

  if (candidates.length === 1) {
    return candidates[0];
  }
  const items = candidates.map(f => ({
    label: f.path.split('/').pop() ?? f.fsPath,
    description: f.path.replace(root, ''),
    uri: f,
  }));
  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a step definition file',
  });
  return selected?.uri;
}

async function bootstrapStepFile(root: string, python: boolean): Promise<vscode.Uri> {
  const fileUri = python
    ? vscode.Uri.file(path.join(root, 'step_defs', 'test_steps.py'))
    : vscode.Uri.file(path.join(root, 'tests', 'bdd_steps.rs'));
  const initial = python
    ? 'from pytest_bdd import given, when, then\n'
    : 'use rstest_bdd_macros::{given, then, when};\n';
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(fileUri, { ignoreIfExists: true });
  edit.insert(fileUri, new vscode.Position(0, 0), initial);
  await vscode.workspace.applyEdit(edit);
  return fileUri;
}
