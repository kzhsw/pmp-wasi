// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { prepareGeometry, resolvePMP, runGeometry } from '../src/gltf/geometry.js';

const module = await WebAssembly.compile(await readFile(new URL('../build/pmp-core.wasm', import.meta.url)));
const triangle = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
const tetrahedron = { positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
  indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };
const fresh = () => new WebAssembly.Instance(module, {});
const prepared = geometry => prepareGeometry(geometry.positions, geometry.indices);
function grid(n = 5) {
  const positions = [], indices = [];
  for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x) positions.push(x / n, y / n, Math.sin(x * Math.PI / n) * Math.sin(y * Math.PI / n) * 0.05);
  for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
    const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
    indices.push(a, b, c, a, c, d);
  }
  return { positions, indices };
}
function valid(result, exact = false) {
  assert(result.positions instanceof Float32Array);
  assert(result.indices instanceof Uint32Array);
  assert(result.positions.every(Number.isFinite));
  assert(result.indices.every(i => i < result.positions.length / 3));
  assert.equal(result.indices.length % 3, 0);
  assert.deepEqual(result.details.after, { vertices: result.positions.length / 3, triangles: result.indices.length / 3 });
  if (result.normals) {
    assert.equal(result.normals.length, result.positions.length);
    assert(result.normals.every(Number.isFinite));
  }
  if (exact) assert.equal(result.sourceIds.length, result.positions.length / 3);
  else assert.equal(result.sourceIds, undefined);
}
function tracked(instance = fresh()) {
  const raw = instance.exports, allocations = new Set(), meshes = new Set(), calls = [];
  const e = { ...raw };
  for (const [name, value] of Object.entries(raw)) if (typeof value === 'function') e[name] = (...args) => {
    calls.push(name); const result = value(...args);
    if (name === 'pmp_alloc' && result) allocations.add(result >>> 0);
    if (name === 'pmp_free') allocations.delete(args[0] >>> 0);
    if (name === 'pmp_mesh_create') meshes.add(result >>> 0);
    if (name === 'pmp_mesh_destroy') meshes.delete(args[0] >>> 0);
    return result;
  };
  return { e, raw, calls, allocations, meshes };
}

test('geometry source normalization accepts every documented shape', () => {
  const instance = fresh(), e = instance.exports;
  for (const source of [e, instance, { instance }, { exports: e }, { instance: { exports: e } }]) assert.equal(resolvePMP(source), e);
  for (const source of [null, {}, { memory: e.memory }, module]) assert.throws(() => resolvePMP(source), TypeError);
  const cyclic = {}; cyclic.instance = cyclic;
  assert.throws(() => resolvePMP(cyclic), /Cyclic/);
});

test('geometry preflight copies input and splits only disconnected vertex fans', () => {
  const positions = [...triangle.positions, -1, 0, 0, 0, -1, 0], indices = [0, 1, 2, 0, 3, 4];
  const result = prepareGeometry(positions, indices);
  assert.equal(result.positions.length / 3, 6);
  assert.deepEqual([...result.sourceIds], [0, 1, 2, 3, 4, 0]);
  assert.deepEqual([...result.indices], [0, 1, 2, 5, 3, 4]);
  assert.deepEqual([...result.positions.slice(15)], positions.slice(0, 3));
  positions[0] = 99; indices[0] = 4;
  assert.equal(result.positions[0], 0); assert.equal(result.indices[0], 0);
  assert.throws(() => prepareGeometry(result.positions, [0, 1, 2, 0, 3, 4], { splitVertices: false }), /disconnected/);
  const distinct = prepareGeometry([...triangle.positions, ...triangle.positions], [0, 1, 2, 3, 4, 5]);
  assert.equal(distinct.positions.length / 3, 6, 'coincident render rows are not welded');
});

