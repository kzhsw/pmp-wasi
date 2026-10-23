# Third-party sources and release status

PMP is pinned in `upstream.json`. The selected and adapted sources are under
`vendor/pmp`, with their original copyright headers and MIT license in
`vendor/pmp/LICENSE.txt`. `vendor/pmp.patch` records adaptations against that pin.

Eigen 5.0.1 headers are copied without modification from the pinned PMP checkout.
They retain their in-file notices and `vendor/eigen/COPYING.*` texts, including
MPL-2.0, Apache, BSD and other notices for portions of the source. A future binary
distribution must identify an accessible location for the corresponding covered
Eigen source and retain the applicable notices. The intended public repository
will provide that source; no public source location is established yet.

The Wasm build statically links selected routines from the SDK's libc, libc++,
libc++abi and compiler-rt. LLVM runtime code uses Apache-2.0 WITH LLVM-exception;
wasi-libc incorporates additional musl, math and allocator notices. Complete,
version-matched runtime notices must be collected before distributing a binary.
Keep the package private and its payload limited to design metadata until the release
notices and full API are ready. No third-party code is relicensed by this project.
