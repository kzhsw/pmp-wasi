// Copied into an isolated consumer before execution; imports must resolve there.
import { attributeView, instantiate, meshView, Property } from 'pmp-wasi';

function checks() {
  let assertions = 0;
  const check = (condition, message) => {
    ++assertions;
    if (!condition) throw new Error(message);
  };
  return { check, count: () => assertions };
}

export async function runCore(source) {
  const { check, count } = checks(), e = await instantiate(source);
  check(e.pmp_abi_version() === 1, 'installed binary exposes ABI 1');
  const scratch = e.pmp_alloc(64) >>> 0, mesh = e.pmp_mesh_create();
  let healthy = true;
  try {
    check(e.pmp_mesh_add_vertices(mesh, 3) === 0, 'bulk vertices start at zero');
    let view = meshView(e, mesh, scratch);
    check(view.positions.buffer === e.memory.buffer, 'positions alias Wasm memory');
    view.positions.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const alias = new Float32Array(e.memory.buffer, view.positions.byteOffset, 9);
    alias[0] = 0.25;
    check(meshView(e, mesh, scratch).positions[0] === 0.25, 'native view sees an aliased write');
    alias[0] = 0;
    check(e.pmp_mesh_add_triangle(mesh, 0, 1, 2) === 0, 'first triangle is accepted');
    check(Math.abs(e.pmp_surface_area(mesh) - 0.5) < 1e-6, 'native geometry reads written positions');
    e.pmp_vertex_normals(mesh);
    const normals = attributeView(e, mesh, 'v:normal', Property.VEC3F);
    check(normals?.buffer === e.memory.buffer, 'stored normal rows alias Wasm memory');
    check(normals.length === 9 && normals.every((v, i) => Math.abs(v - (i % 3 === 2 ? 1 : 0)) < 1e-6),
      'native vertex normals point upward');
    e.pmp_vertex_normal(mesh, 0, scratch);
    check(new Float32Array(e.memory.buffer, scratch, 3).every((v, i) => Math.abs(v - (i === 2 ? 1 : 0)) < 1e-6),
      'standalone normal output uses caller storage');
    e.pmp_linear_subdivision(mesh);
    view = meshView(e, mesh, scratch);
    check(view.liveVertices === 6 && view.liveFaces === 4, 'linear subdivision creates four triangles');
    check(view.positions.buffer === e.memory.buffer && view.positions.every(Number.isFinite),
      'subdivision result remains a finite aliased view');
    return { assertions: count(), abi: e.pmp_abi_version(), vertices: view.liveVertices,
      faces: view.liveFaces, positions: Array.from(view.positions) };
  } catch (error) {
    healthy = !(error instanceof WebAssembly.RuntimeError);
    throw error;
  } finally {
    if (healthy) { e.pmp_mesh_destroy(mesh); e.pmp_free(scratch); }
  }
}

function fixture(Document, hole = false) {
  const document = new Document(), buffer = document.createBuffer('geometry');
  const accessor = (type, array, normalized = false) => document.createAccessor('', buffer)
    .setType(type).setArray(array).setNormalized(normalized);
  const positions = [], indices = [], n = 5;
  if (hole) {
    positions.push(1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1);
    indices.push(0, 2, 1, 0, 1, 3, 0, 3, 2);
  } else {
    for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x)
      positions.push(x / n, y / n, x * (n - x) * y * (n - y) / (n ** 4));
    for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
      const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
      indices.push(a, b, c, a, c, d);
    }
  }
  const uv = [], uv1 = [], color = [], custom = [], morph = [], normals = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1];
    uv.push(x, y); uv1.push(2 * x + 0.1, 3 * y - 0.2);
    color.push((i * 7) % 256, (i * 13) % 256, (i * 19) % 256, 255);
    custom.push(x + 2 * y); morph.push(0, 0, 0.01 + 0.005 * x); normals.push(0, 0, 1);
  }
  const material = document.createMaterial('material').setExtras({ retained: true });
  const primitive = document.createPrimitive().setMaterial(material).setExtras({ retained: true })
    .setIndices(accessor('SCALAR', new Uint16Array(indices)))
    .setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)))
    .setAttribute('NORMAL', accessor('VEC3', new Float32Array(normals)))
    .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array(uv)))
    .setAttribute('TEXCOORD_1', accessor('VEC2', new Float32Array(uv1)))
    .setAttribute('COLOR_0', accessor('VEC4', new Uint8Array(color), true))
    .setAttribute('_CUSTOM', accessor('SCALAR', new Float32Array(custom)))
    .addTarget(document.createPrimitiveTarget('shape').setAttribute('POSITION', accessor('VEC3', new Float32Array(morph))));
  const mesh = document.createMesh('mesh').addPrimitive(primitive).setWeights([0.25]);
  const node = document.createNode('node').setMesh(mesh).setWeights([0.5]);
  document.getRoot().setDefaultScene(document.createScene('scene').addChild(node));
  return { document, primitive, mesh, node, material };
}

