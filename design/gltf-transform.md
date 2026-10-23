# Optional glTF-Transform integration

This integration is separate from the zero-copy core wrapper. It depends only
on the optional peer `@gltf-transform/core` 4.x (tested with 4.5.1). Development
tests use core/extensions 4.5.1. There is no dependency from `src/index.js` to
this adapter, no new Wasm exports, and no PMP vendor changes. Input and output
accessor arrays necessarily cross the JS/Wasm boundary; the adapter owns these
copies and releases every native mesh after processing.

## Public contract

`decimate(source, options)`, `remesh`, `subdivide`, `smooth`, `fillHoles`, `fair`,
and `recomputeNormals` return glTF-Transform document transforms. `source` is
the core exports returned by `instantiate`, a `WebAssembly.Instance`, or an
object containing `.instance` or `.exports`. `process(document, source,
{operation, ...options})` returns per-primitive reports synchronously. `analyze`
returns measurements without changing document geometry. The optional entry
point is `src/gltf-transform.js`; it is never imported by the core entry point.

Selection uses `meshes: Mesh[]`, `primitives: Primitive[]`, and an optional
`filter(context)`; omitted selection means every root mesh. A shared mesh is
processed once, affecting every node referencing it. Instances are not silently
cloned. Every primitive is processed independently in mesh-local coordinates,
preserving its material, extras, target order and scene/skin/animation graph.
No automatic position weld crosses render-vertex or material seams. Triangle
strips/fans and unindexed triangles are converted to indexed triangles; other
modes are skipped by default or rejected with `unsupported: 'error'`.

`parameters(context)` can override operation parameters per primitive. Context
includes document, mesh, primitive, their indices and vertex/triangle counts.
Decimation defaults to adapter aspectRatio=5 for usable output faces and
accepts `ratio` or `targetVertices`; `targetScope` is `primitive`
(default), `mesh`, or `document`. Shared budgets are apportioned across selected
triangle primitives, with at least three target vertices each. Native topology
and quality constraints can prevent reaching a target; reports give actual
counts. Lengths and areas use mesh-local units, unaffected by node transforms.

All selected output geometry and attributes are staged before graph mutation.
Validation failures leave the document unchanged. `invalid: 'skip'` may skip
JS-preflight failures, but never a Wasm trap. A trapped instance is poisoned and
must be replaced; no cleanup calls re-enter it. Callbacks run during staging,
so their own document mutations are outside the transaction guarantee.

## Attribute policy

Decimation maps retained endpoints to original accessor rows exactly. Smoothing,
fairing and normals preserve rows. New topology uses nearest-source-triangle
barycentric transfer accelerated by a JS BVH. This is an approximation, exposed
as `attributeTransfer: 'project'` (default) or `'strict'` (reject attributes and
morphs requiring projection). `maxProjectionDistance` can reject distant
transfers. Transfer never spans primitives. No implicit UV weld is performed.

Multiple UVs, colors and floating custom attributes interpolate. Unnormalized
integer custom attributes choose the greatest-weight corner. Normalized integer
attributes decode before interpolation and re-encode afterward. Joint indices
are categorical: collect joint/weight pairs across all JOINTS_n/WEIGHTS_n sets,
merge repeated joints, keep the strongest available influences and renormalize.
Projected weights use float32 storage to avoid quantization sum errors; exact
row transfer preserves original storage. Unpaired skin channels are rejected.

Morph POSITION deltas transfer with the same correspondence, preserving target
order and animation bindings. Normals default to recomputation when present;
`normals: 'recompute'|'preserve'|'drop'` controls this. Existing morph NORMAL
deltas are recomputed from each morphed surface relative to the new base normals
when its POSITION target exists; unsupported normal-only targets must be
explicitly preserved or rejected. Tangents default to removal after geometry
changes (including morph tangent deltas), allowing consumers to regenerate them;
`tangents: 'preserve'|'drop'` allows explicit preservation. Materials remain
unchanged. Unsupported primitive/accessor extensions are rejected before edits;
extension semantics cannot be guessed. Normalized/quantized POSITION data is
decoded to float32, retaining node transforms.

## Internal module boundaries

