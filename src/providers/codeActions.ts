import * as vscode from 'vscode';
import { toggles } from '../config';

/**
 * Quick fixes:
 *  - undefinedStep  → "Create step definition for this step"
 *  - unboundFeature → "Bind this feature" (scenarios()/#[scenario])
 *  - invalidPattern → jump-to-source style info (no fix offered)
 */
export class BddCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedKinds = [
    vscode.CodeActionKind.QuickFix,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
    _token: vscode.CancellationToken,
  ): vscode.CodeAction[] {
    if (!toggles.codeActions()) {
      return [];
    }
    const actions: vscode.CodeAction[] = [];

    for (const diag of context.diagnostics) {
      if (diag.source !== 'BDD Feature') {
        continue;
      }
      if (diag.code === 'undefinedStep') {
        const fix = new vscode.CodeAction(
          'BDD: Create step definition for this step',
          vscode.CodeActionKind.QuickFix,
        );
        // createStepDefinition operates on the active editor cursor — the
        // lightbulb is invoked with the cursor on the diagnostic line.
        fix.command = {
          command: 'bddFeature.createStep',
          title: 'Create step definition',
        };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
      if (diag.code === 'unboundFeature') {
        const fix = new vscode.CodeAction(
          'BDD: Bind this feature to a test',
          vscode.CodeActionKind.QuickFix,
        );
        fix.command = {
          command: 'bddFeature.bindFeature',
          title: 'Bind feature',
          arguments: [document.uri],
        };
        fix.diagnostics = [diag];
        actions.push(fix);
      }
    }

    return actions;
  }
}
