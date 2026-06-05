import * as vscode from 'vscode';
import * as path from 'path';
import { parseStepLine } from './gherkin';
import { getWorkspaceRoot } from './utils';

/**
 * Create a step definition stub from a .feature step line.
 * Generates a Python function with the appropriate decorator.
 */
export async function createStepDefinition(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'feature') {
    return;
  }

  const line = editor.document.lineAt(editor.selection.start.line);
  const stepInfo = parseStepLine(line.text);
  if (!stepInfo) {
    vscode.window.showWarningMessage('Place cursor on a step line (Given/When/Then/假如/当/那么...)');
    return;
  }

  // Check if next line is a table
  let hasTable = false;
  if (editor.document.lineCount > line.lineNumber + 1) {
    const nextLine = editor.document.lineAt(line.lineNumber + 1).text;
    hasTable = nextLine.trimStart().startsWith('|');
  }

  // Determine decorator keyword
  const keywordMap: Record<string, string> = {
    'Given': 'given', '假如': 'given', '假设': 'given', '假定': 'given', '假設': 'given',
    'When': 'when', '当': 'when', '當': 'when',
    'Then': 'then', '那么': 'then', '那麼': 'then',
    'And': 'given', '而且': 'given', '并且': 'given', '同時': 'given', '同时': 'given',
    'But': 'given', '但是': 'given',
    '*': 'given',
  };
  const decoratorKeyword = keywordMap[stepInfo.keyword] || 'given';

  // Get parser setting
  const config = vscode.workspace.getConfiguration('bddFeature');
  const parser = config.get<string>('parser', 'string');

  // Parse quoted parameters from step text
  const params: string[] = [];
  const quotedPattern = /"([^"]+)"|'([^']+)'/g;
  let match;
  while ((match = quotedPattern.exec(stepInfo.text)) !== null) {
    params.push(match[1] || match[2]);
  }

  // Build the step text for the decorator
  let decoratorStepText = stepInfo.text;
  if (parser === 'parse' || parser === 'cfparse') {
    // Replace quoted params with {param}
    for (const param of params) {
      decoratorStepText = decoratorStepText.replace(`"${param}"`, `{${param}}`);
      decoratorStepText = decoratorStepText.replace(`'${param}'`, `{${param}}`);
    }
  }

  // Build the decorator line
  let decoratorArg: string;
  if (parser === 're') {
    decoratorArg = `r"${decoratorStepText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`;
  } else if (parser === 'parse' || parser === 'cfparse') {
    decoratorArg = `"${decoratorStepText}"`;
  } else {
    // string parser — keep original text with quotes
    decoratorArg = `"${stepInfo.text}"`;
  }

  const parserImport = parser !== 'string' ? `from parse_type import cfparse\n` : '';
  const parserRef = parser !== 'string' ? `parsers.${parser}` : '';

  let decoratorLine: string;
  if (parser !== 'string') {
    decoratorLine = `@${decoratorKeyword}(${parserRef}(${decoratorArg}))`;
  } else {
    decoratorLine = `@${decoratorKeyword}(${decoratorArg})`;
  }

  // Build function signature
  const funcName = stepInfo.text
    .toLowerCase()
    .replace(/[\s]+/g, '_')
    .replace(/["',.;:!@#$%^&*()+=<>?/\\|~`[\]{}]/g, '')
    .replace(/-/g, '')
    .substring(0, 60);

  const funcParams: string[] = [];
  for (const param of params) {
    funcParams.push(param);
  }
  if (hasTable) {
    funcParams.push('datatable');
  }

  // Build the full stub
  const lines = [
    '',
    decoratorLine,
    `def ${funcName}(${funcParams.join(', ')}):`,
    `    # TODO: implement step`,
    `    pass`,
  ];

  // Find target file
  const targetFile = await _selectStepFile(editor.document.uri);
  if (!targetFile) {
    return;
  }

  // Insert into target file
  const doc = await vscode.workspace.openTextDocument(targetFile);
  const edit = new vscode.WorkspaceEdit();
  const insertPos = new vscode.Position(doc.lineCount, 0);
  edit.insert(targetFile, insertPos, lines.join('\n') + '\n');
  await vscode.workspace.applyEdit(edit);

  // Show and focus the inserted code
  const newDoc = await vscode.workspace.openTextDocument(targetFile);
  const newEditor = await vscode.window.showTextDocument(newDoc, vscode.ViewColumn.Beside);
  const insertedLine = doc.lineCount; // approximate
  newEditor.revealRange(new vscode.Range(insertedLine, 0, insertedLine + 5, 0));
}

/**
 * Select a step definition file to insert into.
 * If only one exists, use it directly. Otherwise show a picker.
 */
async function _selectStepFile(featureUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const root = getWorkspaceRoot();
  if (!root) {
    return undefined;
  }

  // Find step definition files
  const patterns = ['**/step_defs/**/*.py', '**/steps/**/*.py', '**/step_definitions/**/*.py'];
  const allFiles: vscode.Uri[] = [];
  for (const pattern of patterns) {
    const found = await vscode.workspace.findFiles(pattern, '**/__pycache__/**');
    for (const f of found) {
      if (!allFiles.some(af => af.fsPath === f.fsPath)) {
        allFiles.push(f);
      }
    }
  }

  // Filter out __init__.py
  const stepFiles = allFiles.filter(f => !f.fsPath.endsWith('__init__.py'));

  if (stepFiles.length === 0) {
    // No step files found — offer to create one
    const featureDir = path.dirname(featureUri.fsPath);
    const stepDir = path.join(featureDir, '..', 'step_defs');
    const newFile = vscode.Uri.file(path.join(stepDir, 'test_steps.py'));

    const choice = await vscode.window.showInformationMessage(
      'No step definition files found. Create a new one?',
      'Create', 'Cancel',
    );
    if (choice === 'Create') {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(newFile, { ignoreIfExists: true });
      edit.insert(newFile, new vscode.Position(0, 0), 'from pytest_bdd import given, when, then\n\n');
      await vscode.workspace.applyEdit(edit);
      return newFile;
    }
    return undefined;
  }

  if (stepFiles.length === 1) {
    return stepFiles[0];
  }

  // Show picker
  const items = stepFiles.map(f => ({
    label: path.basename(f.fsPath),
    description: path.dirname(f.fsPath).replace(root, ''),
    uri: f,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a step definition file',
  });

  return selected?.uri;
}
