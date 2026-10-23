# pmp-wasi v1 design

Status: release candidate 0.1.0, implemented ABI 1 frozen.
The module reports ABI 1 and implements mesh ownership,
construction, properties, normals, feature detection, and all ten entry points
in the five selected families: decimation, remeshing, subdivision, smoothing
and hole filling, plus triangulation, connected components, seven mesh
measurements, curvature and three fairing entry points. Its exact exports are
in [exports/core.json](exports/core.json). The public [C header](include/pmp.h)
declares exactly those functions, with `PMP_ABI_VERSION=1` matching the runtime.
Unimplemented declarations and their supporting types are isolated in
[design/pmp-proposed.h](design/pmp-proposed.h). These future proposals are not a
release requirement or a linkable API. ABI 1 freezes only the implemented set.
The matching JS wrapper rejects other ABIs; no compatibility layer is provided.

## Scope and source boundary

Expose the computational functions in PMP's [algorithms group](https://www.pmp-library.org/group__algorithms.html),
with their original names, arguments, units, numerical precision, and behavior.
The reviewed page contains 77 function entries including overloads. Its one
stream output operator is excluded, leaving **76 C algorithm declarations** across implemented and proposed headers.
Nine standalone math helpers stay C-only, leaving **67 Wasm algorithm exports**. Small
mesh/matrix ownership and storage operations are necessary supporting API.

The reviewed PMP revision is `215975ca1efafab97477b18187a4a23b87529036`
(project version 3.0.0); its bundled Eigen is 5.0.1. The xatlas-wasi reference is
`7cf8877decce7cc63f48d91e94ee7410a77402c0`. Exact source paths are recorded in
[upstream.json](upstream.json). Vendored inputs contain the allowlisted core, algorithm
headers/sources, necessary Eigen headers, and license notices.

The full build will compile `surface_mesh.cpp` and the 19 listed algorithm translation units directly.
The current build compiles `surface_mesh.cpp` and 15 algorithm translation units,
including the numerical dependencies needed by these five families. The explicit
list is in `scripts/build.mjs`. Binding code is split into `core.cpp`,
`algorithms.cpp`, `inspection.cpp`, `triangulation.cpp`, the shared internal
`mesh.hpp`, and the small `runtime.cpp`.
Use ordinary C/C++ source/header files; no generated `.inc` binding fragments.
Do not invoke upstream's top-level CMake: `src/pmp/CMakeLists.txt` unconditionally
includes `io/CMakeLists.txt`, and also searches for OpenMP. The following never
enter our production build or npm payload (host validation uses original tests
and shape helpers separately):

- `src/pmp/io`, viewers, Polygonal, examples, applications, upstream test tools;
- GLFW, GLAD, ImGui, image codecs, windowing or rendering dependencies;
- memory/process monitoring and timing utilities;
- filesystem, stream formatting, file descriptors, sockets, clocks, entropy,
  environment access, threads, workers, or WASI host adapters.

Keep the mesh, properties, vector arithmetic, bounding box, tolerances, and Eigen
internals needed by the algorithms. Removing these would mean rewriting PMP.
No general C++ core API, renderer, or file-format API is exposed.

| Family | Included functions |
| --- | --- |
| Analysis | `analyze` as a numeric report; no stream operator |
| Curvature, simplification | `curvature`, `decimate` |
| Differential geometry | mesh areas, volume, both centroids, dual, cotan weights, Laplace vector |
| C-only standalone math | clamps, vector angle/sin/cos/cotan, triangle area, point-to-segment and point-to-triangle |
| Fairing, features | `minimize_area`, `minimize_curvature`, `fair`, feature/boundary detection and clearing |
| Geodesics | front propagation and heat method |
| Hole filling | `fill_hole` |
| Operators | uniform/cotan mass and Laplace matrices, gradient, divergence |
| Normals | vertex/face batches and vertex/face/corner queries |
| Coordinates | `coordinates_to_matrix`, `matrix_to_coordinates` |
| Parameterization | harmonic and LSCM |
| Remeshing | uniform and adaptive |
| Shapes | all 12 generators, from tetrahedron through torus |
| Smoothing | explicit and implicit |
| Subdivision | Catmull-Clark, Loop, quad-tri, linear |
| Triangulation | whole mesh and one face |
| Utilities | bounds, flip faces, area/edge statistics, connected components |

