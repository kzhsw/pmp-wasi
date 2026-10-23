# pmp-wasi

[PMP](https://github.com/pmp-library/pmp-library) mesh processing in a compact,
freestanding WebAssembly module. Decimate, remesh, subdivide, smooth and fill
holes through a direct C API, with a small JavaScript loader and zero-copy views
of native mesh storage.

The module is **334,638 bytes** (125,248 gzip). It has no runtime imports or
initialization calls. It runs single-threaded without WASI, Emscripten, a
filesystem, network access or workers. The core JS entry has no dependencies.
The project is **MIT licensed**, matching PMP; bundled dependencies retain their
own [licenses and notices](THIRD_PARTY_NOTICES.md).

Install **0.1.0 / ABI 1**:

```sh
npm install pmp-wasi
```

## Load the module

In Node.js 22 or later:

```js
import { readFile } from 'node:fs/promises';
import { instantiate, meshView } from 'pmp-wasi';

const bytes = await readFile(new URL(import.meta.resolve('pmp-wasi/pmp.wasm')));
const pmp = await instantiate(bytes);
```

For a browser, serve `src/index.js` and `dist/pmp.wasm` from the package as
`/assets/pmp/index.js` and `/assets/pmp/pmp.wasm`. Load them from a module script:

```js
import { instantiate, meshView } from '/assets/pmp/index.js';

async function main() {
  const response = await fetch('/assets/pmp/pmp.wasm');
  if (!response.ok) throw new Error(`Wasm request failed: ${response.status}`);
  const pmp = await instantiate(await response.arrayBuffer());
  // Use pmp here.
}
main().catch(console.error);
```

`instantiate` also accepts a compiled `WebAssembly.Module`, so it can be shared
across independent instances. For streaming compilation, pass
`await WebAssembly.compileStreaming(fetch(url))` and serve the Wasm file with
`Content-Type: application/wasm`. Bundlers can resolve the public
`pmp-wasi/pmp.wasm` asset path using their asset handling. Fetching and file
loading remain under your control. Use the JS wrapper and Wasm binary from the
same package version; no compatibility layer is provided.

## Process a mesh

With `pmp` loaded as above, create a triangle, write its positions directly into
Wasm memory, and subdivide it:

```js
const mesh = pmp.pmp_mesh_create();
pmp.pmp_mesh_add_vertices(mesh, 3);
meshView(pmp, mesh).positions.set([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
]);
pmp.pmp_mesh_add_triangle(mesh, 0, 1, 2);
pmp.pmp_linear_subdivision(mesh);

const result = meshView(pmp, mesh);
console.log(result.liveVertices, result.liveFaces); // 6, 4
const positions = result.positions.slice();       // Optional owned JS copy.
pmp.pmp_mesh_destroy(mesh);
```

Views alias native storage. Reacquire them after calls that allocate or mutate,
including view-helper metadata allocations and operations on other meshes.
Connectivity is a read-only halfedge structure; positions and exposed attribute
rows are writable. Release owned meshes with `pmp_mesh_destroy`, and scratch
buffers with `pmp_free`. If a native call traps, discard the whole instance
without calling cleanup functions on it.

| Operation | C / Wasm entry points |
| --- | --- |
| Decimation | `pmp_decimate` |
| Remeshing | `pmp_uniform_remeshing`, `pmp_adaptive_remeshing` |
| Subdivision | `pmp_catmull_clark_subdivision`, `pmp_loop_subdivision`, `pmp_quad_tri_subdivision`, `pmp_linear_subdivision` |
| Smoothing | `pmp_explicit_smoothing`, `pmp_implicit_smoothing` |
| Hole filling | `pmp_fill_hole` |
| Triangulation | `pmp_triangulate`, `pmp_triangulate_face` |
| Fairing | `pmp_fair`, `pmp_minimize_area`, `pmp_minimize_curvature` |
| Inspection | Bounds, area, volume, centroid, edge lengths, face area, curvature, connected components |

Normals and feature detection are also included. The [API guide](API.md) explains
ownership, attributes, winding and algorithm preconditions. The implemented
[C header](include/pmp.h) and TypeScript declarations give every signature.

## Attributes and glTF

The core stores multiple UV sets, colors, joint indices, weights and custom
channels in native property arrays. Bulk face insertion accepts CW or CCW input
and can map each source corner to a native halfedge. Attribute preservation
depends on the operation; the core rejects channels it cannot transfer. Query
`pmp_mesh_unsupported_properties` before mutation.

For glTF assets, install the optional peer:

```sh
npm install @gltf-transform/core@^4.5.1
```

```js
import { NodeIO } from '@gltf-transform/core';
import { decimate, smooth } from 'pmp-wasi/gltf-transform';

const io = new NodeIO();
const document = await io.read('input.glb');
await document.transform(
  decimate(pmp, { ratio: 0.6, targetScope: 'document' }),
  smooth(pmp, { iterations: 1 }),
);
await io.write('output.glb', document);
```

Register any extensions required by your assets with NodeIO or WebIO. Transforms
accept exports from `instantiate`, a `WebAssembly.Instance`, or a wrapper
containing `instance` or `exports`. Select whole documents, meshes or primitives
and override parameters per primitive. The adapter copies accessor data and
supports approximate transfer of UVs, colors, morph targets and multiple skin
sets when topology changes. See the [glTF guide](GLTF_TRANSFORM.md) for all
options and transfer limits.

## Compatibility

The core targets Chrome 75+ features; the optional glTF adapter targets Chrome
93+. Historical Chrome versions have not been execution-tested. Tests run in
Node 24 and current Chromium. Wasm uses float32 positions, float64 solver
arithmetic, a 16 KiB linear-memory stack and one initial 64 KiB memory page.
SIMD and extended constants are disabled. See [compatibility](COMPATIBILITY.md)
and [performance measurements](PERFORMANCE.md) for the precise scope.

To build or contribute, see the repository's
[contributor guide](https://github.com/kzhsw/pmp-wasi/blob/main/CONTRIBUTING.md).
