import { defineConfig } from '@vscode/test-cli';
import * as path from 'node:path';

/**
 * Launch VS Code with this repository as the workspace so that
 * workspace.findFiles / providers operate on test-fixtures/**.
 */
export default defineConfig({
  files: 'out/test/**/*.test.js',
  launchArgs: [
    path.resolve(import.meta.dirname ?? '.'),
    '--disable-extensions',
    '--disable-workspace-trust',
  ],
});
