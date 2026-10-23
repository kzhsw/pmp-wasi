# Size and tuning measurements

Measurements use the pinned PMP/Eigen sources, WASI SDK 32 (Clang 22.1.0),
Binaryen 129, and the Chrome 75 scalar feature target. Sizes are bytes; gzip uses
Node's default gzip settings. There are 52 exports including memory, with no
imports, start section, WASI initialization, IO or threading.

The selected build is **334,638 bytes raw / 125,248 gzip**, with a **4,663-byte JS
wrapper**. It retains Clang `-O3`, full LTO and Binaryen `-O3`, uses heap-backed
Eigen dynamic scratch, and relies on the SDK's existing 16-byte malloc alignment.
The stack is 16 KiB and initial memory is one 64 KiB page. Compared with the
previous five-family release, the expanded build adds 7,545 raw / 5,192 gzip
bytes, including the solver stack fix.

## Cost of the additional algorithms

The initial expanded build, before tuning, is **353,451 bytes raw / 130,548 gzip**.
The JS wrapper is **4,663 bytes**. Relative to the previous five-family build
(327,093 / 120,056), this adds 26,358 raw / 10,492 gzip bytes, including shared
binding changes, attribute transfer and input/postcondition checks.

To isolate retained algorithm cost, `npm run size` relinks the same verified LTO
objects with each new export group independently. These final measurements keep
all previous exports and use the selected O3 and memory configuration throughout:

| Export group | Added raw bytes | Added gzip bytes |
| --- | ---: | ---: |
| Triangulation, both entry points and attribute transfer | 12,733 | 5,098 |
| Connected components | 3,083 | 1,246 |
| Seven mesh measurements | 2,929 | 1,150 |
| Curvature | 6,201 | 3,097 |
| Fairing, all three entry points | 723 | 661 |
| All additions together | 25,352 | 10,561 |

The current-source baseline with only the previous 38 exports is 309,286 /
114,686 bytes. Its reduction from the previous release includes the selected
memory configuration and shared binding changes. Group deltas are not additive: LTO and gzip
share code and data. Compiling a source file does not make every function in it
live; exporting curvature modes retains code previously removed from the build.
The reproducible raw data is `build/size/report.json`.

## Correctness gate

The final selected implementation passed:

- 70 Node tests, including public header/export/runtime ABI agreement.
- 258 identical Node/Chromium workflows, with 870,628 assertions per load mode.
  Each mode includes 64 deterministic JS/Wasm fuzz seeds.
- 97 unchanged tests from PMP's own suite against original C++ and another 97
  against adapted native C++. Test-only shape helpers and GoogleTest stay out of
  the Wasm build; unrelated unimplemented API/IO suites are explicitly excluded.
- 256 seeded JS/Wasm cases (1,794,241 assertions), and 256 C11 caller cases against
  adapted native code under GCC 14 AddressSanitizer/UndefinedBehaviorSanitizer
  (2,626,257 assertions). This is bounded model-based fuzzing, not coverage-guided
  fuzzing. Native sanitizer checks complement actual Wasm/browser tests.

Fixtures include 4 core, 22 original algorithm and 43 extension results generated
from untouched pinned PMP. The triangulation regressions additionally reject a
failed split sentinel and native calls that leave an unsplit polygon. Failure
can follow partial mutation; discard the Wasm instance after a trap.

## Tuning method

`npm run tune -- --build` builds compiler, LTO and Binaryen variants in separate
directories. Each variant passes the import/export/instruction audits, all shared
correctness workflows and 32 JS/Wasm fuzz seeds before it is eligible for timing.
`npm run tune -- --bench` measures all validated variants twice in Node without
concurrent compilation. These are development experiments; they do not add
multiple supported runtime artifacts or a dispatch layer.

The same benchmark runs in Node and Chromium via `scripts/benchmark.mjs`:

```sh
npm run bench -- path/to/a.wasm path/to/b.wasm
npm run bench -- --browser path/to/a.wasm path/to/b.wasm
```