function hash(array) {
  let value = 2166136261;
  for (const byte of new Uint8Array(array.buffer, array.byteOffset, array.byteLength)) {
    value ^= byte; value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

export async function runAdapter(source, Document, adapter) {
  const { check, count } = checks(), cases = [];
  const variants = [
    ['decimate', { ratio: 0.7 }],
    ['remesh', { method: 'uniform', edgeLength: 0.24, iterations: 1, projection: true }],
    ['subdivide', { method: 'loop', iterations: 1 }],
    ['smooth', { method: 'explicit', iterations: 2 }],
    ['fillHoles', { maxEdges: 3, maxHoles: 1 }],
    ['recomputeNormals', {}],
  ];
  for (const [operation, options] of variants) {
    const f = fixture(Document, operation === 'fillHoles'), reports = [];
    const original = f.primitive.getAttribute('POSITION').getCount();
    const beforePositions = hash(f.primitive.getAttribute('POSITION').getArray());
    await f.document.transform(adapter[operation](await instantiate(source), {
      ...options, onReport: report => reports.push(report),
    }));
    check(reports.length === 1 && reports[0].status === 'processed', `${operation}: one processed report`);
    check(f.primitive.getMaterial() === f.material && f.node.getMesh() === f.mesh,
      `${operation}: existing scene and material objects are retained`);
    check(f.primitive.getExtras().retained && f.material.getExtras().retained &&
      f.mesh.getWeights()[0] === 0.25 && f.node.getWeights()[0] === 0.5,
    `${operation}: metadata and morph weights are retained`);
    const position = f.primitive.getAttribute('POSITION'), vertices = position.getCount();
    const indices = f.primitive.getIndices().getArray();
    check(f.primitive.getMode() === 4 && indices.length % 3 === 0 &&
      indices.every(i => i < vertices), `${operation}: indexed triangles reference valid rows`);
    const semantics = ['POSITION', 'NORMAL', 'TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', '_CUSTOM'];
    for (const semantic of semantics) {
      const attribute = f.primitive.getAttribute(semantic);
      check(attribute !== null && attribute.getCount() === vertices && attribute.getArray().every(Number.isFinite),
        `${operation}: ${semantic} has finite matching rows`);
    }
    const uv = f.primitive.getAttribute('TEXCOORD_0').getArray();
    const uv1 = f.primitive.getAttribute('TEXCOORD_1').getArray();
    const custom = f.primitive.getAttribute('_CUSTOM').getArray();
    const colors = f.primitive.getAttribute('COLOR_0');
    const morph = f.primitive.listTargets()[0]?.getAttribute('POSITION');
    const normals = f.primitive.getAttribute('NORMAL').getArray();
    check(colors.getNormalized() && colors.getArray() instanceof Uint8Array, `${operation}: color encoding is retained`);
    check(morph?.getCount() === vertices && morph.getArray().every(Number.isFinite), `${operation}: morph deltas are retained`);
    for (let row = 0; row < vertices; ++row) {
      check(Math.abs(uv1[row * 2] - (2 * uv[row * 2] + 0.1)) < 2e-6 &&
        Math.abs(uv1[row * 2 + 1] - (3 * uv[row * 2 + 1] - 0.2)) < 2e-6 &&
        Math.abs(custom[row] - (uv[row * 2] + 2 * uv[row * 2 + 1])) < 2e-6,
      `${operation}: projected attributes share a consistent correspondence`);
      check(Math.abs(morph.getArray()[row * 3 + 2] - (0.01 + 0.005 * uv[row * 2])) < 1e-8,
        `${operation}: morph and UV transfer correspond`);
      check(Math.abs(Math.hypot(...normals.subarray(row * 3, row * 3 + 3)) - 1) < 3e-5,
        `${operation}: recomputed normals have unit length`);
    }
    if (operation === 'decimate') check(vertices < original, 'decimation removes vertices');
    if (operation === 'subdivide') check(vertices > original, 'Loop subdivision adds vertices');
    if (operation === 'smooth') check(hash(position.getArray()) !== beforePositions, 'smoothing changes curved positions');
    if (operation === 'fillHoles') check(indices.length === 12, 'hole filling closes the tetrahedron');
    cases.push({ operation, vertices, triangles: indices.length / 3, indicesHash: hash(indices),
      attributes: semantics.map(name => { const a = f.primitive.getAttribute(name);
        return { name, type: a.getArray().constructor.name, hash: hash(a.getArray()) }; }),
      morphHash: hash(morph.getArray()) });
  }
  return { assertions: count(), cases };
}
