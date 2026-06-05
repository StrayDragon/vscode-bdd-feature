import * as vscode from 'vscode';
import { normalizeDecorator, stepMatchesDefinition } from './gherkin';

/**
 * Represents a step definition found in a Python file.
 */
export interface StepDefinition {
  /** The keyword type: given, when, then, or step (any) */
  type: 'given' | 'when' | 'then' | 'step';
  /** The step description text (extracted from decorator) */
  text: string;
  /** The file URI */
  file: vscode.Uri;
  /** The line number of the decorator */
  line: number;
}

/**
 * Cache of all discovered step definitions.
 */
let _stepDefinitions: StepDefinition[] = [];
let _stepFiles: vscode.Uri[] = [];

/**
 * Scan all Python step definition files for @given/@when/@then decorators.
 * Looks in step_defs and steps directories.
 */
export async function scanStepDefinitions(): Promise<StepDefinition[]> {
  const defs: StepDefinition[] = [];
  const files: vscode.Uri[] = [];

  // Scan multiple common patterns
  const patterns = [
    '**/step_defs/**/*.py',
    '**/steps/**/*.py',
    '**/step_definitions/**/*.py',
  ];

  for (const pattern of patterns) {
    const found = await vscode.workspace.findFiles(pattern, '**/__pycache__/**');
    for (const file of found) {
      if (files.some(f => f.fsPath === file.fsPath)) {
        continue; // deduplicate
      }
      files.push(file);

      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const lines = text.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          // Match @given(...), @when(...), @then(...), @step(...)
          const decoratorMatch = trimmed.match(/^@(given|when|then|step)\s*\(/);
          if (!decoratorMatch) {
            continue;
          }

          const keywordType = decoratorMatch[1] as 'given' | 'when' | 'then' | 'step';

          // Collect the full decorator text (may span multiple lines)
          let fullDecorator = trimmed;
          let parenDepth = 0;
          for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === '(') {
                parenDepth++;
              } else if (ch === ')') {
                parenDepth--;
              }
            }
            if (j > i) {
              fullDecorator += ' ' + lines[j].trim();
            }
            if (parenDepth <= 0) {
              break;
            }
          }

          const stepText = normalizeDecorator(fullDecorator);
          if (stepText) {
            defs.push({
              type: keywordType,
              text: stepText,
              file: file,
              line: i,
            });
          }
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  _stepDefinitions = defs;
  _stepFiles = files;
  return defs;
}

/**
 * Get cached step definitions.
 */
export function getStepDefinitions(): StepDefinition[] {
  return _stepDefinitions;
}

/**
 * Get cached step files.
 */
export function getStepFiles(): vscode.Uri[] {
  return _stepFiles;
}

/**
 * Find step definitions that match a given feature step text and optional type.
 */
export function findMatchingSteps(
  featureStepText: string,
  stepType?: 'given' | 'when' | 'then',
): StepDefinition[] {
  return _stepDefinitions.filter(def => {
    // If def is 'step' type, it matches any keyword
    if (def.type !== 'step' && stepType && def.type !== stepType) {
      return false;
    }
    return stepMatchesDefinition(featureStepText, def.text);
  });
}

/**
 * Find step definitions whose text starts with or contains the given prefix.
 * Used for auto-completion.
 */
export function findCompletionCandidates(
  prefix: string,
  stepType?: 'given' | 'when' | 'then',
): StepDefinition[] {
  const lowerPrefix = prefix.toLowerCase();
  return _stepDefinitions.filter(def => {
    if (def.type !== 'step' && stepType && def.type !== stepType) {
      return false;
    }
    return def.text.toLowerCase().startsWith(lowerPrefix) ||
           def.text.toLowerCase().includes(lowerPrefix);
  });
}

/**
 * Register file save listener to auto-refresh step definitions.
 */
export function registerStepRefreshOnSave(disposables: vscode.Disposable[]): void {
  disposables.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.languageId === 'python' && doc.uri.fsPath.includes('step')) {
        await scanStepDefinitions();
      }
      if (doc.languageId === 'feature') {
        await scanStepDefinitions();
      }
    }),
  );
}
