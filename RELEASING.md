# Preparing a release

The first candidate is `pmp-wasi@0.1.0`, ABI 1. The public repository is
https://github.com/kzhsw/pmp-wasi. Publication has not been authorized or performed;
`private: true` remains an intentional guard. Preparing and installing a local
npm tarball does not publish it.

## Candidate validation

Use the pinned local toolchain and environment from [CONTRIBUTING.md](CONTRIBUTING.md).
From the final source state:

```sh
npm run build
npm test
npm run test:e2e
npm run test:upstream
npm run test:fuzz -- --seeds 256 --seed 0
npm run test:gltf -- --seeds 256
npm run profile:memory -- --build
npm run profile:gltf
npm run package
npm run test:package -- build/release/pmp-wasi-0.1.0.tgz
```

Include the optional local real-model configuration in the glTF gate when it is
available. Type-check the public declarations with an existing TypeScript
installation. Do not infer certification of historical browsers from current
Chromium; preserve the distinction in `COMPATIBILITY.md`.

`npm run package` verifies production input hashes, exact runtime archive
hashes, ABI, features, exports, live-symbol restrictions and notice hashes. It
stages `dist/pmp.wasm`, generated build provenance and dependency notices, then
checks the npm payload against an explicit file list. `npm pack` invokes the
same staging checks through `prepack`. Build first; packing never silently
rebuilds or downloads a toolchain. Proposed headers, build tools, source maps,
private models and local development files are excluded.

`test:package` installs the actual tarball offline into a temporary directory
outside the repository. It tests the core without its optional peer, then tests
the adapter using existing local peer dependencies. The same consumer runs in
Node and Chromium, including byte/module/streaming paths. The report binds the
tarball and Wasm hashes to the results. A `--node-only` run is useful locally,
but is not the complete release gate.

Preserve `build/report.json`, `build/release/package.json`, the Node/browser/fuzz
and memory reports, and the tested tarball. Record the final commit and candidate
SHA-256 values. A source archive can be produced from the reviewed commit with
`git archive --format=tar.gz --prefix=pmp-wasi-0.1.0/ HEAD`; it includes the
covered Eigen sources and all source notices, and excludes ignored artifacts.

## Publication, when authorized

Before publication, make the reviewed source revision available at the configured
public repository and verify the pinned corresponding-source links in
`THIRD_PARTY_NOTICES.md`. Update release status text and the changelog, remove
`private: true`, and repack. Metadata changes create a different tarball, so rerun
the installed-package gate and record the new hash. Use a version tag and release
notes tied to that reviewed commit. Publish only the resulting verified artifact.
The package test accepts either private or publishable metadata; publication
protection is a repository workflow decision, not a runtime requirement.

Keep the JS wrapper and Wasm binary paired. ABI 1 freezes the implemented layout
and signatures; no fallback or cross-version wrapper is shipped. A changed ABI
requires an explicit new wrapper/binary pair, matching header and regression
coverage. Changes to the exported surface, upstream sources, toolchain, allocator
or Wasm features require renewed correctness, size, memory and license review.
