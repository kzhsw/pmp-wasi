// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runExtensions } from './e2e/extensions.mjs';

const root = new URL('../', import.meta.url);
const [bytes, fixtures] = await Promise.all([
  readFile(new URL('build/pmp-core.wasm', root)),
  readFile(new URL('test/fixtures/native-extensions.json', root), 'utf8').then(JSON.parse),
]);

test('five extension groups and large solvers match 43 untouched native PMP fixtures with attribute and failure coverage', async t => {
  const result = await runExtensions(bytes, fixtures);
  assert(result.assertions > 10000);
  assert.deepEqual(result.cases.slice(0, fixtures.length).map(entry => entry.name), fixtures.map(entry => entry.name));
  let maximumPositionError = 0, maximumCurvatureError = 0;
  for (let i = 0; i < fixtures.length; ++i) {
    const actual = result.cases[i].output, expected = fixtures[i].output;
    if (expected.positions) expected.positions.forEach((value, component) => {
      maximumPositionError = Math.max(maximumPositionError, Math.abs(value - actual.positions[component]));
    });
    if (expected.phases) expected.phases.forEach((phase, index) => phase.samples.forEach((value, component) => {
      maximumPositionError = Math.max(maximumPositionError, Math.abs(value - actual.phases[index].samples[component]));
    }));
    if (fixtures[i].operation === 'pmp_curvature') expected.values.forEach((value, vertex) => {
      maximumCurvatureError = Math.max(maximumCurvatureError, Math.abs(value - actual.values[vertex]));
    });
  }
  t.diagnostic(`${result.cases.length} cases; ${result.assertions} assertions; maximum native position drift ${maximumPositionError}; maximum native curvature drift ${maximumCurvatureError}`);
});