test('geometry rejects bad topology and float32 degeneracy before native allocation', () => {
  const cases = [
    [[NaN, 0, 0], []], [[1e40, 0, 0], []], [[0, 0], []],
    [triangle.positions, [0, 1]], [triangle.positions, [0, 1, 3]], [triangle.positions, [0, 1, 1]],
    [triangle.positions, [0, 1, 2, 2, 1, 0]],
    [[0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]],
    [[0, 0, 0, 1e-30, 0, 0, 0, 1e-30, 0], [0, 1, 2]],
    [[...triangle.positions, 1, 1, 0], [0, 1, 2, 0, 1, 3]],
    [[...triangle.positions, 1, 1, 0, 2, 1, 0], [0, 1, 2, 1, 0, 3, 0, 1, 4]],
  ];
  const owner = tracked();
  for (const [positions, indices] of cases) assert.throws(() => runGeometry(owner.e, { positions, indices }, 'normals'), RangeError);
  assert.equal(owner.calls.length, 0);
});

test('geometry normalizes clockwise source to CCW output and owns every result array', () => {
  const owner = tracked(), geometry = prepareGeometry(triangle.positions, [0, 2, 1]);
  const result = runGeometry(owner.e, geometry, 'normals', { winding: 'cw' });
  valid(result, true);
  assert(result.normals.every((value, i) => Math.abs(value - Number(i % 3 === 2)) < 1e-6));
  const [a, b, c] = result.indices;
  assert((result.positions[b * 3] - result.positions[a * 3]) * (result.positions[c * 3 + 1] - result.positions[a * 3 + 1]) -
    (result.positions[b * 3 + 1] - result.positions[a * 3 + 1]) * (result.positions[c * 3] - result.positions[a * 3]) > 0);
  for (const value of [result.positions, result.indices, result.normals, result.sourceIds]) assert.notEqual(value.buffer, owner.e.memory.buffer);
  const saved = result.positions.slice();
  runGeometry(owner.e, prepared(grid()), 'smooth');
  assert.deepEqual(result.positions, saved);
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
});

test('geometry analysis reports native measurements including empty-domain policy', () => {
  const owner = tracked(), result = runGeometry(owner.e, prepared(triangle), 'analyze');
  valid(result, true);
  assert.equal(result.measurements.area, 0.5);
  assert.equal(result.measurements.volume, 0);
  assert.equal(result.measurements.components, 1);
  assert.deepEqual([...result.measurements.bounds.min], [0, 0, 0]);
  assert.deepEqual([...result.measurements.bounds.max], [1, 1, 0]);
  assert(Math.abs(result.measurements.centroid[0] - 1 / 3) < 1e-6);
  assert.equal(result.measurements.minEdgeLength, 1);
  assert.equal(result.measurements.minFaceArea, 0.5);
  const empty = runGeometry(owner.e, prepared({ positions: [], indices: [] }), 'analyze');
  assert.deepEqual(empty.measurements, { area: 0, volume: 0, components: 0 });
  for (const [operation, options] of [['subdivide', { iterations: 0xffffffff }], ['remesh', { edgeLength: 1 }], ['fair', {}]]) {
    const result = runGeometry(owner.e, prepared({ positions: [], indices: [] }), operation, options);
    assert.equal(result.positions.length, 0); assert.equal(result.details.skipped, 'emptyGeometry');
  }
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
});

for (const method of ['loop', 'catmullClark', 'quadTri', 'linear']) test(`geometry subdivision ${method} returns triangulated owned output`, () => {
  const result = runGeometry(fresh(), prepared(grid(2)), 'subdivide', { method, iterations: 2, preserveBoundary: true });
  valid(result); assert(result.positions.length > 27); assert(result.indices.length > 24);
  assert.equal(result.details.boundary, 'preserve');
});

for (const method of ['explicit', 'implicit']) test(`geometry smoothing ${method} preserves source rows`, () => {
  const input = prepared(grid()), result = runGeometry(fresh(), input, 'smooth', { method, iterations: 2 });
  valid(result, true); assert.deepEqual(result.sourceIds, input.sourceIds);
  assert.equal(result.positions.length, input.positions.length);
});

for (const method of ['uniform', 'adaptive']) test(`geometry remeshing ${method} uses native output`, () => {
  const options = method === 'uniform' ? { edgeLength: 0.3 } : { minEdgeLength: 0.15, maxEdgeLength: 0.4, approxError: 0.01 };
  const result = runGeometry(fresh(), prepared(grid()), 'remesh', { method, ...options, iterations: 1 });
  valid(result); assert(result.indices.length > 0);
});

