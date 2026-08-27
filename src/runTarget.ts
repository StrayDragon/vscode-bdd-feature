import * as vscode from 'vscode';
import { pytestTestName } from './testNames';
import { getBindingsForFeature } from './bindings';
import {
  detectTsBddRunner,
  cucumberCommand,
  playwrightCommand,
  escapeRegExpLiteral,
} from './tsBdd';

/**
 * Shared scenario-execution core used by both the Test Controller and the
 * tag-expression runner. Owns the mapping from (feature, scenario) to the
 * concrete CLI invocation of whichever runner binds it:
 *
 *   python   → pytest <binding-file>::<test-name>
 *   rust     → cargo test -- --exact <generated-fn>
 *   ts/js    → detected runner (cucumber-js --name / playwright -g)
 */

/** Build every runnable command for one scenario (one per binding). */
export async function buildScenarioCommands(
  uri: vscode.Uri,
  scenarioName: string,
): Promise<string[][]> {
  const bindings = getBindingsForFeature(uri.fsPath, scenarioName);
  if (bindings.length === 0) {
    const runner = await detectTsBddRunner();
    if (!runner) {
      return [];
    }
    const nameArg = escapeRegExpLiteral(scenarioName);
    return [
      runner === 'cucumber-js'
        ? [...cucumberCommand().split(/\s+/), uri.fsPath, '--name', nameArg]
        : [...playwrightCommand().split(/\s+/), '-g', nameArg],
    ];
  }

  const cmds: string[][] = [];
  for (const b of bindings) {
    if (b.lang === 'python') {
      const pytestCmd = vscode.workspace
        .getConfiguration('bddFeature')
        .get<string>('pytestCommand', 'pytest -q');
      cmds.push([...pytestCmd.split(/\s+/), `${b.file.fsPath}::${pytestTestName(scenarioName)}`]);
    } else if (b.lang === 'rust') {
      const cargoCmd = vscode.workspace
        .getConfiguration('bddFeature')
        .get<string>('cargoTestCommand', 'cargo test');
      cmds.push([
        ...cargoCmd.split(/\s+/),
        '--',
        '--exact',
        ...(b.rustTestFnName ? [b.rustTestFnName] : []),
      ]);
    } else {
      // TS binding (jest-cucumber): the runnable unit is the binding file,
      // executed by the user's jest/vitest — approximate via detected runner.
      const runner = await detectTsBddRunner();
      if (!runner) {
        continue;
      }
      const nameArg = escapeRegExpLiteral(scenarioName);
      cmds.push(
        runner === 'cucumber-js'
          ? [...cucumberCommand().split(/\s+/), uri.fsPath, '--name', nameArg]
          : [...playwrightCommand().split(/\s+/), '-g', nameArg],
      );
    }
  }
  return cmds;
}

export interface AggregatedRunResult {
  ok: boolean;
  /** Tail of each command's output, separated by markers */
  output: string;
}

/** Execute commands sequentially; aggregate pass/fail like the test controller. */
export async function runScenarioCommands(commands: string[][], cwd?: string): Promise<AggregatedRunResult> {
  let ok = true;
  const outputs: string[] = [];
  for (const cmd of commands) {
    try {
      const out = await execFile(cmd, cwd);
      if (isFailedOutput(out)) {
        ok = false;
      }
      outputs.push(out.slice(-4000));
    } catch (err) {
      ok = false;
      outputs.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { ok, output: outputs.join('\n---\n') };
}

function isFailedOutput(output: string): boolean {
  return (
    /test result:\s*FAILED/.test(output) ||
    /[1-9]\d*\s+failed/.test(output) ||
    /no tests ran|collected\s+0\s+items/.test(output)
  );
}

export function execFile(command: string[], cwd?: string): Promise<string> {
  const cp = require('child_process') as typeof import('child_process');
  return new Promise((resolve, reject) => {
    cp.execFile(
      command[0],
      command.slice(1),
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || String(error)));
        } else {
          resolve(stdout || stderr);
        }
      },
    );
  });
}