Functions outside the linked group, such as arbitrary Cholesky solvers,
mesh/matrix conversion helpers, and curvature/distance visualization helpers,
remain internal when needed and are not additional exports.

The standalone functions `clamp_cot`, `clamp_cos`, `angle`, `sin`, `cos`, `cotan`,
`triangle_area`, `dist_point_line_segment` and `dist_point_triangle` retain declarations in the separate design header but are not implemented C
functions or Wasm exports. Their inexpensive scalar calls do not
justify JS/Wasm crossings. Native algorithm use remains eligible for inlining;
unused C entry points are removed. A future bulk geometry helper needs a measured
use case. [wasm-exports.json](wasm-exports.json) is the proposed complete export
allowlist, including memory and supporting storage operations.

## Direct C ABI

`pmp_<function>` calls its corresponding PMP algorithm. There is no operation
dispatcher, command queue, scene model, serialization, or binding framework.
For example, `uniform_remeshing(mesh, edge_length, iterations, use_projection)`
maps to `pmp_uniform_remeshing` with those same arguments.

Use opaque pointers to the actual `SurfaceMesh`, Eigen matrices, and neighbor
vector. `reinterpret_cast` may convert between opaque handles and the actual
objects without a registry, wrapper object, or copied representation. The public
ABI exposes no STL/Eigen object layouts or C++ mangled names.

- wasm32 pointers, counts and mesh indices are 32-bit. `UINT32_MAX` is the invalid
  mesh index. Pointer results are interpreted as unsigned offsets in JS.
- `Scalar`, positions and normals remain float32; Eigen operators and solvers
  remain float64, as upstream. Do not globally change solver precision.
- C booleans and enum arguments are explicit uint32 values. Enum values are
  frozen in the C header. C callers supply PMP's default arguments explicitly.
- Scalars/counts return directly. Small vector/struct results write to
  caller-provided memory. Mesh-returning shape functions return an owned mesh.
- Only overloaded names get suffixes: `pmp_centroid_face` and
  `pmp_triangulate_face`; the unsuffixed functions operate on the whole mesh.
- Matrix output references become caller-owned matrix handles, preserving
  reuse. Vector inputs become pointer/count spans. Optional geodesic neighbors
  use a native result-vector handle, with a borrowed view of its storage.

Errors escaping an algorithm become Wasm traps in v1. This preserves direct
return types without an exception runtime or a second error-result protocol.
It does **not** preserve C++ exception recovery by callers: traps do not unwind
RAII objects or reliably restore the C++ stack. Discard the entire instance
after a trap, including out-of-memory. Preconditions remain explicit. Internal
numerical recovery used by an algorithm must still work, as described below.
Raw pointers and counts are caller preconditions; this is not a memory-safe
handle registry, and arbitrary invalid pointers are not guaranteed to trap.

## Zero-copy contract

Bulk input and output storage lives in the module's exported linear memory.
The JS wrapper returns typed-array views, never cloned arrays or serialized
meshes. Caller-owned output buffers are written directly. Descriptor fields and
small scalar return values are metadata, not alternate mesh storage.

A pre-existing JS ArrayBuffer cannot become Wasm linear memory through a cast.
To have a genuinely zero-copy pipeline, generate or decode data into the supplied
Wasm views. Uploading an existing external array is an explicit caller copy.
Likewise, zero-copy bindings do not eliminate PMP's algorithmic working storage,
reference-mesh copies for projection, or explicit format-conversion algorithms.

