// Host-only baseline generation from the pinned, unmodified upstream checkout.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

process.chdir(resolve(import.meta.dirname, '..'));
const upstream = process.env.PMP_UPSTREAM_PATH;
assert(upstream, 'Set PMP_UPSTREAM_PATH to the existing pinned PMP checkout');
const run = (command, args, label = command) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  return result.stdout;
};
const pin = JSON.parse(readFileSync('upstream.json', 'utf8'));
const git = ['-c', 'core.filemode=false', '-C', upstream];
assert.equal(run('git', [...git, 'rev-parse', 'HEAD']).trim(), pin.pmp.revision);
run('git', [...git, 'diff', '--quiet', 'HEAD', '--', 'src/pmp', pin.eigen.includeDirectory],
  'Upstream PMP and Eigen sources must match the pinned checkout');
const manifest = JSON.parse(readFileSync('vendor/manifest.json', 'utf8'));
for (const file of manifest.pmp) if (file.original) {
  const bytes = readFileSync(join(upstream, 'src', file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.original, `Modified upstream ${file.path}`);
}
mkdirSync('build', { recursive: true });
const core = ['surface_mesh.cpp', 'algorithms/normals.cpp', 'algorithms/features.cpp'];
const algorithms = [...core, ...['decimation', 'subdivision', 'distance_point_triangle', 'remeshing',
  'curvature', 'smoothing', 'laplace', 'numerics', 'differential_geometry', 'fairing', 'hole_filling']
  .map(name => `algorithms/${name}.cpp`)];
const suites = [
  { name: 'core', generator: 'test/native-reference.cpp', executable: 'build/native-reference',
    sources: core, output: 'native-core.json', count: 4 },
  { name: 'algorithms', generator: 'test/algorithms-reference.cpp', executable: 'build/algorithms-reference',
    sources: algorithms, output: 'native-algorithms.json', count: 22 },
  { name: 'extensions', generator: 'test/extensions-reference.cpp', executable: 'build/extensions-reference',
    sources: [...core, ...['curvature', 'differential_geometry', 'fairing', 'laplace', 'numerics',
      'smoothing', 'triangulation', 'utilities'].map(name => `algorithms/${name}.cpp`)],
    output: 'native-extensions.json', count: 43 },
];
const options = process.argv.slice(2);
assert(options.length <= 1 && options.every(option => /^--suite=(core|algorithms|extensions)$/.test(option)),
  'Optional argument: --suite=core|algorithms|extensions');
const selected = options.length ? suites.filter(suite => options[0] === `--suite=${suite.name}`) : suites;
const generated = selected.map(suite => {
  run(process.env.CXX ?? 'clang++', ['-std=c++20', '-O2', '-I' + join(upstream, 'src'),
    '-isystem', join(upstream, pin.eigen.includeDirectory), suite.generator,
    ...suite.sources.map(path => join(upstream, 'src/pmp', path)), '-o', suite.executable]);
  const result = run(`./${suite.executable}`, []);
  assert.equal(JSON.parse(result).length, suite.count, `${suite.output}: unexpected fixture count`);
  return { output: suite.output, result };
});
mkdirSync('test/fixtures', { recursive: true });
for (const { output, result } of generated) writeFileSync(join('test/fixtures', output), result);
