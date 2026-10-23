// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { attributeView, Domain, instantiate, meshView, Property, Winding } from '../src/index.js';
import { audit } from '../scripts/wasm.mjs';

const root = new URL('../', import.meta.url);
const [wasm, exportNames, native] = await Promise.all([
  readFile(new URL('build/pmp-core.wasm', root)),
  readFile(new URL('exports/core.json', root), 'utf8').then(JSON.parse),
  readFile(new URL('test/fixtures/native-core.json', root), 'utf8').then(JSON.parse),
]);
const module = await WebAssembly.compile(wasm);
const INVALID = 0xffffffff;
const trianglePoints = [0, 0, 0, 1, 0, 0, 0, 1, 0];

function near(actual, expected, label = 'values', tolerance = 2e-6) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  for (let i = 0; i < expected.length; ++i) {
    assert(Number.isFinite(actual[i]), `${label}[${i}] is finite`);
    assert(Math.abs(actual[i] - expected[i]) <= tolerance * Math.max(1, Math.abs(expected[i])),
      `${label}[${i}]: ${actual[i]} != ${expected[i]}`);
  }
}

function upload(e, ArrayType, values) {
  const pointer = e.pmp_alloc(values.length * ArrayType.BYTES_PER_ELEMENT) >>> 0;
  new ArrayType(e.memory.buffer, pointer, values.length).set(values);
  return pointer;
}

function cstring(e, name) {
  return upload(e, Uint8Array, [...new TextEncoder().encode(name), 0]);
}

// Cleanup is deliberately after success only. Never call an instance again after a trap.
async function withMesh(body) {
  const e = await instantiate(module);
  const mesh = e.pmp_mesh_create();
  await body(e, mesh);
  e.pmp_mesh_destroy(mesh);
}

function vertices(e, mesh, positions) {
  assert.equal(e.pmp_mesh_add_vertices(mesh, positions.length / 3), 0);
  meshView(e, mesh).positions.set(positions);
}

function faces(e, mesh, polygons) {
  const offsets = [0];
  for (const polygon of polygons) offsets.push(offsets.at(-1) + polygon.length);
  const indices = upload(e, Uint32Array, polygons.flat());
  const starts = upload(e, Uint32Array, offsets);
  e.pmp_mesh_add_faces(mesh, indices, starts, polygons.length);
  e.pmp_free(indices);
  e.pmp_free(starts);
}

function normal(e, mesh, kind, index, angle) {
  const out = e.pmp_alloc(12) >>> 0;
  if (kind === 'corner') e.pmp_corner_normal(mesh, index, angle, out);
  else e[`pmp_${kind}_normal`](mesh, index, out);
  const result = [...new Float32Array(e.memory.buffer, out, 3)];
  e.pmp_free(out);
  return result;
}

function cycle(view, first) {
  const result = [];
  let h = first;
  do {
    assert(h < view.edges * 2, 'halfedge cycle index is in range');
    assert(result.length < view.edges * 2, 'halfedge cycle closes');
    result.push(h);
    h = view.halfedges[h * 4 + 2];
  } while (h !== first);
  return result;
}

function cyclicEqual(actual, expected) {
  assert.equal(actual.length, expected.length);
  const start = actual.indexOf(expected[0]);
  assert(start >= 0);
  assert.deepEqual(expected.map((_, i) => actual[(start + i) % actual.length]), expected);
}

