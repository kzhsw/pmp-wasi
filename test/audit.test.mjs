// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { audit, auditLinkMap, binaryenFlags } from '../scripts/wasm.mjs';

const names = ['memory', 'f'];
const baseline = ['+mutable-globals'];
const scalar = [0, 11];
const simd = [0, 253, 12, ...Array(16).fill(0), 26, 11]; // v128.const 0; drop
const uint = value => value < 128 ? [value] : [128 | (value & 127), ...uint(value >>> 7)];
const string = value => {
  const bytes = new TextEncoder().encode(value);
  return [...uint(bytes.length), ...bytes];
};
const section = (id, bytes) => [id, ...uint(bytes.length), ...bytes];
function fixture(body = scalar, features = baseline) {
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 96, 0, 0]), ...section(3, [1, 0]), ...section(5, [1, 0, 0]),
    ...section(7, [2, ...string('memory'), 2, 0, ...string('f'), 0, 0]),
    ...section(10, [1, ...uint(body.length), ...body]),
    ...(features === null ? [] : section(0, [...string('target_features'),
      ...uint(features.length), ...features.flatMap(feature => [feature.charCodeAt(0), ...string(feature.slice(1))])])),
  ]);
}

test('audit requires explicit, known SDK feature metadata', () => {
  assert.deepEqual(audit(fixture(), names).features, baseline);
  for (const features of [null, [], ['-mutable-globals'], ['+simd128'], ['+atomics'],
    ['+exception-handling'], ['+unknown-feature']])
    assert.throws(() => audit(fixture(scalar, features), names), undefined, JSON.stringify(features));
  assert.throws(() => audit(fixture(simd, null), names));
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

test('Binaryen rejects unadvertised SIMD under the explicit SDK feature baseline', () => {
  assert(process.env.BINARYEN_PATH, 'Set BINARYEN_PATH to the installed Binaryen directory');
  const directory = mkdtempSync(join(tmpdir(), 'pmp-audit-'));
  try {
    const input = join(directory, 'input.wasm');
    const output = join(directory, 'output.wasm');
    const check = body => {
      writeFileSync(input, fixture(body));
      const result = spawnSync(join(process.env.BINARYEN_PATH, 'bin/wasm-opt'),
        [input, ...binaryenFlags(baseline), '-o', output], { encoding: 'utf8' });
      assert.ifError(result.error);
      return result;
    };
    const control = check(scalar);
    assert.equal(control.status, 0, control.stderr);
    const forbidden = check(simd);
    assert.notEqual(forbidden.status, 0, 'SIMD requires a feature outside the recorded baseline');
    assert.match(forbidden.stderr, /SIMD|simd|v128/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
