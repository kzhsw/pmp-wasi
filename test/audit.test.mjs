// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { audit, auditLinkMap, binaryenFlags, inspect, stripTargetFeatures, targetFeatures } from '../scripts/wasm.mjs';

const names = ['memory', 'f'];
const baseline = targetFeatures;
const scalar = [0, 11];
const simd = [0, 253, 12, ...Array(16).fill(0), 26, 11]; // v128.const 0; drop
const uint = value => value < 128 ? [value] : [128 | (value & 127), ...uint(value >>> 7)];
const string = value => {
  const bytes = new TextEncoder().encode(value);
  return [...uint(bytes.length), ...bytes];
};
const section = (id, bytes) => [id, ...uint(bytes.length), ...bytes];
function fixture(body = scalar, features = baseline, { type = [96, 0, 0], globals = [], tables = [] } = {}) {
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, ...type]), ...section(3, [1, 0]),
    ...(tables.length ? section(4, tables) : []), ...section(5, [1, 0, 0]),
    ...(globals.length ? section(6, globals) : []),
    ...section(7, [2, ...string('memory'), 2, 0, ...string('f'), 0, 0]),
    ...section(10, [1, ...uint(body.length), ...body]),
    ...(features === null ? [] : section(0, [...string('target_features'),
      ...uint(features.length), ...features.flatMap(feature => [feature.charCodeAt(0), ...string(feature.slice(1))])])),
  ]);
}

test('final audit rejects features beyond the Chrome 75 target', () => {
  assert.deepEqual(audit(fixture(), names).features, baseline);
  for (const features of [null, [], ['-mutable-globals'], ['+simd128'], ['+atomics'],
    ['+exception-handling'], ['+extended-const'], ['+reference-types'], ['+multivalue'],
    ['+call-indirect-overlong'], ['+mutable-globals'], ['+sign-ext'], ['+unknown-feature']])
    assert.throws(() => audit(fixture(scalar, features), names), undefined, JSON.stringify(features));
  assert.throws(() => audit(fixture(simd, null), names));
});

test('linked SDK metadata is recorded separately and stripped without changing code', () => {
  const bytes = fixture(scalar, [...baseline, '+extended-const', '+multivalue', '+reference-types']);
  const linked = audit(bytes, names, { linked: true });
  assert(linked.features.includes('+extended-const'));
  const stripped = stripTargetFeatures(bytes);
  assert.deepEqual(stripped, fixture(scalar, null));
  assert.deepEqual(inspect(stripped).bodies, linked.bodies);
  assert.deepEqual(inspect(stripped).features, []);
});

test('link map rejects live I/O, host, thread, and exception families', () => {
  const forbidden = [
    'printf', 'snprintf', '__snprintf_chk', 'snprintf_l', 'puts', 'putchar',
    'fopen', 'fwrite', 'open', 'read', 'write', 'socket', 'connect',
    'std::__2::basic_ostream<char>::put(char)', 'std::__2::basic_istream<char>::get()',
    'getenv', 'setenv', 'environ', 'exit', '_Exit', 'system',
    'pthread_create', 'thrd_create', 'std::__2::thread::join()',
    '__stack_chk_guard', '__stack_chk_fail', '__wasi_fd_write', '__wasilibc_initialize_environ',
    '__cxa_throw', '__cxa_allocate_exception', '_Unwind_RaiseException', '__wasm_call_dtors',
  ];
  for (const symbol of forbidden)
    assert.throws(() => auditLinkMap(`- 123 4 build/core.link.wasm.lto.o:(${symbol})`), undefined, symbol);
  assert.throws(() => auditLinkMap('- 123 4 .command_export'));
});

test('link map permits mesh, allocator, math, and trap symbols', () => {
  for (const symbol of ['pmp_mesh_create', 'pmp_detect_features', 'pmp_free', 'malloc', 'free',
    'dlmalloc', 'dlmemalign', 'sbrk', 'memcpy', 'strlen', 'cosf', 'acosf', 'sqrt',
    'operator new(unsigned long)', 'pmp::SurfaceMesh::add_face(unsigned int const*, unsigned long, bool)',
    'abort', '__abort_message'])
    assert.doesNotThrow(() => auditLinkMap(`- 123 4 build/core.link.wasm.lto.o:(${symbol})`), symbol);
});

test('Binaryen checks the actual artifact and rejects post-Chrome-75 instruction fixtures', () => {
  assert(process.env.BINARYEN_PATH, 'Set BINARYEN_PATH to the installed Binaryen directory');
  const directory = mkdtempSync(join(tmpdir(), 'pmp-audit-'));
  try {
    const input = join(directory, 'input.wasm');
    const output = join(directory, 'output.wasm');
    const check = bytes => {
      writeFileSync(input, stripTargetFeatures(bytes));
      const result = spawnSync(join(process.env.BINARYEN_PATH, 'bin/wasm-opt'),
        [input, ...binaryenFlags(), '--emit-target-features', '-o', output], { encoding: 'utf8' });
      assert.ifError(result.error);
      return result;
    };
    const control = check(fixture());
    assert.equal(control.status, 0, control.stderr);
    assert.deepEqual(audit(readFileSync(output), names).features, targetFeatures);
    const unsupported = [
      fixture(simd, ['+simd128']),
      fixture(scalar, ['+extended-const'], { globals: [1, 127, 0, 65, 1, 65, 2, 106, 11] }),
      fixture([0, 65, 1, 65, 2, 11], ['+multivalue'], { type: [96, 0, 2, 127, 127] }),
      fixture([0, 208, 111, 26, 11], ['+reference-types']), // ref.null externref; drop
    ];
    for (const bytes of unsupported) {
      assert.doesNotThrow(() => new WebAssembly.Module(bytes), 'Negative fixture must be valid modern Wasm');
      const rejected = check(bytes);
      assert.notEqual(rejected.status, 0, 'A post-Chrome-75 feature escaped strict instruction validation');
    }
    // The old call_indirect format ends with one reserved 00 byte. SDK objects
    // can encode it as a padded table-index LEB; the constrained writer must
    // canonicalize it back to the legacy representation.
    const padded = check(fixture([0, 65, 0, 17, 0, 128, 128, 128, 128, 0, 11],
      ['+call-indirect-overlong'], { tables: [1, 112, 0, 1] }));
    assert.equal(padded.status, 0, padded.stderr);
    assert.deepEqual([...inspect(readFileSync(output)).bodies[0]], [0, 65, 0, 17, 0, 0, 11]);
    const artifact = readFileSync(new URL('../build/pmp-core.wasm', import.meta.url));
    assert.deepEqual(inspect(artifact).features, targetFeatures);
    const validated = check(artifact);
    assert.equal(validated.status, 0, validated.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