### Positions and topology

Allocate/reserve vertices in the native mesh, then fill its `v:point` storage
through a `Float32Array`. `pmp_mesh_add_vertices` is a bulk `new_vertex` loop that
avoids one JS-to-Wasm call per vertex; it does not accept/copy a position buffer.
`pmp_mesh_add_faces` is a bulk version of `add_face` with polygon index spans and
offsets already in Wasm memory. Topology construction still builds PMP's native
connectivity; the binding makes no intermediate index-vector copy. All polygon
corners must be distinct live vertex indices. Range checks are linear; triangle
and quad uniqueness is checked cheaply. Larger polygons require caller-validated
uniqueness, avoiding quadratic scans or a copied sorting buffer.

PMP stores halfedges, not a flat render index array. Expose its actual storage:

| Storage | ABI layout | Access |
| --- | --- | --- |
| Positions | float32 xyz; stride 12 | Read/write |
| Vertex connectivity | uint32 outgoing halfedge; stride 4 | Read only |
| Halfedge connectivity | uint32 face, target vertex, next, previous; stride 16 | Read only |
| Face connectivity | uint32 incident halfedge; stride 4 | Read only |
| Deletion flags | uint8 per vertex/edge/face | Read only |

Opposite halfedge is `h ^ 1`; edge index is `h >> 1`. Expose both storage sizes
and live counts: deleted slots can exist until explicit garbage collection.
That operation can renumber entities. There is no implicit compaction on reads.
Do not promise a zero-copy triangle index view of halfedge storage. A renderer
that needs packed triangle indices must explicitly generate them separately.

Use a narrow friend/accessor patch to expose connectivity bytes. Assert sizes,
alignment, field offsets, standard layout and trivial copyability at build time.
These checks pin the physical storage to ABI v1; a future upstream layout change
must be adapted or rejected. C++ code accesses real underlying types, rather
than dereferencing unrelated C structs through aliasing casts. Returning an
address for JS to view is distinct from violating C++ object lifetime rules.
`reinterpret_cast` is not used to turn a raw allocation into a `std::vector`.

### Properties and matrices

The raw property helper corresponds to PMP's named typed properties. It accepts
domain, type, name and whether to create the property, then returns its actual
buffer. This is the small C substitute for PMP's templated property lookup, not
a second property store. Protect internal connectivity/deletion properties from
this writable accessor; `v:point` is accessible as vec3f. Type mismatches trap.

Important properties include `v:normal`, `f:normal`, `v:tex`, `h:tex`, `v:curv`,
`geodesic:distance`, `v:component`, `v:selected`, `v:feature`, and
`e:feature`. Preserve upstream names and types. Absent properties return null
when creation is disabled. Empty buffers also return null with zero length.
Allow explicit property removal so callers can release optional results or
selection masks. Core properties cannot be removed. Algorithm scratch names,
including `v:locked` and `e:locked`, are reserved: they are not persistent input
constraints. Keep temporary properties private and ensure successful repeated
algorithm calls clean them up. Custom properties must use the `user:` prefix.

Upstream boolean properties use `std::vector<bool>`, which has no portable
contiguous bool buffer. Replace **property** bool storage with uint8 storage
(values 0/1), keeping algorithm-facing boolean behavior. Local algorithm
scratch vectors need not change. Do not reinterpret packed bits as bytes.

Eigen sparse results expose their native compressed-column storage: int32 outer
column offsets, int32 inner row indices, and float64 values. Finalize compression
in the native result before exposing it; do not transpose or clone to CSR.
Dense results expose column-major float64 data. Diagonal results expose their
float64 diagonal. Coordinate conversion functions perform their explicitly
requested float32/float64 and layout conversions; ordinary position access
does not call them.

### Additional attributes and winding

