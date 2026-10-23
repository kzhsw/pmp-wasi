# pmp-wasi

A minimal port of [PMP](https://github.com/pmp-library/pmp-library) algorithms to
freestanding, single-threaded WebAssembly using wasi-sdk.

The development build implements the five requested algorithm families and
these additional mesh operations:

| Family | Direct C/Wasm functions |
| --- | --- |
| Decimation | `pmp_decimate` |
| Remeshing | `pmp_uniform_remeshing`, `pmp_adaptive_remeshing` |
| Subdivision | `pmp_catmull_clark_subdivision`, `pmp_loop_subdivision`, `pmp_quad_tri_subdivision`, `pmp_linear_subdivision` |
| Smoothing | `pmp_explicit_smoothing`, `pmp_implicit_smoothing` |
| Hole filling | `pmp_fill_hole` |
| Triangulation | `pmp_triangulate`, `pmp_triangulate_face` |
| Components | `pmp_connected_components` |
| Measurements | `pmp_bounds`, `pmp_surface_area`, `pmp_volume`, `pmp_centroid`, `pmp_mean_edge_length`, `pmp_min_edge_length`, `pmp_min_face_area` |
| Curvature | `pmp_curvature` |
| Fairing | `pmp_fair`, `pmp_minimize_area`, `pmp_minimize_curvature` |

It also provides mesh construction, normals, feature detection, zero-copy native
views, typed attributes, and CW/CCW input with per-corner mappings. Multiple UV
sets, colors and skinning channels have native storage. Attribute transfer has
explicit limits: smoothing and fairing preserve channels; triangulation copies
source polygon corner/face channels and preserves vertices; decimation retains surviving
vertex rows and supports PMP's seam-aware `h:tex`; other topology changes reject
channels they cannot transfer. An allocation-free preflight query reports these
before mutation. See the [attribute contract](DESIGN.md#additional-attributes-and-winding).

[exports/core.json](exports/core.json) is the exact implemented export list
(ABI 0). The [C header](include/pmp.h) declares exactly that implemented API and
version. Unimplemented declarations live in [design/pmp-proposed.h](design/pmp-proposed.h). The core has no runtime dependencies. This private project targets a future
public npm release; development JS entry points are available, while the Wasm
artifact remains a local build and runtime distribution notices are completed.

Build with existing WASI SDK and Binaryen installations. Set `WASI_SDK_PATH`
and `BINARYEN_PATH` to their directories, then run:

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:e2e
npm run bench
npm run size
npm run test:upstream
npm run test:fuzz
npm run profile:memory -- --build
```

Browser tests require `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and
optionally `PLAYWRIGHT_CHROMIUM_ARGS`/the browser's system library search path.
They use an existing installation and download nothing. `npm run test:e2e:node`
runs the same workflows in Node alone. `npm run fixtures` regenerates the native test
baselines with a host compiler and the pinned, unmodified checkout selected by
`PMP_UPSTREAM_PATH`.

The build writes `build/pmp-core.wasm` and `build/report.json`. It uses no network,
checks exact exports, rejects host imports and live I/O/runtime symbols, proves
the unused constructor empty before removing it, and validates instructions
against the Chrome 75 feature limit. No WASI host or initialization call is
needed. Node/browser tests exercise all implemented algorithm entry points, native
reference results, repeated operations, seams, attributes, winding, memory
growth, traps and remeshing's numerical fallback.

Import `instantiate`, `meshView`, `attributeView`, `Property`, `Domain`, `Winding`,
`Algorithm` and `Curvature` from `src/index.js` during development. `instantiate(bytes)` or
`instantiate(module)` returns the raw exports. The wrapper does not load files,
fetch URLs, copy mesh buffers, or wrap individual algorithms. Types are in
`src/index.d.ts`; [examples/core.mjs](examples/core.mjs) shows direct storage,
multiple attributes and preflight use.

Borrowed arrays must be reacquired after allocation or mutation, including
helper metadata allocations. Discard the entire instance after a trap.
[DESIGN.md](DESIGN.md) specifies ownership, preconditions and source boundaries;
[COMPATIBILITY.md](COMPATIBILITY.md) records the Chrome 75/76 feature target,
Wasm/JS requirements and tested runtimes. [upstream.json](upstream.json) pins the reviewed sources.

`npm run size` relinks verified build objects to measure each added export group.
`npm run test:upstream` runs the relevant unchanged PMP tests against both original
and adapted native C++ sources; it requires `PMP_UPSTREAM_PATH` and the checkout's
bundled GoogleTest. `npm run test:fuzz` runs seeded JS/Wasm cases and a C11 caller
against the adapted native implementation with AddressSanitizer and
UndefinedBehaviorSanitizer. Both use existing local compilers and dependencies.
`npm run profile:memory -- --build` creates a separate diagnostic artifact and
checks allocation peaks, reservation choices and repeated mesh lifetimes.
[PERFORMANCE.md](PERFORMANCE.md) records size, compiler/linker/Binaryen tuning,
memory measurements and the selected allocator configuration.

The optional [glTF-Transform adapter](GLTF_TRANSFORM.md) is available through
`pmp-wasi/gltf-transform`. It provides all five mesh-processing families plus
fairing, normals and measurements, with document/mesh/primitive selection,
attribute and morph transfer, and multi-set skinning. It accepts caller-owned
PMP exports or instances. `@gltf-transform/core` is an optional peer and test
dependency; importing the core does not load it. Adapter copies and approximate
transfer policies are separate from the core's zero-copy contract.

Run `npm run test:gltf:node` for its NodeIO tests, or `npm run test:gltf` with
`ESBUILD_MODULE` pointing to an existing esbuild installation plus the browser
settings above. The latter compares NodeIO and WebIO GLB roundtrips, synthetic
models, seeded fuzz cases and optional local GLB fixtures. No browser, compiler
or bundler is downloaded by these scripts.
