import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { audit, auditLinkMap, binaryenFlags, stripTargetFeatures, targetFeatures } from './wasm.mjs';
import { verifyVendor } from './vendor.mjs';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
verifyVendor();
const sdk = process.env.WASI_SDK_PATH;
const binaryen = process.env.BINARYEN_PATH;
assert(sdk && binaryen, 'Set WASI_SDK_PATH and BINARYEN_PATH to existing toolchain directories');
const cxx = join(sdk, 'bin/clang++');
const capture = (exe, args) => {
  const result = spawnSync(exe, args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const toolchain = { compiler: capture(cxx, ['--version']).split('\n')[0],
  target: capture(cxx, ['-print-target-triple']),
  binaryen: capture(join(binaryen, 'bin/wasm-opt'), ['--version']) };
assert(/^wasm32-.*wasi/.test(toolchain.target), 'Compiler must target wasm32 WASI');
const run = (exe, args) => {
  const result = spawnSync(exe, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${exe} failed (${result.status ?? result.signal})`);
};
const exports = JSON.parse(readFileSync('exports/core.json', 'utf8'));
const planned = JSON.parse(readFileSync('wasm-exports.json', 'utf8'));
assert(exports.every(name => planned.includes(name)));
const sources = ['src/core.cpp', 'src/algorithms.cpp', 'src/runtime.cpp', 'vendor/pmp/surface_mesh.cpp',
  ...['normals', 'features', 'decimation', 'subdivision', 'distance_point_triangle',
    'remeshing', 'curvature', 'smoothing', 'laplace', 'numerics', 'differential_geometry',
    'fairing', 'hole_filling'].map(name => `vendor/pmp/algorithms/${name}.cpp`)];
mkdirSync('build', { recursive: true });
const targetFlags = ['-mcpu=mvp', '-mbulk-memory-opt', '-mnontrapping-fptoint', '-msign-ext'];
const flags = [...targetFlags, '-std=c++20', '-O3', '-flto', '-ffreestanding', '-fno-exceptions', '-fno-rtti',
  '-ffunction-sections', '-fdata-sections', '-DNDEBUG', '-DEIGEN_DONT_PARALLELIZE',
  '-Wall', '-Wextra', '-Werror', '-Iinclude', '-Ivendor', '-isystem', 'vendor/eigen'];
const objects = sources.map((source, i) => {
  const object = `build/${i}.o`;
  run(cxx, [...flags, '-MMD', '-MF', `build/${i}.d`, '-c', source, '-o', object]);
  return object;
});
run(cxx, [...targetFlags, '-O3', '-flto', '-nostartfiles', ...objects, '-o', 'build/core.link.wasm',
  '-Wl,--no-entry,--export-memory,--gc-sections,--export=__wasm_call_ctors,-Map=build/core.map,--why-extract=build/archives.tsv',
  ...exports.filter(name => name !== 'memory').map(name => `-Wl,--export=${name}`)]);
auditLinkMap(readFileSync('build/core.map', 'utf8'));
const linkedBytes = readFileSync('build/core.link.wasm');
const linked = audit(linkedBytes, [...exports, '__wasm_call_ctors'], { linked: true });
const featureFlags = binaryenFlags();
const ctor = linked.exports.get('__wasm_call_ctors');
assert.deepEqual([...linked.bodies[ctor.index]], [0, 11], 'Refusing to remove a nonempty constructor');
const graph = [...linked.exports.keys()].map(name => name === '__wasm_call_ctors'
  ? { name, export: name } : { name, export: name, root: true });
writeFileSync('build/graph.json', JSON.stringify(graph));
writeFileSync('build/core.target.wasm', stripTargetFeatures(linkedBytes));
run(join(binaryen, 'bin/wasm-metadce'), ['build/core.target.wasm', ...featureFlags, '--graph-file=build/graph.json', '--emit-target-features', '-o', 'build/core.pruned.wasm']);
run(join(binaryen, 'bin/wasm-opt'), ['build/core.pruned.wasm', ...featureFlags, '-O3', '--emit-target-features', '--strip-debug', '--strip-producers', '--strip-dwarf', '-o', 'build/core.optimized.wasm']);
const bytes = readFileSync('build/core.optimized.wasm');
const final = audit(bytes, exports);
assert.deepEqual(final.features, targetFeatures, 'Unexpected Chrome 75 feature baseline');
const instance = new WebAssembly.Instance(final.module, {});
assert.equal(instance.exports.pmp_abi_version(), 0);
const mesh = instance.exports.pmp_mesh_create();
instance.exports.pmp_mesh_destroy(mesh);
copyFileSync('build/core.optimized.wasm', 'build/pmp-core.wasm');
const report = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
  sha256: createHash('sha256').update(bytes).digest('hex'), jsBytes: readFileSync('src/index.js').length,
  features: final.features, linkedFeatures: linked.features, targetFlags,
  exports: exports.length, imports: [], sources, toolchain };
writeFileSync('build/report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