Multiple UV sets are separate vec2f channels, such as `user:uv0` and `user:uv1`.
Colors can use vec4f or packed RGBA8. Skinning uses vec4u16/vec4u32
`user:matricesIndices` and vec4f `user:matricesWeights`; additional groups of four
influences use additional channels. The binding does not convert colors, normalize
weights, or treat integer joint IDs as interpolatable scalars. Each property
remains one contiguous native buffer with its declared component type.

Use vertex properties for shared vertex data and halfedge properties for
per-corner UVs, colors, or normals. A corner belongs to the halfedge's **target**
vertex. Bulk triangle and polygon construction accept a CW/CCW flag. CW reverses
index traversal in the native accessor, without a reversed input buffer; CCW
preserves traversal. This is an explicit convention, not orientation detection
or a change of coordinate handedness. Neighboring faces must still be oriented
consistently and satisfy PMP's manifold requirements.

An optional caller-owned output maps each original input corner to its native
halfedge, including for CW input. JS can scatter each channel through this map
using direct typed-array writes, with no per-corner Wasm calls. Input indices,
polygon offsets and mapping output must be independent allocations, outside mesh
storage. Allocate all properties first, then reacquire views before filling them.
Packed render vertices that duplicate positions for seams remain distinct PMP
vertices unless the caller explicitly supplies shared topological indices; the
binding does not weld positions implicitly.

Storage support does not imply automatic attribute transfer through every
algorithm. The implemented transfer contract is:

| Operation | Accepted attached channels beyond core storage and derived results |
| --- | --- |
| Normals, feature detection | All; custom channels are untouched |
| Explicit/implicit smoothing, fairing | All; topology and custom rows are unchanged |
| Curvature, connected components, measurements | All; only the named result property is updated where applicable |
| Triangulation | All vertex/corner/face channels, paired features; arbitrary edge channels rejected |
| Decimation | Custom vertex rows, `v:tex`, native `h:tex`, paired features, selection |
| Uniform/adaptive remeshing | Paired features and `v:selected` only |
| Catmull-Clark/Loop | Paired features only |
| Quad-tri/linear subdivision, hole filling | None |

Decimation retains endpoint positions and their complete vertex property rows;
garbage collection remaps these together. Integer joint indices and weights
remain associated with their original surviving vertex, without interpolation
or normalization. Native `h:tex` follows PMP's seam-aware handling: initialize
the complete halfedge channel, including boundary rows, before decimation.
Additional per-corner UV sets are unsupported for decimation. Vertex UVs do not
by themselves supply its per-corner seam constraints.

Paired features means both `v:feature` and `e:feature` exist, with both endpoints
of every marked edge also marked. Both may instead be absent. Upstream interprets
`v:selected` as an input mask; remeshing leaves newly created selection rows false.
Before another call, explicitly refresh or remove that mask if the new vertices
should participate. Decimation may stop above its requested count when topology,
selection, feature, seam, or quality constraints prevent further collapses.

`pmp_mesh_unsupported_properties(mesh, algorithm)` is an allocation-free,
non-mutating preflight returning a domain bitmask: vertex=1, halfedge=2, edge=4,
face=8. An invalid feature pair marks vertex and edge. Zero checks property
support only. The geometry-changing algorithm bindings enforce this policy before
mutation. Callers may explicitly remove unsupported properties or run the
operation on a separate mesh; the binding never silently defaults UV/color/skin
channels. Arbitrary interpolation callbacks and attribute-transfer frameworks
are outside this phase.

Successful geometry mutations remove stale `v:normal`, `f:normal`, `v:curv`,
`geodesic:distance` and `v:component` results. Recompute results after the call.
Triangulation adds no vertices. Each new face copies its source polygon's
`user:*` face rows; each new halfedge copies the source polygon corner targeting
that same vertex, for `user:*` channels and native `h:tex`. Existing halfedge
rows and edge flags stay intact; new diagonals start with `e:feature=false`.
This preserves multiple corner UV sets and face IDs without averaging joint IDs
or crossing seams. Arbitrary edge channels are rejected because new diagonals
have no source row. Copying the necessary new rows occurs inside native storage;
the ABI does not stage or duplicate complete attribute buffers.

