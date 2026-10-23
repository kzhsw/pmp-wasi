# Optional glTF-Transform adapter

The `pmp-wasi/gltf-transform` entry point provides document transforms for
decimation, remeshing, subdivision, smoothing and hole filling, plus fairing,
normal generation and read-only measurements. It uses the same freestanding
Wasm module as the core. Only this entry point requires the optional peer
`@gltf-transform/core` (tested with 4.5.1). The core entry point remains independent
of glTF-Transform.

```js
import { instantiate } from 'pmp-wasi';
import { decimate, remesh, process, analyze } from 'pmp-wasi/gltf-transform';

// The caller loads bytes and reads the glTF document with NodeIO or WebIO.
const pmp = await instantiate(wasmBytes);
await document.transform(decimate(pmp, { ratio: 0.6 }));

// Process just one mesh. Every node sharing that mesh sees the result.
const mesh = document.getRoot().listMeshes()[0];
await document.transform(remesh(pmp, {
  meshes: [mesh], method: 'uniform', edgeLength: 0.05, iterations: 3,
  attributeTransfer: 'project', maxProjectionDistance: 0.1,
}));

// Synchronous processing returns detailed per-primitive reports.
const reports = process(document, pmp, {
  operation: 'decimate', targetVertices: 10000, targetScope: 'document',
  parameters: ({ mesh }) => ({ normalDeviation: mesh.getName() === 'detail' ? 5 : 20 }),
});
const measurements = analyze(document, pmp, { meshes: [mesh] });
```

`source` accepts the raw exports returned by `instantiate`, a
`WebAssembly.Instance`, `{instance}`, or `{exports}`. Ownership stays with the
caller. No instance is created, fetched or initialized by the adapter. A Wasm
trap invalidates that instance, including aliases of the same memory; replace
it before further processing. Ordinary JS validation failures release native
allocations and leave the instance usable.

## Selection, budgets and coordinates

By default, a transform visits each primitive of every root mesh. `meshes`,
`primitives` and `filter(context)` intersect. Each shared primitive is processed
once. Context contains the document, mesh, primitive, their indices and input
vertex/triangle counts. `parameters(context)` overrides operation parameters per
primitive; it cannot change selection, callbacks, operation or budget scope.
An overridden `targetVertices` replaces an outer `ratio`, and vice versa.

Primitives remain separate surfaces, preserving material boundaries. The adapter
does not weld coincident positions or merge primitives. Disconnected vertex fans
are split into identical position/attribute rows by default; `splitVertices:
false` rejects them. Nonmanifold edges, inconsistent winding, duplicate faces,
nonfinite data and zero-area triangles are rejected before native processing.
Unreferenced vertex rows are rejected for active numerical/topology operations
that cannot safely handle them. Indexed/unindexed triangles, strips and fans
are accepted. Repeated-index strip connectors are omitted. Lines and points are
skipped unless `unsupported: 'error'` is selected. Input `winding: 'cw'` is
canonicalized to CCW output, as required by glTF.

All distances, areas, solver settings and measurements are in **mesh-local
coordinates**. Node transforms, instancing, skeletons and animation bindings are
retained. A shared primitive is changed in every owning mesh, and skin validation covers
all affected owners. A shared mesh is changed for all of its nodes; clone it explicitly
before calling the adapter when only one instance should change.

Decimation `ratio` defaults to 0.5. `targetVertices` is an alternative, and
`targetScope` selects a per-primitive, per-mesh or whole-document budget across
the selected surfaces. Shared budgets are apportioned by available vertex
capacity with at least three vertices per primitive. Targets are best effort:
topology, seams and quality constraints can stop decimation early. Reports give
the allocated target and actual result. A primitive shared across different
meshes cannot use a mesh budget because ownership would be ambiguous.

## Operations and options

| Factory / operation | Parameters |
| --- | --- |
| `decimate` | `ratio` or `targetVertices`, `targetScope`, `aspectRatio`, `edgeLength`, `maxValence`, `normalDeviation`, `hausdorffError`, `seamThreshold`, `seamAngleDeviation`, `seamTexcoord` |
| `remesh` | `method: 'uniform'` with `edgeLength`, or `'adaptive'` with `minEdgeLength`, `maxEdgeLength`, `approxError`; `iterations`, `projection` |
| `subdivide` | `method: 'loop'` (default), `'catmullClark'`, `'quadTri'`, or `'linear'`; `iterations`, `boundary: 'interpolate'|'preserve'` |
| `smooth` | `method: 'explicit'` (default) or `'implicit'`; `iterations`, `uniformLaplace`; implicit-only `timestep`, `rescale` |
| `fillHoles` | `maxEdges` (default 32), `maxPerimeter`, `maxHoles`, `holeFilter({vertices, positions, perimeter})` |
| `fair` | `method: 'fair'` with `k` (default 2), or `'area'` / `'curvature'` |
| `recomputeNormals` / `operation: 'normals'` | Generate normals, including when absent |
| `analyze(document, source, options)` | Bounds, area, absolute volume, centroid, minimum face area, min/mean edge length and component count; no document edits |

Decimation defaults to `aspectRatio: 5` in this adapter to avoid unusable faces
from unconstrained collapses. The raw C/Wasm default remains 0. `seamTexcoord`
selects one UV set for PMP's seam constraint (default 0, `null` disables it);
all UV sets are transferred. Angles use PMP's degree units. Remeshing defaults
to ten iterations and projection enabled. Smoothing/subdivision default to one
iteration. Implicit smoothing defaults to timestep 0.001 and rescaling enabled.
Catmull-Clark/quad output is triangulated after all subdivision iterations.