for (const method of ['fair', 'area', 'curvature']) test(`geometry fairing ${method} retains endpoint IDs`, () => {
  const input = prepared(grid()), result = runGeometry(fresh(), input, 'fair', { method });
  valid(result, true); assert.deepEqual(result.sourceIds, input.sourceIds);
});

test('geometry decimation retains exact source rows and maps original UVs to native corners', () => {
  const input = prepared(grid(6)), owner = tracked(); let uvChecked = false;
  const native = owner.e.pmp_decimate;
  owner.e.pmp_decimate = (...args) => {
    const mesh = args[0], scratch = owner.raw.pmp_alloc(128) >>> 0;
    new Uint8Array(owner.raw.memory.buffer, scratch + 64, 6).set(new TextEncoder().encode('h:tex\0'));
    const pointer = owner.raw.pmp_mesh_property(mesh, 1, 5, scratch + 64, 0) >>> 0;
    assert(pointer > 0);
    owner.raw.pmp_mesh_get_view(mesh, scratch);
    const words = new Uint32Array(owner.raw.memory.buffer, scratch, 13), halfedges = new Uint32Array(owner.raw.memory.buffer, words[8], words[1] * 8);
    const uv = new Float32Array(owner.raw.memory.buffer, pointer, words[1] * 4);
    for (let h = 0; h < words[1] * 2; ++h) assert.deepEqual([...uv.slice(h * 2, h * 2 + 2)], [...texcoords.slice(halfedges[h * 4 + 1] * 2, halfedges[h * 4 + 1] * 2 + 2)]);
    uvChecked = true; owner.raw.pmp_free(scratch);
    return native(...args);
  };
  const texcoords = Float32Array.from({ length: input.sourceIds.length * 2 }, (_, i) => input.positions[Math.floor(i / 2) * 3 + i % 2]);
  const result = runGeometry(owner.e, input, 'decimate', { targetVertices: 30, texcoords });
  valid(result, true); assert(uvChecked); assert(result.sourceIds.length <= input.sourceIds.length);
  for (let i = 0; i < result.sourceIds.length; ++i) assert.deepEqual(result.positions.slice(i * 3, i * 3 + 3), input.positions.slice(result.sourceIds[i] * 3, result.sourceIds[i] * 3 + 3));
  const clockwise = input.indices.slice();
  for (let i = 0; i < clockwise.length; i += 3) [clockwise[i], clockwise[i + 2]] = [clockwise[i + 2], clockwise[i]];
  const unchanged = runGeometry(owner.e, prepareGeometry(input.positions, clockwise), 'decimate', { targetVertices: input.sourceIds.length, texcoords, winding: 'cw' });
  assert.deepEqual(unchanged.sourceIds, input.sourceIds);
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
});

test('geometry empty selections do not trigger native all-vertex fallback', () => {
  const input = prepared(grid());
  for (const [operation, options] of [['decimate', { targetVertices: 3 }], ['remesh', { edgeLength: 0.3 }], ['fair', {}]]) {
    const owner = tracked(), result = runGeometry(owner.e, input, operation, { ...options, selectedVertices: [] });
    assert.deepEqual(result.positions, input.positions); assert.equal(result.details.skipped, 'emptySelection');
    assert.deepEqual(result.sourceIds, input.sourceIds);
    assert(!owner.calls.some(name => ['pmp_decimate', 'pmp_uniform_remeshing', 'pmp_fair'].includes(name)));
  }
});

test('geometry boundary preservation freezes original boundary rows during decimation', () => {
  const input = prepared(grid()), result = runGeometry(fresh(), input, 'decimate', { targetVertices: 10, preserveBoundary: true, aspectRatio: 3 });
  for (let i = 0; i < input.sourceIds.length; ++i) if (i % 6 === 0 || i % 6 === 5 || i < 6 || i >= 30) assert(result.sourceIds.includes(i));
});

test('geometry rejects degenerate native output and releases the healthy instance', () => {
  const owner = tracked();
  assert.throws(() => runGeometry(owner.e, prepared(grid()), 'decimate', { targetVertices: 10, preserveBoundary: true, computeNormals: false }), /degenerate triangle/);
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
  valid(runGeometry(owner.e, prepared(triangle), 'normals'), true);
});