Curvature writes `v:curv` (float32); components writes `v:component` (int32),
including isolated vertices as individual components. Read both through property
views. Fairing honors native `v:selected` and boundary constraints; `k` must be
at least one. Native higher orders are accepted; matrix fill and solve costs can
increase substantially. Every numerical method retains its native degeneracy
preconditions and precision.

Bounds requires vertices, edge statistics require edges, and minimum face area
requires faces. Centroid requires finite positive total face area. Undefined
empty-domain calls trap; empty surface area, volume, and component count are zero.
Volume retains PMP's absolute result and triangle precondition. Interpret it as
enclosed volume only for closed, consistently oriented meshes; it is not an
orientation detector or self-intersection validator.

Reserve and garbage collection follow PMP's native property movement; clear
removes properties. Future algorithms must undergo the same transfer review.

### Ownership and invalidation

`pmp_alloc`/`pmp_free` own caller scratch storage with at least 16-byte alignment.
Mesh/matrix/vector destructors own their internal buffers; never free a borrowed
pointer. Any operation that may allocate, grow, compact, replace properties, or
change topology invalidates previously acquired views for that object. As a
simple conservative rule, reacquire views after any mutating algorithm call.
`dual` clears properties. Do not hold input spans into storage that the same
call may reallocate; bulk face inputs belong in independent scratch storage.

There are two independent hazards: C++ vector relocation changes the offset,
and `memory.grow` replaces the JS buffer. Even an allocation on another mesh can
cause the latter. Construct views from the current `memory.buffer`, reacquire
descriptors after mutations, and keep no permanently cached heap views. Only raw C
storage-view getters (with property creation disabled) and direct element edits
promise not to allocate; the JS convenience helpers allocate metadata scratch
and can detach earlier views even during lookups. `meshView` accepts caller
scratch to avoid that allocation; raw property access accepts a persistent C
string. Const algorithms such as analysis can allocate temporary storage.
Mesh counts cannot be changed by writing into a descriptor.

Algorithm entry points require compact indices: live counts must match storage
sizes for vertices, edges and faces. Several upstream solvers size matrices by
live count but index them by raw entity index. Check this in O(1) at the boundary;
the caller explicitly invokes garbage collection when needed. Never compact
silently and invalidate entity IDs. Individual input handles, enum values and
shape/count arithmetic receive cheap boundary validation; raw pointers remain
caller-owned valid spans. Check overflow before multiplication/allocation, and
retain the signed 32-bit Eigen index limit. Numerical/topological preconditions
from upstream remain applicable, including nondegenerate inputs where required.
The implemented geometry/inspection entry points reject non-finite coordinates and invalid scalar
parameters. Cotan smoothing, curvature, fairing and hole filling also check per-polygon dense matrix
dimensions in uint64 before entering Eigen; `(valence+1)^2` doubles must fit its
signed wasm32 allocation limit. Finite inputs alone do not guarantee finite
results for degenerate geometry. Remeshing/hole-filling flip energies use int64
operands so high-valence fans cannot overflow squared int32 errors.
Triangulation bounds its two quadratic tables before allocation: `valence^2`
must fit `INT32_MAX / 8`. Its native cubic-time search remains unchanged; the
allocation guard is not a latency limit. A failed split now traps instead of
indexing the native `-1` sentinel. The binding also checks that every source
n-gon yields exactly n-2 triangles: native blocked-diagonal cases can otherwise
return an unsplit polygon. This failure may follow partial mutation and requires
discarding the instance.

## Freestanding runtime and patches

