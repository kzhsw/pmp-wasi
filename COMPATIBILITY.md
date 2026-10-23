# Compatibility baseline

The development module reports ABI 0; only `exports/core.json` is implemented.
The remaining declarations in `include/pmp.h` are future API, not callable
exports. wasm32 pointers and indices are unsigned 32-bit offsets; native scalar
positions are float32, while Eigen operators and solvers remain float64.

## Chrome 75 target

The build now targets **Chrome 75 and later**, including Chrome 76, by enforcing
its Wasm instructions and JS API requirements. This is a feature-based minimum;
actual execution on Chrome 75/76 has not been certified. The available test
runtimes are Node 24.16.0 and Chromium 151.0.7922.34 (Playwright 1.59.1). Both
byte and compiled-module paths pass in Node, and byte and streaming compilation
paths pass in Chromium, across all five algorithm families.

## Wasm

The existing WASI SDK 32 (Clang 22.1.0) and Binaryen 129 remain the toolchain.
Compilation and LTO use `-mcpu=mvp -mbulk-memory-opt -mnontrapping-fptoint
-msign-ext`. The final artifact advertises exactly these three features:

| Feature | Runtime use | Chrome support |
| --- | --- | --- |
| `bulk-memory-opt` | `memory.copy` and `memory.fill` only | [75](https://v8.dev/blog/v8-release-75#bulk-memory-operations) |
| `nontrapping-fptoint` | Saturating float-to-integer conversions | [75](https://chromestatus.com/feature/4611843511287808) |
| `sign-ext` | Integer sign-extension instructions | [69](https://chromestatus.com/feature/4961472689995776) |

`bulk-memory-opt` is the LLVM/Binaryen name for the copy/fill subset of the
bulk-memory proposal. Extended constants, reference types, multivalue, SIMD,
relaxed SIMD, mutable-global imports/exports and padded indirect-call table
indices are not enabled. Ordinary internal mutable globals are part of MVP.
There are no host imports, start section, initialization calls, threads, atomics,
exception handling or memory64. One unshared memory is exported.

The SDK libraries still advertise newer features. The build records those as
`linkedFeatures` in `build/report.json`, removes only their `target_features`
custom section, then validates and writes the module with Binaryen's explicit
three-feature limit. This is essential: Binaryen can otherwise broaden its
feature set from input metadata. Stripping metadata alone is not compatibility
proof. Unsupported live instructions fail the build; new metadata is emitted
only for the validated output. Regression fixtures reject extended constants,
reference types, multivalue and SIMD, and check that `call_indirect` uses the
legacy single reserved zero byte. Tests independently validate the actual
artifact under the same instruction limit.

Keep `nontrapping-fptoint`: it is available in Chrome 75 and used by the emitted
code. The conversions clamp overflow and produce zero for NaN; invalid API calls
still trap. No libc rebuild, compiler download or lowering of these useful
instructions is necessary. The Chrome 75 build is 327,093 bytes raw / 120,056
gzip, with a 4,502-byte JS wrapper. All 317 function bodies are byte-identical to
the earlier SDK-default build; the changes remove unnecessary metadata and its
unused data-count section.

Memory allocation is subject to the engine and available memory. Chrome 75/76
has the older 2 GiB linear-memory ceiling; access above that requires Chrome 83
or later, as described in [V8's memory-limit update](https://v8.dev/blog/4gb-wasm-memory).
The module starts small and grows on demand. Allocation failure traps; it does
not add a host runtime or fallback allocator.

## JavaScript

The wrapper uses ESM, ES2017 syntax (including async/Promises), typed arrays,
`TextEncoder.encodeInto`, and the standard WebAssembly JS API. ESM shipped in
[Chrome 61](https://chromestatus.com/feature/5365692190687232), async/await in
[55](https://chromestatus.com/feature/5643236399906816), and `encodeInto` in
[74](https://chromestatus.com/feature/5546544912662528). Optional chaining was
removed because it needs [Chrome 80](https://v8.dev/features/optional-chaining).
The browser test modules also avoid optional chaining, nullish coalescing and
`Array.prototype.at`, so they do not impose those newer requirements.

The wrapper accepts bytes or a compiled `WebAssembly.Module`. It uses no DOM,
Node built-ins, BigInt, top-level await, bundler, generated bindings or runtime
dependencies. The caller controls fetching or file loading. Browser
`compileStreaming` needs an HTTP response with `Content-Type: application/wasm`;
byte loading does not. No WASI object, Emscripten runtime, COOP/COEP headers or
workers are required.

Repository development scripts still require Node 22 or later; this does not
set the browser wrapper's minimum. Firefox, Safari and older Node releases have
not been certified. Chrome 75/76 itself is not installed in the test environment,
so the feature gate and current-runtime E2E tests do not substitute for a test
on the historical browser. No browser or toolchain was downloaded for this change.

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

The earlier SDK-default five-family baseline was 327,197 bytes raw / 120,158
gzip; the experimental
SIMD build is 333,575 / 123,583 (+1.95% raw, +2.85% gzip). Both pass the same
Node/Chromium correctness workflows. The scalar baseline's function bodies match
the current Chrome 75 build byte-for-byte.
The experiment is not a second npm artifact
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
