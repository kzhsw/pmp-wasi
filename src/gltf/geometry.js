// SPDX-License-Identifier: MIT
// Owned-copy bridge for the optional glTF adapter. No document dependencies.
const INVALID = 0xffffffff;
const MAX_ROWS = Math.floor(0x7fffffff / 24);
const poisoned = new WeakSet();
const encoder = new TextEncoder();
const operations = new Set(['decimate', 'remesh', 'subdivide', 'smooth', 'fillHoles', 'fair', 'normals', 'analyze']);
const common = ['winding', 'splitVertices', 'selectedVertices', 'featureAngle', 'preserveBoundary', 'computeNormals', 'maxVertices'];
const parameters = {
  decimate: ['targetVertices', 'aspectRatio', 'edgeLength', 'maxValence', 'normalDeviation', 'hausdorffError', 'seamThreshold', 'seamAngleDeviation', 'texcoords'],
  remesh: ['method', 'edgeLength', 'minEdgeLength', 'maxEdgeLength', 'approxError', 'iterations', 'projection'],
  subdivide: ['method', 'iterations', 'boundary'],
  smooth: ['method', 'iterations', 'uniformLaplace', 'timestep', 'rescale'],
  fillHoles: ['maxEdges', 'maxPerimeter', 'maxHoles', 'holeFilter'],
  fair: ['method', 'k'], normals: [], analyze: [],
};
const required = ['pmp_abi_version', 'pmp_alloc', 'pmp_free', 'pmp_mesh_create', 'pmp_mesh_destroy',
  'pmp_mesh_reserve', 'pmp_mesh_add_vertices', 'pmp_mesh_add_triangles', 'pmp_mesh_get_view',
  'pmp_mesh_property', 'pmp_vertex_normals', 'pmp_surface_area', 'pmp_volume', 'pmp_bounds',
  'pmp_centroid', 'pmp_min_face_area', 'pmp_min_edge_length', 'pmp_mean_edge_length',
  'pmp_connected_components', 'pmp_triangulate', 'pmp_decimate', 'pmp_uniform_remeshing',
  'pmp_adaptive_remeshing', 'pmp_loop_subdivision', 'pmp_catmull_clark_subdivision',
  'pmp_quad_tri_subdivision', 'pmp_linear_subdivision', 'pmp_explicit_smoothing',
  'pmp_implicit_smoothing', 'pmp_fill_hole', 'pmp_fair', 'pmp_minimize_area',
  'pmp_minimize_curvature', 'pmp_detect_features'];

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
}
function integer(value, label, min = 0, max = INVALID) {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  return value;
}
function scalar(value, label, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (positive && value === 0) ||
      !Number.isFinite(Math.fround(value)) || (positive && Math.fround(value) === 0))
    throw new RangeError(`${label} must be a finite ${positive ? 'positive' : 'nonnegative'} float32 value`);
  return Math.fround(value);
}
function choice(value, allowed, label) {
  if (!allowed.includes(value)) throw new TypeError(`${label} must be ${allowed.join(' or ')}`);
  return value;
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`);
  return value;
}
function array(value, label) {
  if (!Array.isArray(value) && (!ArrayBuffer.isView(value) || value instanceof DataView)) throw new TypeError(`${label} must be a numeric array`);
  return value;
}
function invoke(e, name, ...args) {
  if (poisoned.has(e.memory)) throw new WebAssembly.RuntimeError('PMP instance is poisoned by an earlier native trap; replace it');
  try { return e[name](...args); }
  catch (error) {
    if (error instanceof WebAssembly.RuntimeError) poisoned.add(e.memory);
    throw error;
  }
}

/** Normalize supported source shapes; all aliases of a trapped memory are poisoned. */
export function resolvePMP(source) {
  const seen = new Set();
  let e = source;
  while (e && typeof e === 'object' && !(e.memory instanceof WebAssembly.Memory)) {
    if (seen.has(e)) throw new TypeError('Cyclic PMP source');
    seen.add(e);
    e = e.instance ?? e.exports;
  }
  if (!e || !(e.memory instanceof WebAssembly.Memory) || required.some(name => typeof e[name] !== 'function'))
    throw new TypeError('Expected PMP exports, a WebAssembly.Instance, or an object containing instance/exports');
  if (poisoned.has(e.memory)) throw new WebAssembly.RuntimeError('PMP instance is poisoned by an earlier native trap; replace it');
  if (invoke(e, 'pmp_abi_version') !== 0) throw new TypeError('Unsupported PMP ABI');
  return e;
}

// Use the same float32 cross/norm operations as native triangle area. This
// rejects float underflow/overflow before a solver sees a zero/invalid area.
function faceArea(p, a, b, c) {
  const f = Math.fround;
  const x = f(p[b * 3] - p[a * 3]), y = f(p[b * 3 + 1] - p[a * 3 + 1]), z = f(p[b * 3 + 2] - p[a * 3 + 2]);
  const u = f(p[c * 3] - p[a * 3]), v = f(p[c * 3 + 1] - p[a * 3 + 1]), w = f(p[c * 3 + 2] - p[a * 3 + 2]);
  const nx = f(f(y * w) - f(z * v)), ny = f(f(z * u) - f(x * w)), nz = f(f(x * v) - f(y * u));
  return f(0.5 * Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz))));
}

/** Validate topology and split disconnected incident face fans without welding. */
export function prepareGeometry(positions, indices, options = {}) {
  object(options, 'options');
  const maxVertices = integer(options.maxVertices ?? 5_000_000, 'maxVertices', 1, MAX_ROWS);
  const split = boolean(options.splitVertices ?? true, 'splitVertices');
  choice(options.winding ?? 'ccw', ['ccw', 'cw'], 'winding');
  array(positions, 'positions'); array(indices, 'indices');
  if (positions.length % 3 || indices.length % 3) throw new RangeError('Positions and triangle indices must have three components per row');
  const count = positions.length / 3;
  if (count > maxVertices || indices.length > 0x1fffffff) throw new RangeError('Geometry exceeds native size limits');
  const points = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; ++i) {
    if (typeof positions[i] !== 'number' || !Number.isFinite(positions[i]) || !Number.isFinite(Math.fround(positions[i])))
      throw new RangeError(`Position component ${i} is not finite float32`);
    points[i] = positions[i];
  }
  const triangles = new Uint32Array(indices.length), parent = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; ++i) { triangles[i] = integer(indices[i], `indices[${i}]`, 0, count - 1); parent[i] = i; }
  const root = i => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (i !== r) { const next = parent[i]; parent[i] = r; i = next; }
    return r;
  };
  const join = (a, b) => { parent[root(a)] = root(b); };
  const edges = new Map(), faces = new Set();
  let totalArea = 0;
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    if (a === b || b === c || c === a) throw new RangeError('Triangle has repeated vertices');
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (faces.has(key)) throw new RangeError('Duplicate triangle');
    faces.add(key);
    const area = faceArea(points, a, b, c);
    if (!(area > 0) || !Number.isFinite(area)) throw new RangeError('Triangle is degenerate or has invalid float32 area');
    totalArea = Math.fround(totalArea + area);
    if (!Number.isFinite(totalArea)) throw new RangeError('Total surface area exceeds float32 range');
    for (let j = 0; j < 3; ++j) {
      const corner = i + j, next = i + (j + 1) % 3, from = triangles[corner], to = triangles[next];
      const edge = Math.min(from, to) * count + Math.max(from, to), old = edges.get(edge);
      if (old === undefined) edges.set(edge, corner);
      else {
        if (old < 0) throw new RangeError('Nonmanifold edge has more than two incident faces');
        const oldNext = old - old % 3 + (old % 3 + 1) % 3;
        if (triangles[old] !== to || triangles[oldNext] !== from) throw new RangeError('Adjacent triangles have inconsistent directed edges');
        join(corner, oldNext); join(next, old); edges.set(edge, -1);
      }
    }
  }
  const first = new Int32Array(count).fill(-1), rowForRoot = new Map(), extra = [];
  for (let i = 0; i < triangles.length; ++i) {
    const source = triangles[i], r = root(i);
    let row = rowForRoot.get(r);
    if (row === undefined) {
      if (first[source] === -1) { first[source] = r; row = source; }
      else {
        if (!split) throw new RangeError(`Vertex ${source} has disconnected face fans`);
        row = count + extra.length; extra.push(source);
        if (row >= maxVertices) throw new RangeError('Splitting vertex fans exceeds maxVertices');
      }
      rowForRoot.set(r, row);
    }
    triangles[i] = row;
  }
  const output = new Float32Array((count + extra.length) * 3), sourceIds = new Uint32Array(count + extra.length);
  output.set(points);
  for (let i = 0; i < count; ++i) sourceIds[i] = i;
  for (let i = 0; i < extra.length; ++i) {
    const source = extra[i]; output.set(points.subarray(source * 3, source * 3 + 3), (count + i) * 3); sourceIds[count + i] = source;
  }
  return { positions: output, indices: triangles, sourceIds };
}

// Plan native insertion entirely in JS. PMP can splice disconnected temporary
// fans, but a face closing the wrong gap must wait for other faces. Mirror only
// its connectivity bookkeeping, deferring such faces until their gap is ready.
function insertionOrder(indices, vertices, clockwise) {
  const count = indices.length / 3, out = new Int32Array(vertices).fill(-1);
  const next = [], previous = [], face = [], directed = new Map(), result = new Uint32Array(indices.length);
  const pending = Array.from({ length: count }, (_, i) => i);
  let accepted = 0, head = 0, deferred = 0;
  while (accepted < count) {
    const f = pending[head++], base = f * 3;
    const v = clockwise ? [indices[base + 2], indices[base + 1], indices[base]] : [indices[base], indices[base + 1], indices[base + 2]];
    const h = v.map((from, i) => directed.get(from * vertices + v[(i + 1) % 3]) ?? -1);
    const fresh = h.map(x => x < 0), links = [], adjust = [false, false, false];
    let valid = v.every((vertex, i) => (out[vertex] < 0 || face[out[vertex]] < 0) && (fresh[i] || face[h[i]] < 0));
    if (valid) for (let i = 0; i < 3; ++i) {
      const j = (i + 1) % 3;
      if (!fresh[i] && !fresh[j] && next[h[i]] !== h[j]) {
        let boundaryPrevious = h[j] ^ 1, steps = 0;
        do {
          boundaryPrevious = next[boundaryPrevious] ^ 1;
          if (++steps > next.length) throw new RangeError('Invalid temporary vertex link');
        } while (face[boundaryPrevious] >= 0 || boundaryPrevious === h[i]);
        const boundaryNext = next[boundaryPrevious];
        if (boundaryNext === h[j]) { valid = false; break; }
        links.push([boundaryPrevious, next[h[i]]], [previous[h[j]], boundaryNext], [h[i], h[j]]);
      }
    }
    if (!valid) {
      pending.push(f);
      if (++deferred >= count - accepted) throw new RangeError('Triangle topology cannot be inserted into PMP in a valid face order');
      continue;
    }
    deferred = 0;
    for (let i = 0; i < 3; ++i) if (fresh[i]) {
      h[i] = next.length; next.push(-1, -1); previous.push(-1, -1); face.push(-1, -1);
      directed.set(v[i] * vertices + v[(i + 1) % 3], h[i]); directed.set(v[(i + 1) % 3] * vertices + v[i], h[i] ^ 1);
    }
    for (let i = 0; i < 3; ++i) {
      const j = (i + 1) % 3, vertex = v[j], innerPrevious = h[i], innerNext = h[j];
      const outerPrevious = innerNext ^ 1, outerNext = innerPrevious ^ 1;
      const type = Number(fresh[i]) | (Number(fresh[j]) << 1);
      if (type === 1) { links.push([previous[innerNext], outerNext]); out[vertex] = outerNext; }
      if (type === 2) { links.push([outerPrevious, next[innerPrevious]]); out[vertex] = next[innerPrevious]; }
      if (type === 3) {
        if (out[vertex] < 0) { out[vertex] = outerNext; links.push([outerPrevious, outerNext]); }
        else { links.push([previous[out[vertex]], outerNext], [outerPrevious, out[vertex]]); }
      }
      if (type) links.push([innerPrevious, innerNext]);
      else adjust[j] = out[vertex] === innerNext;
      face[innerPrevious] = f;
    }
    for (const [a, b] of links) { next[a] = b; previous[b] = a; }
    for (let i = 0; i < 3; ++i) if (adjust[i]) {
      let current = out[v[i]], steps = 0;
      do {
        if (face[current] < 0) { out[v[i]] = current; break; }
        current = next[current ^ 1];
        if (++steps > next.length) throw new RangeError('Invalid temporary vertex link');
      } while (current !== out[v[i]]);
    }
    result.set(indices.subarray(base, base + 3), accepted++ * 3);
  }
  return { indices: result, edges: next.length / 2 };
}

function validateOptions(operation, options, geometry) {
  if (!operations.has(operation)) throw new TypeError(`Unsupported geometry operation: ${operation}`);
  object(options, 'options');
  const allowed = new Set([...common, ...parameters[operation]]);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`Unsupported ${operation} option: ${key}`);
  const o = { ...options, winding: choice(options.winding ?? 'ccw', ['ccw', 'cw'], 'winding'),
    computeNormals: boolean(options.computeNormals ?? true, 'computeNormals'),
    preserveBoundary: boolean(options.preserveBoundary ?? false, 'preserveBoundary'),
    maxVertices: integer(options.maxVertices ?? 5_000_000, 'maxVertices', 1, MAX_ROWS) };
  boolean(options.splitVertices ?? true, 'splitVertices');
  if (options.selectedVertices !== undefined && !['decimate', 'remesh', 'fair'].includes(operation)) throw new TypeError(`selectedVertices is unsupported for ${operation}`);
  if (o.preserveBoundary && !['decimate', 'remesh', 'subdivide'].includes(operation)) throw new TypeError(`preserveBoundary is unsupported for ${operation}`);
  if (options.featureAngle !== undefined) {
    if (!['decimate', 'remesh', 'subdivide'].includes(operation)) throw new TypeError(`featureAngle is unsupported for ${operation}`);
    o.featureAngle = scalar(options.featureAngle, 'featureAngle');
    if (o.featureAngle > 180) throw new RangeError('featureAngle must not exceed 180 degrees');
  }
  let originalCount = 0;
  for (const id of geometry.sourceIds) originalCount = Math.max(originalCount, id + 1);
  if (options.selectedVertices !== undefined) {
    array(options.selectedVertices, 'selectedVertices'); o.selectedVertices = new Set();
    for (const id of options.selectedVertices) o.selectedVertices.add(integer(id, 'selectedVertices entry', 0, originalCount - 1));
  }
  if (operation === 'decimate') {
    o.targetVertices = integer(options.targetVertices, 'targetVertices', 3, MAX_ROWS);
    for (const [key, fallback] of [['aspectRatio', 0], ['edgeLength', 0], ['normalDeviation', 0], ['hausdorffError', 0], ['seamThreshold', 0.01], ['seamAngleDeviation', 1]]) o[key] = scalar(options[key] ?? fallback, key);
    o.maxValence = integer(options.maxValence ?? 0, 'maxValence');
    if (options.texcoords !== undefined) {
      array(options.texcoords, 'texcoords');
      if (options.texcoords.length !== originalCount * 2) throw new RangeError('texcoords must contain one Vec2 per original vertex');
      o.texcoords = new Float32Array(options.texcoords.length);
      for (let i = 0; i < o.texcoords.length; ++i) {
        const value = options.texcoords[i];
        if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))) throw new RangeError('texcoords must be finite float32');
        o.texcoords[i] = value;
      }
    }
  }
  if (['remesh', 'subdivide', 'smooth'].includes(operation)) o.iterations = integer(options.iterations ?? (operation === 'remesh' ? 10 : 1), 'iterations');
  if (operation === 'remesh') {
    o.method = choice(options.method ?? 'uniform', ['uniform', 'adaptive'], 'method'); o.projection = boolean(options.projection ?? true, 'projection');
    if (o.method === 'uniform') {
      if (['minEdgeLength', 'maxEdgeLength', 'approxError'].some(key => options[key] !== undefined)) throw new TypeError('Adaptive lengths are unsupported for uniform remeshing');
      o.edgeLength = scalar(options.edgeLength, 'edgeLength', true);
    } else {
      if (options.edgeLength !== undefined) throw new TypeError('edgeLength is unsupported for adaptive remeshing');
      for (const key of ['minEdgeLength', 'maxEdgeLength', 'approxError']) o[key] = scalar(options[key], key, true);
      if (o.maxEdgeLength < o.minEdgeLength) throw new RangeError('maxEdgeLength must be at least minEdgeLength');
    }
  }
  if (operation === 'subdivide') {
    o.method = choice(options.method ?? 'loop', ['loop', 'catmullClark', 'quadTri', 'linear'], 'method');
    o.boundary = choice(options.boundary ?? 'interpolate', ['interpolate', 'preserve'], 'boundary');
    if (o.preserveBoundary) o.boundary = 'preserve';
    if (o.featureAngle !== undefined && !['loop', 'catmullClark'].includes(o.method)) throw new TypeError(`featureAngle is unsupported for ${o.method}`);
  }
  if (operation === 'smooth') {
    o.method = choice(options.method ?? 'explicit', ['explicit', 'implicit'], 'method');
    o.uniformLaplace = boolean(options.uniformLaplace ?? false, 'uniformLaplace');
    if (o.method === 'explicit' && (options.timestep !== undefined || options.rescale !== undefined)) throw new TypeError('timestep/rescale require implicit smoothing');
    o.timestep = scalar(options.timestep ?? 0.001, 'timestep'); o.rescale = boolean(options.rescale ?? true, 'rescale');
  }
  if (operation === 'fair') { o.method = choice(options.method ?? 'fair', ['fair', 'area', 'curvature'], 'method'); o.k = integer(options.k ?? 2, 'k', 1); if (o.method !== 'fair' && options.k !== undefined) throw new TypeError('k requires method=fair'); }
  if (operation === 'fillHoles') {
    o.maxEdges = integer(options.maxEdges ?? 32, 'maxEdges', 3, 16383);
    o.maxPerimeter = options.maxPerimeter ?? Infinity;
    if (typeof o.maxPerimeter !== 'number' || o.maxPerimeter < 0 || Number.isNaN(o.maxPerimeter)) throw new RangeError('maxPerimeter must be nonnegative');
    o.maxHoles = options.maxHoles ?? Infinity;
    if (o.maxHoles !== Infinity) integer(o.maxHoles, 'maxHoles');
    if (options.holeFilter !== undefined && typeof options.holeFilter !== 'function') throw new TypeError('holeFilter must be a function');
  }
  return o;
}

/** Run one operation, returning only owned arrays. Native ownership never escapes. */
export function runGeometry(source, geometry, operation, options = {}) {
  object(geometry, 'geometry');
  const input = prepareGeometry(geometry.positions, geometry.indices, { ...options, splitVertices: false });
  if (geometry.sourceIds !== undefined) {
    array(geometry.sourceIds, 'sourceIds');
    if (geometry.sourceIds.length !== input.positions.length / 3) throw new RangeError('sourceIds cardinality differs from positions');
    for (let i = 0; i < input.sourceIds.length; ++i) input.sourceIds[i] = integer(geometry.sourceIds[i], 'sourceIds entry', 0, INVALID - 1);
  }
  const o = validateOptions(operation, options, input);
  const order = insertionOrder(input.indices, input.positions.length / 3, o.winding === 'cw');
  if (order.edges >= Math.floor(INVALID / 32)) throw new RangeError('Edge storage exceeds native size limits');
  const before = { vertices: input.positions.length / 3, triangles: input.indices.length / 3 };
  const used = new Uint8Array(before.vertices), boundary = new Uint8Array(before.vertices), edgeCounts = new Map();
  for (let i = 0; i < input.indices.length; i += 3) for (let j = 0; j < 3; ++j) {
    const a = input.indices[i + j], b = input.indices[i + (j + 1) % 3]; used[a] = 1;
    const key = Math.min(a, b) * before.vertices + Math.max(a, b); edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of edgeCounts) if (count === 1) { boundary[Math.floor(key / before.vertices)] = 1; boundary[key % before.vertices] = 1; }
  let selected;
  if (o.selectedVertices || (o.preserveBoundary && operation !== 'subdivide')) selected = input.sourceIds.map((id, i) => Number((!o.selectedVertices || o.selectedVertices.has(id)) && (!o.preserveBoundary || !boundary[i])));
  const emptySelection = selected !== undefined && !selected.some(Boolean);
  const skip = before.vertices === 0 || emptySelection || (o.iterations === 0 && ['remesh', 'smooth', 'subdivide'].includes(operation));
  const needsReferencedRows = ['remesh', 'subdivide', 'fair'].includes(operation) ||
    (operation === 'fillHoles' && o.maxHoles > 0 && boundary.some(Boolean));
  if (!skip && needsReferencedRows && used.some(value => !value)) throw new RangeError(`${operation} requires every vertex to belong to a triangle`);
  if (!skip && operation === 'smooth' && o.method === 'implicit' && used.some(value => !value)) throw new RangeError('Implicit smoothing requires every vertex to belong to a triangle');
  if (!skip && operation === 'fair' && !boundary.some(Boolean) && !(selected && selected.some(Boolean) && selected.some(value => !value))) throw new RangeError('Fairing requires boundary or selected-vertex constraints');
  if (!skip && operation === 'subdivide') {
    let v = before.vertices, e = order.edges, f = before.triangles, valence = 3;
    for (let i = 0; i < o.iterations; ++i) {
      v += e + (o.method === 'catmullClark' ? f : 0);
      if (v > o.maxVertices) throw new RangeError('Subdivision would exceed maxVertices');
      e = 2 * e + valence * f; f *= o.method === 'catmullClark' ? valence : 4; valence = o.method === 'catmullClark' ? 4 : 3;
      if (!Number.isSafeInteger(e) || e >= Math.floor(INVALID / 32) || f >= 0x7fffffff) throw new RangeError('Subdivision exceeds native index limits');
    }
  }
  const e = resolvePMP(source), allocations = new Set();
  let mesh = 0;
  const call = (name, ...args) => invoke(e, name, ...args);
  const alloc = bytes => { const pointer = call('pmp_alloc', bytes) >>> 0; if (pointer) allocations.add(pointer); return pointer; };
  const free = pointer => { if (pointer) { call('pmp_free', pointer); allocations.delete(pointer); } };
  try {
    const scratch = alloc(128); mesh = call('pmp_mesh_create') >>> 0;
    const view = () => {
      call('pmp_mesh_get_view', mesh, scratch);
      const words = new Uint32Array(e.memory.buffer, scratch, 13), values = [...words], buffer = e.memory.buffer;
      return { vertices: values[0], edges: values[1], faces: values[2], positions: new Float32Array(buffer, values[6], values[0] * 3),
        halfedges: new Uint32Array(buffer, values[8], values[1] * 8), faceHalfedges: new Uint32Array(buffer, values[9], values[2]) };
    };
    const property = (name, domain, type, create = true) => {
      new Uint8Array(e.memory.buffer, scratch + 64, 64).set(encoder.encode(`${name}\0`));
      return call('pmp_mesh_property', mesh, domain, type, scratch + 64, Number(create)) >>> 0;
    };
    call('pmp_mesh_reserve', mesh, before.vertices, order.edges, before.triangles);
    call('pmp_mesh_add_vertices', mesh, before.vertices); view().positions.set(input.positions);
    const upload = alloc(order.indices.byteLength), cornerMap = o.texcoords ? alloc(order.indices.byteLength) : 0;
    new Uint32Array(e.memory.buffer, upload, order.indices.length).set(order.indices);
    call('pmp_mesh_add_triangles', mesh, upload, before.triangles, Number(o.winding === 'cw'), cornerMap);
    free(upload);
    if (o.texcoords) {
      const pointer = property('h:tex', 1, 5), current = view();
      const values = new Float32Array(e.memory.buffer, pointer, current.edges * 4), mapping = new Uint32Array(e.memory.buffer, cornerMap, order.indices.length);
      for (let h = 0; h < current.edges * 2; ++h) {
        const id = input.sourceIds[current.halfedges[h * 4 + 1]];
        values.set(o.texcoords.subarray(id * 2, id * 2 + 2), h * 2);
      }
      for (let i = 0; i < order.indices.length; ++i) values.set(o.texcoords.subarray(input.sourceIds[order.indices[i]] * 2, input.sourceIds[order.indices[i]] * 2 + 2), mapping[i] * 2);
      free(cornerMap);
    }
    if (operation === 'decimate') {
      const pointer = property('user:gltfSourceIds', 0, 2); new Uint32Array(e.memory.buffer, pointer, before.vertices).set(input.sourceIds);
    }
    if (selected) { const pointer = property('v:selected', 0, 0); new Uint8Array(e.memory.buffer, pointer, before.vertices).set(selected); }
    if (o.featureAngle !== undefined) call('pmp_detect_features', mesh, o.featureAngle);
    const details = { before, after: null };
    if (!before.vertices) details.skipped = 'emptyGeometry';
    if (emptySelection) details.skipped = 'emptySelection';
    if (operation === 'subdivide') details.boundary = o.method === 'linear' ? 'preserve' : o.boundary;
    if (!skip && operation === 'decimate') call('pmp_decimate', mesh, o.targetVertices, o.aspectRatio, o.edgeLength, o.maxValence, o.normalDeviation, o.hausdorffError, o.seamThreshold, o.seamAngleDeviation);
    if (!skip && operation === 'remesh') {
      if (o.method === 'uniform') call('pmp_uniform_remeshing', mesh, o.edgeLength, o.iterations, Number(o.projection));
      else call('pmp_adaptive_remeshing', mesh, o.minEdgeLength, o.maxEdgeLength, o.approxError, o.iterations, Number(o.projection));
    }
    if (!skip && operation === 'subdivide') for (let i = 0; i < o.iterations; ++i) {
      const name = { loop: 'pmp_loop_subdivision', catmullClark: 'pmp_catmull_clark_subdivision', quadTri: 'pmp_quad_tri_subdivision', linear: 'pmp_linear_subdivision' }[o.method];
      if (o.method === 'linear') call(name, mesh); else call(name, mesh, Number(o.boundary === 'preserve'));
    }
    if (!skip && operation === 'smooth') {
      if (o.method === 'explicit') call('pmp_explicit_smoothing', mesh, o.iterations, Number(o.uniformLaplace));
      else call('pmp_implicit_smoothing', mesh, o.timestep, o.iterations, Number(o.uniformLaplace), Number(o.rescale));
    }
    if (!skip && operation === 'fair') {
      if (o.method === 'fair') call('pmp_fair', mesh, o.k);
      else call(o.method === 'area' ? 'pmp_minimize_area' : 'pmp_minimize_curvature', mesh);
    }
    if (operation === 'fillHoles') {
      details.holesFilled = 0;
      // Snapshot complete loops before filling; native refinement may move every
      // subsequent halfedge ID. Match each later loop by its original vertices.
      const current = view(), visited = new Uint8Array(current.edges * 2), loops = [];
      for (let first = 0; first < visited.length; ++first) if (!visited[first] && current.halfedges[first * 4] === INVALID) {
        const vertices = []; let h = first;
        do { visited[h] = 1; vertices.push(current.halfedges[h * 4 + 1]); h = current.halfedges[h * 4 + 2]; if (vertices.length > visited.length) throw new RangeError('Invalid native boundary loop'); } while (h !== first);
        const positions = new Float32Array(vertices.length * 3); let perimeter = 0;
        for (let i = 0; i < vertices.length; ++i) {
          positions.set(current.positions.subarray(vertices[i] * 3, vertices[i] * 3 + 3), i * 3);
          const a = vertices[i] * 3, b = vertices[(i + 1) % vertices.length] * 3;
          perimeter += Math.hypot(current.positions[a] - current.positions[b], current.positions[a + 1] - current.positions[b + 1], current.positions[a + 2] - current.positions[b + 2]);
        }
        loops.push({ vertices: Uint32Array.from(vertices), positions, perimeter });
      }
      for (const loop of loops) {
        if (details.holesFilled >= o.maxHoles) break;
        if (loop.vertices.length > o.maxEdges || loop.perimeter > o.maxPerimeter) continue;
        if (o.holeFilter && !boolean(o.holeFilter({ vertices: loop.vertices.slice(), positions: loop.positions.slice(), perimeter: loop.perimeter }), 'holeFilter return value')) continue;
        const now = view(); let halfedge = -1;
        const a = loop.vertices[0], b = loop.vertices[1];
        for (let h = 0; h < now.edges * 2; ++h) if (now.halfedges[h * 4] === INVALID && now.halfedges[h * 4 + 1] === a && now.halfedges[now.halfedges[h * 4 + 2] * 4 + 1] === b) { halfedge = h; break; }
        if (halfedge < 0) continue;
        call('pmp_fill_hole', mesh, halfedge); ++details.holesFilled;
        if (view().vertices > o.maxVertices) throw new RangeError('Hole filling exceeded maxVertices');
      }
    }
    if (['subdivide', 'remesh', 'fillHoles'].includes(operation)) call('pmp_triangulate', mesh);
    let current = view();
    if (current.vertices > o.maxVertices) throw new RangeError('Native result exceeded maxVertices');
    const positions = current.positions.slice(), indices = new Uint32Array(current.faces * 3);
    if (!positions.every(Number.isFinite)) throw new RangeError('Native result contains nonfinite positions');
    for (let f = 0; f < current.faces; ++f) {
      const first = current.faceHalfedges[f]; let h = first;
      for (let j = 0; j < 3; ++j) {
        if (h >= current.edges * 2) throw new RangeError('Native result contains an invalid halfedge');
        const vertex = current.halfedges[h * 4 + 1];
        if (vertex >= current.vertices) throw new RangeError('Native result contains an invalid vertex index');
        indices[f * 3 + j] = vertex; h = current.halfedges[h * 4 + 2];
      }
      if (h !== first) throw new RangeError('Native result contains a nontriangle face');
      const area = faceArea(positions, indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]);
      if (!(area > 0) || !Number.isFinite(area))
        throw new RangeError('Native result contains a degenerate triangle');
    }
    const result = { positions, indices, details };
    details.after = { vertices: current.vertices, triangles: current.faces };
    if (skip || (operation === 'fillHoles' && details.holesFilled === 0) || ['decimate', 'smooth', 'fair', 'normals', 'analyze'].includes(operation)) {
      if (operation === 'decimate') { const pointer = property('user:gltfSourceIds', 0, 2, false); result.sourceIds = new Uint32Array(e.memory.buffer, pointer, current.vertices).slice(); }
      else result.sourceIds = input.sourceIds.slice();
    }
    if (o.computeNormals || operation === 'normals') {
      call('pmp_vertex_normals', mesh); const pointer = property('v:normal', 0, 6, false);
      result.normals = new Float32Array(e.memory.buffer, pointer, current.vertices * 3).slice();
      if (!result.normals.every(Number.isFinite)) throw new RangeError('Native result contains nonfinite normals');
    }
    if (operation === 'analyze') {
      const measurements = { area: call('pmp_surface_area', mesh), volume: call('pmp_volume', mesh), components: call('pmp_connected_components', mesh) };
      if (current.vertices) { call('pmp_bounds', mesh, scratch); const bounds = new Float32Array(e.memory.buffer, scratch, 6); measurements.bounds = { min: bounds.slice(0, 3), max: bounds.slice(3, 6) }; }
      if (current.edges) { measurements.minEdgeLength = call('pmp_min_edge_length', mesh); measurements.meanEdgeLength = call('pmp_mean_edge_length', mesh); }
      if (current.faces) measurements.minFaceArea = call('pmp_min_face_area', mesh);
      if (current.faces && measurements.area > 0 && Number.isFinite(measurements.area)) { call('pmp_centroid', mesh, scratch); measurements.centroid = new Float32Array(e.memory.buffer, scratch, 3).slice(); }
      for (const value of Object.values(measurements)) if ((typeof value === 'number' && !Number.isFinite(value)) ||
          (ArrayBuffer.isView(value) && !value.every(Number.isFinite))) throw new RangeError('Native measurement is not finite');
      result.measurements = measurements;
    }
    return result;
  } finally {
    if (!poisoned.has(e.memory)) {
      if (mesh) call('pmp_mesh_destroy', mesh);
      for (const pointer of allocations) free(pointer);
    }
  }
}