Use the existing SDK's wasm32 single-thread libraries, with no startup files,
entry point, `_start`, `_initialize`, WASI initialization, imported memory, or
host function imports. Export one ordinary non-shared memory. Static libc
allocation/math/memory routines and the necessary C++ containers can remain;
using SDK libraries at build time does not require a WASI runtime.

No clocks, random source, file/network I/O, logging imports, fake WASI stubs,
or JS callbacks are needed by the selected algorithms. No dynamic constructors
are intended; confirm this in the linked module rather than skipping live
initialization blindly. An unexpected live initializer is a build failure.

Required changes are small, pinned patches, applied with context checks:

1. Remove filesystem includes, `IOFlags` and I/O friends from `surface_mesh.h`;
   remove stream input/output operators and includes from core/analysis headers
   and sources. Remove the diagnostic in the optional TFEM branch of
   `laplace.cpp`; TFEM is not enabled for v1. No printf is used by the selected
   algorithms, but the C++ runtime can otherwise pull formatting in.
2. Replace the one property `dynamic_cast` with a checked per-type identity
   token and `static_cast`. Preserve wrong-type rejection; never replace it
   with an unchecked cast. Then compile without RTTI.
3. Remove C++ throw/catch dependencies. Failures that would escape become
   cold trap paths with no formatted error strings. **Do not blanket-replace
   every throw with a trap:** remeshing catches a singular 3x3 inverse and uses
   a weighted centroid. Convert that internal solve to a boolean/result check
   and preserve its fallback. Review hole-filling's cleanup/rethrow paths too.
4. Add native span overloads for face construction and geodesic seeds, so
   borrowed uint32 input does not require constructing a copied STL vector.
   Construct individual typed handles from indices; respect object lifetimes.
5. Add the narrow connectivity accessors and contiguous bool property storage.
6. Supply minimal trap-only fatal runtime hooks where needed, including
   `abort` and libc++ fatal diagnostics, so their printing implementations are
   never retained. Never stub successful filesystem, socket, random or clock
   operations. Audit archive extraction and the final live symbol graph.

Do not ship regex-transformed source like the feasibility experiment. Check in
the minimal source subset and reviewable diffs against its pinned revision;
verify provenance and build without network access. Preserve numerical formulas
and operation order while making the exception-free fallback explicit. Tests
must compare patched numerical behavior against unmodified native upstream.

The local SDK 32 exception-link probe fails on `__cxa_throw`, exception allocation,
and Wasm unwinder symbols. Downloading or building an exception runtime is
outside this design. No setjmp/longjmp or JS exception emulation is introduced.
Internal recoverable solver failures must be tested before accepting a patch.

### Feasibility evidence

The expanded ABI 0 module exports 52 names including memory and has zero
imports/start/init. `build/report.json` records the exact raw/gzip size, features,
artifact hash and compiler versions. Node and Chromium run the same workflows;
22 original-family and 43 extension fixtures compare against untouched native
PMP, including a tiny
remeshing mesh that exercises the original singular-inverse fallback. Attribute,
seam, repeated-operation, size-guard and memory tests supplement those fixtures.
A 50,000-valence fan regression exercises the widened flip energies and checks
all resulting halfedge/triangle invariants in both runtimes.
The earlier normals/features-only module was 72,725 bytes (24,531 gzip), which
is not the size of the current expanded build.

A limited SDK 32 core probe (mesh construction, destruction and position access)
links and runs with no imports and no initialization call. After Binaryen it is
25,677 bytes. Direct position edits are visible to native code; repeated mesh
lifetimes and memory growth passed. The final module has no start section or
retained I/O, formatting, stack-guard, or WASI initialization symbols. This is
not a full algorithm build, performance benchmark, or complete port validation.

SDK 32 LTO eagerly extracts a stack-check archive member while resolving dead
libcalls; that member brings an entropy constructor. The probe satisfies those
references locally and verifies that **both** guard and failure symbols are
then dead. A live fixed/zero stack canary is not acceptable: reject the build
if either survives, and resolve the actual library dependency instead.

