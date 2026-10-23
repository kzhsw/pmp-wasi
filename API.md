# Core API

ABI **1** consists of the 51 implemented functions declared in
[include/pmp.h](include/pmp.h), plus exported `memory`. The declaration version,
`pmp_abi_version()` and JS wrapper agree. Use the matching wrapper and binary;
there is no version negotiation or compatibility shim. Proposed functions are
excluded from the package. Offsets and handles are wasm32 values; use `>>> 0`
on returned pointers before using them as JS byte offsets. Inputs use PMP's
names, argument order and units. C has no default arguments, so supply every
argument.

## Ownership and storage

`instantiate(bytesOrModule)` creates an independent instance and returns its
exports. `pmp_mesh_create()` owns a mesh, released with `pmp_mesh_destroy(mesh)`.
`pmp_alloc(bytes)` allocates 16-byte-aligned scratch space, released with
`pmp_free(pointer)`. A zero-byte allocation returns zero; freeing zero is valid.
Never free borrowed positions or property pointers.

The caller must supply valid pointers, lengths and live handles from the same
instance. Native errors, invalid preconditions and allocation failures trap.
After **any native trap**, abandon the entire instance; do not re-enter it even
to destroy a mesh or free scratch space. These raw bindings do not validate
arbitrary pointer provenance or make malformed native memory safe.

`meshView(exports, mesh, scratch?)` returns typed arrays aliasing native
storage. Optional scratch is a caller-owned, aligned 52-byte buffer. Omitting
it allocates temporary metadata. Counts distinguish stored rows (`vertices`,
`edges`, `faces`) from live rows (`liveVertices`, `liveEdges`, `liveFaces`).

Positions are writable float32 triples. Connectivity and deletion flags are
read-only by contract. Each halfedge has four u32 fields: face, target vertex,
next halfedge, previous halfedge. Opposite halfedges have indices `h ^ 1`; a
missing face or handle is `0xffffffff`. `faceHalfedges[f]` starts a circular
face traversal. No triangle index buffer is maintained by the wrapper.

Reacquire all borrowed arrays after any allocation or mutation. Memory growth
can detach JS arrays across **all** meshes in an instance, while a native vector
can move even without memory growth. `meshView` and `attributeView` can themselves
allocate metadata. Destroying a mesh releases its allocations, but Wasm memory
pages cannot shrink. `pmp_mesh_clear` may retain native scratch capacity; use
destroy/recreate when ending a mesh lifetime.

## Construction and winding

`pmp_mesh_add_vertices(mesh, count)` appends empty rows and returns the first
index. Initialize their positions through a freshly acquired view before using
geometry algorithms. Reserve expected vertices, edges and faces with
`pmp_mesh_reserve` to avoid repeated reallocations.

Single faces use `pmp_mesh_add_triangle` or `pmp_mesh_add_face`. Bulk triangles
use `pmp_mesh_add_triangles(mesh, indicesPointer, triangleCount, winding,
cornerMapPointer)`. Polygon batches use an index array and an offsets array
with `faceCount + 1` entries, starting at zero. Inputs must describe valid,
consistently oriented manifold connectivity. PMP also requires a valid insertion
order; unordered faces may need reordering. Every polygon corner must be a
distinct live vertex. Duplicate checks for larger polygons are a caller
precondition.

`Winding.CCW` is 0 and `Winding.CW` is 1. Bulk winding helpers normalize to CCW
without reversing a staging copy. Pass zero for an unused corner map; otherwise
provide a separate u32 array with one slot per input corner. Its result maps
each original corner to the native halfedge targeting that corner. Input
indices, offsets and mapping must not overlap or alias storage being mutated.

## Attributes

`attributeView(exports, mesh, name, type, domain = Domain.VERTEX, create = false)`
returns an aliased typed array, or `null` for an absent/empty buffer. A new
property is zero-initialized. Type mismatch traps. Creating on an empty mesh
still creates the property, although its data pointer is null. Use raw
`pmp_mesh_property` with a persistent C string to avoid helper name allocations.

Custom property names start with `user:`. Useful examples include `user:uv1`,
`user:colors`, `user:matricesIndices` and `user:matricesWeights`; additional
four-component channels represent more skin influences. The core stores values
without interpolation, normalization or encoding conversions.

| Layout | JS view / components per row |
| --- | --- |
| `BOOL` | Uint8 / 1, values restricted to 0 or 1 |
| `I32`, `U32`, `F32`, `F64` | Int32, Uint32, Float32, Float64 / 1 |
| `VEC2F`, `VEC3F`, `VEC4F` | Float32 / 2, 3, 4 |
| `VEC4U32`, `VEC4U16`, `RGBA8` | Uint32, Uint16, Uint8 / 4 |

Domains are `VERTEX`, `HALFEDGE`, `EDGE`, `FACE`. Per-corner attributes use
halfedge rows, preserving seams. Recognized PMP channels include `v:normal`,
`f:normal`, `v:tex`, `h:tex`, `v:curv`, `v:component`, `v:selected`, `v:feature`
and `e:feature`. The position property `v:point` cannot be removed. Internal
connectivity and algorithm scratch properties are inaccessible through the
property API.

Before processing, call `pmp_mesh_unsupported_properties(mesh, Algorithm.X)`.
Zero means the attached property set is supported; other values are a bitmask
of unsupported domains (`1 << Domain.X`). This query allocates nothing and
does not validate geometry. Algorithm entry points enforce the same policy.

| Operation | Attribute behavior |
| --- | --- |
| Smoothing / fairing | Preserve rows and custom channels |
| Decimation | Retain surviving vertex rows; support `v:tex`, `h:tex`, selection and paired feature flags |
| Remeshing | Support selection and paired feature flags; reject other channels without a transfer rule |
| Loop / Catmull-Clark | Support paired feature flags |
| Quad-tri / linear / hole filling | Reject attached channels without a transfer rule |
| Triangulation | Preserve vertices; copy source face/corner rows; reject arbitrary edge channels |
| Curvature / connected components | Preserve existing rows; produce `v:curv` / `v:component` |

Geometry-changing algorithms invalidate stored normals, curvature, distance and
component results. Recompute those results when needed. Feature edges must have
both endpoint vertex flags set, and vertex/edge feature properties must exist
together. `pmp_detect_features`, `pmp_detect_boundary` and `pmp_clear_features`
manage that pair. Feature detection takes degrees.

## Algorithms and measurements

The [header](include/pmp.h) documents exact argument constraints. Decimation,
remeshing and Loop subdivision require triangles. The other subdivision modes
accept the polygon types supported by PMP. Boundary mode 0 interpolates and 1
preserves. Linear subdivision preserves existing positions. Decimation targets
are best effort because topology, seams and quality constraints can prevent
further collapses.

Smoothing and fairing use mesh-local coordinates. Fairing needs boundary or
selection constraints. Hole filling starts at a boundary halfedge; an outer
boundary is also eligible. It may triangulate, refine and fair the filled area.

`pmp_bounds` writes six floats (min xyz, max xyz); `pmp_centroid` writes three.
Both require nonempty usable input. Volume is absolute native volume and has
enclosed-volume meaning only for a closed, consistently oriented triangle mesh.
Minimum/mean edge length require edges, and minimum face area requires faces.
Connected components writes integer vertex labels. Curvature selects a kind
from `Curvature` and writes `v:curv`.

No primitive generators, file IO, parameterization, geodesics or standalone
math functions are exported in this release. The separate
[glTF adapter](GLTF_TRANSFORM.md) provides owned-copy construction, topology
preflight and attribute projection for application-level mesh data.
