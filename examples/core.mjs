// Run after building: node examples/core.mjs. File loading is caller-side only.
import { readFile } from 'node:fs/promises';
import { instantiate, meshView, attributeView, Property, Domain, Winding } from '../src/index.js';

const pmp = await instantiate(await readFile(new URL('../build/pmp-core.wasm', import.meta.url)));
const mesh = pmp.pmp_mesh_create();
pmp.pmp_mesh_reserve(mesh, 3, 3, 1);
pmp.pmp_mesh_add_vertices(mesh, 3);
// A real decoder can write directly into this native buffer.
meshView(pmp, mesh).positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const indices = pmp.pmp_alloc(12) >>> 0;
const corners = pmp.pmp_alloc(12) >>> 0;
new Uint32Array(pmp.memory.buffer, indices, 3).set([2, 1, 0]);
pmp.pmp_mesh_add_triangles(mesh, indices, 1, Winding.CW, corners);

for (const name of ['user:uv0', 'user:uv1']) {
  const uv = attributeView(pmp, mesh, name, Property.VEC2F, Domain.HALFEDGE, true);
  const mapping = new Uint32Array(pmp.memory.buffer, corners, 3);
  // Original CW input corner order. Two faces can have different UVs at a seam.
  const sourceUV = [0, 1, 1, 0, 0, 0];
  for (let i = 0; i < 3; ++i) {
    uv[mapping[i] * 2] = sourceUV[i * 2];
    uv[mapping[i] * 2 + 1] = sourceUV[i * 2 + 1];
  }
}
attributeView(pmp, mesh, 'user:colors', Property.RGBA8, Domain.VERTEX, true).fill(255);
attributeView(pmp, mesh, 'user:matricesIndices', Property.VEC4U16, Domain.VERTEX, true).fill(0);
const weights = attributeView(pmp, mesh, 'user:matricesWeights', Property.VEC4F, Domain.VERTEX, true);
for (let v = 0; v < 3; ++v) weights[v * 4] = 1;
pmp.pmp_vertex_normals(mesh);
console.log(attributeView(pmp, mesh, 'v:normal', Property.VEC3F));

// After a trap, discard the instance; do not call native cleanup from finally.
pmp.pmp_free(indices);
pmp.pmp_free(corners);
pmp.pmp_mesh_destroy(mesh);
