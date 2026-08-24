import * as vscode from 'vscode';
import * as path from 'path';
import { parseStepLine, detectDocumentLanguage, resolveInheritedStepType } from './gherkin';
import { getWorkspaceRoot } from './utils';
import { getStepDefinitions, scanStepDefinitions } from './steps';

/**
 * Create a step-definition stub from the step under the cursor.
 * Generates Python (pytest-bdd), Rust (rstest-bdd) or TypeScript/JavaScript
 * (cucumber-js / playwright-bdd) syntax depending on the chosen target file.
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
  const hasDocstring =
    line.lineNumber + 1 < document.lineCount &&
    /^[\s]*(?:"""|```)/.test(document.lineAt(line.lineNumber + 1).text);

  await scanStepDefinitions();
  const targetFile = await _selectTargetFile();
  if (!targetFile) {
    return;
  }

  const ext = targetFile.fsPath.split('.').pop()?.toLowerCase() ?? '';
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

  let snippetLines: string[];
  if (ext === 'rs') {
    snippetLines = rustStub(stepType ?? 'given', patternText, fnName, params);
  } else if (ext === 'ts' || ext === 'js' || ext === 'mjs') {
    snippetLines = tsStub(stepType ?? 'given', patternText, fnName, params);
  } else {
    snippetLines = pythonStub(
      stepType ?? 'given',
      patternText,
      parserStyle,
      fnName,
      params,
      hasTable,
      hasDocstring,
    );
  }

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
  hasDocstring: boolean,
): string[] {
  const decoratorArg =
    parserStyle === 'string' ? `"${pattern}"` : `parsers.${parserStyle}("${pattern}")`;
  const sigParams = [...params];
  // pytest-bdd injects tables/docstrings by these EXACT reserved names (8.1+).
  if (hasTable) {
    sigParams.push('datatable');
  }
  if (hasDocstring) {
    sigParams.push('docstring');
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

/** Cucumber Expression stub for cucumber-js / playwright-bdd style files. */
function tsStub(type: string, pattern: string, fnName: string, params: string[]): string[] {
  // Quoted values in the feature text become {string}; bare ints stay literal.
  let expr = pattern;
  const args: string[] = [];
  expr = expr.replace(/"([^"]+)"|'([^']+)'/g, (_all, dq?: string, sq?: string) => {
    const name = sanitizeTsArgName(dq ?? sq ?? `arg${args.length + 1}`);
    args.push(`${name}: string`);
    return `{string}`;
  });
  if (params.length && args.length === 0) {
    for (const p of params) {
      args.push(`${sanitizeTsArgName(p)}: string`);
    }
  }
  const fnLabel = fnName.replace(/[^A-Za-z0-9_]/g, '_');
  return [
    `${type}('${expr}', function ${fnLabel}(${args.join(', ')}) {`,
    `  // TODO: implement step`,
    `  throw new Error('unimplemented');`,
    `});`,
  ];
}

function sanitizeTsArgName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_ ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `arg${cleaned}`;
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

  const exclude = '**/{node_modules,target,__pycache__,dist,out,.features-gen}/**';
  const pyFiles = await vscode.workspace.findFiles('**/*step*.py', exclude, 500);
  const rsFiles = await vscode.workspace.findFiles('**/tests/**/*step*.rs', exclude, 500);
  const tsFiles = await vscode.workspace.findFiles(
    '**/*{[Ss]tep,steps}*/**/*.ts',
    exclude,
    500,
  );
  const tsFlat = await vscode.workspace.findFiles(
    '**/{features,step_definitions,steps,e2e}/**/*.ts',
    exclude,
    500,
  );
  const seen = new Set<string>();
  const candidates = [
    ...pyFiles.filter(f => !f.fsPath.endsWith('__init__.py')),
    ...rsFiles,
    ...[...tsFiles, ...tsFlat].filter(f => !f.fsPath.endsWith('.d.ts') && !seen.has(f.fsPath) && seen.add(f.fsPath)),
  ];

  if (candidates.length === 0) {
    const pick = await vscode.window.showQuickPick(
      ['Python (pytest-bdd)', 'Rust (rstest-bdd)', 'TypeScript (cucumber-js / playwright-bdd)'],
      { placeHolder: 'No step files found — choose language to bootstrap' },
    );
    if (!pick) {
      return undefined;
    }
    return bootstrapStepFile(root, pick);
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

async function bootstrapStepFile(root: string, pick: string): Promise<vscode.Uri> {
  const isPy = pick.startsWith('Python');
  const fileUri = isPy
    ? vscode.Uri.file(path.join(root, 'step_defs', 'test_steps.py'))
    : pick.startsWith('Rust')
      ? vscode.Uri.file(path.join(root, 'tests', 'bdd_steps.rs'))
      : vscode.Uri.file(path.join(root, 'features', 'step_definitions', 'steps.ts'));
  const initial = isPy
    ? 'from pytest_bdd import given, when, then\n'
    : pick.startsWith('Rust')
      ? 'use rstest_bdd_macros::{given, then, when};\n'
      : "import { Given, When, Then } from '@cucumber/cucumber';\n";
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(fileUri, { ignoreIfExists: true });
  edit.insert(fileUri, new vscode.Position(0, 0), initial);
  await vscode.workspace.applyEdit(edit);
  return fileUri;
}