LLD also synthesizes command-style destructor wrappers when constructors are
not explicitly referenced. The probe temporarily exports `__wasm_call_ctors`,
verifies its body is empty, then uses Binaryen metadce with only intended exports
as roots to remove it. This removes unused stdio teardown as well. Never remove
a nonempty constructor this way. The delivered module has no init export or
call; these are build-time dependency-removal checks, not runtime stubs.

## Build and Wasm features

Use WASI SDK 32 and Binaryen 129 by default; allow
explicit environment overrides. Do not
silently switch SDKs or download toolchains/dependencies during an npm build.

Start with C++20, `-O3 -flto -ffreestanding -fno-exceptions -fno-rtti`,
`-ffunction-sections -fdata-sections`, `-DNDEBUG`, and `-DEIGEN_DONT_PARALLELIZE`.
Link with `-nostartfiles`, `--no-entry`, `--gc-sections`, and a precise C export
list. No `--whole-archive`, `--export-all`, `--allow-undefined`, shared memory,
pthread/OpenMP libraries, or `-pthread`. Keep linker maps and symbol information
for auditing before stripping release output. Use one Binaryen `-O3` pass and
strip debug, names and producer metadata after validation.

**The current runtime target is Chrome 75/76.** This supersedes the initial
policy of inheriting the SDK's full feature metadata. Keep the existing SDK 32,
but compile and LTO-link with `-mcpu=mvp -mbulk-memory-opt
-mnontrapping-fptoint -msign-ext`. These instructions all fit Chrome 75.

Keep the linked SDK feature metadata as build evidence, separate from the
runtime requirements. Remove its `target_features` custom section before the
Binaryen passes; otherwise Binaryen can re-enable features from that metadata.
Validate and write with only MVP plus memory.copy/fill, saturating conversions
and sign extension, and emit fresh target metadata. Reject unsupported actual
instructions, not just unknown feature names. Negative fixtures cover extended
constants, reference types, multivalue and SIMD; also verify the legacy single
zero byte for indirect-call table indices. The final artifact must advertise
exactly the intended three features. Keep no `--all-features`, shared memory,
atomics, relaxed SIMD or a silently widened compatibility target.

No numerical code depends on extended constants, reference types or multivalue.
Nontrapping conversions remain enabled because Chrome 75 supports them. The
ES2017 JS wrapper no longer uses optional chaining. Actual Chrome 75/76 execution
is not yet certified; current Node/Chromium runs plus strict binary validation
establish the feature-based target. [COMPATIBILITY.md](COMPATIBILITY.md) records
primary browser support sources, tested runtimes, limits and the SIMD decision.

Do not enable fast-math: PMP uses finite/degenerate checks and numerically
sensitive solvers. Preserve upstream double precision. The measured compiler,
linker and Binaryen pass retains `-O3`/full LTO/Binaryen `-O3`; smaller compiler
profiles slowed representative workloads. See PERFORMANCE.md for the tradeoffs.

Use a 16 KiB linear-memory stack. Ordinary scalar temporaries usually become
Wasm locals, but Eigen's addressable dynamic scratch arrays used `alloca` with
a 128 KiB per-buffer threshold. A 9,409-vertex smoothing case exceeded even
the former 64 KiB stack.
Set `EIGEN_STACK_ALLOCATION_LIMIT=0` so positive dynamic scratch buffers use the
heap. This leaves fixed small matrices and scalars unchanged; Eigen's static
fixed-object size assertion is disabled by that setting. Link `--stack-first`
to place static data above the downward-growing stack. No larger stack or WASI
runtime is required. Native-reference tests cover the failing mesh in Node and
Chromium. `EIGEN_NO_ALLOCA` alone does not compile this pinned Eigen version's
triangular matrix/vector templates, so use the limit setting without a vendor patch.

