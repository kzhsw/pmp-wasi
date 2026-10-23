# pmp-wasi v1 design

Status: reviewed for implementation; ABI version 1 remains provisional.
The declarations in [include/pmp.h](include/pmp.h) are the proposed contract, not
an implemented or released ABI. Freeze ABI version 1 after implementation and
validation against this document.

## Scope and source boundary

Expose the computational functions in PMP's [algorithms group](https://www.pmp-library.org/group__algorithms.html),
with their original names, arguments, units, numerical precision, and behavior.
The reviewed page contains 77 function entries including overloads. Its one
stream output operator is excluded, leaving **76 C algorithm declarations**.
Nine standalone math helpers stay C-only, leaving **67 Wasm algorithm exports**. Small
mesh/matrix ownership and storage operations are necessary supporting API.

The reviewed PMP revision is `215975ca1efafab97477b18187a4a23b87529036`
(project version 3.0.0); its bundled Eigen is 5.0.1. The xatlas-wasi reference is
`7cf8877decce7cc63f48d91e94ee7410a77402c0`. Exact source paths are recorded in
[upstream.json](upstream.json). Future vendored inputs contain the allowlisted core, algorithm
headers/sources, necessary Eigen headers, and license notices.

Build `surface_mesh.cpp` and the 19 listed algorithm translation units directly.
Do not invoke upstream's top-level CMake: `src/pmp/CMakeLists.txt` unconditionally
includes `io/CMakeLists.txt`, and also searches for OpenMP. The following never
enter our build or npm payload:

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
`triangle_area`, `dist_point_line_segment` and `dist_point_triangle` retain their
C declarations but are not Wasm exports. Their inexpensive scalar calls do not
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
connectivity; the binding makes no intermediate index-vector copy.

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
algorithm calls clean them up. User properties should use a distinct prefix.

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
descriptors after mutations, and keep no permanently cached heap views. Only
storage-view getters and direct element edits promise not to allocate; const
algorithms such as analysis can allocate temporary storage. Mesh counts cannot be changed
by writing into a descriptor.

Algorithm entry points require compact indices: live counts must match storage
sizes for vertices, edges and faces. Several upstream solvers size matrices by
live count but index them by raw entity index. Check this in O(1) at the boundary;
the caller explicitly invokes garbage collection when needed. Never compact
silently and invalidate entity IDs. Individual input handles, enum values and
shape/count arithmetic receive cheap boundary validation; raw pointers remain
caller-owned valid spans. Check overflow before multiplication/allocation, and
retain the signed 32-bit Eigen index limit. Numerical/topological preconditions
from upstream remain applicable, including nondegenerate inputs where required.

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

**v1 uses the feature baseline of the chosen SDK compiler and linked libc
objects.** Do not force MVP, enable SIMD/relaxed SIMD, use `--all-features`, or
hand-select a different target CPU. Record module `target_features` and feed
the same allowed feature set to Binaryen. Fail if the result adds features,
atomics, shared memory, or a different memory model. Retained feature metadata
is a conservative compatibility baseline, not proof every feature is used.

The SDK 32 core probe reports mutable-globals, nontrapping-fptoint, bulk-memory,
sign-ext, reference-types, multivalue and extended-const. Binaryen also reports
bulk-memory-opt and call-indirect-overlong as feature/encoding switches. Record
the full module's final baseline when all algorithms are linked; do not infer
it from the SDK version alone. Feature tuning is deferred as requested.

Do not enable fast-math: PMP uses finite/degenerate checks and numerically
sensitive solvers. Preserve upstream double precision. Later benchmark `-O3`
against `-Os`/`-Oz`, inlining and SIMD before choosing a speed/size tradeoff;
no single setting can guarantee both the fastest and smallest result.

Allocator tuning is permitted when measurements show significant cost. Start
with the SDK's single-thread allocator and use mesh reservation and reusable
native results. Profile allocation count/time, allocator code bytes, peak memory
and fragmentation during remeshing, subdivision and sparse solves. If justified,
replace only the allocator boundary with a compact single-thread allocator using
linear-memory growth; preserve alignment, free/realloc behavior, overflow/OOM
handling and C++ allocation compatibility. No allocator download or dependency
is assumed. A bump allocator that leaks algorithm temporaries is not a valid
replacement. Select a replacement only after representative repeated-operation
and fragmentation benchmarks; keep one allocator in the shipped binary.

## JS package

One `pmp.wasm`, an ESM loader, `.d.ts` declarations and the C header. No runtime
or development npm dependencies are required. No bundler, TypeScript compiler,
CommonJS duplication, base64 Wasm embedding, or generated C++ binding framework.
Retain upstream MIT, Eigen MPL-2.0 and applicable SDK runtime license notices.

The loader accepts bytes or a compiled module, instantiates with `{}`, and
returns exports. URL loading can be a separate tiny convenience helper, allowing
callers to control fetch or Node file access. Such caller-side loading is not
an import or I/O capability inside the module. No init function is called.
Optional view helpers construct typed arrays over current memory and check the
ABI version. They do not wrap every algorithm or copy mesh arrays. Bulk vertex
and face construction are the only planned helpers to reduce crossing costs.

The repository is intended for public release, but nothing is published now.
Keep npm `private: true` during implementation. Before release, add real package
entry points, declarations and an explicit Wasm subpath export; include only the
built JS/Wasm, C header and notices. Supply actual repository metadata when a
public remote exists. Do not publish stubs or paths to nonexistent build output.

## Implementation acceptance

1. Check C11 and C++20 header validity, wasm32 sizes/offsets, the 76-function C
   coverage list, the 67 Wasm algorithms, and a frozen ABI/export manifest.
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
   remeshing and decimation, normals/curvature, matrix operators, solvers,
   parameterization, shapes, holes, boundaries and degeneracies. Include the
   remeshing singular-solve fallback and all algorithm families.
5. Prove storage aliasing in both directions, correct empty properties,
   bool-property access, matrix layouts, reserve/growth invalidation and entity
   renumbering. Include `memory.grow` and operations on multiple meshes.
6. Measure final raw/gzip Wasm size, JS bytes, peak memory and representative
   algorithm timings. Core probe size is not a full-library size estimate.
   Confirm npm's payload excludes sources, clones, maps, probes and toolchains.

The implementation should need only a small C++ binding file, a runtime file,
the JS loader/declarations, a build script and a Wasm audit script, plus focused
upstream patches and behavior fixtures. Add infrastructure only when needed.