`selectedVertices` contains original POSITION row indices and is supported for
decimation, remeshing and fairing. An empty selection is explicitly a no-op;
PMP's native all-false selection otherwise means no restriction. Smoothing
does not support selection. `preserveBoundary` fixes original boundary rows in
decimation/remeshing and selects preserved boundaries for subdivision.
`featureAngle` detects feature edges for decimation, remeshing, Loop and
Catmull-Clark. Fairing requires boundary or selection constraints. Other
unsupported option/operation combinations fail explicitly.

Hole filling cannot distinguish a desired hole from an outer boundary. Use
edge/perimeter limits and a `holeFilter` to choose loops deliberately. Filter
positions are owned copies, and its vertex indices refer to the prepared mesh,
including any split fans. Native hole refinement may change surrounding geometry.
Volume is an enclosed-volume measurement only for a closed, consistently
oriented surface.

## Attributes, skins and morphs

Decimation retains exact source vertex rows. Smoothing/fairing keep their rows.
New topology uses nearest-source-triangle barycentric transfer with a JS BVH.
This is an **approximation**, particularly across nearby surfaces, UV seams,
hard normal boundaries and newly filled regions. A geometric nearest point does
not identify the correct side of coincident attribute seams. Explicitly split
such surfaces into primitives or use `attributeTransfer: 'strict'` to reject
channels requiring projection. `maxProjectionDistance` limits geometric error,
but cannot resolve ambiguous coincident surfaces.

- Multiple UV sets, colors and floating custom attributes interpolate.
  Normalized integer channels decode and re-encode; unnormalized integer custom
  channels select the greatest-weight corner. Exact row paths retain storage.
- JOINTS/WEIGHTS sets are processed together. Projected influences merge by joint
  ID, keep the strongest available slots across all sets and renormalize.
  Projected weights use float32; exact rows retain their original types.
- Morph POSITION deltas use the same correspondence. Target order, mesh/node
  weights and animation bindings stay intact. Preserving these deltas describes
  offsets from the changed base mesh; it is not a separate remeshing of every
  animated pose.
- Existing normals are recomputed by default. Existing morph NORMAL deltas are
  recomputed from the morphed surface against the new base normal. The same
  angle-weighted routine is used for both. Normal-only targets require explicit
  `normals: 'preserve'` or `'drop'`. Without morph normals, native PMP computes
  the base normals. `recomputeNormals` creates missing base normals.
- Tangents and morph tangent deltas are dropped by default after processing.
  Consumers can regenerate them. `tangents: 'preserve'` retains/transfers them
  explicitly, accepting that they may no longer describe the modified surface.
  Materials and normal textures remain attached.

Quantized POSITION values decode to float32 without changing node transforms.
Sparse/interleaved input is handled through glTF-Transform's decoded accessor
arrays. Shared accessors and targets are cloned for edited primitives; unselected
users keep their original data. Primitive and accessor extensions are rejected
because their geometry semantics are unknown to this adapter. Materials, nodes
and other unaffected extension properties remain attached.

## Ownership, limits and testing

The adapter copies accessors into Wasm and copies output arrays back into glTF.
It does not claim zero-copy processing of external glTF buffers. Native calls
operate on PMP's own storage, and each temporary mesh is destroyed afterward.
All selected results are staged before replacing graph references. Input errors,
native traps, transfer failures and report-callback failures leave the document
unchanged. Callbacks must not mutate the document themselves. `invalid: 'skip'`
skips recoverable input preflight failures, never native traps.

`maxVertices` defaults to 5,000,000. Subdivision growth is checked beforehand;
remeshing/hole growth is checked after native execution, so this is not an OOM
or execution-time sandbox. Staging a large document retains all selected output
arrays until commit. Process meshes separately when a smaller transaction is
more appropriate. Wasm memory can grow but cannot shrink.

`npm run test:gltf:node` runs synthetic and seeded model tests with GLB
serialization/reloading. `npm run test:gltf` additionally runs the same scenarios
through browser WebIO and compares results with NodeIO. Set `ESBUILD_MODULE` and
the existing Playwright/browser environment variables described in the
[contributor guide](https://github.com/kzhsw/pmp-wasi/blob/main/CONTRIBUTING.md).
`--seeds 256 --seed 0` selects a bounded reproducible fuzz run. `--models FILE`
accepts a private JSON array of `{path, name, primitives?: [[meshIndex,
primitiveIndex]], options?: {...}}` GLB cases. Inputs are read only; asset paths
and bytes are not included in the public test fixtures or package.

See [COMPATIBILITY.md](COMPATIBILITY.md) for the separate optional-adapter
baseline and [src/gltf-transform.d.ts](src/gltf-transform.d.ts) for complete types.

`npm run profile:gltf` measures the optional adapter bundle, end-to-end processing
time and repeated native lifetimes. First build the diagnostic artifact with
`npm run profile:memory -- --build`; set `ESBUILD_MODULE` to the existing bundler.
The profiler runs Node with explicit GC and records JS/external/ArrayBuffer
accounting separately from native usable allocations. [PERFORMANCE.md](PERFORMANCE.md)
records the measured size, accounting limits and representative workloads.
