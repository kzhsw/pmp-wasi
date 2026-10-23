# pmp-wasi

A minimal port of [PMP](https://github.com/pmp-library/pmp-library) algorithms to
freestanding, single-threaded WebAssembly using wasi-sdk.

The initial implementation provides mesh construction, zero-copy native views,
typed properties, normals and feature detection. It supports multiple UV sets,
colors and skinning channels, plus CW/CCW bulk input with per-corner mappings for
seams. [exports/core.json](exports/core.json) lists the supported development
exports (ABI 0). The full [C ABI](include/pmp.h) is still a proposal; remeshing,
decimation, solvers and other algorithm families are not implemented yet.

This project targets a future public npm release. Publication is disabled and
the package has no dependencies. npm distribution entry points will follow full
ABI validation and completion of the third-party notices.

[DESIGN.md](DESIGN.md) defines the source boundary, direct mapping to PMP,
zero-copy memory contract, runtime removal, and build acceptance checks.
[upstream.json](upstream.json) pins the reviewed sources and source allowlist.

The intended package contains one `pmp.wasm`, a small ESM loader with TypeScript
declarations, the C header, and license notices. Callers can use the Wasm exports
directly. There is no Emscripten, WASI host, filesystem, socket, worker, or thread
runtime.

Build with an existing WASI SDK and Binaryen installation. Set `WASI_SDK_PATH`
and `BINARYEN_PATH` to their installation directories, then run:

```sh
npm run build
npm test
```

`npm run bench` measures construction, normals and feature detection on a
32,768-triangle grid. `npm run fixtures` regenerates the test baseline using a
host compiler and the unmodified checkout selected by `PMP_UPSTREAM_PATH`.

The build writes `build/pmp-core.wasm` and `build/report.json`. It uses no network,
checks the exact exports, rejects host imports and live I/O/runtime symbols,
proves the unused constructor empty before removing it, and validates instructions
against the linked SDK's feature baseline. Tests compare against fixtures from
unmodified native PMP and exercise memory aliasing, attributes, winding and growth.

For development, import `instantiate`, `meshView`, `attributeView`, `Property`,
`Domain` and `Winding` from `src/index.js`. `instantiate(bytes)` returns the raw
Wasm exports; it needs no WASI object or initialization call. Types are in
`src/index.d.ts` and an end-to-end usage example is in [examples/core.mjs](examples/core.mjs).

Arrays returned by view helpers borrow Wasm storage. Reacquire them after calls
that allocate or change the mesh; JS helper metadata allocations can also grow
memory. Discard the whole instance after a trap. Extra attributes have native
storage support, but automatic interpolation through future topology-changing
algorithms is not implemented. These contracts are detailed in the design.
