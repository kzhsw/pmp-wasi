# Contributing

The implementation uses explicit C++ source allowlists, raw C exports and a
small ESM wrapper. Read [DESIGN.md](DESIGN.md) for the native boundaries and
[design/gltf-transform.md](design/gltf-transform.md) for the optional adapter.
Only implemented functions belong in `include/pmp.h`; proposed declarations
stay under `design/`. Keep wrappers paired with the matching Wasm ABI; do not
add legacy shims or automatic version negotiation.

## Build

Use Node.js 22+, WASI SDK 32.0 and Binaryen 129. Set `WASI_SDK_PATH` and
`BINARYEN_PATH` to existing installations. Scripts do not download compilers,
browsers or bundlers. Machine-specific paths belong in local `AGENTS.md`.

```sh
npm ci --ignore-scripts
npm run build
npm test
```

The build verifies vendored source hashes, compiles the explicit source list,
links with full LTO, audits live symbols and constructors, and validates the
final instructions against the documented Chrome 75 feature limit. Artifacts,
link maps, archive extraction and input hashes are written under `build/`.
`npm run package` refuses stale, diagnostic, experimental or unreviewed-toolchain
artifacts. Runtime archive changes require reviewing and updating the notices.

## Validation

```sh
npm run test:e2e
npm run test:upstream
npm run test:fuzz -- --seeds 256 --seed 0
npm run test:gltf -- --seeds 256
npm run profile:memory -- --build
npm run profile:gltf
```

Core E2E runs the same fixtures in Node and Chromium, using byte and compiled
or streaming module paths. Browser runs require an existing Playwright module
and browser configured through `PLAYWRIGHT_MODULE` and
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`; optional `PLAYWRIGHT_CHROMIUM_ARGS` and
`LD_LIBRARY_PATH` configure the local launch. Adapter browser tests and profiling
also require `ESBUILD_MODULE` pointing to an existing esbuild installation.
`test:e2e:node` and `test:gltf:node` explicitly omit the browser gate.

`PMP_UPSTREAM_PATH` must point to the untouched revision in `upstream.json` for
upstream tests and fixture generation. The suite compiles 97 unchanged tests
against both the original and adapted native C++ implementation. It uses the
checkout's bundled GoogleTest and an existing host compiler (`CXX`); host tests
supplement the Wasm tests. `UPSTREAM_TEST_JOBS` controls build concurrency.
`npm run fixtures` regenerates deterministic reference outputs.

The fuzz runner combines seeded JS/Wasm workflows with a C11 caller compiled
using AddressSanitizer and UndefinedBehaviorSanitizer. Use installed host GCC
and its sanitizer runtimes; compiler overrides are documented in the scripts.
An unexpected trap in a valid workflow fails the run with a replay seed.
Malformed-input trap tests always discard the affected instance.

Optional local GLB tests accept `--models path/to/config.json`, with entries
`{path, name, primitives?, options?}`. Keep private models/configurations outside
version control and the npm payload. Synthetic tests must remain independently
runnable; real models supplement them. See [GLTF_TRANSFORM.md](GLTF_TRANSFORM.md)
for the full fixture format and coverage.

## Performance and maintenance

`npm run bench`, `npm run size`, `npm run tune` and the profiling commands write
measurements under `build/`. Keep time and size observations separate from
correctness gates. Diagnostic allocator exports never enter the production
module. Check peak native allocations, repeated mesh lifetimes, retained memory
pages and JS transfer buffers when changing algorithms or attribute handling.

The final Wasm must remain single-threaded, import-free and free of startup,
stream/printf, filesystem, socket, clock, random and exception-unwind symbols.
Keep the strict feature audit; removing target metadata alone is insufficient.
Do not add Emscripten, generated binding frameworks or vendored SIMD patches.

Type-check with an existing TypeScript 5.9.3 installation using `--noEmit
--strict --module nodenext --moduleResolution nodenext --target es2022 --lib
es2022,dom,esnext.float16 src/index.d.ts src/gltf-transform.d.ts`. The optional
peer's types reference Float16Array; the core wrapper has no such runtime need.

Source changes should preserve the exact upstream pin and explain any adaptation
in `vendor/pmp.patch`. Verify numerical fallback behavior, large polygons,
attribute ownership, winding, degenerate inputs and shared glTF graph objects.
Review code before committing and follow [RELEASING.md](RELEASING.md) for a
release candidate.

## GitHub Actions

[CI](.github/workflows/ci.yml) runs one job on pull requests, pushes to `main`
and manual dispatch. It builds and audits Wasm, runs unit tests on Node 22,
checks C/C++ headers and TypeScript declarations, then tests core, glTF, the
packed npm package and the demo in Node 24 and the runner's Chrome. The glTF
run uses 16 reproducible fuzz seeds. Reports are retained for seven days.

The Ubuntu 24.04 runner caches checksum-pinned WASI SDK 32/Binaryen 129 archives
and native output keyed by native inputs, build scripts and workflow. Cached
Wasm still passes the unit and packaging audits. The runner reuses its installed
Chrome. Actions are commit-pinned and use Node 24;
test-only Playwright/TypeScript installations stay outside the package. New
commits cancel superseded checks, and the job has a ten-minute limit. There is
no scheduled run, platform matrix, upstream recompilation, sanitizer build,
extended fuzz campaign, memory profiling or benchmarking in automatic CI;
those remain local/release checks. CI does not publish packages or deploy Pages.

## Web demo

`npm run demo` builds and serves the local demo; `npm run build:demo` writes its
static site and `npm run test:demo` tests that exact build in Chromium. The demo
uses pinned esbuild 0.28.1 from development dependencies or `ESBUILD_MODULE`.
It reuses the reviewed `demo/pmp.wasm` snapshot, verified against source hashes,
instead of invoking a C++ compiler. Refresh the snapshot and its `wasm.json`
provenance together after a native build change. See [DEMO.md](DEMO.md) for
behavior, limits and the manual Pages workflow. The demo remains outside npm.
The Pages workflow reuses CI and deploys its tested site artifact, so there is
one shared set of build and test steps.
