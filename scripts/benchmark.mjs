// Shared Node/browser benchmark: repeated, alternating timings exclude setup.
import { meshView } from '../src/index.js';
const assert = condition => { if (!condition) throw new Error('Invalid benchmark mesh'); };
export function runBenchmark(variants, fixtures, { warmup = 5, rounds = 15 } = {}) {
  const n = 40, positions = [], indices = [], quads = [];
  for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x)
    positions.push(0.6 * x, 0.55 * y, 0.15 * Math.sin(x * 0.4) * Math.sin(y * 0.35));
  for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
    const a = y * (n + 1) + x;
    indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
    quads.push(a, a + 1, a + n + 2, a + n + 1);
  }
  const grid = { positions, indices };
  const polygonGrid = { positions, indices: quads, corners: 4 };
  const hole = fixtures.find(fixture => fixture.name === 'hole-annulus-refine-fair');
  const cases = [
    ['construction', null, [], grid],
    ['vertex-normals', 'pmp_vertex_normals', [], grid],
    ['face-normals', 'pmp_face_normals', [], grid],
    ['features', 'pmp_detect_features', [30], grid],
    ['decimation', 'pmp_decimate', [900, 0, 0, 0, 0, 0, 0.01, 1], grid],
    ['uniform-remesh', 'pmp_uniform_remeshing', [0.45, 2, 1], grid],
    ['adaptive-remesh', 'pmp_adaptive_remeshing', [0.28, 0.8, 0.025, 2, 1], grid],
    ['catmull-clark', 'pmp_catmull_clark_subdivision', [0], grid],
    ['loop', 'pmp_loop_subdivision', [0], grid],
    ['quad-tri', 'pmp_quad_tri_subdivision', [0], grid],
    ['linear', 'pmp_linear_subdivision', [], grid],
    ['explicit-smoothing', 'pmp_explicit_smoothing', [3, 0], grid],
    ['implicit-smoothing', 'pmp_implicit_smoothing', [0.03, 2, 0, 1], grid],
    ['hole-refine-fair', 'pmp_fill_hole', hole.args,
      { positions: hole.input.positions, indices: hole.input.faces.flat() }],
    ['triangulate-quads', 'pmp_triangulate', [], polygonGrid],
    ['components', 'pmp_connected_components', [], grid],
    ['surface-area', 'pmp_surface_area', [], grid],
    ['curvature-laplace', 'pmp_curvature', [2, 1, 0, 0], grid],
    ['curvature-tensor', 'pmp_curvature', [4, 1, 1, 1], grid],
    ['minimize-area', 'pmp_minimize_area', [], grid],
    ['minimize-curvature', 'pmp_minimize_curvature', [], grid],
  ];
  for (const [name, operation, args, input] of cases) {
    for (let round = -warmup; round < rounds; ++round) {
      // Reverse order every round to reduce systematic tiering/thermal bias.
      for (const variant of (round % 2 ? [...variants].reverse() : variants)) {
        const e = variant.exports, mesh = e.pmp_mesh_create();
        const count = input.positions.length / 3, corners = input.corners || 3;
        const faces = input.indices.length / corners;
        e.pmp_mesh_reserve(mesh, count, faces * corners, faces);
        e.pmp_mesh_add_vertices(mesh, count);
        const pointer = e.pmp_alloc(input.indices.length * 4) >>> 0;
        new Uint32Array(e.memory.buffer, pointer, input.indices.length).set(input.indices);
        const offsets = corners === 3 ? 0 : e.pmp_alloc((faces + 1) * 4) >>> 0;
        if (offsets) {
          const values = new Uint32Array(e.memory.buffer, offsets, faces + 1);
          for (let i = 0; i <= faces; ++i) values[i] = i * corners;
        }
        meshView(e, mesh).positions.set(input.positions);
        const construct = () => offsets ? e.pmp_mesh_add_faces(mesh, pointer, offsets, faces) :
          e.pmp_mesh_add_triangles(mesh, pointer, faces, 0, 0);
        let elapsed;
        if (operation) {
          construct();
          const start = performance.now();
          e[operation](mesh, ...args);
          elapsed = performance.now() - start;
        } else {
          const start = performance.now();
          construct();
          elapsed = performance.now() - start;
        }
        const view = meshView(e, mesh);
        assert(view.liveFaces > 0 && view.positions.every(Number.isFinite));
        if (round >= 0) {
          if (!variant.samples.has(name)) variant.samples.set(name, []);
          variant.samples.get(name).push(elapsed);
        }
        e.pmp_free(pointer);
        e.pmp_free(offsets);
        e.pmp_mesh_destroy(mesh);
      }
    }
  }
  const results = variants.map(variant => ({ path: variant.path,
    finalMemoryBytes: variant.exports.memory.buffer.byteLength,
    milliseconds: Object.fromEntries([...variant.samples].map(([name, values]) => {
      values.sort((a, b) => a - b);
      return [name, { median: values[rounds >> 1], min: values[0], max: values[values.length - 1] }];
    })) }));
  return { gridVertices: positions.length / 3, gridTriangles: indices.length / 3, warmup, rounds,
    note: 'Algorithm time excludes setup. Hole uses the small native fixture. Memory is final high-water capacity, not process memory.',
    results };
}
