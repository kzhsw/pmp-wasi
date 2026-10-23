# Third-party notices

pmp-wasi's bindings, JavaScript wrapper and adapter are licensed under the
[MIT license](LICENSE), matching PMP. The statically linked dependencies below
retain their original licenses. The package's MIT declaration does not relicense
those components.

## PMP

PMP 3.0.0 is pinned to
[`215975ca1efafab97477b18187a4a23b87529036`](https://github.com/pmp-library/pmp-library/tree/215975ca1efafab97477b18187a4a23b87529036).
Its MIT notice is included as `dist/licenses/pmp-MIT.txt` in the npm package
and `vendor/pmp/LICENSE.txt` in this repository. Selected computational sources
are adapted to remove IO, replace escaping exceptions with traps, expose native
storage and preserve internal numerical recovery paths. The source and complete
patch are in [the project repository](https://github.com/kzhsw/pmp-wasi).

## Eigen

The binary includes code generated from **unmodified Eigen 5.0.1 headers**.
Eigen is primarily MPL-2.0 licensed; portions carry additional Apache, BSD and
MINPACK notices. All `COPYING.*` files are included under `dist/licenses/eigen/`
in the npm package and `vendor/eigen/` in this repository.

The corresponding covered source is available without charge in the pinned
[PMP source tree, `external/eigen-5.0.1`](https://github.com/pmp-library/pmp-library/tree/215975ca1efafab97477b18187a4a23b87529036/external/eigen-5.0.1),
or as the [complete pinned source archive](https://github.com/pmp-library/pmp-library/archive/215975ca1efafab97477b18187a4a23b87529036.tar.gz).
That tree contains the exact headers used by this build, their in-file notices,
and the MPL-2.0 license. This project's `vendor/eigen` contains the selected
headers unchanged, with a verified tree hash in `vendor/manifest.json`.
Covered source remains available under its original license.

## Statically linked SDK runtime

The Wasm module uses selected libc, libc++, libc++abi and compiler-rt routines
from WASI SDK 32.0. Using those routines introduces no host imports, WASI
initialization, threads, IO or filesystem access into the final module.

- wasi-libc revision: `2fc32bc81b9f07f8d9525edea59bfbaf760c06d6`.
- LLVM revision: `4434dabb69916856b824f68a64b029c67175e532`.

[Runtime notices](licenses/runtime/README.md) include the complete upstream
license texts and component credits, musl and cloudlibc copyright notices,
source-specific math/runtime notices, and dlmalloc's CC0 dedication and legal
code. LLVM portions use Apache-2.0 WITH LLVM-exception and retained legacy
notices. `licenses/runtime/manifest.json` pins their source URLs, file hashes
and the reviewed SDK archive hashes. This notice set conservatively includes
archive members that link-time optimization may subsequently discard.

## Optional integration

`@gltf-transform/core` is an optional peer for the separate glTF adapter. Neither
it nor its dependencies are bundled in this package or the Wasm module; install
them separately under their respective licenses. Local development and test
models are not distributed in the package.
