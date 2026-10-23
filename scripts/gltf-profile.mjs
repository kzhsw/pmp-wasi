// SPDX-License-Identifier: MIT
// Optional adapter size, end-to-end CPU time, and native/JS lifetime accounting.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { instantiate } from '../src/index.js';
import { process as transform } from '../src/gltf-transform.js';
import { fixture, summary } from '../test/gltf/fixtures.mjs';

process.chdir(resolve(import.meta.dirname, '..'));
const options = { cells: 32, cycles: 8, warmup: 2 };
for (let i = 2; i < process.argv.length; ++i) {
  const name = process.argv[i].slice(2);
  assert(['cells', 'cycles', 'warmup'].includes(name), 'Use --cells, --cycles or --warmup');
  options[name] = Number(process.argv[++i]);
}
assert(Number.isInteger(options.cells) && options.cells >= 3 && options.cells <= 96);
assert(Number.isInteger(options.cycles) && options.cycles >= 4 && options.cycles <= 32);
assert(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup < options.cycles - 1);
assert(process.env.ESBUILD_MODULE, 'Set ESBUILD_MODULE to an existing esbuild installation');
const esbuild = createRequire(import.meta.url)(process.env.ESBUILD_MODULE);
const bundle = await esbuild.build({ entryPoints: ['src/gltf-transform.js'], bundle: true,
  minify: true, write: false, platform: 'browser', format: 'esm', target: 'chrome93', metafile: true });
assert(bundle.outputFiles.length === 1);
assert(Object.keys(bundle.metafile.inputs).every(name => name.startsWith('src/')),
  'The adapter must not import the SDK merely to access mode constants');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile('build/pmp-core.wasm');
// Build separately with npm run profile:memory -- --build. Never time instrumentation.
const diagnosticBytes = await readFile('build/memory/pmp-core.wasm');
const module = await WebAssembly.compile(bytes), diagnostic = await WebAssembly.compile(diagnosticBytes);
const sourceFiles = [...Object.keys(bundle.metafile.inputs), 'src/index.js', 'test/gltf/fixtures.mjs', 'scripts/gltf-profile.mjs'];
const fingerprints = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(file))])));
const sourceHashes = await fingerprints();
const variants = [
  ['decimate', { ratio: 0.65 }],
  ['remesh', { method: 'uniform', edgeLength: 1 / options.cells, iterations: 1 }],
  ['remesh', { method: 'adaptive', minEdgeLength: 0.5 / options.cells, maxEdgeLength: 2 / options.cells, approxError: 0.01, iterations: 1 }],
  ...['loop', 'catmullClark', 'quadTri', 'linear'].map(method => ['subdivide', { method }]),
  ['smooth', { method: 'explicit' }], ['smooth', { method: 'implicit' }],
  ['fair', { method: 'curvature' }], ['fillHoles', { maxEdges: 3, maxHoles: 1 }],
];
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const report = { kind: 'optional-glTF-adapter-profile', options, node: process.version, sourceHashes,
  artifactSha256: sha(bytes), diagnosticSha256: sha(diagnosticBytes),
  adapter: { bytes: bundle.outputFiles[0].contents.length, gzipBytes: gzipSync(bundle.outputFiles[0].contents).length,
    esbuild: esbuild.version, target: 'chrome93', sha256: sha(bundle.outputFiles[0].contents) },
  gcAvailable: typeof global.gc === 'function', workloads: [] };
for (const [operation, parameters] of variants) {
  const e = await instantiate(module), d = await instantiate(diagnostic);
  assert.equal(typeof d.pmp_profile_get, 'function', 'Expected the separate diagnostic artifact');
  const input = operation === 'fillHoles' ? { positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
    indices: [0, 2, 1, 0, 1, 3, 0, 3, 2] } : { n: options.cells };
  const run = (exports, timed) => {
    const { doc } = fixture(input);
    const start = performance.now();
    const reports = transform(doc, exports, { operation, ...parameters });
    const milliseconds = performance.now() - start;
    return { ...(timed ? { milliseconds } : {}), reports, output: summary(doc) };
  };
  const cycles = [];
  let expected;
  for (let cycle = 0; cycle < options.cycles; ++cycle) {
    const result = run(e, true);
    if (expected) assert.deepEqual(result.output, expected); else expected = result.output;
    if (global.gc) global.gc();
    const usage = process.memoryUsage();
    cycles.push({ milliseconds: result.milliseconds, nativeCapacity: e.memory.buffer.byteLength,
      ...(global.gc ? { retainedJSHeap: usage.heapUsed, retainedArrayBuffers: usage.arrayBuffers,
        retainedExternalBytes: usage.external } : {}) });
  }
  d.pmp_profile_reset();
  const measured = run(d, false);
  assert.deepEqual(measured.output, expected, 'Instrumentation changes adapter results');
  assert.equal(d.pmp_profile_get(0), 0, 'Adapter leaves no live native payload');
  assert.equal(d.pmp_profile_get(2), 0, 'Adapter leaves no live native allocations');
  const stable = cycles.slice(options.warmup);
  assert(stable.every(cycle => cycle.nativeCapacity === stable[0].nativeCapacity), 'Native backing must plateau');
  const result = { operation, parameters, medianMs: median(stable.map(cycle => cycle.milliseconds)),
    peakNativeUsableBytes: d.pmp_profile_get(1), peakNativeAllocations: d.pmp_profile_get(3),
    nativeAllocationEvents: d.pmp_profile_get(4), nativeReleaseEvents: d.pmp_profile_get(5),
    postDestroyLiveBytes: d.pmp_profile_get(0), postDestroyLiveBlocks: d.pmp_profile_get(2),
    cycles, counts: measured.reports.map(({ before, after }) => ({ before, after })) };
  report.workloads.push(result);
  console.log(JSON.stringify({ operation, ...parameters, medianMs: result.medianMs,
    peakNativeUsableBytes: result.peakNativeUsableBytes, retainedNativeCapacity: stable[0].nativeCapacity }));
}
assert.deepEqual(await fingerprints(), sourceHashes, 'Sources changed during profiling');
assert.equal(sha(await readFile('build/pmp-core.wasm')), report.artifactSha256);
assert.equal(sha(await readFile('build/memory/pmp-core.wasm')), report.diagnosticSha256);
await mkdir('build/gltf', { recursive: true });
await writeFile('build/gltf/profile.json', JSON.stringify(report, null, 2) + '\n');
