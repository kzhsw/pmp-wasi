# Web demo

The demo opens a local GLB, or a glTF file together with its referenced buffers
and images. Drop the files anywhere on the page or use **Choose files**. A generated
sample is included; no model assets are checked in or uploaded.

Choose the whole model or a single mesh, choose an operation, and apply it to the
current result. Decimation, remeshing, subdivision, smoothing, hole filling,
fairing, normals and analysis are available. Common parameters have controls;
**Additional options** accepts JSON options from the
[adapter API](GLTF_TRANSFORM.md). Decimation supports document, mesh and primitive
budgets. A shared mesh changes for every scene node that uses it.

**Original / Result** switches the preview. Drag to orbit, scroll to zoom, or use
the arrow keys, plus/minus and F to fit. Toggle wireframe to inspect topology.
**Reset to original** discards the operation chain; **Download GLB** saves the
current complete document. Cancelling terminates the worker and retains the last
completed result. Operations exceeding 120 seconds are cancelled automatically.

## Run locally

Use Node.js 22 or later and the locked development dependencies:

```sh
npm ci --ignore-scripts
npm run demo
```

Open the loopback URL printed by the command. `PORT` changes the default port
4173. An existing esbuild 0.28.1 installation can instead be selected through
`ESBUILD_MODULE`; local builds do not download compilers, browsers or bundlers.
`npm run build:demo` only writes the standalone site to `build/demo/`. It uses
relative URLs and works below a repository prefix such as `/pmp-wasi/`.

The demo has a checked-in copy of the reviewed production `pmp.wasm`, together
with `demo/wasm.json` recording its hashes and provenance. Building checks the
binary, ABI, imports, source hashes, wrapper hashes and vendor tree. Native source
changes require rebuilding with the existing toolchains and refreshing both
files from the verified package staging output. The local demo command needs no
C++ toolchain. GitHub Actions rebuilds Wasm with the pinned toolchain and checks
that it matches this snapshot before testing and uploading the site. Demo files
and esbuild are excluded from the library's runtime dependencies and npm payload.

## Manual GitHub Pages deployment

After pushing the source to GitHub:

1. In **Settings → Pages**, select **GitHub Actions** as the source.
2. In **Actions → Deploy web demo**, choose **Run workflow** on `main`.
3. Open the deployment URL reported by the `github-pages` environment.

The deployment workflow is triggered only by `workflow_dispatch`, and accepts
`main` only. It calls the same [CI workflow](.github/workflows/ci.yml) used for
pull requests and pushes, then deploys the checked Pages artifact. Checks use
read-only repository permissions; only the deployment job has write permissions.
It does not publish an npm package or deploy on pushes or pull requests. Both
workflows use Ubuntu 24.04 and Node 24 actions. The deployment job has the Pages
and identity-token permissions
required by GitHub's [custom workflow procedure](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
The generated site includes complete native and bundled JavaScript license notices.

## Scope and limits

The viewer shows base geometry, node transforms, material base colors and vertex
colors, including GPU instances. It omits texture rendering, skin deformation,
morph weights and animation playback. Supported textures, materials, skins,
morph targets and animation data remain in the exported GLB. Transparency is
approximate. This is a geometry preview, not a full glTF renderer.

Unknown extensions and Draco/meshopt compressed geometry are rejected with a
message; no codecs are downloaded. Primitive extensions may be preserved on
loading but rejected by transforms that cannot safely update them. Points and
lines are retained but omitted from the surface preview. Resources must be
embedded or selected alongside the model; remote resource URLs are rejected.
When selecting companions from different folders, filenames must be unambiguous.

The demo accepts up to 100 MiB of files and one million input vertex rows and
triangles, including displayed instances. A transform is limited to 500,000
vertices per primitive. These limits bound common workloads, not peak solver
memory. Smaller models are appropriate for memory-constrained devices. New
topology uses approximate attribute projection by default; strict transfer is
available. Closed-surface fairing requires selected-vertex constraints. Hole
filling can also close outer boundaries, so inspect the result.

The site needs WebGL 2, module workers and WebAssembly compilation permitted by
the browser's `wasm-unsafe-eval` CSP directive. It is tested in current Chromium;
the core library's Chrome 75 feature baseline is not the demo's browser guarantee.
No cross-origin isolation, shared memory, service worker, external CDN, analytics
or model upload endpoint is used. Processing runs in a dedicated worker; the
Wasm module itself remains single-threaded and import-free.

## Tests

Build the site, configure the existing Playwright module and browser as described
in [CONTRIBUTING.md](CONTRIBUTING.md), then run `npm run test:demo`. The suite
loads the built site under a repository URL prefix, exercises picker/drop,
algorithms, resource loading, selection, recovery, cancellation and downloads,
and reparses exported GLBs in Node. It checks WebGL output, mobile layout and
requests against an asset allowlist. Reports and synthetic screenshots stay in
`build/`; no private model paths or assets are included in public source.
