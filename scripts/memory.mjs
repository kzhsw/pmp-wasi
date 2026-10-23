// Diagnostic allocation accounting; never adds profiling exports to production.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from './build.mjs';
import { verifyVendor } from './vendor.mjs';
import { attributeView, Domain, instantiate, meshView, Property } from '../src/index.js';

process.chdir(resolve(import.meta.dirname, '..'));
verifyVendor();
const options = { directory: 'build/memory', sizes: [32, 96], cycles: 8, warmup: 2, build: false, workload: null };
for (let i = 2; i < process.argv.length; ++i) {
  const flag = process.argv[i];
  if (flag === '--build') options.build = true;
  else if (flag === '--directory') options.directory = process.argv[++i];
  else if (flag === '--sizes') options.sizes = process.argv[++i].split(',').map(Number);
  else if (flag === '--cycles') options.cycles = Number(process.argv[++i]);
  else if (flag === '--warmup') options.warmup = Number(process.argv[++i]);
  else if (flag === '--workload') options.workload = process.argv[++i];
  else throw new Error(`Unknown option ${flag}; use --build --directory PATH --sizes 32,96 --cycles 8 --warmup 2 --workload NAME`);
}
assert(options.sizes.length && new Set(options.sizes).size === options.sizes.length &&
  options.sizes.every(n => Number.isInteger(n) && n >= 2 && n <= 128), 'Grid cell counts must be distinct integers between 2 and 128');
