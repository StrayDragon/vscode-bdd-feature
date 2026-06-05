import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Execute a command asynchronously and return stdout.
 */
export function execAsync(command: string, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cp = require('child_process');
    cp.exec(command, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
      if (error) {
        // pytest returns non-zero on collection errors too, don't reject
        resolve(stdout || stderr);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Read file content from a vscode.Uri.
 */
export async function readFile(uri: vscode.Uri): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return doc.getText();
}

/**
 * Read file content from a filesystem path.
 */
export async function readFileFromPath(filePath: string): Promise<string> {
  const uri = vscode.Uri.file(filePath);
  return readFile(uri);
}

/**
 * Get the workspace root path.
 */
export function getWorkspaceRoot(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

/**
 * Normalize a file path to use forward slashes.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Get a display-friendly relative path from workspace root.
 */
export function getRelativePath(absolutePath: string): string {
  const root = getWorkspaceRoot();
  if (root) {
    const rel = path.relative(root, absolutePath);
    return normalizePath(rel);
  }
  return normalizePath(absolutePath);
}

/**
 * Show a status bar message that auto-disappears.
 */
export function showTemporaryMessage(message: string, durationMs: number = 3000): void {
  const disposable = vscode.window.setStatusBarMessage(message, durationMs);
  // The disposable auto-cleans after duration
}

/**
 * Create an output channel for BDD operations.
 */
let _outputChannel: vscode.OutputChannel | undefined;
export function getOutputChannel(): vscode.OutputChannel {
  if (!_outputChannel) {
    _outputChannel = vscode.window.createOutputChannel('BDD Feature');
  }
  return _outputChannel;
}
