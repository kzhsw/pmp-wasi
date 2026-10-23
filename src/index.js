// SPDX-License-Identifier: MIT
export const Property = Object.freeze({ BOOL: 0, I32: 1, U32: 2, F32: 3, F64: 4,
  VEC2F: 5, VEC3F: 6, VEC4F: 7, VEC4U32: 8, VEC4U16: 9, RGBA8: 10 });
export const Domain = Object.freeze({ VERTEX: 0, HALFEDGE: 1, EDGE: 2, FACE: 3 });
export const Winding = Object.freeze({ CCW: 0, CW: 1 });
export const Curvature = Object.freeze({ MIN: 0, MAX: 1, MEAN: 2, GAUSS: 3, MAX_ABS: 4 });
export const Algorithm = Object.freeze({ DECIMATE: 0, UNIFORM_REMESH: 1, ADAPTIVE_REMESH: 2,
  CATMULL_CLARK: 3, LOOP: 4, QUAD_TRI: 5, LINEAR: 6, EXPLICIT_SMOOTH: 7, IMPLICIT_SMOOTH: 8, FILL_HOLE: 9,
  TRIANGULATE: 10, CURVATURE: 11, FAIR: 12, CONNECTED_COMPONENTS: 13 });
const layouts = [[Uint8Array, 1], [Int32Array, 1], [Uint32Array, 1], [Float32Array, 1],
  [Float64Array, 1], [Float32Array, 2], [Float32Array, 3], [Float32Array, 4],
  [Uint32Array, 4], [Uint16Array, 4], [Uint8Array, 4]];
const encoder = new TextEncoder();

export async function instantiate(source) {
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  if (WebAssembly.Module.imports(module).length) throw new TypeError('Expected a freestanding PMP module');
  const { exports } = await WebAssembly.instantiate(module, {});
  if (typeof exports.pmp_abi_version !== 'function' || exports.pmp_abi_version() !== 1)
    throw new TypeError('Unsupported PMP ABI');
  return exports;
}

// Metadata only is read into JS; all array results alias current native storage.
// Without caller scratch this helper allocates and can detach earlier JS views.
export function meshView(exports, mesh, scratch) {
  const own = scratch === undefined;
  scratch = own ? exports.pmp_alloc(52) >>> 0 : scratch >>> 0;
  let completed = false;
  try {
    exports.pmp_mesh_get_view(mesh, scratch);
    const words = new Uint32Array(exports.memory.buffer, scratch, 13);
    const [vertices, edges, faces, liveVertices, liveEdges, liveFaces,
      positions, vertexHalfedges, halfedges, faceHalfedges, deletedVertices, deletedEdges, deletedFaces] = words;
    const buffer = exports.memory.buffer;
    const result = { vertices, edges, faces, liveVertices, liveEdges, liveFaces,
      positions: new Float32Array(buffer, positions, vertices * 3),
      vertexHalfedges: new Uint32Array(buffer, vertexHalfedges, vertices),
      halfedges: new Uint32Array(buffer, halfedges, edges * 8),
      faceHalfedges: new Uint32Array(buffer, faceHalfedges, faces),
      deletedVertices: new Uint8Array(buffer, deletedVertices, vertices),
      deletedEdges: new Uint8Array(buffer, deletedEdges, edges),
      deletedFaces: new Uint8Array(buffer, deletedFaces, faces) };
    completed = true;
    return result;
  } finally { if (own && completed) exports.pmp_free(scratch); }
}

// Names are metadata. Custom channels must use the user: prefix.
// create=false returns null for an absent/empty buffer. No bulk data is copied.
// Encoding name metadata allocates scratch even on lookup; reacquire earlier
// views afterwards. Use the raw getter with a persistent C string to avoid this.
export function attributeView(exports, mesh, name, type, domain = Domain.VERTEX, create = false) {
  if (!layouts[type] || !Number.isInteger(type) || !Number.isInteger(domain) || domain < 0 || domain > 3)
    throw new TypeError('Invalid property layout');
  if (typeof name !== 'string' || name.includes('\0')) throw new TypeError('Invalid property name');
  const bytes = name.length * 3 + 1;
  if (bytes > 0xffffffff - 52 - 15) throw new RangeError('Property name is too long');
  if (typeof create !== 'boolean') throw new TypeError('create must be a boolean');
  const scratch = exports.pmp_alloc(52 + bytes) >>> 0;
  let completed = false;
  try {
    const encoded = new Uint8Array(exports.memory.buffer, scratch + 52, bytes);
    const { written } = encoder.encodeInto(name, encoded);
    encoded[written] = 0;
    const pointer = exports.pmp_mesh_property(mesh, domain, type, scratch + 52, Number(create)) >>> 0;
    if (!pointer) { completed = true; return null; }
    exports.pmp_mesh_get_view(mesh, scratch);
    const sizes = new Uint32Array(exports.memory.buffer, scratch, 3);
    const count = domain === Domain.VERTEX ? sizes[0] : domain === Domain.HALFEDGE ? sizes[1] * 2 :
      domain === Domain.EDGE ? sizes[1] : sizes[2];
    const [ArrayType, components] = layouts[type];
    const result = new ArrayType(exports.memory.buffer, pointer, count * components);
    completed = true;
    return result;
  } finally {
    // Never re-enter an instance after a trap: its C++ stack may be corrupted.
    if (completed) exports.pmp_free(scratch);
  }
}
