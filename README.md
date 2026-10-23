# pmp-wasi

A minimal port of [PMP](https://github.com/pmp-library/pmp-library) algorithms to
freestanding, single-threaded WebAssembly using wasi-sdk.

The development build implements all five requested algorithm families:

| Family | Direct C/Wasm functions |
| --- | --- |
| Decimation | `pmp_decimate` |
| Remeshing | `pmp_uniform_remeshing`, `pmp_adaptive_remeshing` |
| Subdivision | `pmp_catmull_clark_subdivision`, `pmp_loop_subdivision`, `pmp_quad_tri_subdivision`, `pmp_linear_subdivision` |
| Smoothing | `pmp_explicit_smoothing`, `pmp_implicit_smoothing` |
| Hole filling | `pmp_fill_hole` |

It also provides mesh construction, normals, feature detection, zero-copy native
views, typed attributes, and CW/CCW input with per-corner mappings. Multiple UV
sets, colors and skinning channels have native storage. Attribute transfer has
explicit limits: smoothing preserves channels; decimation retains surviving
vertex rows and supports PMP's seam-aware `h:tex`; other topology changes reject
channels they cannot transfer. An allocation-free preflight query reports these
before mutation. See the [attribute contract](DESIGN.md#additional-attributes-and-winding).

[exports/core.json](exports/core.json) is the exact implemented export list
(ABI 0). The larger [C header](include/pmp.h) remains a proposal for the rest of
PMP's algorithm API. This private, dependency-free project targets a future
public npm release; the current npm payload contains design metadata, without a
runtime entry point, while the remaining ABI and runtime notices are completed.

Build with existing WASI SDK and Binaryen installations. Set `WASI_SDK_PATH`
and `BINARYEN_PATH` to their directories, then run:

```sh
npm run build
npm test
npm run test:e2e
npm run bench
```

Browser tests require `PLAYWRIGHT_MODULE`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE`, and
optionally `PLAYWRIGHT_CHROMIUM_ARGS`/the browser's system library search path.
They use an existing installation and download nothing. `npm run test:e2e:node`
runs the same workflows in Node alone. `npm run fixtures` regenerates both test
baselines with a host compiler and the pinned, unmodified checkout selected by
`PMP_UPSTREAM_PATH`.

The build writes `build/pmp-core.wasm` and `build/report.json`. It uses no network,
checks exact exports, rejects host imports and live I/O/runtime symbols, proves
the unused constructor empty before removing it, and validates instructions
against the Chrome 75 feature limit. No WASI host or initialization call is
needed. Node/browser tests exercise all ten algorithm entry points, native
reference results, repeated operations, seams, attributes, winding, memory
growth, traps and remeshing's numerical fallback.

Import `instantiate`, `meshView`, `attributeView`, `Property`, `Domain`, `Winding`
and `Algorithm` from `src/index.js` during development. `instantiate(bytes)` or
`instantiate(module)` returns the raw exports. The wrapper does not load files,
fetch URLs, copy mesh buffers, or wrap individual algorithms. Types are in
`src/index.d.ts`; [examples/core.mjs](examples/core.mjs) shows direct storage,
multiple attributes and preflight use.

Borrowed arrays must be reacquired after allocation or mutation, including
helper metadata allocations. Discard the entire instance after a trap.
[DESIGN.md](DESIGN.md) specifies ownership, preconditions and source boundaries;
[COMPATIBILITY.md](COMPATIBILITY.md) records the Chrome 75/76 feature target,
Wasm/JS requirements and tested runtimes. [upstream.json](upstream.json) pins the reviewed sources.
