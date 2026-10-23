// Host-only baseline generation from the pinned, unmodified upstream checkout.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

process.chdir(resolve(import.meta.dirname, '..'));
const upstream = process.env.PMP_UPSTREAM_PATH;
assert(upstream, 'Set PMP_UPSTREAM_PATH to the existing pinned PMP checkout');
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const pin = JSON.parse(readFileSync('upstream.json', 'utf8'));
assert.equal(run('git', ['-C', upstream, 'rev-parse', 'HEAD']).trim(), pin.pmp.revision);
run('git', ['-C', upstream, 'diff', '--exit-code', 'HEAD', '--', 'src/pmp', pin.eigen.includeDirectory]);
const manifest = JSON.parse(readFileSync('vendor/manifest.json', 'utf8'));
for (const file of manifest.pmp) if (file.original) {
  const bytes = readFileSync(join(upstream, 'src', file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.original, `Modified upstream ${file.path}`);
}
mkdirSync('build', { recursive: true });
run(process.env.CXX ?? 'clang++', ['-std=c++20', '-O2', '-I' + join(upstream, 'src'),
  '-isystem', join(upstream, pin.eigen.includeDirectory), 'test/native-reference.cpp',
  ...['surface_mesh.cpp', 'algorithms/normals.cpp', 'algorithms/features.cpp'].map(path => join(upstream, 'src/pmp', path)),
  '-o', 'build/native-reference']);
const result = run('./build/native-reference', []);
assert.equal(JSON.parse(result).length, 4);
mkdirSync('test/fixtures', { recursive: true });
writeFileSync('test/fixtures/native-core.json', result);