Each case starts with a fresh mesh. Timings exclude setup; five warmups precede
15 samples, variant order alternates, and results include median/min/max. The
curved grid has 1,681 vertices and 3,200 triangles; triangulation uses its 1,600
quads. Hole filling uses the native annulus fixture. Cases cover all five
original families plus triangulation, components, area, curvature and fairing.
Browser timer quantization limits comparisons of very short calls. Reported
memory is final linear-memory capacity, not total process memory.

No candidate changes precision, enables fast-math or SIMD, or raises the Wasm
feature requirement. Results apply to these workloads and engines; they do not
establish a global optimum.

## Compiler, linker and Binaryen results

The first pass used the expanded source before memory tuning. Ratios are the
geometric mean of 21 median times relative to that pass's baseline, across two
Node runs; higher means slower. Identical artifacts can have different timing
samples, illustrating measurement noise.

| Candidate | Raw bytes | Gzip bytes | Node time ratio |
| --- | ---: | ---: | ---: |
| Clang O3, full LTO, Binaryen O3 | 353,451 | 130,548 | 1.00 |
| Clang O2 | 326,674 | 122,641 | 1.04–1.05 |
| Clang Os | 281,986 | 106,678 | 1.34 |
| Clang Oz | 213,978 | 91,393 | 1.48–1.51 |
| LTO O2 | 353,451 | 130,548 | identical artifact |
| LTO codegen O3 | 353,451 | 130,548 | identical artifact |
| Binaryen O4 | 354,230 | 131,612 | 1.03–1.06 |
| Binaryen Os | 353,145 | 130,604 | 1.04 |
| Binaryen Oz | 348,032 | 130,699 | 1.03–1.06 |
| Binaryen O3 with converge | 353,398 | 130,554 | 1.02–1.04 |

Keep the O3 defaults: the smaller compiler modes cost speed, and the Binaryen
alternatives do not improve compressed size. Chromium confirms the substantial
Os regression: uniform remeshing takes 41.2 ms versus 23.5 ms; adaptive remeshing
20.3 versus 11.5 ms. O2 is a possible size/speed tradeoff for future workload
requirements, not the selected performance default.

Memory profiling then found a correctness defect absent from the smaller timing
grid: Eigen's default 128 KiB per-buffer stack threshold allowed a 72,200-byte
addressable solver array on the 64 KiB Wasm stack. The 9,409-vertex implicit
smoothing case trapped in both production and diagnostic builds. Ordinary scalar
Wasm locals are unrelated to this linear-memory allocation. Setting
`EIGEN_STACK_ALLOCATION_LIMIT=0` moves positive dynamic buffers to the heap.
`--stack-first` places static data above the downward-growing stack. The fixed
stack size remained 64 KiB during this comparison. The pinned Eigen's `EIGEN_NO_ALLOCA` option alone fails
to compile some triangular matrix/vector templates; no vendor patch was needed.

| Memory configuration, all with O3 | Raw bytes | Gzip bytes |
| --- | ---: | ---: |
| Heap scratch and stack first | 352,593 | 129,852 |
| Above, plus existing malloc alignment (64 KiB stack) | 334,638 | 125,247 |

`EIGEN_MALLOC_ALREADY_ALIGNED=1` removes redundant alignment/pointer-adjustment
code. The SDK allocator provides 16-byte alignment; compile-time checks enforce
`max_align_t` and Eigen's exact requirement, and the diagnostic self-test checks
differently sized malloc/realloc chunks. Both corrected candidates pass all 194
shared correctness workflows and 32 fuzz seeds. Their Node aggregate timings
differ by less than 0.2%; both are about 1.4–1.7% above the old smaller-grid
baseline in these runs. Chromium medians are effectively unchanged: selected
uniform/adaptive remeshing 23.4/11.5 ms, implicit smoothing 3.9 ms and
minimum-curvature fairing 4.2 ms. Choose the alignment optimization for its code
size reduction; its heap-byte savings are negligible.

The final gate adds a 43rd compact native extension fixture for the large solver
regression. It checks smoothing followed by fair(2), native position samples,
whole-mesh sums/area/range, connectivity, constrained boundaries and all UV/color/
skinning channels. Current Node/browser and fuzz results are recorded above and
in the build reports. Timing raw data lives under `build/tuning`; the tuning
script now uses the corrected production defaults for subsequent experiments.

## Memory profiling and allocator decision

