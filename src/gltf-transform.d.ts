import type { Document, Mesh, Primitive, Transform } from '@gltf-transform/core';
import type { CoreExports } from './index.js';

/** A caller-owned, healthy ABI 1 instance. Discard it after any Wasm trap. */
export type PMPSource = CoreExports | WebAssembly.Instance |
  { instance: WebAssembly.Instance } | { exports: CoreExports };
export type Operation = 'decimate' | 'remesh' | 'subdivide' | 'smooth' | 'fillHoles' | 'fair' | 'normals' | 'analyze';
export interface PrimitiveContext {
  document: Document;
  mesh: Mesh;
  primitive: Primitive;
  meshIndex: number;
  primitiveIndex: number;
  vertices: number;
  triangles: number;
}
export interface SelectionOptions {
  /** Omitted means every root mesh. A shared mesh is processed once for all its nodes. */
  meshes?: readonly Mesh[];
  /** Intersects meshes and filter. Each primitive remains a separate surface. */
  primitives?: readonly Primitive[];
  filter?: (context: PrimitiveContext) => boolean;
  /** Lines/points: skip by default. */
  unsupported?: 'skip' | 'error';
  /** Skip only input preflight errors. A native trap always aborts the transaction. */
  invalid?: 'error' | 'skip';
  /** Called after staging, before document mutation. Must not mutate the document. */
  onReport?: (report: PrimitiveReport) => void;
}
export interface TransferOptions {
  /** New topology uses approximate nearest-surface transfer by default. */
  attributeTransfer?: 'project' | 'strict';
  /** Mesh-local distance limit for projected rows; exact source rows ignore it. */
  maxProjectionDistance?: number;
  /** Recompute existing normals by default. recomputeNormals also creates absent normals. */
  normals?: 'recompute' | 'preserve' | 'drop';
  /** Defaults to drop, including morph tangent deltas. Preservation is explicit. */
  tangents?: 'preserve' | 'drop';
}
export interface NativeCommonOptions {
  /** Input winding only; glTF output is always CCW. */
  winding?: 'ccw' | 'cw';
  /** Split disconnected vertex fans into identical rows; never weld positions. Default true. */
  splitVertices?: boolean;
  /** Original POSITION row IDs. Supported by decimation, remeshing and fairing. */
  selectedVertices?: readonly number[] | Uint32Array;
  /** Degrees. Decimation, remeshing, Loop and Catmull-Clark only. */
  featureAngle?: number;
  /** Fix original boundary rows for decimation/remeshing, or subdivision boundary mode. */
  preserveBoundary?: boolean;
  /** Default 5,000,000. Checked before subdivision and after other native operations. */
  maxVertices?: number;
}
export interface DecimateParameters {
  /** Default 0.5; mutually exclusive with targetVertices. */
  ratio?: number;
  targetVertices?: number;
  /** Budget across selected primitives in each mesh or whole document. Default primitive. */
  targetScope?: 'primitive' | 'mesh' | 'document';
  /** Adapter quality default 5; native default 0 remains accessible explicitly. */
  aspectRatio?: number;
  edgeLength?: number;
  maxValence?: number;
  normalDeviation?: number;
  hausdorffError?: number;
  seamThreshold?: number;
  seamAngleDeviation?: number;
  /** UV set used by PMP's seam constraint. Default 0; null disables it. */
  seamTexcoord?: number | null;
}
export interface RemeshParameters {
  method?: 'uniform' | 'adaptive';
  /** Required for uniform remeshing, in mesh-local units. */
  edgeLength?: number;
  /** Required for adaptive remeshing. */
  minEdgeLength?: number;
  maxEdgeLength?: number;
  approxError?: number;
  iterations?: number;
  projection?: boolean;
}
export interface SubdivideParameters {
  method?: 'loop' | 'catmullClark' | 'quadTri' | 'linear';
  iterations?: number;
  boundary?: 'interpolate' | 'preserve';
}
export interface SmoothParameters {
  method?: 'explicit' | 'implicit';
  iterations?: number;
  uniformLaplace?: boolean;
  timestep?: number;
  rescale?: boolean;
}
export interface BoundaryLoop {
  /** Vertex rows in the prepared native mesh, including any split fans. */
  vertices: Uint32Array;
  positions: Float32Array;
  perimeter: number;
}
export interface FillHolesParameters {
  /** Default 32. Outer boundaries are also eligible; select deliberately. */
  maxEdges?: number;
  maxPerimeter?: number;
  maxHoles?: number;
  holeFilter?: (loop: BoundaryLoop) => boolean;
}
export interface FairParameters {
  method?: 'fair' | 'area' | 'curvature';
  k?: number;
}
export type Options<P = object> = SelectionOptions & TransferOptions & NativeCommonOptions & P & {
  /** Override per-primitive parameters. A callback targetVertices replaces the outer ratio. */
  parameters?: (context: PrimitiveContext) => Partial<Omit<P, 'targetScope'> & TransferOptions & NativeCommonOptions>;
};
export type ProcessOptions =
  | (Options<DecimateParameters> & { operation: 'decimate' })
  | (Options<RemeshParameters> & { operation: 'remesh' })
  | (Options<SubdivideParameters> & { operation: 'subdivide' })
  | (Options<SmoothParameters> & { operation: 'smooth' })
  | (Options<FillHolesParameters> & { operation: 'fillHoles' })
  | (Options<FairParameters> & { operation: 'fair' })
  | (Options & { operation: 'normals' | 'analyze' });
export interface Counts { vertices: number; triangles: number }
export interface Measurements {
  bounds: { min: number[]; max: number[] };
  area: number;
  /** Absolute native volume; enclosed-volume meaning requires a closed surface. */
  volume: number;
  centroid?: number[];
  minEdgeLength?: number;
  meanEdgeLength?: number;
  minFaceArea?: number;
  components: number;
}
export interface PrimitiveReport {
  operation: Operation;
  status: 'processed' | 'skipped' | 'analyzed';
  meshIndex: number;
  primitiveIndex: number;
  before: Counts;
  after: Counts;
  reason?: string;
  transfer?: 'exact' | 'projected';
  maxProjectionDistance?: number;
  targetVertices?: number;
  measurements?: Measurements;
  details?: { before: Counts; after: Counts; holesFilled?: number; boundary?: string; skipped?: string };
}

/** Synchronous native processing. Stages every selected primitive before editing the graph. */
export function process(document: Document, source: PMPSource, options: ProcessOptions): PrimitiveReport[];
/** Read-only analysis in mesh-local units. No accessors or scene objects are replaced. */
export function analyze(document: Document, source: PMPSource, options?: Options): PrimitiveReport[];
export function decimate(source: PMPSource, options?: Options<DecimateParameters>): Transform;
export function remesh(source: PMPSource, options?: Options<RemeshParameters>): Transform;
export function subdivide(source: PMPSource, options?: Options<SubdivideParameters>): Transform;
export function smooth(source: PMPSource, options?: Options<SmoothParameters>): Transform;
export function fillHoles(source: PMPSource, options?: Options<FillHolesParameters>): Transform;
export function fair(source: PMPSource, options?: Options<FairParameters>): Transform;
export function recomputeNormals(source: PMPSource, options?: Options): Transform;