assert(Number.isInteger(options.cycles) && options.cycles >= 3 && options.cycles <= 32, 'Cycles must be between 3 and 32');
assert(Number.isInteger(options.warmup) && options.warmup >= 0 && options.warmup < options.cycles - 1, 'Keep at least two measured cycles');
assert(typeof options.directory === 'string' && options.directory.length, 'Directory must be a path');
if (options.build) build({ directory: options.directory, objectDirectory: 'build', profile: true, quiet: true });
const directory = options.directory, bytes = readFileSync(`${directory}/pmp-core.wasm`);
const metadata = JSON.parse(readFileSync(`${directory}/report.json`, 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
assert.equal(metadata.diagnostic, true, 'Use the separate diagnostic build, never production Wasm');
assert.equal(sha256(bytes), metadata.sha256, 'Diagnostic Wasm differs from its build metadata');
const module = await WebAssembly.compile(bytes);
const productionExports = JSON.parse(readFileSync('exports/core.json', 'utf8'));
assert.deepEqual(WebAssembly.Module.exports(module).map(item => item.name).sort(),
  [...productionExports, 'pmp_profile_reset', 'pmp_profile_get', 'pmp_profile_self_test'].sort());
const inputs = [...new Set([...metadata.sources, metadata.profileSource || 'test/memory-profile.cpp',
  'src/mesh.hpp', 'include/pmp.h', 'vendor/manifest.json', 'exports/core.json', 'src/index.js',
  'scripts/build.mjs', 'scripts/memory.mjs'])];
const sourceHashes = Object.fromEntries(inputs.map(path => [path, sha256(readFileSync(path))]));
if (metadata.objectSignature) {
  const signature = createHash('sha256').update(JSON.stringify({ flags: metadata.flags, sources: metadata.sources,
    toolchain: metadata.toolchain, runtimeArchives: metadata.runtimeArchives }));
  for (const path of [...metadata.sources.filter(path => path.startsWith('src/')), 'src/mesh.hpp', 'include/pmp.h', 'vendor/manifest.json'])
    signature.update(path).update(readFileSync(path));
  assert.equal(signature.digest('hex'), metadata.objectSignature, 'Source/flags differ from the compiled diagnostic artifact');
}
if (metadata.profileSourceSha256)
  assert.equal(sourceHashes[metadata.profileSource || 'test/memory-profile.cpp'], metadata.profileSourceSha256);
let assertions = 0, current = null;
const check = (condition, message) => { ++assertions; assert(condition, `${JSON.stringify(current)}: ${message}`); };
const fields = ['liveUsableBytes', 'peakUsableBytes', 'liveAllocations', 'peakLiveAllocations',
  'allocationEvents', 'releaseEvents', 'reallocationCalls', 'linearMemoryBytes'];
const sample = e => {
  const result = Object.fromEntries(fields.map((name, i) => [name, e.pmp_profile_get(i) >>> 0]));
  check(result.linearMemoryBytes === e.memory.buffer.byteLength, 'profile reports actual linear memory');
  check(result.peakUsableBytes >= result.liveUsableBytes && result.peakLiveAllocations >= result.liveAllocations, 'peak accounting bounds live totals');
  return result;
};
const sameLive = (a, b) => a.liveUsableBytes === b.liveUsableBytes && a.liveAllocations === b.liveAllocations;
async function sanity() {
  current = { workload: 'profiler-sanity' };
  const e = await instantiate(module), initial = sample(e);
  e.pmp_profile_self_test();
  check(sameLive(sample(e), initial), 'allocator self-test releases every allocation');
  e.pmp_profile_reset();
  const pointer = e.pmp_alloc(123), allocated = sample(e);
  check(allocated.liveAllocations === initial.liveAllocations + 1 &&
    allocated.liveUsableBytes >= initial.liveUsableBytes + 123 && allocated.allocationEvents > 0, 'known-size allocation is accounted');
  new Uint8Array(e.memory.buffer, pointer, 123).fill(0xa5);
  e.pmp_profile_reset();
  const reset = sample(e);
  check(sameLive(reset, allocated) && reset.peakUsableBytes === reset.liveUsableBytes &&
    reset.peakLiveAllocations === reset.liveAllocations, 'reset retains live buffers and resets peaks to live totals');
  check(reset.allocationEvents === 0 && reset.releaseEvents === 0 && reset.reallocationCalls === 0, 'reset clears call counters');
  check(new Uint8Array(e.memory.buffer, pointer, 123).every(value => value === 0xa5), 'reset preserves buffer contents');
  e.pmp_free(pointer);
  const freed = sample(e);
  check(sameLive(freed, initial) && freed.releaseEvents === 1, 'known-size allocation is released after reset');
  return { initial, allocated, reset, freed };
}
function grid(n, shape) {
  const positions = [], faces = [];
  for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x)
    positions.push(x / n, y / n, 0.05 * Math.sin(Math.PI * x / n) * Math.sin(Math.PI * y / n));
  for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    faces.push(...(shape === 'quads' ? [[a, b, c, d]] : [[a, b, c], [a, c, d]]));
  }
  return { positions, faces, edges: shape === 'quads' ? 2 * n * (n + 1) : 3 * n * n + 2 * n };
}
function inputFor(n, shape) {
  if (shape === 'hole') return { positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
    faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2]], edges: 6 };
  if (shape !== 'polygon') return grid(n, shape);
  const count = n * n, face = Array.from({ length: count }, (_, i) => i);
  return { positions: face.flatMap(i => [Math.cos(i * 2 * Math.PI / count), Math.sin(i * 2 * Math.PI / count), 0]),
    faces: [face], edges: count };
}
function construct(e, mesh, input, reserve) {
  if (reserve !== 'none') e.pmp_mesh_reserve(mesh, input.positions.length / 3,
    reserve === 'corner-bound' ? input.faces.reduce((sum, face) => sum + face.length, 0) : input.edges, input.faces.length);
  e.pmp_mesh_add_vertices(mesh, input.positions.length / 3);
  meshView(e, mesh).positions.set(input.positions);
  const corners = input.faces.flat(), offsets = [0];
  for (const face of input.faces) offsets.push(offsets[offsets.length - 1] + face.length);
  const indices = e.pmp_alloc(corners.length * 4), starts = e.pmp_alloc(offsets.length * 4);
  new Uint32Array(e.memory.buffer, indices, corners.length).set(corners);
  new Uint32Array(e.memory.buffer, starts, offsets.length).set(offsets);
  e.pmp_mesh_add_faces(mesh, indices, starts, input.faces.length);
  e.pmp_free(starts); e.pmp_free(indices);
}
function attributes(e, mesh) {
  const view = meshView(e, mesh), points = [...view.positions], targets = [...view.halfedges].filter((_, i) => i % 4 === 1);
  const channels = [['user:uv0', Property.VEC2F, 2], ['user:uv1', Property.VEC2F, 2],
    ['user:color', Property.RGBA8, 4], ['user:joints', Property.VEC4U16, 4], ['user:weights', Property.VEC4F, 4],
    ['h:tex', Property.VEC2F, 2, Domain.HALFEDGE]];
  for (const [name, type, components, domain = Domain.VERTEX] of channels) {
    const values = attributeView(e, mesh, name, type, domain, true);
    for (let row = 0; row < values.length / components; ++row) for (let c = 0; c < components; ++c) {
      const vertex = domain === Domain.HALFEDGE ? targets[row] : row;
      values[row * components + c] = name === 'user:color' ? (c === 3 ? 255 : vertex % 251) :
        name === 'user:joints' ? (c === 0 ? vertex % 16 : 0) : name === 'user:weights' ? Number(c === 0) :
          points[vertex * 3 + c] * (name === 'user:uv1' ? 2 : 1);
    }
  }
  return channels.map(([name, type, components, domain = Domain.VERTEX]) => ({ name, type, components, domain }));
}
function geometry(e, mesh) {
  const v = meshView(e, mesh);
  check(v.positions.every(Number.isFinite), 'all output coordinates are finite');
  return { vertices: v.liveVertices, edges: v.liveEdges, faces: v.liveFaces };
}
const jobs = [];
for (const n of options.sizes) {
  for (const shape of ['triangles', 'quads']) for (const reserve of ['none', 'exact', 'corner-bound'])
    jobs.push({ name: `construction-${shape}-${reserve}`, n, shape, reserve, attributes: true });
  for (const [name, shape, attached, algorithm, calls] of [
    ['normals-curvature', 'triangles', true, 11, [['pmp_vertex_normals'], ['pmp_face_normals'], ['pmp_curvature', 2, 1, 1, 1]]],
    ['decimation', 'triangles', true, 0, [['pmp_decimate', Math.floor((n + 1) ** 2 * 0.7), 0, 0, 0, 0, 0, 0.01, 1]]],
    ['uniform-remeshing', 'triangles', false, 1, [['pmp_uniform_remeshing', 1.25 / n, 1, 1]]],
    ['adaptive-remeshing', 'triangles', false, 2, [['pmp_adaptive_remeshing', 0.7 / n, 1.4 / n, 0.02 / n, 1, 1]]],
    ['catmull-clark-subdivision', 'quads', false, 3, [['pmp_catmull_clark_subdivision', 0]]],
    ['loop-subdivision', 'triangles', false, 4, [['pmp_loop_subdivision', 0]]],
    ['quad-tri-subdivision', 'quads', false, 5, [['pmp_quad_tri_subdivision', 0]]],
    ['linear-subdivision', 'triangles', false, 6, [['pmp_linear_subdivision']]],
    ['implicit-smoothing-fairing', 'triangles', true, 8,
      [['pmp_implicit_smoothing', 0.1 / (n * n), 1, 0, 0], ['pmp_fair', 2]]],
    ['triangulation', 'quads', true, 10, [['pmp_triangulate']]],
    ['polygon-clear-reuse', 'polygon', false, null, []],
  ]) jobs.push({ name, n, shape, reserve: 'exact', attributes: attached, algorithm, calls });
}
jobs.push({ name: 'hole-filling', n: null, shape: 'hole', reserve: 'exact', attributes: false, algorithm: 9, calls: [] });
const selected = options.workload ? jobs.filter(job => job.name === options.workload) : jobs;
assert(selected.length, `No workload named ${options.workload}`);
const report = { kind: 'diagnostic-memory-profile', status: 'running', options, artifact: metadata,
  compiledSourceVerified: Boolean(metadata.objectSignature && metadata.profileSourceSha256),
  sourceSha256: sha256(JSON.stringify(sourceHashes)), sourceHashes,
  accounting: 'Wrapped allocation completion: malloc_usable_size payload capacity, excluding chunk metadata, JS arrays, stack, and internal realloc old/new overlap. Allocation/release events include successful realloc replacements; wrapper metadata allocations are included. Linear memory includes static data, stack, and retained allocator backing; it cannot shrink.',
  scope: 'Lifecycle leak and retained-memory checks cover only the deterministic workloads listed here; no timing measurements.', workloads: [] };
