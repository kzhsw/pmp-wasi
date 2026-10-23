// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTransfer, computeNormals, transferAttribute, transferSkin } from '../src/gltf/transfer.js';

const triangle = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
const indices = new Uint32Array([0, 1, 2]);
const map = (weights = [0.2, 0.3, 0.5], ids = [0, 1, 2]) => ({ indices: Uint32Array.from(ids), weights: Float64Array.from(weights) });
const near = (actual, expected, tolerance = 1e-6) => {
  assert.equal(actual.length, expected.length);
  expected.forEach((value, i) => assert(Math.abs(actual[i] - value) <= tolerance * Math.max(1, Math.abs(value)), `${i}: ${actual[i]} != ${value}`));
};

test('nearest projection covers triangle interior, all edges, vertices and 3D planes', () => {
  const result = buildTransfer(triangle, indices, [0.5, 0.5, 3, 1, -2, 0, 2, 2, 0, -1, 1, 0, -2, -3, 0]);
  near(result.weights, [0.5, 0.25, 0.25, 0.5, 0.5, 0, 0, 0.5, 0.5, 0.5, 0, 0.5, 1, 0, 0], 1e-12);
  near(result.distances, [3, 2, Math.sqrt(2), 1, Math.sqrt(13)], 1e-12);
  assert.deepEqual(Array.from(result.indices), Array(5).fill([0, 1, 2]).flat());
  const tilted = buildTransfer([0, 0, 0, 1, 0, 1, 0, 1, 1], indices, [0.25 - 2, 0.25 - 2, 0.5 + 2]);
  near(tilted.weights, [0.5, 0.25, 0.25], 1e-12);
  near(tilted.distances, [Math.sqrt(12)], 1e-12);
});