test('geometry hole selection includes outer loops and callback errors release ownership', () => {
  const hole = prepared({ positions: tetrahedron.positions, indices: tetrahedron.indices.slice(0, 9) });
  let callbacks = 0;
  const result = runGeometry(fresh(), hole, 'fillHoles', { holeFilter(loop) { ++callbacks; assert.equal(loop.vertices.length, 3); assert.equal(loop.positions.length, 9); assert(loop.perimeter > 0); return true; } });
  valid(result); assert.equal(callbacks, 1); assert.equal(result.details.holesFilled, 1); assert.equal(result.indices.length, 12);
  const skipped = runGeometry(fresh(), hole, 'fillHoles', { maxHoles: 0 }); assert.equal(skipped.details.holesFilled, 0);
  assert.deepEqual(skipped.sourceIds, hole.sourceIds);
  const owner = tracked();
  assert.throws(() => runGeometry(owner.e, hole, 'fillHoles', { holeFilter() { throw new Error('callback failed'); } }), /callback failed/);
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
  valid(runGeometry(owner.e, prepared(triangle), 'normals'), true);
});

test('geometry returns exact source IDs when topology operations make no changes', () => {
  const input = prepareGeometry([...triangle.positions, ...triangle.positions], [0, 1, 2, 3, 4, 5]);
  for (const [operation, options] of [['remesh', { edgeLength: 1, iterations: 0 }],
    ['subdivide', { iterations: 0 }], ['fillHoles', { holeFilter: () => false }]]) {
    const result = runGeometry(fresh(), input, operation, options);
    assert.deepEqual(result.sourceIds, input.sourceIds);
    assert.deepEqual(result.positions, input.positions);
  }
});

test('geometry rejects unsupported options, unsafe solver inputs and growth limits in JS', () => {
  const input = prepared(grid()), owner = tracked();
  const bad = [
    ['decimate', {}], ['decimate', { targetVertices: -1 }], ['decimate', { targetVertices: 3, texcoords: [0, 0] }],
    ['remesh', {}], ['remesh', { method: 'adaptive', minEdgeLength: 1, maxEdgeLength: 0.5, approxError: 1 }],
    ['smooth', { selectedVertices: [0] }], ['smooth', { timestep: 1 }], ['smooth', { preserveBoundary: true }],
    ['normals', { featureAngle: 1 }], ['normals', { unknown: 1 }], ['subdivide', { method: 'linear', featureAngle: 1 }],
    ['subdivide', { iterations: 10, maxVertices: 100 }], ['fair', { k: 0 }], ['fillHoles', { maxEdges: 2 }],
  ];
  for (const [operation, options] of bad) assert.throws(() => runGeometry(owner.e, input, operation, options), error => error instanceof TypeError || error instanceof RangeError);
  assert.throws(() => runGeometry(owner.e, prepared(tetrahedron), 'fair'), /constraints/);
  const isolated = prepared({ positions: [...triangle.positions, 2, 2, 2], indices: triangle.indices });
  for (const operation of ['subdivide', 'fair']) assert.throws(() => runGeometry(owner.e, isolated, operation), /every vertex/);
  assert.equal(owner.calls.length, 0);
});

test('geometry traps poison every source alias and never call native cleanup', () => {
  const owner = tracked();
  owner.e.pmp_decimate = mesh => { owner.calls.push('forced-trap'); owner.raw.pmp_fair(mesh, 2); };
  assert.throws(() => runGeometry(owner.e, prepared(tetrahedron), 'decimate', { targetVertices: 3 }), WebAssembly.RuntimeError);
  assert(!owner.calls.includes('pmp_mesh_destroy'));
  const count = owner.calls.length;
  assert.throws(() => runGeometry({ exports: owner.raw }, prepared(triangle), 'normals'), /poisoned/);
  assert.equal(owner.calls.length, count);
});