function topology(view, expectedFaces) {
  assert.deepEqual([view.liveVertices, view.liveEdges, view.liveFaces],
    [view.vertices, view.edges, view.faces]);
  assert.equal(view.faces, expectedFaces.length);
  const uniqueEdges = new Set();
  for (const face of expectedFaces) for (let i = 0; i < face.length; ++i) {
    const a = face[i], b = face[(i + 1) % face.length];
    uniqueEdges.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
  assert.equal(view.edges, uniqueEdges.size);
  for (const deleted of [view.deletedVertices, view.deletedEdges, view.deletedFaces])
    assert(deleted.every(value => value === 0), 'all entities are live');
  for (let h = 0; h < view.edges * 2; ++h) {
    const [face, vertex, next, previous] = view.halfedges.subarray(h * 4, h * 4 + 4);
    assert(face === INVALID || face < view.faces);
    assert(vertex < view.vertices);
    assert(next < view.edges * 2 && previous < view.edges * 2);
    assert.equal(view.halfedges[next * 4 + 3], h, 'next/previous are inverse');
    assert.equal(view.halfedges[previous * 4 + 2], h, 'previous/next are inverse');
    assert.equal(view.halfedges[(next ^ 1) * 4 + 1], vertex, 'successive endpoints meet');
    assert.equal(view.halfedges[next * 4], face, 'a cycle stays in one face or boundary');
  }
  for (let f = 0; f < view.faces; ++f) {
    const loop = cycle(view, view.faceHalfedges[f]);
    for (const h of loop) assert.equal(view.halfedges[h * 4], f);
    cyclicEqual(loop.map(h => view.halfedges[h * 4 + 1]), expectedFaces[f]);
  }
  for (let v = 0; v < view.vertices; ++v) {
    const outgoing = [];
    for (let h = 0; h < view.edges * 2; ++h)
      if (view.halfedges[(h ^ 1) * 4 + 1] === v) outgoing.push(h);
    if (!outgoing.length) assert.equal(view.vertexHalfedges[v], INVALID);
    else {
      assert(outgoing.includes(view.vertexHalfedges[v]), 'vertex points to an outgoing halfedge');
      if (outgoing.some(h => view.halfedges[h * 4] === INVALID))
        assert.equal(view.halfedges[view.vertexHalfedges[v] * 4], INVALID,
          'a boundary vertex points to a boundary halfedge');
    }
  }
}

test('public C header declares exactly the implemented API and matching runtime ABI', async () => {
  const header = (await readFile(new URL('../include/pmp.h', import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...header.matchAll(/\b(pmp_\w+)\s*\([^;{}]*\)\s*;/g)].map(match => match[1]);
  assert.deepEqual(declarations.sort(), exportNames.filter(name => name !== 'memory').sort());
  const version = Number(header.match(/^#define PMP_ABI_VERSION (\d+)u$/m)[1]);
  assert.equal((await instantiate(module)).pmp_abi_version(), version);
});

test('core binary has exactly the development exports and no host or initialization hooks', async () => {
  const info = audit(wasm, exportNames);
  assert.equal(exportNames.length, 52);
  assert.deepEqual(WebAssembly.Module.imports(info.module), []);
  assert.equal(info.start, false);
  assert(![...info.exports.keys()].some(name => /init|ctor|dtor|start|wasi/i.test(name)));
  const e = await instantiate(wasm);
  assert.equal(e.pmp_abi_version(), 0);
  assert(e.memory instanceof WebAssembly.Memory);
  assert.equal(e.memory.buffer.byteLength, 65536, 'production starts with one Wasm page');
  assert(!(e.memory.buffer instanceof SharedArrayBuffer));
});

test('allocator returns independent, aligned buffers and accepts zero-sized ownership', async () => {
  const e = await instantiate(module);
  assert.equal(e.pmp_alloc(0), 0);
  const allocations = [1, 15, 16, 17, 31, 256].map((size, i) => {
    const pointer = e.pmp_alloc(size) >>> 0;
    assert(pointer > 0);
    assert.equal(pointer % 16, 0);
    new Uint8Array(e.memory.buffer, pointer, size).fill(i + 1);
    return { pointer, size, value: i + 1 };
  });
  for (const { pointer, size, value } of allocations) {
    assert(new Uint8Array(e.memory.buffer, pointer, size).every(byte => byte === value));
    e.pmp_free(pointer);
  }
  e.pmp_free(0);
  e.pmp_mesh_destroy(0);
});

for (const fixture of native) test(`matches unmodified native PMP: ${fixture.name}`, async () => {
  await withMesh((e, mesh) => {
    vertices(e, mesh, fixture.positions);
    faces(e, mesh, fixture.faces);
    const view = meshView(e, mesh);
    topology(view, fixture.faces);
    assert.equal(view.edges, fixture.edges);
    assert.deepEqual([...view.positions], fixture.positions);
    for (const key of ['vertexHalfedges', 'halfedges', 'faceHalfedges'])
      assert.deepEqual([...view[key]], fixture[key].flat(), `native ${key}`);
    for (let v = 0; v < view.vertices; ++v)
      near(normal(e, mesh, 'vertex', v), fixture.vertexNormals.slice(v * 3, v * 3 + 3), `vertex ${v}`);
    for (let f = 0; f < view.faces; ++f)
      near(normal(e, mesh, 'face', f), fixture.faceNormals.slice(f * 3, f * 3 + 3), `face ${f}`);
    e.pmp_vertex_normals(mesh);
    e.pmp_face_normals(mesh);
    near(attributeView(e, mesh, 'v:normal', Property.VEC3F), fixture.vertexNormals, 'vertex normals');
    near(attributeView(e, mesh, 'f:normal', Property.VEC3F, Domain.FACE), fixture.faceNormals, 'face normals');
    for (const corner of fixture.cornerNormals)
      near(normal(e, mesh, 'corner', corner.halfedge, corner.angle), corner.normal,
        `native corner ${corner.halfedge} at ${corner.angle}`);
    assert.equal(e.pmp_detect_features(mesh, 30), fixture.features30);
    const edgeFeatures = attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE);
    assert.equal(edgeFeatures.reduce((sum, value) => sum + value, 0), fixture.features30);
    assert(edgeFeatures.every(value => value === 0 || value === 1), 'features are byte bools');
    e.pmp_clear_features(mesh);
    assert(attributeView(e, mesh, 'v:feature', Property.BOOL).every(value => value === 0));
    assert(attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE).every(value => value === 0));
    assert.equal(e.pmp_detect_boundary(mesh), fixture.boundary);
    const boundaryView = meshView(e, mesh);
    const boundaryEdges = attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE);
    for (let edge = 0; edge < boundaryView.edges; ++edge)
      assert.equal(boundaryEdges[edge], Number(boundaryView.halfedges[edge * 8] === INVALID ||
        boundaryView.halfedges[edge * 8 + 4] === INVALID));
    e.pmp_clear_features(mesh);
    assert(attributeView(e, mesh, 'v:feature', Property.BOOL).every(value => value === 0));
    assert(attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE).every(value => value === 0));
  });
});

test('positions and named attributes alias native storage, including a borrowed add_vertex input', async () => {
  await withMesh((e, mesh) => {
    e.pmp_mesh_reserve(mesh, 3, 3, 1);
    const input = upload(e, Float32Array, [2, 3, 4]);
    assert.equal(e.pmp_mesh_add_vertex(mesh, input), 0);
    new Float32Array(e.memory.buffer, input, 3).set([3, 3, 4]);
    assert.equal(e.pmp_mesh_add_vertex(mesh, input), 1);
    new Float32Array(e.memory.buffer, input, 3).set([2, 4, 4]);
    assert.equal(e.pmp_mesh_add_vertex(mesh, input), 2);
    assert.equal(e.pmp_mesh_add_triangle(mesh, 0, 1, 2), 0);
    const view = meshView(e, mesh);
    const points = attributeView(e, mesh, 'v:point', Property.VEC3F);
    assert.equal(points.buffer, e.memory.buffer);
    assert.equal(points.byteOffset, view.positions.byteOffset);
    view.positions[8] = 5;
    assert.equal(points[8], 5);
    near(normal(e, mesh, 'face', 0), [0, -Math.SQRT1_2, Math.SQRT1_2]);
    points[8] = 4;
    near(normal(e, mesh, 'face', 0), [0, 0, 1]);
    assert.equal(e.pmp_mesh_add_vertex(mesh, points.byteOffset), 3);
    assert.deepEqual([...meshView(e, mesh).positions.slice(9)], [2, 3, 4]);
    topology(meshView(e, mesh), [[0, 1, 2]]);
    e.pmp_free(input);
  });
});

test('single polygon construction exposes native face connectivity', async () => {
  await withMesh((e, mesh) => {
    vertices(e, mesh, [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]);
    const input = upload(e, Uint32Array, [0, 1, 2, 3]);
    assert.equal(e.pmp_mesh_add_face(mesh, input, 4), 0);
    topology(meshView(e, mesh), [[0, 1, 2, 3]]);
    near(normal(e, mesh, 'face', 0), [0, 0, 1]);
    e.pmp_free(input);
  });
});

const propertyCases = [
  ['v:selected', Property.BOOL, Uint8Array, [1, 0, 1, 1]],
  ['user:material', Property.I32, Int32Array, [-2147483648, -1, 0, 2147483647]],
  ['user:index', Property.U32, Uint32Array, [0, 65536, 0x80000001, 0xffffffff]],
  ['user:scalar', Property.F32, Float32Array, [0.125, -2.5, 8, 1024]],
  ['user:precision', Property.F64, Float64Array, [1 + 2 ** -40, Math.PI, -1e100, 1e-100]],
  ['v:tex', Property.VEC2F, Float32Array, [0, 0, 1, 0, 1, 1, 0, 1]],
  ['user:uv1', Property.VEC2F, Float32Array, [0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 0.25]],
  ['user:direction', Property.VEC3F, Float32Array, [1, 0, 0, 0, 1, 0, 0, 0, 1, -1, -1, -1]],
  ['user:matricesWeights', Property.VEC4F, Float32Array,
    [0.25, 0.5, 0.125, 0.125, 1, 0, 0, 0, 0, 0.5, 0.5, 0, 0.125, 0.125, 0.25, 0.5]],
  ['user:matricesWeightsExtra', Property.VEC4F, Float32Array,
    [0.25, 0, 0, 0, 0, 0.125, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1]],
  ['user:matricesIndices', Property.VEC4U32, Uint32Array,
    [0, 65536, 0x80000001, 0xffffffff, 1, 2, 3, 4, 100, 200, 300, 400, 7, 8, 9, 10]],
  ['user:matricesIndices16', Property.VEC4U16, Uint16Array,
    [0, 65535, 1, 2048, 1, 2, 3, 4, 100, 200, 300, 400, 7, 8, 9, 10]],
  ['user:colors', Property.RGBA8, Uint8Array, [0, 255, 128, 1, 255, 0, 64, 255, 3, 7, 11, 13, 16, 32, 64, 128]],
  ['user:颜色🎨', Property.U32, Uint32Array, [1, 2, 3, 4]],
];

test('all property layouts preserve exact values, zero-fill growth and survive reserve/collection', async () => {
  await withMesh((e, mesh) => {
    vertices(e, mesh, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    faces(e, mesh, [[0, 1, 2, 3]]);
    for (const [name, type, ArrayType, values] of propertyCases) {
      const view = attributeView(e, mesh, name, type, Domain.VERTEX, true);
      assert(view instanceof ArrayType, name);
      assert.equal(view.buffer, e.memory.buffer);
      assert.equal(view.byteOffset % ArrayType.BYTES_PER_ELEMENT, 0);
      assert.equal(view.length, values.length);
      assert(view.every(value => value === 0), `${name} is zero-initialized`);
      view.set(values);
      assert.deepEqual([...attributeView(e, mesh, name, type)], values, `${name} aliases storage`);
    }
    for (const [domain, count] of [[Domain.HALFEDGE, 8], [Domain.EDGE, 4], [Domain.FACE, 1]]) {
      const attribute = attributeView(e, mesh, 'user:domain', Property.U32, domain, true);
      assert.equal(attribute.length, count);
      attribute.set(Array.from({ length: count }, (_, i) => 100 * domain + i));
    }
    assert.equal(e.pmp_mesh_add_vertices(mesh, 2), 4);
    e.pmp_mesh_reserve(mesh, 64, 64, 32);
    // No deletion operation is exported yet; this exercises collection's no-garbage path.
    e.pmp_mesh_garbage_collection(mesh);
    e.pmp_vertex_normals(mesh);
    e.pmp_face_normals(mesh);
    e.pmp_detect_features(mesh, 30);
    e.pmp_detect_boundary(mesh);
    e.pmp_clear_features(mesh);
    for (const [name, type, , values] of propertyCases) {
      const view = attributeView(e, mesh, name, type);
      assert.equal(view.length, values.length / 4 * 6);
      assert.deepEqual([...view.subarray(0, values.length)], values, `${name} survives storage changes`);
      assert(view.subarray(values.length).every(value => value === 0), `${name} new elements are zero`);
    }
    for (const [domain, count] of [[Domain.HALFEDGE, 8], [Domain.EDGE, 4], [Domain.FACE, 1]])
      assert.deepEqual([...attributeView(e, mesh, 'user:domain', Property.U32, domain)],
        Array.from({ length: count }, (_, i) => 100 * domain + i));
    topology(meshView(e, mesh), [[0, 1, 2, 3]]);
  });
});

test('missing, empty and removed properties follow the raw ownership contract', async () => {
  await withMesh((e, mesh) => {
    assert.equal(attributeView(e, mesh, 'user:absent', Property.F32), null);
    assert.equal(attributeView(e, mesh, 'user:empty', Property.F32, Domain.VERTEX, true), null);
    const emptyName = cstring(e, 'user:empty');
    assert.equal(e.pmp_mesh_remove_property(mesh, Domain.VERTEX, emptyName), 1);
    assert.equal(e.pmp_mesh_remove_property(mesh, Domain.VERTEX, emptyName), 0);
    vertices(e, mesh, trianglePoints);
    faces(e, mesh, [[0, 1, 2]]);
    const name = cstring(e, 'user:channel');
    attributeView(e, mesh, 'user:channel', Property.U32, Domain.VERTEX, true).set([2, 4, 8]);
    assert.equal(e.pmp_mesh_remove_property(mesh, Domain.VERTEX, name), 1);
    assert.equal(attributeView(e, mesh, 'user:channel', Property.U32), null);
    assert.equal(e.pmp_mesh_remove_property(mesh, Domain.VERTEX, name), 0);
    assert.deepEqual([...attributeView(e, mesh, 'user:channel', Property.F64, Domain.VERTEX, true)], [0, 0, 0]);
    e.pmp_vertex_normals(mesh);
    const normalName = cstring(e, 'v:normal');
    assert.equal(e.pmp_mesh_remove_property(mesh, Domain.VERTEX, normalName), 1);
    assert.equal(attributeView(e, mesh, 'v:normal', Property.VEC3F), null);
    e.pmp_vertex_normals(mesh);
    near(attributeView(e, mesh, 'v:normal', Property.VEC3F), [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    for (const pointer of [emptyName, name, normalName]) e.pmp_free(pointer);
  });
});

const bulkCases = [
  { name: 'triangles', positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], polygons: [[0, 1, 2], [0, 2, 3]] },
  { name: 'polygons', positions: [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0],
    polygons: [[0, 1, 4, 3], [1, 2, 5, 4]] },
];
for (const shape of bulkCases) for (const winding of [Winding.CCW, Winding.CW])
  for (const mapped of [false, true]) test(
    `${winding === Winding.CW ? 'CW' : 'CCW'} bulk ${shape.name} ${mapped ? 'map source corners and UV seams' : 'accept an omitted mapping'}`,
    async () => {
      await withMesh((e, mesh) => {
        vertices(e, mesh, shape.positions);
        const inputFaces = shape.polygons.map(face => winding === Winding.CW ? [...face].reverse() : face);
        const source = inputFaces.flat();
        const offsets = [0];
        for (const face of inputFaces) offsets.push(offsets.at(-1) + face.length);
        const input = upload(e, Uint32Array, source);
        const starts = upload(e, Uint32Array, offsets);
        const mapping = mapped ? upload(e, Uint32Array, source.map(() => INVALID)) : 0;
        if (shape.name === 'triangles')
          e.pmp_mesh_add_triangles(mesh, input, inputFaces.length, winding, mapping);
        else e.pmp_mesh_add_faces_winding(mesh, input, starts, inputFaces.length, winding, mapping);
        assert.deepEqual([...new Uint32Array(e.memory.buffer, input, source.length)], source,
          'construction leaves caller indices intact');
        topology(meshView(e, mesh), shape.polygons);
        for (let f = 0; f < inputFaces.length; ++f) near(normal(e, mesh, 'face', f), [0, 0, 1]);
        if (mapped) {
          const corners = [...new Uint32Array(e.memory.buffer, mapping, source.length)];
          assert.equal(new Set(corners).size, source.length);
          const scratch = e.pmp_alloc(52) >>> 0;
          const uv = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE, true);
          const view = meshView(e, mesh, scratch);
          for (let f = 0; f < inputFaces.length; ++f) for (let i = offsets[f]; i < offsets[f + 1]; ++i) {
            const h = corners[i];
            assert(h < view.edges * 2);
            assert.equal(view.halfedges[h * 4], f);
            assert.equal(view.halfedges[h * 4 + 1], source[i], 'mapping targets its original source corner');
            uv.set([i + 0.125, i + 0.25], h * 2);
          }
          const seamVertex = source.find(v => source.indexOf(v) !== source.lastIndexOf(v));
          const seamCorners = source.flatMap((v, i) => v === seamVertex ? [i] : []);
          assert.equal(seamCorners.length, 2);
          assert.notEqual(corners[seamCorners[0]], corners[seamCorners[1]]);
          e.pmp_mesh_reserve(mesh, 32, 32, 8);
          e.pmp_mesh_garbage_collection(mesh);
          const retained = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE);
          for (let i = 0; i < corners.length; ++i)
            assert.deepEqual([...retained.subarray(corners[i] * 2, corners[i] * 2 + 2)], [i + 0.125, i + 0.25]);
          e.pmp_free(scratch);
        }
        for (const pointer of [input, starts, mapping]) e.pmp_free(pointer);
      });
    });

test('empty bulk construction is a no-op with null input buffers', async () => {
  await withMesh((e, mesh) => {
    e.pmp_mesh_add_faces(mesh, 0, 0, 0);
    e.pmp_mesh_add_faces_winding(mesh, 0, 0, 0, Winding.CW, 0);
    e.pmp_mesh_add_triangles(mesh, 0, 0, Winding.CCW, 0);
    assert.equal(e.pmp_mesh_add_vertices(mesh, 0), 0);
    topology(meshView(e, mesh), []);
  });
});

test('memory.grow detaches old JS views and reacquired views address the same native data', async () => {
  await withMesh((e, mesh) => {
    vertices(e, mesh, trianglePoints);
    faces(e, mesh, [[0, 1, 2]]);
    const scratch = e.pmp_alloc(52) >>> 0;
    const old = meshView(e, mesh, scratch);
    const oldProperty = attributeView(e, mesh, 'user:index', Property.U32, Domain.VERTEX, true);
    oldProperty.set([17, 23, 42]);
    const positionPointer = old.positions.byteOffset, propertyPointer = oldProperty.byteOffset;
    const oldBuffer = e.memory.buffer;
    const pages = oldBuffer.byteLength / 65536;
    assert.equal(e.memory.grow(1), pages);
    assert.equal(oldBuffer.byteLength, 0);
    assert.equal(old.positions.length, 0);
    assert.equal(oldProperty.length, 0);
    const current = meshView(e, mesh, scratch);
    const currentProperty = attributeView(e, mesh, 'user:index', Property.U32);
    assert.equal(current.positions.buffer, e.memory.buffer);
    assert.notEqual(current.positions.buffer, oldBuffer);
    assert.equal(current.positions.byteOffset, positionPointer);
    assert.equal(currentProperty.byteOffset, propertyPointer);
    assert.deepEqual([...current.positions], trianglePoints);
    assert.deepEqual([...currentProperty], [17, 23, 42]);
    current.positions[8] = 1;
    near(normal(e, mesh, 'face', 0), [0, -Math.SQRT1_2, Math.SQRT1_2]);
    currentProperty[1] = 99;
    assert.equal(new Uint32Array(e.memory.buffer, propertyPointer, 3)[1], 99);
    e.pmp_free(scratch);
  });
});

test('allocating storage on another mesh grows memory and invalidates every borrowed view', async () => {
  await withMesh((e, mesh) => {
    vertices(e, mesh, trianglePoints);
    faces(e, mesh, [[0, 1, 2]]);
    const other = e.pmp_mesh_create();
    const oldProperty = attributeView(e, mesh, 'user:owner', Property.U32, Domain.VERTEX, true);
    oldProperty.set([11, 22, 33]);
    const old = meshView(e, mesh);
    const positionsPointer = old.positions.byteOffset, propertyPointer = oldProperty.byteOffset;
    const oldBuffer = e.memory.buffer;
    // Positions alone exceed the entire existing memory; no large stress allocation is needed.
    e.pmp_mesh_reserve(other, Math.floor(oldBuffer.byteLength / 12) + 1, 0, 0);
    assert.equal(oldBuffer.byteLength, 0);
    assert.equal(old.positions.length, 0);
    assert.equal(oldProperty.length, 0);
    const current = meshView(e, mesh);
    const owner = attributeView(e, mesh, 'user:owner', Property.U32);
    assert.equal(current.positions.byteOffset, positionsPointer);
    assert.equal(owner.byteOffset, propertyPointer);
    assert.deepEqual([...current.positions], trianglePoints);
    assert.deepEqual([...owner], [11, 22, 33]);
    topology(current, [[0, 1, 2]]);
    assert.equal(e.pmp_mesh_add_vertices(other, 3), 0);
    meshView(e, other).positions.set([0, 0, 0, 0, 1, 0, 1, 0, 0]);
    e.pmp_mesh_add_triangle(other, 0, 1, 2);
    near(normal(e, other, 'face', 0), [0, 0, -1]);
    near(normal(e, mesh, 'face', 0), [0, 0, 1]);
    e.pmp_mesh_destroy(other);
  });
});

test('independent meshes support repeated create, clear, reuse and destroy lifetimes', async () => {
  const e = await instantiate(module);
  for (let iteration = 0; iteration < 24; ++iteration) {
    const a = e.pmp_mesh_create(), b = e.pmp_mesh_create();
    assert.notEqual(a, b);
    vertices(e, a, trianglePoints);
    vertices(e, b, trianglePoints);
    faces(e, a, [[0, 1, 2]]);
    faces(e, b, [[0, 2, 1]]);
    attributeView(e, a, 'user:owner', Property.U32, Domain.VERTEX, true).fill(iteration + 1);
    attributeView(e, b, 'user:owner', Property.U32, Domain.VERTEX, true).fill(iteration + 100);
    near(normal(e, a, 'face', 0), [0, 0, 1]);
    near(normal(e, b, 'face', 0), [0, 0, -1]);
    e.pmp_mesh_destroy(a);
    assert.deepEqual([...attributeView(e, b, 'user:owner', Property.U32)], Array(3).fill(iteration + 100));
    e.pmp_mesh_clear(b);
    topology(meshView(e, b), []);
    assert.equal(attributeView(e, b, 'user:owner', Property.U32), null);
    assert.equal(e.pmp_mesh_add_vertices(b, 3), 0);
    assert(meshView(e, b).positions.every(value => value === 0));
    meshView(e, b).positions.set(trianglePoints);
    assert.equal(e.pmp_mesh_add_triangle(b, 0, 1, 2), 0);
    near(normal(e, b, 'face', 0), [0, 0, 1]);
    e.pmp_mesh_destroy(b);
  }
});

test('JS layout validation rejects malformed metadata before entering Wasm', async () => {
  await withMesh((e, mesh) => {
    for (const [name, type, domain] of [
      ['user:x', -1, 0], ['user:x', 1.5, 0], ['user:x', 11, 0], ['user:x', 0, -1],
      ['user:x', 0, 4], ['user:x', 0, 0.5], ['user:x\0hidden', 0, 0], [null, 0, 0],
    ]) assert.throws(() => attributeView(e, mesh, name, type, domain), TypeError);
    vertices(e, mesh, trianglePoints);
    faces(e, mesh, [[0, 1, 2]]);
    near(normal(e, mesh, 'face', 0), [0, 0, 1]);
  });
});

test('invalid properties trap; each failure discards its own fresh instance', async t => {
  const cases = [
    ['existing custom type mismatch', (e, m) => {
      attributeView(e, m, 'user:x', Property.F32, Domain.VERTEX, true);
      attributeView(e, m, 'user:x', Property.U32);
    }],
    ['public property type mismatch', (e, m) => attributeView(e, m, 'v:normal', Property.F32)],
    ['public property domain mismatch', (e, m) => attributeView(e, m, 'h:tex', Property.VEC2F)],
    ['unprefixed custom name', (e, m) => attributeView(e, m, 'material', Property.U32, Domain.VERTEX, true)],
    ['empty custom suffix', (e, m) => attributeView(e, m, 'user:', Property.U32, Domain.VERTEX, true)],
    ...['v:connectivity', 'h:connectivity', 'f:connectivity', 'v:deleted', 'e:deleted', 'f:deleted',
      'v:garbage-collection'].map(name => [`reserved ${name}`, (e, m) => attributeView(e, m, name, Property.U32)]),
    ['remove required positions', (e, m) => e.pmp_mesh_remove_property(m, Domain.VERTEX, cstring(e, 'v:point'))],
    ['remove reserved core property', (e, m) => e.pmp_mesh_remove_property(m, Domain.VERTEX, cstring(e, 'v:deleted'))],
    ['raw invalid property type', (e, m) => e.pmp_mesh_property(m, Domain.VERTEX, 11, cstring(e, 'user:x'), 1)],
    ['raw invalid property domain', (e, m) => e.pmp_mesh_property(m, 4, Property.U32, cstring(e, 'user:x'), 1)],
    ['raw invalid create flag', (e, m) => e.pmp_mesh_property(m, Domain.VERTEX, Property.U32, cstring(e, 'user:x'), 2)],
  ];
  for (const [name, operation] of cases) await t.test(name, async () => {
    const e = await instantiate(module);
    const mesh = e.pmp_mesh_create();
    vertices(e, mesh, trianglePoints);
    assert.throws(() => operation(e, mesh), WebAssembly.RuntimeError);
    // The trapped instance and its allocations are intentionally abandoned.
  });
});

test('invalid geometry and algorithm arguments trap without reusing the failed instance', async t => {
  const cases = [
    ['null mesh', (e) => e.pmp_mesh_add_vertices(0, 1)],
    ['out-of-range vertex', (e, m) => e.pmp_mesh_add_triangle(m, 0, 1, 3)],
    ['repeated triangle corner', (e, m) => e.pmp_mesh_add_triangle(m, 0, 1, 0)],
    ['nonadjacent repeated polygon corner', (e, m) =>
      e.pmp_mesh_add_face(m, upload(e, Uint32Array, [0, 1, 2, 1]), 4)],
    ['too few polygon corners', (e, m) => e.pmp_mesh_add_face(m, upload(e, Uint32Array, [0, 1]), 2)],
    ['invalid triangle winding', (e, m) => e.pmp_mesh_add_triangles(m, 0, 0, 2, 0)],
    ['nonzero first polygon offset', (e, m) => e.pmp_mesh_add_faces(m,
      upload(e, Uint32Array, [0, 1, 2]), upload(e, Uint32Array, [1, 3]), 1)],
    ['decreasing polygon offsets', (e, m) => e.pmp_mesh_add_faces(m,
      upload(e, Uint32Array, [0, 1, 2]), upload(e, Uint32Array, [0, 3, 2]), 2)],
    ['duplicate oriented face', (e, m) => {
      e.pmp_mesh_add_triangle(m, 0, 1, 2);
      e.pmp_mesh_add_triangle(m, 0, 1, 2);
    }],
    ['invalid face normal index', (e, m) => e.pmp_face_normal(m, 0, e.pmp_alloc(12))],
    ['invalid vertex normal index', (e, m) => e.pmp_vertex_normal(m, 3, e.pmp_alloc(12))],
    ['boundary corner normal', (e, m) => {
      e.pmp_mesh_add_triangle(m, 0, 1, 2);
      const view = meshView(e, m);
      const h = Array.from({ length: view.edges * 2 }, (_, i) => i)
        .find(index => view.halfedges[index * 4] === INVALID);
      e.pmp_corner_normal(m, h, 0, e.pmp_alloc(12));
    }],
    ...[-1, 181, NaN, Infinity].map(angle => [`invalid feature angle ${angle}`,
      (e, m) => e.pmp_detect_features(m, angle)]),
    ['invalid corner angle', (e, m) => {
      e.pmp_mesh_add_triangle(m, 0, 1, 2);
      e.pmp_corner_normal(m, meshView(e, m).faceHalfedges[0], NaN, e.pmp_alloc(12));
    }],
  ];
  for (const [name, operation] of cases) await t.test(name, async () => {
    const e = await instantiate(module);
    const mesh = e.pmp_mesh_create();
    vertices(e, mesh, trianglePoints);
    assert.throws(() => operation(e, mesh), WebAssembly.RuntimeError);
  });
});
