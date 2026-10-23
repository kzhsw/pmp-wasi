// SPDX-License-Identifier: MIT
import { attributeView, Domain, instantiate, meshView, Property, Winding } from '../../src/index.js';

const INVALID = 0xffffffff;
const triangle = [0, 0, 0, 1, 0, 0, 0, 1, 0];

// Compiled Modules expose imports and exports, but do not expose their start section.
// Callers passing a Module must audit its original bytes before compilation.
function hasStart(source) {
  if (source instanceof WebAssembly.Module) return false;
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : new Uint8Array(source);
  let offset = 8;
  const uint = () => {
    let value = 0, shift = 0, byte;
    do { byte = bytes[offset++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
    return value;
  };
  while (offset < bytes.length) {
    const id = bytes[offset++], length = uint();
    if (id === 8) return true;
    offset += length;
  }
  return false;
}

export async function runScenario(source, nativeFixtures, expectedExports) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  let assertions = 0;
  const cases = [];
  const check = (condition, label) => {
    ++assertions;
    if (!condition) throw new Error(label);
  };
  const equal = (actual, expected, label) => check(JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  const near = (actual, expected, label) => {
    equal(actual.length, expected.length, `${label} length`);
    expected.forEach((value, i) => check(Number.isFinite(actual[i]) &&
      Math.abs(actual[i] - value) <= 2e-6 * Math.max(1, Math.abs(value)), `${label}[${i}]`));
  };
  const run = async (name, body) => cases.push({ name, output: await body() });
  const upload = (e, ArrayType, values) => {
    const pointer = e.pmp_alloc(values.length * ArrayType.BYTES_PER_ELEMENT) >>> 0;
    new ArrayType(e.memory.buffer, pointer, values.length).set(values);
    return pointer;
  };
  const vertices = (e, mesh, positions) => {
    equal(e.pmp_mesh_add_vertices(mesh, positions.length / 3), 0, 'first vertex');
    meshView(e, mesh).positions.set(positions);
  };
  const faces = (e, mesh, polygons) => {
    const offsets = [0];
    for (const face of polygons) offsets.push(offsets[offsets.length - 1] + face.length);
    const indices = upload(e, Uint32Array, polygons.flat()), starts = upload(e, Uint32Array, offsets);
    e.pmp_mesh_add_faces(mesh, indices, starts, polygons.length);
    e.pmp_free(indices);
    e.pmp_free(starts);
  };
  const normal = (e, mesh, kind, index, angle) => {
    const pointer = e.pmp_alloc(12) >>> 0;
    if (kind === 'corner') e.pmp_corner_normal(mesh, index, angle, pointer);
    else e[`pmp_${kind}_normal`](mesh, index, pointer);
    const result = [...new Float32Array(e.memory.buffer, pointer, 3)];
    e.pmp_free(pointer);
    return result;
  };
  const snapshot = view => ({
    counts: [view.vertices, view.edges, view.faces], positions: [...view.positions],
    vertexHalfedges: [...view.vertexHalfedges], halfedges: [...view.halfedges],
    faceHalfedges: [...view.faceHalfedges],
  });
  const topology = (view, polygons) => {
    equal([view.liveVertices, view.liveEdges, view.liveFaces],
      [view.vertices, view.edges, polygons.length], 'live entity counts');
    for (const deleted of [view.deletedVertices, view.deletedEdges, view.deletedFaces])
      check(deleted.every(value => value === 0), 'no deleted entities');
    const edges = new Set(polygons.flatMap(face => face.map((a, i) => {
      const b = face[(i + 1) % face.length];
      return `${Math.min(a, b)},${Math.max(a, b)}`;
    })));
    equal(view.edges, edges.size, 'unique edge count');
    for (let h = 0; h < view.edges * 2; ++h) {
      const [face, vertex, next, previous] = view.halfedges.subarray(h * 4, h * 4 + 4);
      check((face === INVALID || face < view.faces) && vertex < view.vertices &&
        next < view.edges * 2 && previous < view.edges * 2, 'connectivity indices');
      equal(view.halfedges[next * 4 + 3], h, 'next/previous inverse');
      equal(view.halfedges[previous * 4 + 2], h, 'previous/next inverse');
      equal(view.halfedges[(next ^ 1) * 4 + 1], vertex, 'halfedge endpoints meet');
      equal(view.halfedges[next * 4], face, 'cycle stays in its face or boundary');
    }
    polygons.forEach((polygon, f) => {
      const loop = [], first = view.faceHalfedges[f];
      let h = first;
      do {
        check(h < view.edges * 2 && loop.length < view.edges * 2, 'face cycle closes');
        equal(view.halfedges[h * 4], f, 'face owns corner');
        loop.push(view.halfedges[h * 4 + 1]);
        h = view.halfedges[h * 4 + 2];
      } while (h !== first);
      const start = loop.indexOf(polygon[0]);
      check(start >= 0, 'face contains first vertex');
      equal(polygon.map((_, i) => loop[(start + i) % loop.length]), polygon, 'face winding');
      equal(loop.length, polygon.length, 'face corner count');
    });
  };
  // Cleanup follows success only. A trap abandons the entire instance and its allocations.
  const withMesh = async body => {
    const e = await instantiate(module), mesh = e.pmp_mesh_create(), scratch = e.pmp_alloc(52) >>> 0;
    const result = await body(e, mesh, () => meshView(e, mesh, scratch));
    e.pmp_free(scratch);
    e.pmp_mesh_destroy(mesh);
    return result;
  };

  await run('freestanding ABI 0 contract', async () => {
    equal(WebAssembly.Module.imports(module), [], 'no host imports');
    const exports = WebAssembly.Module.exports(module);
    equal(exports.map(entry => entry.name).sort(), [...expectedExports].sort(), 'exact exports');
    for (const entry of exports) equal(entry.kind, entry.name === 'memory' ? 'memory' : 'function', 'export kind');
    check(!exports.some(entry => /init|ctor|dtor|start|wasi/i.test(entry.name)), 'no initialization hooks');
    check(!hasStart(source), 'no start section in supplied bytes');
    const e = await instantiate(module);
    equal(e.pmp_abi_version(), 0, 'development ABI');
    check(e.memory instanceof WebAssembly.Memory, 'native memory export');
    check(typeof SharedArrayBuffer === 'undefined' || !(e.memory.buffer instanceof SharedArrayBuffer), 'unshared memory');
    equal(e.pmp_alloc(0), 0, 'zero allocation');
    const pointer = e.pmp_alloc(17) >>> 0;
    check(pointer > 0 && pointer % 16 === 0, 'aligned owned allocation');
    new Uint8Array(e.memory.buffer, pointer, 17).fill(123);
    check(new Uint8Array(e.memory.buffer, pointer, 17).every(value => value === 123), 'writable allocation');
    e.pmp_free(pointer);
    e.pmp_free(0);
    check(nativeFixtures.length > 0, 'native references supplied');
    return { abi: 0, imports: 0, exports: exports.length };
  });

  for (const fixture of nativeFixtures) await run(`native reference: ${fixture.name}`, () => withMesh((e, mesh, view) => {
    vertices(e, mesh, fixture.positions);
    faces(e, mesh, fixture.faces);
    topology(view(), fixture.faces);
    const result = snapshot(view());
    equal(result.counts, [fixture.positions.length / 3, fixture.edges, fixture.faces.length], 'native counts');
    for (const key of ['positions', 'vertexHalfedges', 'halfedges', 'faceHalfedges'])
      equal(result[key], fixture[key].flat(), `native ${key}`);
    result.vertexNormals = fixture.positions.flatMap((_, i) => i % 3 ? [] : normal(e, mesh, 'vertex', i / 3));
    result.faceNormals = fixture.faces.flatMap((_, i) => normal(e, mesh, 'face', i));
    near(result.vertexNormals, fixture.vertexNormals, 'native vertex normals');
    near(result.faceNormals, fixture.faceNormals, 'native face normals');
    result.cornerNormals = fixture.cornerNormals.map(corner => normal(e, mesh, 'corner', corner.halfedge, corner.angle));
    result.cornerNormals.forEach((values, i) => near(values, fixture.cornerNormals[i].normal, 'native corner normal'));
    e.pmp_vertex_normals(mesh);
    e.pmp_face_normals(mesh);
    near(attributeView(e, mesh, 'v:normal', Property.VEC3F), result.vertexNormals, 'stored vertex normals');
    near(attributeView(e, mesh, 'f:normal', Property.VEC3F, Domain.FACE), result.faceNormals, 'stored face normals');
    result.features30 = e.pmp_detect_features(mesh, 30);
    equal(result.features30, fixture.features30, 'native feature count');
    result.featureEdges = [...attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE)];
    equal(result.featureEdges.reduce((sum, value) => sum + value, 0), fixture.features30, 'feature flags');
    e.pmp_clear_features(mesh);
    result.boundary = e.pmp_detect_boundary(mesh);
    equal(result.boundary, fixture.boundary, 'native boundary count');
    result.boundaryEdges = [...attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE)];
    const current = view();
    equal(result.boundaryEdges, Array.from({ length: current.edges }, (_, i) => Number(
      current.halfedges[i * 8] === INVALID || current.halfedges[i * 8 + 4] === INVALID)), 'boundary flags');
    e.pmp_clear_features(mesh);
    check(attributeView(e, mesh, 'v:feature', Property.BOOL).every(value => value === 0), 'cleared vertex features');
    check(attributeView(e, mesh, 'e:feature', Property.BOOL, Domain.EDGE).every(value => value === 0), 'cleared edge features');
    return result;
  }));

  for (const winding of [Winding.CCW, Winding.CW]) await run(`shared asset: ${winding === Winding.CCW ? 'CCW' : 'CW'}`,
    () => withMesh((e, mesh, view) => {
      const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], polygons = [[0, 1, 2], [0, 2, 3]];
      vertices(e, mesh, positions);
      const sourceCorners = polygons.flatMap(face => winding === Winding.CW ? [...face].reverse() : face);
      const indices = upload(e, Uint32Array, sourceCorners), mapping = upload(e, Uint32Array, Array(6).fill(INVALID));
      e.pmp_mesh_add_triangles(mesh, indices, 2, winding, mapping);
      equal([...new Uint32Array(e.memory.buffer, indices, 6)], sourceCorners, 'caller indices preserved');
      const corners = [...new Uint32Array(e.memory.buffer, mapping, 6)];
      equal(new Set(corners).size, 6, 'distinct corner mappings');
      topology(view(), polygons);
      const channels = [
        ['v:tex', Property.VEC2F, Domain.VERTEX, [0, 0, 1, 0, 1, 1, 0, 1]],
        ['user:uv1', Property.VEC2F, Domain.VERTEX, [0.25, 0.5, 0.5, 0.75, 0.75, 1, 1, 0.25]],
        ['user:color0', Property.RGBA8, Domain.VERTEX, [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 128, 255, 255, 255, 64]],
        ['user:color1', Property.VEC4F, Domain.VERTEX, Array.from({ length: 16 }, (_, i) => i / 16)],
        ['user:joint0', Property.VEC4U32, Domain.VERTEX, Array.from({ length: 16 }, (_, i) => 65536 + i)],
        ['user:joint1', Property.VEC4U16, Domain.VERTEX, Array.from({ length: 16 }, (_, i) => i + 1)],
        ['user:weight0', Property.VEC4F, Domain.VERTEX, Array(4).fill([0.5, 0.25, 0.125, 0]).flat()],
        ['user:weight1', Property.VEC4F, Domain.VERTEX, Array(4).fill([0.125, 0, 0, 0]).flat()],
      ];
      for (const [name, type, domain, values] of channels) {
        const attribute = attributeView(e, mesh, name, type, domain, true);
        check(attribute.buffer === e.memory.buffer && attribute.every(value => value === 0), `${name} native zeroed storage`);
        attribute.set(values);
      }
      for (const [name, type, components] of [['h:tex', Property.VEC2F, 2], ['user:cornerColor', Property.RGBA8, 4]]) {
        const attribute = attributeView(e, mesh, name, type, Domain.HALFEDGE, true), connectivity = view();
        const expected = Array(attribute.length).fill(0);
        corners.forEach((h, i) => {
          equal(connectivity.halfedges[h * 4], Math.floor(i / 3), 'corner face');
          equal(connectivity.halfedges[h * 4 + 1], sourceCorners[i], 'original source corner');
          const values = components === 2 ? [i + 0.125, i + 0.25] : [i, i + 10, i + 20, 255];
          attribute.set(values, h * components);
          expected.splice(h * components, components, ...values);
        });
        channels.push([name, type, Domain.HALFEDGE, expected]);
      }
      const seam = sourceCorners.flatMap((vertex, i) => vertex === 0 ? [i] : []);
      check(corners[seam[0]] !== corners[seam[1]], 'shared vertex has separate seam corners');
      const uv = attributeView(e, mesh, 'h:tex', Property.VEC2F, Domain.HALFEDGE);
      check(uv[corners[seam[0]] * 2] !== uv[corners[seam[1]] * 2], 'UV seam has distinct values');
      const points = attributeView(e, mesh, 'v:point', Property.VEC3F), borrowed = view();
      equal(points.byteOffset, borrowed.positions.byteOffset, 'positions share native storage');
      points[0] = 0.25;
      equal(borrowed.positions[0], 0.25, 'position mutation aliases view');
      borrowed.positions[0] = 0;
      e.pmp_vertex_normals(mesh);
      e.pmp_face_normals(mesh);
      equal(e.pmp_detect_features(mesh, 30), 0, 'flat asset has no crease');
      equal(e.pmp_detect_boundary(mesh), 4, 'asset boundary');
      e.pmp_clear_features(mesh);
      e.pmp_mesh_reserve(mesh, 64, 64, 32);
      e.pmp_mesh_garbage_collection(mesh); // The core currently exposes no deletion operation.
      const retained = {};
      for (const [name, type, domain, values] of channels) {
        retained[name] = [...attributeView(e, mesh, name, type, domain)];
        equal(retained[name], values, `${name} survives algorithms and reserve`);
      }
      topology(view(), polygons);
      const normals = [...attributeView(e, mesh, 'v:normal', Property.VEC3F)];
      near(normals, Array(4).fill([0, 0, 1]).flat(), 'asset normals');
      e.pmp_free(indices);
      e.pmp_free(mapping);
      return { ...snapshot(view()), corners, attributes: retained, normals };
    }));

  await run('allocator growth across meshes', () => withMesh((e, mesh, view) => {
    vertices(e, mesh, triangle);
    faces(e, mesh, [[0, 1, 2]]);
    const other = e.pmp_mesh_create();
    const oldOwner = attributeView(e, mesh, 'user:owner', Property.U32, Domain.VERTEX, true);
    oldOwner.set([11, 22, 33]);
    const old = view(), oldBuffer = e.memory.buffer;
    const positionPointer = old.positions.byteOffset, ownerPointer = oldOwner.byteOffset;
    e.pmp_mesh_reserve(other, Math.floor(oldBuffer.byteLength / 12) + 1, 0, 0);
    equal([oldBuffer.byteLength, old.positions.length, oldOwner.length], [0, 0, 0], 'borrowed views detached');
    const owner = attributeView(e, mesh, 'user:owner', Property.U32), current = view();
    check(current.positions.buffer === e.memory.buffer && owner.buffer === e.memory.buffer, 'reacquired current memory');
    equal([current.positions.byteOffset, owner.byteOffset], [positionPointer, ownerPointer], 'native buffers retained');
    equal([...current.positions], triangle, 'positions retained');
    equal([...owner], [11, 22, 33], 'attributes retained');
    current.positions[8] = 1;
    owner[1] = 99;
    const changedNormal = normal(e, mesh, 'face', 0);
    near(changedNormal, [0, -Math.SQRT1_2, Math.SQRT1_2], 'reacquired positions affect native normal');
    vertices(e, other, triangle);
    equal(e.pmp_mesh_add_triangle(other, 0, 2, 1), 0, 'second mesh face');
    const otherNormal = normal(e, other, 'face', 0);
    near(otherNormal, [0, 0, -1], 'second mesh remains independent');
    const result = { ...snapshot(view()), owner: [...attributeView(e, mesh, 'user:owner', Property.U32)], changedNormal, otherNormal };
    equal(result.owner, [11, 99, 33], 'reacquired attribute writes retained');
    e.pmp_mesh_destroy(other);
    return result;
  }));

  await run('repeated create clear reuse destroy', async () => {
    const e = await instantiate(module), output = [];
    for (let i = 0; i < 12; ++i) {
      const a = e.pmp_mesh_create(), b = e.pmp_mesh_create();
      check(a !== b, 'independent live mesh handles');
      for (const mesh of [a, b]) vertices(e, mesh, triangle);
      e.pmp_mesh_add_triangle(a, 0, 1, 2);
      e.pmp_mesh_add_triangle(b, 0, 2, 1);
      attributeView(e, b, 'user:owner', Property.U32, Domain.VERTEX, true).fill(i + 1);
      near(normal(e, a, 'face', 0), [0, 0, 1], 'first lifetime orientation');
      e.pmp_mesh_destroy(a);
      equal([...attributeView(e, b, 'user:owner', Property.U32)], Array(3).fill(i + 1), 'other mesh survives destruction');
      near(normal(e, b, 'face', 0), [0, 0, -1], 'other mesh orientation');
      e.pmp_mesh_clear(b);
      topology(meshView(e, b), []);
      equal(attributeView(e, b, 'user:owner', Property.U32), null, 'cleared attribute has no storage');
      equal(e.pmp_mesh_add_vertices(b, 3), 0, 'cleared mesh reuses index zero');
      check(meshView(e, b).positions.every(value => value === 0), 'new positions zero initialized');
      meshView(e, b).positions.set(triangle);
      equal(e.pmp_mesh_add_triangle(b, 0, 1, 2), 0, 'reused face index');
      output.push(normal(e, b, 'face', 0));
      near(output[output.length - 1], [0, 0, 1], 'reused mesh normal');
      e.pmp_mesh_destroy(b);
    }
    return { lifetimes: output.length * 2, reusedNormals: output };
  });

  await run('isolated fatal trap and fresh recovery', async () => {
    const failed = await instantiate(module), mesh = failed.pmp_mesh_create();
    vertices(failed, mesh, triangle);
    failed.pmp_mesh_add_triangle(mesh, 0, 1, 2);
    let trapped = false;
    try { failed.pmp_mesh_add_triangle(mesh, 0, 1, 2); }
    catch (error) { check(error instanceof WebAssembly.RuntimeError, 'fatal failure is a Wasm trap'); trapped = true; }
    check(trapped, 'duplicate oriented face traps');
    // Never free, destroy, inspect, or otherwise re-enter failed after this trap.
    const recoveredNormal = await withMesh((e, fresh) => {
      vertices(e, fresh, triangle);
      equal(e.pmp_mesh_add_triangle(fresh, 0, 1, 2), 0, 'fresh instance constructs geometry');
      return normal(e, fresh, 'face', 0);
    });
    near(recoveredNormal, [0, 0, 1], 'fresh instance recovers independently');
    return { trapped, recoveredNormal };
  });
  return { cases, assertions };
}
