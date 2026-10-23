# Compatibility baseline

The development module reports ABI 0; only `exports/core.json` is implemented.
The remaining declarations in `include/pmp.h` are future API, not callable
exports. wasm32 pointers and indices are unsigned 32-bit offsets; native scalar
positions are float32, while Eigen operators and solvers remain float64.

## Wasm

The supported build uses WASI SDK 32 (Clang 22.1.0) and Binaryen 129. Its recorded
`target_features` are:

- `bulk-memory`, `bulk-memory-opt`
- `call-indirect-overlong`
- `extended-const`
- `multivalue`
- `mutable-globals`
- `nontrapping-fptoint`
- `reference-types`
- `sign-ext`

These are the conservative compiler/linked-library baseline. Not every recorded
feature necessarily has a live instruction. `bulk-memory-opt` and
`call-indirect-overlong` include toolchain validation/encoding switches, rather
than separate application capabilities. Binaryen starts with MVP validation
and enables exactly these switches; this does not downgrade the artifact to MVP.
Different SDK inputs must pass the same build audits and be validated separately.

**Keep `nontrapping-fptoint` enabled.** SDK 32 already enables it, and the linked
artifact contains saturating float-to-integer conversions. They clamp overflow
and produce zero for NaN, as specified by the [WebAssembly proposal](https://github.com/WebAssembly/nontrapping-float-to-int-conversions/blob/main/proposals/nontrapping-float-to-int-conversion/Overview.md).
Disabling it would change the SDK baseline and can require scalar conversion
sequences. This says nothing about invalid API calls: those still trap.

The supported artifact uses one unshared memory and has no imports, start
section, init export, threads, atomics, exception handling, relaxed SIMD or
memory64. No WASI object, Emscripten runtime, COOP/COEP headers or workers are
required. Runtime allocation/math/memory functions are linked internally;
filesystem, socket, stream and printf implementations are absent.

## JavaScript

The wrapper is browser-compatible ESM with async/Promises, ES2020 optional
chaining, typed arrays, `TextEncoder.encodeInto`, and the standard WebAssembly
JS API. It accepts bytes or a compiled `WebAssembly.Module`. It uses no DOM,
Node built-ins, BigInt, bundler, generated bindings or runtime dependencies.
The caller controls fetching or file loading. Browser `compileStreaming` needs
an HTTP response with `Content-Type: application/wasm`; byte loading does not.

Repository development scripts require Node 22 or later (the package engine
range); that is separate from the wrapper's language/API requirements. Verified
runtimes are Node 24.16.0 and Chromium 151.0.7922.34 using Playwright 1.59.1.
Both byte and compiled-module paths pass in Node; byte and streaming compilation
paths pass in Chromium. Firefox, Safari, older browsers and older Node versions
have not been certified. These tested versions are not claimed as the earliest
compatible versions. Instantiate the actual artifact to check engine support.

All view helpers borrow native storage. Memory growth on any mesh can detach
arrays; property/topology changes can also relocate storage without growing
memory. Reacquire views after calls that allocate or mutate. A Wasm trap requires
abandoning the whole instance, since native stack/temporary ownership may not be
restored. Pointer validity remains a raw-API caller precondition.

## SIMD decision for this phase

Keep one supported build **without SIMD**. An isolated `-msimd128` experiment
used identical PMP/Eigen sources, `-O3`/LTO and Binaryen 129, adding only that
compiler/linker flag and explicit `simd128` validation. No relaxed SIMD or
fast-math was enabled. Eigen 5.0.1 has no Wasm packet backend: its float/double
packet widths remain one. Emitted SIMD therefore comes from Clang's loop/SLP
auto-vectorization, with no source-level SIMD patches.

The five-family baseline is 327,197 bytes raw / 120,158 gzip; the experimental
SIMD build is 333,575 / 123,583 (+1.95% raw, +2.85% gzip). Both pass the same
Node/Chromium correctness workflows. The experiment is not a second npm artifact
or an automatic runtime-selection path.

`scripts/bench.mjs` measures every entry point on a 1,681-vertex, 3,200-triangle
curved grid, except hole filling, which uses the small annulus refinement fixture.
Each measurement starts with a fresh mesh; setup is excluded. Five warmups precede
15 samples, variant order alternates, and the median is reported. A repeated
Node 24.16.0 comparison gave these milliseconds:

| Operation | Baseline | SIMD |
| --- | ---: | ---: |
| Decimation | 10.540 | 10.398 |
| Uniform remeshing | 23.699 | 23.342 |
| Adaptive remeshing | 11.599 | 11.242 |
| Catmull-Clark | 1.256 | 1.277 |
| Loop | 1.138 | 1.129 |
| Quad-tri | 1.369 | 1.375 |
| Linear subdivision | 0.912 | 0.918 |
| Explicit smoothing | 0.796 | 0.791 |
| Implicit smoothing | 3.867 | 3.916 |
| Hole refinement/fairing | 0.201 | 0.198 |

An earlier Node run showed a 9% decimation gain, but it fell to 1.4% on repeat.
Chromium 151 measured decimation at 9.6/9.7 ms, uniform remeshing at 23.5/23.2 ms,
and adaptive remeshing at 11.5/11.2 ms. Browser timer quantization makes short
operations unsuitable for precise percentage comparisons. Both variants reached
the same 2,424,832-byte linear-memory capacity in the Node benchmark.

These inputs do not establish a general SIMD speedup. The small consistent gain
in adaptive remeshing does not currently justify another supported artifact and
compatibility target. Revisit with real workload profiles or upstream SIMD
support. The default feature audit deliberately continues to reject SIMD. To
compare separately built artifacts, run `npm run bench -- path/to/a.wasm
path/to/b.wasm`; measurements are workload/engine dependent, not performance
thresholds or a claim of globally optimal speed or size.
