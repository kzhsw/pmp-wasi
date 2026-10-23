// Development measurements, not performance thresholds or a full-library benchmark.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { instantiate, meshView, attributeView, Property, Domain, Winding } from '../src/index.js';

const e = await instantiate(await readFile(new URL('../build/pmp-core.wasm', import.meta.url)));
const n = 128, vertices = (n + 1) ** 2, triangles = 2 * n * n;
const mesh = e.pmp_mesh_create();
e.pmp_mesh_reserve(mesh, vertices, 3 * n * n + 2 * n, triangles);
e.pmp_mesh_add_vertices(mesh, vertices);
const indices = e.pmp_alloc(triangles * 12) >>> 0;
const points = meshView(e, mesh).positions;
const input = new Uint32Array(e.memory.buffer, indices, triangles * 3);
for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x) {
  const v = y * (n + 1) + x;
  points[v * 3] = x; points[v * 3 + 1] = y;
}
for (let y = 0, i = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
  const v = y * (n + 1) + x;
  for (const vertex of [v, v + 1, v + n + 2, v, v + n + 2, v + n + 1]) input[i++] = vertex;
}
const start = performance.now();
e.pmp_mesh_add_triangles(mesh, indices, triangles, Winding.CCW, 0);
const constructionMs = performance.now() - start;
const median = call => {
  for (let i = 0; i < 3; ++i) call();
  const samples = [];
  for (let i = 0; i < 9; ++i) { const t = performance.now(); call(); samples.push(performance.now() - t); }
  return samples.sort((a, b) => a - b)[4];
};
const vertexNormalsMs = median(() => e.pmp_vertex_normals(mesh));
const faceNormalsMs = median(() => e.pmp_face_normals(mesh));
const featuresMs = median(() => e.pmp_detect_features(mesh, 30));
const normals = attributeView(e, mesh, 'f:normal', Property.VEC3F, Domain.FACE);
assert(normals.every((value, i) => value === (i % 3 === 2 ? 1 : 0)));
console.log(JSON.stringify({ node: process.version, vertices, triangles, constructionMs,
  vertexNormalsMs, faceNormalsMs, featuresMs, linearMemoryBytes: e.memory.buffer.byteLength }, null, 2));
e.pmp_free(indices);
e.pmp_mesh_destroy(mesh);
