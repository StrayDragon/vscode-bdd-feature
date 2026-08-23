import * as vscode from 'vscode';
import * as path from 'path';
import { getWorkspaceRoot } from './utils';
import { parseFeatureLine, parseScenarioLine, detectDocumentLanguage } from './gherkin';
import { ensureBindings } from './bindings';

/**
 * Bind a feature file to a test:
 *  - Python: append scenarios("<relative path>") to a chosen existing binding
 *    module (or create test_<stem>.py next to the features dir)
 *  - Rust: append a #[scenario] stub per scenario into a chosen bindings file
 */
export async function bindFeatureCommand(featureUri?: vscode.Uri): Promise<void> {
  const uri =
    featureUri ??
    vscode.window.activeTextEditor?.document.uri;
  const root = getWorkspaceRoot();
  if (!uri || !root || !uri.fsPath.endsWith('.feature')) {
    vscode.window.showWarningMessage('Run from a .feature file');
    return;
  }

  await ensureBindings();
  const doc = await vscode.workspace.openTextDocument(uri);
  const dialect = detectDocumentLanguage(doc.getText());

  // Collect scenarios for rust per-scenario bindings
  const scenarios: string[] = [];
  let featureTitle = '';
  for (let i = 0; i < doc.lineCount; i++) {
    const f = parseFeatureLine(doc.lineAt(i).text, dialect);
    if (f !== undefined && f.trim()) {
      featureTitle = f;
      break;
    }
  }
  void featureTitle;
  for (let i = 0; i < doc.lineCount; i++) {
    const name = parseScenarioLine(doc.lineAt(i).text, dialect);
    if (name !== undefined) {
      scenarios.push(name);
    }
  }

  const lang = await vscode.window.showQuickPick(
    [
      { label: 'Python (pytest-bdd)', value: 'python' as const },
      { label: 'Rust (rstest-bdd)', value: 'rust' as const },
    ],
    { placeHolder: 'Binding language' },
  );
  if (!lang) {
    return;
  }
  const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');

  if (lang.value === 'python') {
    const target = await pickOrCreatePythonTarget(root, uri);
    if (!target) {
      return;
    }
    const snippet = `\nscenarios("${rel}")\n`;
    await appendToFile(target, snippet);
    return;
  }

  // Rust — choose an existing bindings file under tests/
  const rsFiles = await vscode.workspace.findFiles('**/tests/**/*.rs', '**/{node_modules,target}/**', 500);
  const candidates = [];
  for (const f of rsFiles) {
    const text = (await vscode.workspace.openTextDocument(f)).getText();
    if (text.includes('#[scenario') || text.includes('scenario(')) {
      candidates.push(f);
    }
  }
  const picked = candidates.length
    ? (await vscode.window.showQuickPick(candidates.map(c => ({ label: c.path.split('/').pop()!, uri: c })), {
        placeHolder: 'Select a bindings file',
      }))?.uri
    : undefined;
  if (!picked) {
    vscode.window.showInformationMessage('Create a tests/**/bindings_*.rs file first');
    return;
  }
  const fnBase = path.basename(uri.fsPath, '.feature').replace(/[^\p{L}\p{N}_]+/gu, '_').toLowerCase();
  const lines: string[] = [''];
  scenarios.forEach((name, idx) => {
    const fnName = `test_${fnBase}_${idx}`;
    lines.push(`#[scenario(path = "${rel}", name = "${name}")]`);
    lines.push(`fn ${fnName}() {}`);
    lines.push('');
  });
  await appendToFile(picked, '\n' + lines.join('\n'));
}

async function appendToFile(uri: vscode.Uri, text: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(doc.lineCount, 0), text);
  await vscode.workspace.applyEdit(edit);
  await doc.save();
}

async function pickOrCreatePythonTarget(
  root: string,
  featureUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const pyFiles = await vscode.workspace.findFiles('**/*.py', '**/{node_modules,target,__pycache__}/**', 2000);
  const binders: vscode.Uri[] = [];
  for (const f of pyFiles) {
    try {
      const text = (await vscode.workspace.openTextDocument(f)).getText();
      if (/\bscenario(s)?\s*\(/.test(text)) {
        binders.push(f);
      }
    } catch {
      // skip
    }
  }
  const items: Array<{ label: string; uri?: vscode.Uri }> = binders.map(b => ({
    label: path.relative(root, b.fsPath),
    uri: b,
  }));
  items.push({ label: '+ Create new binding file' });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Bind via which module?',
  });
  if (!picked) {
    return undefined;
  }
  if (picked.uri) {
    return picked.uri;
  }
  const stem = path.basename(featureUri.fsPath, '.feature');
  const newUri = vscode.Uri.file(path.join(path.dirname(featureUri.fsPath), '..', `test_${stem}.py`));
  const edit = new vscode.WorkspaceEdit();
  edit.createFile(newUri, { ignoreIfExists: true });
  edit.insert(newUri, new vscode.Position(0, 0), 'from pytest_bdd import scenarios\n');
  await vscode.workspace.applyEdit(edit);
  return newUri;
}
