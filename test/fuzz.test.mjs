// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runFuzz } from './fuzz-js.mjs';

const source = await readFile(new URL('../build/pmp-core.wasm', import.meta.url));

test('seeded public-wrapper workflows cover each implemented algorithm family', async t => {
  const result = await runFuzz(source, { seed: 1, seeds: 14 });
  assert.equal(new Set(result.results.map(entry => entry.family)).size, 14);
  assert(result.assertions > 10000);
  assert.deepEqual(result.results.map(entry => entry.seed), Array.from({ length: 14 }, (_, i) => i + 1));
  t.diagnostic(`${result.seeds} reproducible seeds; ${result.assertions} invariants and metamorphic assertions`);
});

test('byte and compiled-module fuzzing reproduce a wrapped u32 seed sequence', async () => {
  const options = { seed: 0xfffffffe, seeds: 3 };
  const bytes = await runFuzz(source, options);
  const compiled = await runFuzz(await WebAssembly.compile(source), options);
  assert.deepEqual(compiled, bytes);
  assert.deepEqual(bytes.results.map(entry => entry.seed), [0xfffffffe, 0xffffffff, 0]);
});

test('unexpected traps in a valid workflow retain the replay seed and original error', async () => {
  // A deliberately tiny ABI-shaped module traps at mesh creation. The fuzzer
  // must fail the valid workflow, rather than accepting every RuntimeError as
  // an expected malformed-input rejection.
  const text = new TextEncoder();
  const entry = (name, kind, index) => [...text.encode(name)].length < 128
    ? [name.length, ...text.encode(name), kind, index] : assert.fail('short export name required');
  const exports = [3, ...entry('memory', 2, 0), ...entry('pmp_abi_version', 0, 0), ...entry('pmp_mesh_create', 0, 1)];
  const module = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    1, 5, 1, 0x60, 0, 1, 0x7f,
    3, 3, 2, 0, 0,
    5, 3, 1, 0, 1,
    7, exports.length, ...exports,
    10, 10, 2, 4, 0, 0x41, 0, 0x0b, 3, 0, 0, 0x0b,
  ]);
  await assert.rejects(runFuzz(module, { seed: 47, seeds: 1 }), error => {
    assert.equal(error.seed, 47);
    assert.equal(error.stage, 'construct');
    assert(error.cause instanceof WebAssembly.RuntimeError);
    assert.match(error.message, /seed=47 stage=construct/);
    return true;
  });
});
