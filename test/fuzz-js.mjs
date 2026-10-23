// SPDX-License-Identifier: MIT
// Browser-compatible, bounded, deterministic property testing of the public wrapper.
import { attributeView, Domain, instantiate, meshView, Property, Winding } from '../src/index.js';

const INVALID = 0xffffffff;
const layouts = [[Uint8Array, 1], [Int32Array, 1], [Uint32Array, 1], [Float32Array, 1],
  [Float64Array, 1], [Float32Array, 2], [Float32Array, 3], [Float32Array, 4],
  [Uint32Array, 4], [Uint16Array, 4], [Uint8Array, 4]];
const families = ['decimate', 'uniform_remeshing', 'adaptive_remeshing', 'catmull_clark_subdivision',
  'loop_subdivision', 'quad_tri_subdivision', 'linear_subdivision', 'explicit_smoothing',
  'implicit_smoothing', 'fill_hole', 'triangulate', 'curvature', 'fair', 'connected_components'];

export async function runFuzz(source, { seed = 1, seeds = 16 } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > INVALID || !Number.isInteger(seeds) || seeds < 1 || seeds > 256)
    throw new RangeError('Fuzz seed must be u32 and seeds must be between 1 and 256');
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  let assertions = 0, stage = 'setup', currentSeed = seed;
  const check = (condition, message) => {
    ++assertions;
    if (!condition) throw new Error(`seed=${currentSeed} stage=${stage}: ${message}`);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
  const near = (actual, expected, message, tolerance = 4e-5) => check(Number.isFinite(actual) &&
    Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${message}: ${actual} != ${expected}`);
  const upload = (e, values, Type = Uint32Array) => {
    const pointer = e.pmp_alloc(values.length * Type.BYTES_PER_ELEMENT) >>> 0;
    new Type(e.memory.buffer, pointer, values.length).set(values);
    return pointer;
  };
  const remove = (e, mesh, name, domain) => {
    const pointer = upload(e, [...new TextEncoder().encode(name), 0], Uint8Array);
    check(e.pmp_mesh_remove_property(mesh, domain, pointer) === 1, `remove ${name}`);
    e.pmp_free(pointer);
  };
  const construct = (e, mesh, positions, polygons, winding = Winding.CCW) => {
    equal(e.pmp_mesh_add_vertices(mesh, positions.length / 3), 0, 'construction begins at vertex zero');
    meshView(e, mesh).positions.set(positions);
    const faces = polygons.map(face => winding === Winding.CW ? [...face].reverse() : face), offsets = [0];
    for (const face of faces) offsets.push(offsets[offsets.length - 1] + face.length);
    const source = faces.flat(), indices = upload(e, source), starts = upload(e, offsets);
    const mapping = upload(e, Array(source.length).fill(INVALID));
    e.pmp_mesh_add_faces_winding(mesh, indices, starts, faces.length, winding, mapping);
    equal([...new Uint32Array(e.memory.buffer, indices, source.length)], source, 'input corners unchanged');
    const mapped = [...new Uint32Array(e.memory.buffer, mapping, source.length)], view = meshView(e, mesh);
    equal(new Set(mapped).size, source.length, 'source corners map independently');
    mapped.forEach((h, i) => {
      equal(view.halfedges[h * 4 + 1], source[i], 'mapped original source vertex');
      check(h < view.edges * 2, 'mapped halfedge in range');
    });
    for (const pointer of [indices, starts, mapping]) e.pmp_free(pointer);
  };
  const inspect = (e, mesh, euler = 1) => {
    const v = meshView(e, mesh), { vertices: V, edges: E, faces: F, halfedges: H } = v;
    equal([v.liveVertices, v.liveEdges, v.liveFaces], [V, E, F], 'compact native sizes');
    equal(V - E + F, euler, 'Euler characteristic');
    for (const deleted of [v.deletedVertices, v.deletedEdges, v.deletedFaces])
      check(deleted.every(value => value === 0), 'no deleted slots');
    for (const value of v.positions) check(Number.isFinite(value), 'finite coordinate');
    let boundary = 0;
    for (let h = 0; h < E * 2; ++h) {
      const [face, vertex, next, previous] = H.subarray(h * 4, h * 4 + 4);
      check((face === INVALID || face < F) && vertex < V && next < E * 2 && previous < E * 2, 'valid connectivity');
      equal(H[next * 4 + 3], h, 'next/previous inverse');
      equal(H[previous * 4 + 2], h, 'previous/next inverse');
      equal(H[(next ^ 1) * 4 + 1], vertex, 'successive endpoints meet');
      equal(H[next * 4], face, 'face or boundary cycle');
      if (face === INVALID) ++boundary;
    }
    const polygons = [], owned = new Set();
    for (let face = 0; face < F; ++face) {
      const first = v.faceHalfedges[face], polygon = [];
      let h = first;
      do {
        check(h < E * 2 && polygon.length < E * 2 && !owned.has(h), 'bounded disjoint face cycle');
        equal(H[h * 4], face, 'corner owner');
        owned.add(h);
        polygon.push(H[h * 4 + 1]);
        h = H[h * 4 + 2];
      } while (h !== first);
      check(polygon.length >= 3 && new Set(polygon).size === polygon.length, 'simple polygon');
      polygons.push(polygon);
    }
    equal(owned.size + boundary, E * 2, 'all halfedges belong to a face or boundary');
    for (let vertex = 0; vertex < V; ++vertex) {
      const h = v.vertexHalfedges[vertex];
      check(h === INVALID || (h < E * 2 && H[(h ^ 1) * 4 + 1] === vertex), 'outgoing vertex halfedge');
    }
    return { counts: [V, E, F], positions: [...v.positions], faces: polygons, boundary };
  };
  const out = (e, mesh, operation, length) => {
    const pointer = e.pmp_alloc(length * 4) >>> 0;
    e[operation](mesh, pointer);
    const values = [...new Float32Array(e.memory.buffer, pointer, length)];
    e.pmp_free(pointer);
    return values;
  };
  const measurements = (e, mesh) => {
    const before = inspect(e, mesh), bounds = out(e, mesh, 'pmp_bounds', 6);
    for (let axis = 0; axis < 3; ++axis) {
      const values = before.positions.filter((_, i) => i % 3 === axis);
      equal(bounds[axis], Math.min(...values), 'minimum bound');
      equal(bounds[axis + 3], Math.max(...values), 'maximum bound');
    }
    const area = e.pmp_surface_area(mesh), centroid = out(e, mesh, 'pmp_centroid', 3);
    const minimum = e.pmp_min_edge_length(mesh), mean = e.pmp_mean_edge_length(mesh);
    check(area > 0 && Number.isFinite(area) && minimum > 0 && mean >= minimum, 'positive surface measures');
    check(e.pmp_min_face_area(mesh) > 0, 'positive minimum face area');
    for (let axis = 0; axis < 3; ++axis)
      check(centroid[axis] >= bounds[axis] - 1e-5 && centroid[axis] <= bounds[axis + 3] + 1e-5, 'centroid inside bounds');
    const factor = 1.25, translation = [0.5, -0.25, 0.75];
    meshView(e, mesh).positions.set(before.positions.map((value, i) => factor * value + translation[i % 3]));
    near(e.pmp_surface_area(mesh), area * factor ** 2, 'area scales quadratically');
    near(e.pmp_mean_edge_length(mesh), mean * factor, 'edge length scales linearly');
    const moved = out(e, mesh, 'pmp_centroid', 3);
    moved.forEach((value, axis) => near(value, centroid[axis] * factor + translation[axis], 'centroid affine covariance'));
    meshView(e, mesh).positions.set(before.positions);
    return area;
  };
  const results = [];
  try {
    for (let iteration = 0; iteration < seeds; ++iteration) {
      currentSeed = (seed + iteration) >>> 0;
      let state = currentSeed || 0x6d2b79f5;
      const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
      const unit = () => random() / 2 ** 32;
      const n = 5 + random() % 2, scale = 0.8 + unit() * 0.4, offset = [unit() * 2, -unit(), unit()];
      const positions = [], faces = [], quads = Boolean(random() & 1);
      for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x)
        positions.push(Math.fround(scale * (x + 0.025 * unit()) + offset[0]),
          Math.fround(scale * (y + 0.025 * unit()) + offset[1]),
          Math.fround(scale * 0.018 * x * (n - 1 - x) * y * (n - 1 - y) + offset[2]));
      for (let y = 0; y + 1 < n; ++y) for (let x = 0; x + 1 < n; ++x) {
        const a = y * n + x, b = a + 1, c = a + n + 1, d = a + n;
        if (quads) faces.push([a, b, c, d]);
        else if (random() & 1) faces.push([a, b, c], [a, c, d]);
        else faces.push([a, b, d], [b, c, d]);
      }
      stage = 'construct';
      const e = await instantiate(module), mesh = e.pmp_mesh_create();
      construct(e, mesh, positions, faces, random() & 1);
      inspect(e, mesh);
      e.pmp_triangulate(mesh);
      equal(inspect(e, mesh).counts[2], 2 * (n - 1) ** 2, 'grid triangulation count');
      stage = 'measurements';
      measurements(e, mesh);
      stage = 'attributes';
      const channels = layouts.map(([Type, components], type) => {
        const domain = random() % 4, name = `user:颜色🎨:${type}`;
        const values = attributeView(e, mesh, name, type, domain, true);
        check(values instanceof Type && values.buffer === e.memory.buffer, 'typed native property storage');
        check(values.every(value => value === 0), 'property starts zeroed');
        for (let i = 0; i < values.length; ++i)
          values[i] = type === Property.BOOL ? random() & 1 : Type === Float64Array ? (unit() - 0.5) * 1e20 :
            Type === Float32Array ? (random() % 257 - 128) / 16 : random();
        return { name, type, domain, components, saved: [...values] };
      });
      e.pmp_mesh_reserve(mesh, n * n * 3, n * n * 8, n * n * 4);
      e.pmp_mesh_garbage_collection(mesh);
      e.pmp_vertex_normals(mesh);
      e.pmp_face_normals(mesh);
      check(e.pmp_detect_boundary(mesh) === 4 * (n - 1), 'native boundary count');
      e.pmp_clear_features(mesh);
      e.pmp_explicit_smoothing(mesh, 1 + random() % 2, random() & 1);
      for (const { name, type, domain, saved } of channels)
        equal([...attributeView(e, mesh, name, type, domain)], saved, `${name} retained through reserve and smoothing`);
      stage = 'zero-copy memory growth';
      const other = e.pmp_mesh_create(), old = meshView(e, mesh), oldBuffer = e.memory.buffer;
      const savedPositions = [...old.positions], pointer = old.positions.byteOffset;
      e.pmp_mesh_reserve(other, Math.floor(oldBuffer.byteLength / 12) + 1, 0, 0);
      equal([oldBuffer.byteLength, old.positions.length], [0, 0], 'allocator growth detaches borrowed views');
      const reacquired = meshView(e, mesh);
      equal(reacquired.positions.byteOffset, pointer, 'native position allocation survives other mesh growth');
      equal([...reacquired.positions], savedPositions, 'reacquired positions preserved');
      const pointAlias = attributeView(e, mesh, 'v:point', Property.VEC3F), view = meshView(e, mesh);
      equal(pointAlias.byteOffset, view.positions.byteOffset, 'position and attribute views alias');
      pointAlias[0] += 0.125;
      equal(view.positions[0], pointAlias[0], 'direct native alias writes');
      view.positions[0] = savedPositions[0];
      e.pmp_mesh_destroy(other);
      for (const { name, type, domain, saved } of channels) {
        equal([...attributeView(e, mesh, name, type, domain)], saved, 'property survives global memory growth');
        remove(e, mesh, name, domain);
      }
      remove(e, mesh, 'v:feature', Domain.VERTEX);
      remove(e, mesh, 'e:feature', Domain.EDGE);
      stage = families[currentSeed % families.length];
      const before = inspect(e, mesh), family = currentSeed % families.length;
      if (family === 0) e.pmp_decimate(mesh, Math.floor(n * n * 0.7), 0, 0, 0, 0, 0, 0.01, 1);
      else if (family === 1) e.pmp_uniform_remeshing(mesh, scale * 0.65, 1, random() & 1);
      else if (family === 2) e.pmp_adaptive_remeshing(mesh, scale * 0.55, scale * 1.1, scale * 0.05, 1, random() & 1);
      else if (family >= 3 && family <= 6) e[`pmp_${families[family]}`](mesh, random() & 1);
      else if (family === 7) e.pmp_explicit_smoothing(mesh, 2, random() & 1);
      else if (family === 8) e.pmp_implicit_smoothing(mesh, 0.03, 2, random() & 1, 0);
      else if (family === 9) {
        e.pmp_mesh_clear(mesh);
        construct(e, mesh, [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1].map(value => value * scale),
          [[0, 2, 1], [0, 1, 3], [0, 3, 2]]);
        const open = meshView(e, mesh), h = Array.from({ length: open.edges * 2 }, (_, i) => i)
          .find(i => open.halfedges[i * 4] === INVALID);
        e.pmp_fill_hole(mesh, h);
        const closed = inspect(e, mesh, 2);
        equal(closed.counts, [4, 6, 4], 'hole closes tetrahedron');
        near(Math.abs(e.pmp_volume(mesh)), 8 / 3 * scale ** 3, 'closed tetrahedron volume');
      } else if (family === 10) {
        e.pmp_mesh_clear(mesh);
        const count = 5 + random() % 5, polygon = Array.from({ length: count }, (_, i) => i);
        const points = polygon.flatMap(i => [Math.cos(i * 2 * Math.PI / count), Math.sin(i * 2 * Math.PI / count), 0]);
        construct(e, mesh, points, [polygon], random() & 1);
        attributeView(e, mesh, 'user:material', Property.U32, Domain.FACE, true)[0] = currentSeed;
        e.pmp_triangulate_face(mesh, 0);
        equal(inspect(e, mesh).counts, [count, 2 * count - 3, count - 2], 'polygon triangulation counts');
        check(attributeView(e, mesh, 'user:material', Property.U32, Domain.FACE).every(value => value === currentSeed), 'face rows transferred');
        const triangles = inspect(e, mesh);
        e.pmp_triangulate(mesh);
        equal(inspect(e, mesh), triangles, 'triangulation is idempotent');
      } else if (family === 11) {
        e.pmp_curvature(mesh, random() % 5, random() % 2, random() & 1, random() & 1);
        check(attributeView(e, mesh, 'v:curv', Property.F32).every(Number.isFinite), 'finite curvature field');
        equal(inspect(e, mesh), before, 'curvature preserves geometry');
      } else if (family === 12) {
        e.pmp_fair(mesh, 1 + random() % 2);
        e.pmp_minimize_area(mesh);
        e.pmp_minimize_curvature(mesh);
        equal(inspect(e, mesh).faces, before.faces, 'fairing preserves indexed topology');
      } else {
        e.pmp_mesh_add_vertices(mesh, 3);
        equal(e.pmp_connected_components(mesh), 4, 'grid plus three isolated components');
        const labels = [...attributeView(e, mesh, 'v:component', Property.I32)];
        equal(new Set(labels).size, 4, 'one component label per connected component');
        equal(e.pmp_connected_components(mesh), 4, 'component count is idempotent');
        equal([...attributeView(e, mesh, 'v:component', Property.I32)], labels, 'component labels are deterministic');
      }
      const final = inspect(e, mesh, family === 9 ? 2 : family === 13 ? 4 : 1);
      if (family === 0) check(final.counts[0] < before.counts[0], 'decimation removes vertices');
      if (family >= 3 && family <= 6) check(final.counts[0] > before.counts[0] && final.counts[2] > before.counts[2], 'subdivision refines topology');
      if (family === 7 || family === 8) equal(final.faces, before.faces, 'smoothing preserves topology');
      e.pmp_mesh_clear(mesh);
      equal(meshView(e, mesh).vertices, 0, 'clear removes mesh storage');
      construct(e, mesh, [0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]]);
      inspect(e, mesh);
      e.pmp_mesh_destroy(mesh);
      stage = 'wrapper validation before Wasm';
      const invalidMetadata = [
        ['user:x', -1, 0, false], ['user:x', 11 + random() % 50, 0, false], ['user:x', NaN, 0, false],
        ['user:x', 1.5, 0, false], ['user:x', 1, -1, false], ['user:x', 1, 4 + random() % 10, false],
        ['user:x', 1, 0.5, false], ['user:x\0hidden', 1, 0, false], [null, 1, 0, false], ['user:x', 1, 0, 1],
      ];
      for (const args of invalidMetadata) {
        let accesses = 0, caught;
        const untouched = new Proxy({}, { get() { ++accesses; throw new Error('entered Wasm'); } });
        try { attributeView(untouched, 0, ...args); } catch (error) { caught = error; }
        check(caught instanceof TypeError && accesses === 0, 'malformed wrapper metadata rejected before Wasm');
      }
      stage = 'isolated invalid raw calls';
      const invalid = [
        e => e.pmp_mesh_add_vertices(0, 1),
        (e, m) => e.pmp_mesh_add_triangle(m, 0, 1, 3 + random() % 100),
        (e, m) => e.pmp_mesh_add_triangle(m, 0, 1, 0),
        (e, m) => e.pmp_mesh_add_triangles(m, 0, 0, 2 + random() % 100, 0),
        (e, m) => e.pmp_uniform_remeshing(m, 0, 1, 0),
        (e, m) => e.pmp_curvature(m, 5 + random() % 100, 0, 0, 0),
        (e, m) => e.pmp_fair(m, 0),
        (e, m) => e.pmp_triangulate_face(m, INVALID),
        (e, m) => e.pmp_bounds(m, 0),
        (e, m) => e.pmp_mesh_unsupported_properties(m, 14 + random() % 100),
      ];
      for (let i = 0; i < 3; ++i) {
        const failed = await instantiate(module), fresh = failed.pmp_mesh_create();
        construct(failed, fresh, [0, 0, 0, 1, 0, 0, 0, 1, 0], [[0, 1, 2]]);
        let caught;
        try { invalid[(currentSeed + i * 3) % invalid.length](failed, fresh); } catch (error) { caught = error; }
        check(caught instanceof WebAssembly.RuntimeError, 'invalid raw call traps');
        // No cleanup or exported call follows the trap on this fresh instance.
      }
      results.push({ seed: currentSeed, family: families[family], counts: final.counts,
        boundary: final.boundary, coordinateSum: final.positions.reduce((sum, value) => sum + value, 0) });
    }
  } catch (error) {
    const failure = new Error(`JS fuzz failed: seed=${currentSeed} stage=${stage}: ${error.message}`);
    failure.cause = error;
    failure.seed = currentSeed;
    failure.stage = stage;
    throw failure;
  }
  return { seed, seeds, assertions, results };
}