test('geometry cannot re-enter a trapped instance even when a hole callback catches the trap', () => {
  const owner = tracked(), hole = prepared({ positions: tetrahedron.positions, indices: tetrahedron.indices.slice(0, 9) });
  owner.e.pmp_decimate = mesh => { owner.calls.push('forced-trap'); owner.raw.pmp_fair(mesh, 2); };
  assert.throws(() => runGeometry(owner.e, hole, 'fillHoles', { holeFilter() {
    assert.throws(() => runGeometry(owner.e, prepared(tetrahedron), 'decimate', { targetVertices: 3 }), WebAssembly.RuntimeError);
    return false;
  } }), /poisoned/);
  assert.equal(owner.calls.at(-1), 'forced-trap');
  assert(!owner.calls.includes('pmp_mesh_destroy'));
});

test('geometry inserts shuffled manifold triangle fans and closed surfaces safely', () => {
  const source = grid(7), faces = Array.from({ length: source.indices.length / 3 }, (_, i) => source.indices.slice(i * 3, i * 3 + 3));
  // Deterministic hostile order repeatedly jumps to disconnected vertex wedges.
  faces.sort((a, b) => ((a[0] * 37) % 101) - ((b[0] * 37) % 101));
  const result = runGeometry(fresh(), prepareGeometry(source.positions, faces.flat()), 'analyze');
  valid(result, true); assert.equal(result.indices.length, source.indices.length);
  valid(runGeometry(fresh(), prepared(tetrahedron), 'analyze'), true);
});

test('geometry face ordering handles shuffled torus handles and disconnected components', () => {
  const positions = [], faces = [], n = 8, m = 6;
  for (let y = 0; y < m; ++y) for (let x = 0; x < n; ++x) {
    const u = x * 2 * Math.PI / n, v = y * 2 * Math.PI / m, r = 2 + 0.5 * Math.cos(v);
    positions.push(r * Math.cos(u), r * Math.sin(u), 0.5 * Math.sin(v));
  }
  for (let y = 0; y < m; ++y) for (let x = 0; x < n; ++x) {
    const a = y * n + x, b = y * n + (x + 1) % n, c = ((y + 1) % m) * n + (x + 1) % n, d = ((y + 1) % m) * n + x;
    faces.push([a, b, c], [a, c, d]);
  }
  for (let seed = 1; seed <= 32; ++seed) {
    let state = seed; const shuffled = faces.slice();
    for (let i = shuffled.length - 1; i > 0; --i) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const j = state % (i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const result = runGeometry(fresh(), prepareGeometry(positions, shuffled.flat()), 'analyze', { computeNormals: false });
    assert.equal(result.measurements.components, 1); assert.equal(result.indices.length, faces.length * 3);
    assert(result.measurements.volume > 0);
  }
  const disconnected = prepareGeometry([...triangle.positions, ...triangle.positions.map((v, i) => i % 3 === 0 ? v + 3 : v)], [3, 4, 5, 0, 1, 2]);
  assert.equal(runGeometry(fresh(), disconnected, 'analyze').measurements.components, 2);
});

test('geometry selections and UVs refer to original rows after fan splitting', () => {
  const input = prepareGeometry([...triangle.positions, -1, 0, 0, 0, -1, 0], [0, 1, 2, 0, 3, 4]);
  const owner = tracked(), native = owner.e.pmp_decimate;
  owner.e.pmp_decimate = (...args) => {
    const scratch = owner.raw.pmp_alloc(32) >>> 0;
    new Uint8Array(owner.raw.memory.buffer, scratch, 11).set(new TextEncoder().encode('v:selected\0'));
    const pointer = owner.raw.pmp_mesh_property(args[0], 0, 0, scratch, 0) >>> 0;
    assert.deepEqual([...new Uint8Array(owner.raw.memory.buffer, pointer, 6)], [1, 0, 0, 0, 0, 1]);
    owner.raw.pmp_free(scratch); return native(...args);
  };
  const result = runGeometry(owner.e, input, 'decimate', { targetVertices: 6, selectedVertices: [0], texcoords: [0, 0, 1, 0, 0, 1, -1, 0, 0, -1] });
  assert.deepEqual(result.sourceIds, input.sourceIds);
  assert.equal(owner.allocations.size, 0); assert.equal(owner.meshes.size, 0);
});
