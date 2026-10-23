# pmp-wasi

A minimal port of [PMP](https://github.com/pmp-library/pmp-library) algorithms to
freestanding, single-threaded WebAssembly using wasi-sdk.

This repository currently contains the package initialization and reviewed v1
design, including a proposed [C ABI](include/pmp.h). The full algorithm binding
is not implemented yet. This project targets a future public npm release;
publication is currently disabled. The package has no dependencies.

[DESIGN.md](DESIGN.md) defines the source boundary, direct mapping to PMP,
zero-copy memory contract, runtime removal, and build acceptance checks.
[upstream.json](upstream.json) pins the reviewed sources and source allowlist.

The intended package contains one `pmp.wasm`, a small ESM loader with TypeScript
declarations, the C header, and license notices. Callers can use the Wasm exports
directly. There is no Emscripten, WASI host, filesystem, socket, worker, or thread
runtime.