Allocator tuning is permitted when measurements show significant cost. Start
with the SDK's single-thread allocator and use mesh reservation and reusable
native results. Profile allocation count/time, allocator code bytes, peak memory
and fragmentation during remeshing, subdivision and sparse solves. If justified,
replace only the allocator boundary with a compact single-thread allocator using
linear-memory growth; preserve alignment, free/realloc behavior, overflow/OOM
handling and C++ allocation compatibility. No allocator download or dependency
is assumed. The current build retains SDK dlmalloc and sets
`EIGEN_MALLOC_ALREADY_ALIGNED=1`: wasm32 malloc already provides the 16-byte
alignment Eigen needs. Compile-time checks enforce the target's `max_align_t`
and Eigen alignment requirements. Diagnostic allocator wrapping stays outside
the production ABI and measures usable allocation capacity separately from
retained linear-memory pages. A bump allocator that leaks algorithm temporaries is not a valid
replacement. Select a replacement only after representative repeated-operation
and fragmentation benchmarks; keep one allocator in the shipped binary.

## JS package

One `pmp.wasm`, an ESM loader, `.d.ts` declarations and the C header. No core runtime npm dependencies are required. The optional glTF adapter has an
optional core peer, and its tests use core/extensions as development dependencies. No bundler, TypeScript compiler,
CommonJS duplication, base64 Wasm embedding, or generated C++ binding framework.
Retain upstream MIT, Eigen MPL-2.0 and applicable SDK runtime license notices.

The loader accepts bytes or a compiled module, instantiates with `{}`, and
returns exports. URL loading can be a separate tiny convenience helper, allowing
callers to control fetch or Node file access. Such caller-side loading is not
an import or I/O capability inside the module. No init function is called.
Optional view helpers construct typed arrays over current memory and check the
ABI version. They do not wrap every algorithm or copy mesh arrays. Bulk vertex
and face construction are the only planned helpers to reduce crossing costs.

Version 0.1.0 uses ABI 1. The public package contains the implemented JS/Wasm,
C header, user documentation and complete dependency notices, with an explicit
Wasm subpath export. Proposed APIs are excluded. See [RELEASING.md](RELEASING.md)
for staging, input provenance, installed-tarball checks and publication gates.

## Implementation acceptance

1. Check C11 and C++20 header validity, wasm32 sizes/offsets, the implemented public header/export match and the frozen ABI/export manifest. Keep the proposed coverage list separate.
2. Compile only the source allowlist; inspect archive extraction and the final
   linker map before stripping. Reject live stream/printf/scanf, file/socket,
   clock/random, process/environment, thread/OpenMP, exception-unwind and unused
   startup/stack-initialization machinery. Dead declarations or extracted
   archive members must contribute no retained code/data to the final artifact.
3. Require `WebAssembly.Module.imports(module)` to be exactly `[]`, no start
   section, no WASI/CRT init exports, no shared memory/atomics, and only the
   explicit public exports. Instantiate with `{}` and exercise algorithms
   immediately, including repeated calls, without initialization.
4. Compare deterministic fixtures with native PMP: polygon/triangle topology,
   remeshing and decimation, normals/curvature, internal matrix operators/solvers,
   holes, boundaries and degeneracies. Include the
   remeshing singular-solve fallback and all algorithm families.
5. Prove storage aliasing in both directions, correct empty properties,
   bool-property access, matrix layouts, reserve/growth invalidation and entity
   renumbering. Include `memory.grow` and operations on multiple meshes.
6. Measure final raw/gzip Wasm size, JS bytes, peak memory and representative
   algorithm timings. Core probe size is not a full-library size estimate.
   Confirm npm's payload excludes sources, clones, maps, probes and toolchains.

Keep the implementation split by responsibility: mesh storage, algorithm
boundaries, shared internal checks and fatal runtime hooks. The JS layer remains
a loader and direct view helpers. Native-reference fixtures and shared Node/
browser scenarios validate behavior without generating a binding framework.