mkdirSync(directory, { recursive: true });
try {
  report.sanity = await sanity();
  for (const job of selected) {
    current = { workload: job.name, cells: job.n, cycle: null };
    const e = await instantiate(module), baseline = sample(e), input = inputFor(job.n, job.shape);
    const result = { ...job, input: { generator: job.shape, cells: job.n,
      vertices: input.positions.length / 3, edges: input.edges, faces: input.faces.length,
      ...(job.shape === 'hole' ? { positions: input.positions, polygons: input.faces, boundary: 'first native boundary halfedge' } : {}) }, baseline, cycles: [] };
    report.workloads.push(result);
    for (let cycle = 0; cycle < options.cycles; ++cycle) {
      current.cycle = cycle;
      e.pmp_profile_reset();
      const entry = { cycle, beforeConstruction: sample(e) }, mesh = e.pmp_mesh_create();
      result.cycles.push(entry);
      construct(e, mesh, input, job.reserve);
      if (job.attributes) result.channels = attributes(e, mesh);
      const initialGeometry = geometry(e, mesh);
      check(initialGeometry.vertices === result.input.vertices && initialGeometry.edges === input.edges &&
        initialGeometry.faces === input.faces.length, 'construction has expected native topology');
      entry.afterConstruction = sample(e);
      if (job.algorithm != null) check(e.pmp_mesh_unsupported_properties(mesh, job.algorithm) === 0, 'attached attributes match the operation contract');
      entry.operations = [];
      for (const [name, ...args] of job.calls || []) {
        current.operation = name;
        e[name](mesh, ...args);
        entry.operations.push({ name, args, geometry: geometry(e, mesh), memory: sample(e) });
      }
      if (job.shape === 'hole') {
        current.operation = 'pmp_fill_hole';
        const v = meshView(e, mesh), h = [...v.halfedges].findIndex((face, i) => i % 4 === 0 && face === 0xffffffff) / 4;
        check(Number.isInteger(h) && h >= 0, 'hole fixture has a boundary');
        e.pmp_fill_hole(mesh, h);
        check(geometry(e, mesh).faces === 4, 'hole filling closes the missing tetrahedron face');
        entry.operations.push({ name: 'pmp_fill_hole', args: [h], memory: sample(e) });
      }
      if (job.shape === 'polygon') {
        current.operation = 'clear-reuse';
        e.pmp_mesh_clear(mesh);
        check(geometry(e, mesh).vertices === 0, 'clear removes polygon vertices');
        entry.afterClear = sample(e);
        construct(e, mesh, { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]], edges: 3 }, 'none');
        check(geometry(e, mesh).faces === 1, 'cleared mesh can be reused');
        entry.afterReuse = sample(e);
      }
      entry.afterOperation = sample(e);
      const output = geometry(e, mesh);
      if (job.name === 'decimation') check(output.vertices < initialGeometry.vertices, 'decimation reduces the vertex count');
      if (job.name.endsWith('subdivision')) check(output.faces > initialGeometry.faces, 'subdivision refines topology');
      if (job.name === 'triangulation') check(output.faces === 2 * job.n * job.n, 'quad triangulation produces two triangles per cell');
      e.pmp_mesh_destroy(mesh);
      entry.afterDestroy = sample(e);
      check(sameLive(entry.afterDestroy, baseline), 'destroy returns all tracked allocations and usable bytes to baseline');
    }
    const measured = result.cycles.slice(options.warmup), retained = measured.map(cycle => cycle.afterDestroy.linearMemoryBytes);
    check(new Set(retained).size === 1, 'identical repeated workloads reach a linear-memory plateau after warmup');
    result.summary = { peakUsableBytes: Math.max(...result.cycles.map(cycle => cycle.afterDestroy.peakUsableBytes)),
      peakLiveAllocations: Math.max(...result.cycles.map(cycle => cycle.afterDestroy.peakLiveAllocations)),
      allocationEvents: Math.max(...measured.map(cycle => cycle.afterDestroy.allocationEvents)),
      releaseEvents: Math.max(...measured.map(cycle => cycle.afterDestroy.releaseEvents)),
      reallocationCalls: Math.max(...measured.map(cycle => cycle.afterDestroy.reallocationCalls)),
      retainedLinearMemoryBytes: retained[0], postDestroyLiveUsableBytes: baseline.liveUsableBytes,
      postDestroyLiveAllocations: baseline.liveAllocations, plateauAfterWarmupCycles: options.warmup };
    if (job.shape === 'polygon') result.summary.retainedAfterClearUsableBytes = measured[0].afterClear.liveUsableBytes - baseline.liveUsableBytes;
    console.log(JSON.stringify({ workload: job.name, cells: job.n, ...result.summary }));
  }
  verifyVendor();
  check(inputs.every(path => sha256(readFileSync(path)) === sourceHashes[path]), 'profiling inputs remained unchanged during the run');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { ...current, message: error.message,
    replay: `node scripts/memory.mjs --directory ${JSON.stringify(directory)} --sizes ${current.cells || options.sizes.join(',')} --cycles ${options.cycles} --warmup ${options.warmup} --workload ${current.workload}` };
  throw error;
} finally {
  report.assertions = assertions;
  writeFileSync(`${directory}/profile.json`, JSON.stringify(report, null, 2) + '\n');
}
