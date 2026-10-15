import * as assert from 'assert';

import { pathUnderRoot } from '../../profiles/resolve';
import { definitionsForFeature } from '../../profiles/scope';
import type { StepDefinition } from '../../model';
import * as vscode from 'vscode';

suite('Framework profile scoping', () => {
  test('pathUnderRoot matches nested feature paths', () => {
    assert.ok(pathUnderRoot('llmanspec/specs/cli.feature', 'llmanspec/specs'));
    assert.ok(!pathUnderRoot('other/x.feature', 'llmanspec/specs'));
  });

  test('pathUnderRoot matches nested tests/bdd in monorepos', () => {
    assert.ok(pathUnderRoot('apps/server/tests/bdd/steps/x.ts', 'tests/bdd'));
  });

  test('definitionsForFeature filters to profile step roots', () => {
    const root = '/ws';
    const defs: StepDefinition[] = [
      {
        lang: 'typescript',
        frameworkId: 'member-dsl-bdd',
        profileId: 'member-dsl-bdd',
        type: 'given',
        matcherKind: 'parse-lite',
        text: 'a',
        file: vscode.Uri.file('/ws/tests/bdd/steps/x.ts'),
        decoratorLine: 0,
      },
      {
        lang: 'typescript',
        frameworkId: 'cucumber-js',
        profileId: 'cucumber-js',
        type: 'given',
        matcherKind: 'cexpr',
        text: 'b',
        file: vscode.Uri.file('/ws/src/foo.ts'),
        decoratorLine: 0,
      },
    ];
    const scoped = definitionsForFeature(
      '/ws/llmanspec/specs/t.feature',
      defs,
      root,
    );
    assert.strictEqual(scoped.length, 1);
    assert.strictEqual(scoped[0].text, 'a');
  });
});
