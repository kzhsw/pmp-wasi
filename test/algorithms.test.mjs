// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runAlgorithms } from './e2e/algorithms.mjs';

const root = new URL('../', import.meta.url);
const [bytes, fixtures] = await Promise.all([
  readFile(new URL('build/pmp-core.wasm', root)),
  readFile(new URL('test/fixtures/native-algorithms.json', root), 'utf8').then(JSON.parse),
]);

test('five algorithm families match 22 untouched native PMP references and survive repeated calls', async t => {
  const result = await runAlgorithms(bytes, fixtures);
  assert(result.assertions > 1000);
  assert.deepEqual(result.cases.slice(0, fixtures.length).map(entry => entry.name), fixtures.map(entry => entry.name));
  let worst = { error: 0, name: '' };
  for (let i = 0; i < fixtures.length; ++i) {
    const actual = result.cases[i].output.positions, expected = fixtures[i].output.positions;
    for (let component = 0; component < expected.length; ++component) {
      const error = Math.abs(actual[component] - expected[component]);
      if (error > worst.error) worst = { error, name: fixtures[i].name };
    }
  }
  t.diagnostic(`${result.cases.length} cases; ${result.assertions} assertions; maximum native position drift ${worst.error} (${worst.name})`);
});