Run `npm run profile:memory -- --build` after the production build. This creates
`build/memory/pmp-core.wasm` with three diagnostic exports; production still has
exactly 52 exports. `build/memory/profile.json` records source/toolchain/artifact
fingerprints, every phase and cycle, plus replay settings. The profiler verifies
vendored inputs and refuses to overwrite the production build directory.

The profile intercepts malloc, calloc, realloc, aligned_alloc, posix_memalign,
free and libc aliases, including C++ new/delete paths. Its fixed counters do not
allocate. `malloc_usable_size` measures payload capacity of live chunks, excluding
allocator headers, stack, JS arrays and free chunks. Peak usable bytes are
sampled at allocation completion; internal realloc old/new overlap is excluded.
Linear-memory capacity captures backing growth, including static data, stack,
free space and fragmentation; it cannot shrink. Allocation/release events include
successful realloc replacements and JS view-helper metadata allocations. No
timings come from the instrumented binary.

Both corrected candidates pass **35 workloads × 8 lifecycles = 280 cycles**, with
4,538 profiling assertions each. Workloads use 32×32 and 96×96 cell grids, all
four subdivision methods, both remesh methods, decimation, curvature, smoothing/
fairing, triangulation, hole filling and polygon clear/reuse. Supported operations
carry two UV sets, color, joint indices/weights and corner UVs. Every destroy
returns tracked bytes and blocks to zero; identical workloads reach a backing
memory plateau after two warmup cycles. These are bounded lifecycle checks, not
a proof against every leak or fragmentation pattern.

Historical 64 KiB stack profile, 96×96 cells (9,409 vertices); values are bytes:

| Workload | Peak live usable | Retained linear memory |
| --- | ---: | ---: |
| Triangle construction, no reserve | 2,384,472 | 2,818,048 |
| Triangle construction, exact reserve | 2,031,576 | 2,162,688 |
| Triangle construction, edge count = corner count | 2,937,624 | 3,080,192 |
| Quad construction, exact reserve | 1,533,960 | 1,703,936 |
| Normals and tensor curvature | 8,130,820 | 8,257,536 |
| Decimation | 3,538,980 | 3,997,696 |
| Uniform remeshing | 4,506,580 | 4,784,128 |
| Adaptive remeshing | 5,321,872 | 5,701,632 |
| Loop subdivision | 7,121,196 | 8,060,928 |
| Implicit smoothing followed by fair(2) | 20,375,960 | 21,954,560 |
| Quad triangulation with attributes | 2,744,916 | 2,883,584 |

Keep SDK dlmalloc. The installed library exposes no mallopt controls, and these
runs show stable reuse after destruction. Eigen alignment removes code but saves
only 400 peak usable bytes in the largest solve, with no page/count difference.
Replacing the allocator has no measured justification in this pass.

Reserve realistic vertex, **edge**, and face counts when known: a triangulated
n×n grid has `3*n*n + 2*n` edges, while its quad version has `2*n*(n+1)`.
For the 96-cell triangle construction, exact reserve reduces successful
allocation events from 165 to 62, and avoids 917,504 backing bytes relative to
the corner-count reservation. Release upload buffers once construction finishes.

Preserve PMP's native clear semantics. A 9,216-corner polygon leaves 261,044
usable bytes in the live empty mesh after `clear()`, primarily face-construction
scratch; destruction returns that to zero. Destroy/recreate a mesh after an
unusually large polygon when that retained capacity is unwanted. Freeing chunks
does not return Wasm pages to the engine; discard the instance when its high-water
backing memory must be reclaimed. Neither policy requires a thicker JS wrapper.

## Reduced stack reservation

After moving dynamic Eigen scratch to the heap, instrumenting all 226 writes to
the optimized binary's stack-pointer global observed a maximum movement of
960 bytes. An independent write watermark observed 900 bytes. The workload
covered 184 algorithm/extension cases, the large solver regression, 256 fuzz
seeds and benchmark inputs. These observations are not a universal upper bound;
leaf red-zone writes can bypass stack-pointer updates.