test('exact source IDs retain rows even with no triangles or a zero projection cutoff', () => {
  const result = buildTransfer([0, 0, 0, 1, 0, 0], [], [100, 200, 300, -100, -200, -300],
    { sourceIds: [1, 0], maxDistance: 0 });
  assert.deepEqual(Array.from(result.indices), [1, 1, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(result.weights), [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(Array.from(result.distances), [0, 0]);
  const signed = new Int8Array([-128, 127]);
  assert.deepEqual(transferAttribute(signed, 1, result, { normalized: true }), new Int8Array([127, -128]));
  assert.deepEqual(buildTransfer([], [], []).indices, new Uint32Array());
});

test('equal-distance BVH ties choose the lowest source triangle and retain render seams', () => {
  const positions = [], faces = [];
  // The two nearest triangles have distinct accessor rows and opposite sides
  // of the query. Other triangles force traversal through several BVH leaves.
  for (let t = 0; t < 32; ++t) {
    const x = t === 0 || t === 31 ? 0 : 100 + t, z = t === 0 ? 1 : t === 31 ? -1 : 0;
    positions.push(x, 0, z, x + 2, 0, z, x, 2, z);
    faces.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  const result = buildTransfer(positions, faces, [0.5, 0.5, 0]);
  assert.deepEqual(Array.from(result.indices), [0, 1, 2]);
  near(result.weights, [0.5, 0.25, 0.25]);
  const uv = Float32Array.from({ length: positions.length / 3 * 2 }, (_, i) => i < 6 ? 10 : 99);
  near(transferAttribute(uv, 2, result), [10, 10]);
  assert.deepEqual(buildTransfer(positions, faces, [0.5, 0.5, 0]), result);
  const tiny = buildTransfer([0, 0, 1e-20, 2, 0, 1e-20, 0, 2, 1e-20,
    0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2, 3, 4, 5], [0.5, 0.5, 0]);
  assert.deepEqual(Array.from(tiny.indices), [3, 4, 5], 'tiny unequal distances are not treated as equal');
});

test('projection cutoff applies to actual point distance and accepts its boundary', () => {
  assert.equal(buildTransfer(triangle, indices, [0.5, 0.5, 2], { maxDistance: 2 }).distances[0], 2);
  assert.throws(() => buildTransfer(triangle, indices, [0.5, 0.5, 2], { maxDistance: 1.99 }), /maxDistance/);
  assert.throws(() => buildTransfer(triangle, indices, [-3, -4, 0], { maxDistance: 4.99 }), /maxDistance/);
  for (const maxDistance of [-1, NaN, -Infinity, '1'])
    assert.throws(() => buildTransfer(triangle, indices, [0, 0, 0], { maxDistance }), /maxDistance/);
});

test('projection handles thin triangles and geometry across very different scales', () => {
  const thin = buildTransfer([0, 0, 0, 1, 0, 0, 1, 1e-12, 0], indices, [0.75, 2.5e-13, 1]);
  near(thin.weights, [0.25, 0.5, 0.25], 1e-12);
  near(thin.distances, [1], 1e-12);
  for (const scale of [1e-200, 1e-20, 1e20, 1e200]) {
    const result = buildTransfer(Array.from(triangle, value => value * scale), indices, [0.5 * scale, 0.5 * scale, scale]);
    near(result.weights, [0.5, 0.25, 0.25], 1e-12);
    assert(Math.abs(result.distances[0] / scale - 1) <= 1e-12);
  }
});

test('generated edge barycentrics clamp tiny subtraction residuals without relaxing mapping validation', () => {
  // In binary64, 0.9 + 0.1 is 1, but (1 - 0.9) - 0.1 is negative.
  const mapping = buildTransfer([0, 0, 0, 1, 0, 0, 0, 1, 0], indices, [0.9, 0.1, 0]);
  assert.equal(mapping.weights[0], 0);
  assert(mapping.weights.every(value => value >= 0 && value <= 1));
  near(mapping.weights, [0, 0.9, 0.1], 1e-15);
  near(transferAttribute(new Float32Array([1, 2, 3]), 1, mapping), [2.1]);
  for (const negative of [-Number.EPSILON, -0.001])
    assert.throws(() => transferAttribute(new Float32Array([1, 2, 3]), 1,
      map([negative, 0.5, 0.5 - negative])), /mapping weight/);
});

test('continuous, normalized and categorical attributes preserve constructors and inputs', () => {
  for (const ArrayType of [Float32Array, Float64Array]) {
    const input = new ArrayType([0, 10, 10, 20, 20, 30]), original = input.slice();
    const output = transferAttribute(input, 2, map());
    assert(output instanceof ArrayType); near(output, [13, 23]);
    assert.deepEqual(input, original);
  }
  for (const ArrayType of [Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array]) {
    const input = new ArrayType([3, 5, 7]);
    assert.deepEqual(transferAttribute(input, 1, map()), new ArrayType([7]));
    assert.deepEqual(transferAttribute(input, 1, map([0.5, 0.5, 0])), new ArrayType([3]), 'categorical ties choose the first corner');
  }
  assert.deepEqual(transferAttribute(new Float32Array([1, 2, 3]), 1, map(), { discrete: true }), new Float32Array([3]));
  assert.deepEqual(transferAttribute(new Uint8Array([0, 255, 255]), 1, map([0.5, 0.25, 0.25]), { normalized: true }), new Uint8Array([128]));
  assert.deepEqual(transferAttribute(new Int8Array([-128, 127, 0]), 1, map([0.5, 0.5, 0]), { normalized: true }), new Int8Array([0]));
  assert.deepEqual(transferAttribute(new Int16Array([-32768, 32767, 0]), 1, map([0.25, 0.75, 0]), { normalized: true }), new Int16Array([16384]));
  assert.deepEqual(transferAttribute(new Uint16Array([0, 65535, 65535]), 1, map([0.5, 0.25, 0.25]), { normalized: true }), new Uint16Array([32768]));
});

test('skin projection merges repeated joints, selects top influences, and normalizes source rows', () => {
  const channels = [{ set: 0, joints: new Uint8Array([2, 4, 0, 0, 4, 6, 0, 0, 6, 8, 0, 0]),
    weights: new Float32Array([1, 1, 0, 0, 1, 3, 0, 0, 7, 0, 0, 0]) }];
  const result = transferSkin(channels, map());
  assert.equal(result[0].set, 0);
  assert(result[0].joints instanceof Uint8Array && result[0].weights instanceof Float32Array);
  assert.deepEqual(Array.from(result[0].joints), [6, 4, 2, 0]);
  near(result[0].weights, [0.725, 0.175, 0.1, 0]);
  const duplicate = transferSkin([{ set: 0, joints: new Uint16Array([4, 4, 1, 2]),
    weights: new Float32Array([0.25, 0.25, 0.5, 0]) }], map([1, 0, 0], [0, 0, 0]));
  assert.deepEqual(Array.from(duplicate[0].joints), [1, 4, 0, 0]);
  near(duplicate[0].weights, [0.5, 0.5, 0, 0]);
});

test('multiset skin projection decodes normalized weights, widens joints and sorts sets', () => {
  const channels = [{ set: 7, joints: new Uint16Array([500, 4, 3, 2]), weights: new Uint8Array([255, 255, 255, 255]), normalized: true },
    { set: 1, joints: new Uint8Array([1, 4, 8, 9]), weights: new Float32Array([1, 1, 1, 1]) }];
  const result = transferSkin(channels, map([1, 0, 0], [0, 0, 0]));
  assert.deepEqual(result.map(channel => channel.set), [1, 7]);
  assert(result.every(channel => channel.joints instanceof Uint16Array && channel.weights instanceof Float32Array));
  assert.deepEqual(result.flatMap(channel => Array.from(channel.joints)), [4, 1, 2, 3, 8, 9, 500, 0]);
  near(result.flatMap(channel => Array.from(channel.weights)), [0.25, 0.125, 0.125, 0.125, 0.125, 0.125, 0.125, 0]);
  const equal = [{ set: 0, joints: Uint8Array.from({ length: 12 }, (_, i) => i), weights: new Float32Array(12).fill(0.25) },
    { set: 1, joints: Uint8Array.from({ length: 12 }, (_, i) => i + 12), weights: new Float32Array(12).fill(0.25) }];
  const retained = transferSkin(equal, map([1 / 3, 1 / 3, 1 / 3]));
  assert.deepEqual(retained.flatMap(channel => Array.from(channel.joints)), [0, 1, 2, 3, 4, 5, 6, 7]);
  near(retained.flatMap(channel => Array.from(channel.weights)), Array(8).fill(0.125));
});

test('angle-weighted normals retain winding, ignore unequal areas, and handle isolated or cancelling vertices', () => {
  const positions = [0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 1, 0, 0, 0, 1, 9, 9, 9];
  const output = computeNormals(positions, [0, 1, 2, 0, 3, 4]);
  assert(output instanceof Float32Array);
  near(output, [Math.SQRT1_2, 0, Math.SQRT1_2, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0]);
  const unequalAngles = positions.slice(); unequalAngles[13] = 1;
  near(computeNormals(unequalAngles, [0, 1, 2, 0, 3, 4]).subarray(0, 3), [1 / Math.sqrt(5), 0, 2 / Math.sqrt(5)]);
  near(computeNormals(triangle, [0, 2, 1]), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  near(computeNormals(triangle, [0, 1, 2, 0, 2, 1]), Array(9).fill(0));
  assert.deepEqual(computeNormals([], []), new Float32Array());
  for (const scale of [1e-200, 1e-20, 1e20, 1e200]) near(computeNormals(Array.from(triangle, value => value * scale), indices), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('invalid geometry, mapping, attribute and skin inputs fail clearly', () => {
  for (const positions of [[0, 0], [0, 0, NaN], [0, Infinity, 0]])
    assert.throws(() => buildTransfer(positions, [], []), /positions/);
  for (const faces of [[0, 1], [0, 1, 3], [0, -1, 2], [0, 1.5, 2], [0, 0, 2]])
    assert.throws(() => buildTransfer(triangle, faces, [0, 0, 0]), /indices|index|degenerate/);
  assert.throws(() => buildTransfer([0, 0, 0, 1, 1, 1, 2, 2, 2], indices, []), /degenerate/);
  assert.throws(() => buildTransfer(triangle, indices, [0, NaN, 0]), /finite/);
  assert.throws(() => buildTransfer([], [], [0, 0, 0]), /source triangle/);
  for (const sourceIds of [[], [3], [-1], [0.5]])
    assert.throws(() => buildTransfer(triangle, indices, [0, 0, 0], { sourceIds }), /source ID/);
  for (const bad of [map([0, 0, 0]), map([-0.1, 0.6, 0.5]), map([0.5, 0.5, 1]), map([1, 0, 0], [0, 1, 4]),
    { indices: [0, 1], weights: [0.5, 0.5] }, { indices: [0, 1, 2], weights: [0, NaN, 1] },
    Object.assign(map(), { distances: [-1] })])
    assert.throws(() => transferAttribute(new Float32Array([1, 2, 3]), 1, bad), /mapping/);
  for (const size of [0, -1, 0.5, 2]) assert.throws(() => transferAttribute(new Float32Array(3), size, map()), /itemSize/);
  assert.throws(() => transferAttribute(new Float32Array([1, NaN, 3]), 1, map()), /finite/);
  assert.throws(() => transferAttribute(new Float32Array(3), 1, map(), { normalized: true }), /integer/);
  assert.throws(() => transferAttribute(new Uint8Array(3), 1, map(), { discrete: 1 }), /booleans/);
  assert.throws(() => transferAttribute(new BigInt64Array(3), 1, map()), /typed array/);
  const valid = { set: 0, joints: new Uint8Array(12), weights: new Float32Array(12).fill(0.25) };
  for (const channels of [[], [null, valid], [Object.assign({}, valid, { set: -1 })], [valid, valid],
    [Object.assign({}, valid, { joints: new Float32Array(12) })],
    [Object.assign({}, valid, { weights: new Float32Array(11) })],
    [Object.assign({}, valid, { weights: new Float32Array(12) })],
    [Object.assign({}, valid, { weights: new Float32Array(12).fill(-1) })],
    [Object.assign({}, valid, { weights: new Float32Array(12).fill(NaN) })],
    [Object.assign({}, valid, { normalized: true })],
    [valid, { set: 1, joints: new Uint8Array(4), weights: new Float32Array(4).fill(0.25) }]])
    assert.throws(() => transferSkin(channels, map()), /skin|finite/);
  assert.throws(() => computeNormals(triangle, [0, 0, 1]), /degenerate/);
});

test('deterministic normal fuzz preserves rotation, translation and uniform scaling', () => {
  let state = 17290481;
  const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296);
  const positions = [], faces = [], n = 9;
  for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x)
    positions.push(x + 0.1 * random(), y + 0.1 * random(), random() - 0.5);
  for (let y = 0; y + 1 < n; ++y) for (let x = 0; x + 1 < n; ++x) {
    const a = y * n + x, b = a + 1, c = a + n + 1, d = a + n;
    faces.push(a, b, c, a, c, d);
  }
  const original = computeNormals(positions, faces), moved = [];
  for (let v = 0; v < positions.length; v += 3)
    moved.push(-positions[v + 1] * 7 + 2, positions[v] * 7 - 3, positions[v + 2] * 7 + 5);
  const output = computeNormals(moved, faces);
  for (let v = 0; v < original.length; v += 3) {
    near(output.subarray(v, v + 3), [-original[v + 1], original[v], original[v + 2]], 1e-6);
    near([Math.hypot(...original.subarray(v, v + 3))], [1], 1e-6);
  }
  assert.deepEqual(computeNormals(positions, faces), original, 'same base and zero-delta morph positions give identical normals');
});

// Independent Ericson closest-point reference for bounded random triangles.
function referencePoint(p, a, b, c) {
  const sub = (x, y) => x.map((value, i) => value - y[i]);
  const dot = (x, y) => x.reduce((sum, value, i) => sum + value * y[i], 0);
  const along = (x, d, t) => x.map((value, i) => value + d[i] * t);
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return along(a, ab, d1 / (d1 - d3));
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return along(a, ac, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return along(b, sub(c, b), (d4 - d3) / (d4 - d3 + d5 - d6));
  return a.map((value, i) => value + ab[i] * vb / (va + vb + vc) + ac[i] * vc / (va + vb + vc));
}

test('bounded deterministic projection fuzz agrees with independent exhaustive geometry', () => {
  let state = 0x83db2f17;
  const random = () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296);
  const positions = Float64Array.from({ length: 180 * 9 }, () => random() * 20 - 10);
  const triangles = Uint32Array.from({ length: 180 * 3 }, (_, i) => i);
  const targets = Float64Array.from({ length: 160 * 3 }, () => random() * 28 - 14);
  const mapping = buildTransfer(positions, triangles, targets);
  for (let row = 0; row < targets.length / 3; ++row) {
    const p = Array.from(targets.subarray(row * 3, row * 3 + 3));
    let expected = Infinity, triangleIndex = -1;
    for (let t = 0; t < triangles.length / 3; ++t) {
      const corner = c => Array.from(positions.subarray((t * 3 + c) * 3, (t * 3 + c) * 3 + 3));
      const nearest = referencePoint(p, corner(0), corner(1), corner(2));
      const distance = Math.hypot(...p.map((value, i) => value - nearest[i]));
      if (distance < expected) { expected = distance; triangleIndex = t; }
    }
    near([mapping.distances[row]], [expected], 1e-10);
    assert.equal(mapping.indices[row * 3], triangleIndex * 3);
    near([mapping.weights[row * 3] + mapping.weights[row * 3 + 1] + mapping.weights[row * 3 + 2]], [1], 1e-12);
    assert(mapping.weights.subarray(row * 3, row * 3 + 3).every(value => value >= 0 && value <= 1));
  }
});

test('BVH prunes spatially separated triangles instead of scanning every triangle per output', () => {
  const positions = [], triangles = [], targets = [];
  for (let t = 0; t < 3200; ++t) {
    const x = t % 80 * 4, y = Math.floor(t / 80) * 4;
    positions.push(x, y, 0, x + 1, y, 0, x, y + 1, 0); triangles.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  for (let i = 0; i < 512; ++i) {
    const t = i * 619 % 3200; targets.push(t % 80 * 4 + 0.2, Math.floor(t / 80) * 4 + 0.2, 0.1);
  }
  let reads = 0;
  const observed = new Proxy(positions, { get(target, key) {
    if (typeof key === 'string' && /^\d+$/.test(key)) ++reads;
    return target[key];
  } });
  const result = buildTransfer(observed, triangles, targets);
  near(result.distances, Array(512).fill(0.1));
  assert(reads < 3200 * 512, `BVH read ${reads} positions; exhaustive triangle queries would exceed this bound`);
});
