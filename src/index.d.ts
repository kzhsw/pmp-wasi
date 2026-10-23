/** Development ABI 0. Only the implemented core subset is declared here. */
export interface CoreExports {
  memory: WebAssembly.Memory;
  pmp_abi_version(): number;
  pmp_alloc(bytes: number): number;
  pmp_free(pointer: number): void;
  pmp_mesh_create(): number;
  pmp_mesh_destroy(mesh: number): void;
  pmp_mesh_clear(mesh: number): void;
  pmp_mesh_reserve(mesh: number, vertices: number, edges: number, faces: number): void;
  pmp_mesh_add_vertex(mesh: number, point: number): number;
  pmp_mesh_add_vertices(mesh: number, count: number): number;
  pmp_mesh_add_triangle(mesh: number, a: number, b: number, c: number): number;
  pmp_mesh_add_face(mesh: number, vertices: number, count: number): number;
  pmp_mesh_add_faces(mesh: number, vertices: number, offsets: number, count: number): void;
  pmp_mesh_add_faces_winding(mesh: number, vertices: number, offsets: number, count: number, winding: number, cornerHalfedges: number): void;
  pmp_mesh_add_triangles(mesh: number, vertices: number, count: number, winding: number, cornerHalfedges: number): void;
  pmp_mesh_garbage_collection(mesh: number): void;
  pmp_mesh_get_view(mesh: number, output: number): void;
  pmp_mesh_property(mesh: number, domain: number, type: number, name: number, create: number): number;
  pmp_mesh_remove_property(mesh: number, domain: number, name: number): number;
  /** Domain bitmask of unsupported attached properties; zero is supported. */
  pmp_mesh_unsupported_properties(mesh: number, algorithm: number): number;
  pmp_decimate(mesh: number, vertices: number, aspectRatio: number, edgeLength: number,
    maxValence: number, normalDeviation: number, hausdorffError: number, seamThreshold: number, seamAngleDeviation: number): void;
  pmp_uniform_remeshing(mesh: number, edgeLength: number, iterations: number, projection: number): void;
  pmp_adaptive_remeshing(mesh: number, minLength: number, maxLength: number, error: number, iterations: number, projection: number): void;
  pmp_catmull_clark_subdivision(mesh: number, boundary: number): void;
  pmp_loop_subdivision(mesh: number, boundary: number): void;
  pmp_quad_tri_subdivision(mesh: number, boundary: number): void;
  pmp_linear_subdivision(mesh: number): void;
  pmp_explicit_smoothing(mesh: number, iterations: number, uniform: number): void;
  pmp_implicit_smoothing(mesh: number, timestep: number, iterations: number, uniform: number, rescale: number): void;
  pmp_fill_hole(mesh: number, halfedge: number): void;
  pmp_triangulate(mesh: number): void;
  pmp_triangulate_face(mesh: number, face: number): void;
  pmp_connected_components(mesh: number): number;
  /** Writes [minX,minY,minZ,maxX,maxY,maxZ] to caller-owned float storage. */
  pmp_bounds(mesh: number, output: number): void;
  pmp_surface_area(mesh: number): number;
  /** Absolute native volume; meaningful for closed, consistently oriented triangles. */
  pmp_volume(mesh: number): number;
  pmp_centroid(mesh: number, output: number): void;
  pmp_mean_edge_length(mesh: number): number;
  pmp_min_edge_length(mesh: number): number;
  pmp_min_face_area(mesh: number): number;
  pmp_curvature(mesh: number, kind: number, smoothingSteps: number, tensor: number, twoRing: number): void;
  pmp_fair(mesh: number, k: number): void;
  pmp_minimize_area(mesh: number): void;
  pmp_minimize_curvature(mesh: number): void;
  pmp_vertex_normals(mesh: number): void;
  pmp_face_normals(mesh: number): void;
  pmp_vertex_normal(mesh: number, vertex: number, output: number): void;
  pmp_face_normal(mesh: number, face: number, output: number): void;
  pmp_corner_normal(mesh: number, halfedge: number, creaseAngle: number, output: number): void;
  /** Angle is in degrees, as in PMP. */
  pmp_detect_features(mesh: number, angle: number): number;
  pmp_detect_boundary(mesh: number): number;
  pmp_clear_features(mesh: number): void;
}
export const Property: Readonly<{ BOOL: 0; I32: 1; U32: 2; F32: 3; F64: 4;
  VEC2F: 5; VEC3F: 6; VEC4F: 7; VEC4U32: 8; VEC4U16: 9; RGBA8: 10 }>;
export const Domain: Readonly<{ VERTEX: 0; HALFEDGE: 1; EDGE: 2; FACE: 3 }>;
export const Winding: Readonly<{ CCW: 0; CW: 1 }>;
export const Curvature: Readonly<{ MIN: 0; MAX: 1; MEAN: 2; GAUSS: 3; MAX_ABS: 4 }>;
export const Algorithm: Readonly<{ DECIMATE: 0; UNIFORM_REMESH: 1; ADAPTIVE_REMESH: 2;
  CATMULL_CLARK: 3; LOOP: 4; QUAD_TRI: 5; LINEAR: 6; EXPLICIT_SMOOTH: 7; IMPLICIT_SMOOTH: 8; FILL_HOLE: 9;
  TRIANGULATE: 10; CURVATURE: 11; FAIR: 12; CONNECTED_COMPONENTS: 13 }>;
export interface MeshView {
  vertices: number; edges: number; faces: number;
  liveVertices: number; liveEdges: number; liveFaces: number;
  positions: Float32Array;
  /** Connectivity and deletion arrays are read only by contract. */
  vertexHalfedges: Uint32Array; halfedges: Uint32Array; faceHalfedges: Uint32Array;
  deletedVertices: Uint8Array; deletedEdges: Uint8Array; deletedFaces: Uint8Array;
}
export type AttributeArray = Uint8Array | Uint16Array | Uint32Array | Int32Array | Float32Array | Float64Array;
export function instantiate(source: BufferSource | WebAssembly.Module): Promise<CoreExports>;
/** Borrowed arrays. Allocates metadata scratch unless supplied, and may grow memory. */
export function meshView(exports: CoreExports, mesh: number, scratch?: number): MeshView;
/** Named zero-copy storage. Allocates name metadata even for lookups; reacquire
 * earlier views afterwards. Multiple channels use distinct user: names. */
export function attributeView(exports: CoreExports, mesh: number, name: string,
  type: number, domain?: number, create?: boolean): AttributeArray | null;