`src/gltf/geometry.js` has no glTF dependency. It exports
`resolvePMP(source)`, `prepareGeometry(positions, indices, options={})`, and
`runGeometry(source, geometry, operation, options={})`.
`prepareGeometry` validates finite float32 positions, triangle indices,
nondegenerate faces, directed-edge consistency and manifold edges; it rejects
duplicate triangles. Disconnected vertex fans are split by default into
identical position rows, or rejected with `splitVertices:false`. It returns
`{positions:Float32Array, indices:Uint32Array, sourceIds:Uint32Array}`; IDs refer
to original rows. No position weld occurs. `runGeometry` copies prepared data
to native buffers, dispatches the operation, triangulates polygon output,
collects owned result arrays, and releases native ownership. Its result is
`{positions, indices, sourceIds?, normals?, measurements?, details}`. Exact IDs
are returned for decimation, smoothing, fairing, normals and analyze; topology
creation omits them. Measurements contain bounds, area, volume, centroid when
defined, min/mean edge length and component count. No result aliases Wasm.

Geometry operation names and parameters:

- `decimate`: targetVertices, aspectRatio=0 in the internal bridge (adapter=5), edgeLength=0, maxValence=0,
  normalDeviation=0, hausdorffError=0, seamThreshold=0.01,
  seamAngleDeviation=1. A provided `texcoords` array is optional h:tex input.
- `remesh`: method='uniform'|'adaptive', edgeLength (required for uniform),
  minEdgeLength/maxEdgeLength/approxError (required for adaptive), iterations=10,
  projection=true.
- `subdivide`: method='loop'|'catmullClark'|'quadTri'|'linear', iterations=1,
  boundary='interpolate'|'preserve'. Triangulate once after all iterations.
- `smooth`: method='explicit'|'implicit', iterations=1, uniformLaplace=false,
  timestep=0.001, rescale=true.
- `fillHoles`: maxEdges=32, maxPerimeter=Infinity, maxHoles=Infinity,
  holeFilter({vertices,positions,perimeter}) optional. Boundary loops include
  outer boundaries; callers must select according to their application.
- `fair`: method='fair'|'area'|'curvature', k=2; require native boundary or
  selected-vertex constraints before invoking the solver.
- `normals`, `analyze`: no mutation other than temporary native properties.

Common geometry options: winding='ccw'|'cw', splitVertices=true,
selectedVertices (original row indices), featureAngle, preserveBoundary=false,
computeNormals=true, maxVertices=5_000_000. Reject unsupported option/operation
combinations. Validate all numeric/native preconditions in JS before calls.

`src/gltf/transfer.js` has no glTF or Wasm dependency. It exports
`buildTransfer(sourcePositions, sourceIndices, targetPositions,
{sourceIds?,maxDistance?})` returning `{indices,weights,distances}` with three
source vertex IDs/weights per destination. It exports
`transferAttribute(array, itemSize, mapping, {normalized=false, discrete=false})`
returning a typed array with the same constructor, and
`transferSkin(channels, mapping)` returning channels
`{set:number,joints:Uint8Array|Uint16Array,weights:Float32Array}`. Input skin
channels additionally specify `normalized` for weight decoding. It exports
`computeNormals(positions,indices)` returning float32 angle-weighted normals.
Equal-distance projection ties are deterministic (lowest source triangle).
Degenerate input triangles, nonfinite values, invalid sizes and indices fail
clearly. Distance limits apply to projected correspondence, not exact ID maps.

The main session owns the document adapter, declarations, package metadata and
public documentation. Other implementation assignments own only their specified
modules and focused tests. No agent may commit; main reviews every change.

## Validation

Synthetic fixtures cover every operation variant, shared meshes/accessors,
materials, strips/fans/unindexed data, dual UV, normalized colors, multi-set
skinning, morphs/animations, scope/budget behavior, CW input, bad topology,
transaction failures and poisoned instances. Bounded deterministic fuzzing
checks counts, finite outputs, indices, attribute cardinality and graph/skin/
morph invariants. NodeIO and browser WebIO round-trip GLB results. Both runtimes
run the same scenarios and compare deterministic summaries. Private local real
models exercise skin/animation, dual UV, colors, morph targets and a medium mesh;
paths and artifacts remain outside tracked public files.

The optional adapter/dependency browser baseline is documented separately from
the core Chrome 75 feature target. No historical browser certification is
claimed without executing that browser.

Implemented review refinements: output indices are always canonical CCW. Empty
selections and known no-op operations retain exact source IDs. Smoothing does
not honor native v:selected, so the adapter rejects that option. preserveBoundary
uses fixed selected rows for decimation/remeshing and boundary mode for
subdivision; feature detection is separately controlled by featureAngle.
Output zero-area/nonfinite triangles fail before graph mutation. Generated
barycentric coordinates clamp only bounded floating-point roundoff; supplied
mappings remain strictly validated. The optional browser feature baseline is
Chrome93 because core4.5.1 uses Object.hasOwn.