The selected 16 KiB reservation retains substantial measured headroom, reduces
initial memory from 131,072 to 65,536 bytes, and keeps raw code size unchanged.
Gzip grows by one byte. The core suite asserts the one-page initial memory.
Full Node/browser workflows, JS and sanitized C fuzzing, and allocator lifecycle
checks are rerun against this configuration. Dynamic input-sized Eigen buffers
remain heap-backed; reducing the reservation does not reinstate `alloca`.

The production reduction passes 70 Node tests; 258 shared E2E workflows and
870,628 assertions per load mode in Node and Chromium; 256 JS fuzz seeds with
1,794,241 assertions; and 256 C11 ASan/UBSan seeds with 2,626,257 assertions.
The rebuilt diagnostic profile passes all 280 lifecycles (4,538 assertions),
returns tracked live bytes to zero, and reaches the same allocation plateau.
Its largest solver retains 21,889,024 linear-memory bytes, one page less than
the earlier profile; peak live payload capacity remains 20,375,960 bytes.

## Optional glTF-Transform adapter

The adapter adds **zero Wasm bytes or exports**: production remains 334,638 raw /
125,248 gzip bytes, with the unchanged 4,663-byte core wrapper. The separate
adapter is **46,684 bytes minified / 15,960 gzip**, bundled as ESM for Chrome 93
with esbuild 0.27.7. This includes the document adapter, topology bridge, BVH and
attribute transfer. It does not import glTF-Transform merely for enum constants;
the caller already provides its Document. SDK/IO code and the Wasm binary are
excluded from this adapter-only measurement.

`npm run profile:gltf` uses an existing esbuild installation selected by
`ESBUILD_MODULE`, the production binary, and the separately built memory
diagnostic binary. It writes source/artifact fingerprints and raw cycles to
`build/gltf/profile.json`. The default profile uses a 32×32-cell surface
(1,089 vertices /2,048 triangles), dual UVs, normalized colors, custom channels,
two skin influence sets and an animated morph target. Hole filling uses a
missing tetrahedron face. Document creation is outside the timed interval; all
adapter validation, copies, native processing, attribute/morph transfer and
graph commit are inside. Eight cycles include two warmups. Production is timed;
the diagnostic build supplies allocation accounting and must match its output.

| Representative operation | Median milliseconds | Peak native usable bytes | Retained native capacity |
| --- | ---: | ---: | ---: |
| Decimation, ratio 0.65 | 42.5 | 369,204 | 458,752 |
| Uniform remeshing, one iteration | 116.7 | 739,540 | 851,968 |
| Loop subdivision, one level | 147.8 | 801,720 | 917,504 |
| Implicit smoothing | 36.4 | 873,048 | 983,040 |
| Minimum-curvature fairing | 36.8 | 1,598,540 | 1,900,544 |
| Fill one triangular hole | 3.6 | 1,808 | 65,536 |

These are Node 24.16.0 observations, not portable latency guarantees or isolated
PMP timings. Host load and JS warmup vary substantially between runs. Exact row
paths validate source IDs once and copy rows directly; unchanged row order uses
one typed-array copy per channel. This avoids allocating/revalidating a
three-corner interpolation map for each retained channel. Projected paths still
use the BVH and categorical joint merging.

All eleven profile workloads complete eight production lifetimes each; their
diagnostic runs return live native bytes and blocks to zero. Native backing
capacity plateaus after warmup. With explicit GC, whole-process retained JS heap
ranges from 7.3–8.2 MB, ArrayBuffer accounting from 0.85–3.3 MB, and external
accounting from 3.4–10.3 MB in this run. These overlapping process-wide counters
include runtime/test artifacts, are not per-operation peaks and must not be
added together. The adapter unit suite also checks repeated graph edits release
orphan accessors and preserve shared targets.

Integration validation covers 51 scenarios (43 synthetic and eight cases across
five local GLB assets), plus 256 bounded deterministic fuzz seeds. Each Node
bytes/module and Chromium bytes/streaming mode passes 708,979 assertions with
matching deterministic summaries. Real cases include skinning/animation, eight
morph targets, dual UVs, colors and interleaving. Synthetic cases also cover
shared accessor and morph-target storage.
The combined unit suite has 120 passing tests. Asset paths and bytes stay out
of the repository; the optional runner accepts a private local model manifest.
