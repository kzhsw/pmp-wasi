These notices accompany the statically linked runtime portions from WASI SDK
32.0. The source revisions recorded by that SDK are:

- wasi-libc: `2fc32bc81b9f07f8d9525edea59bfbaf760c06d6`
- LLVM (libc++, libc++abi and compiler-rt): `4434dabb69916856b824f68a64b029c67175e532`

`wasi-libc-LICENSE` describes the upstream repository's licensing. Its three
referenced license texts are included unchanged. `musl-COPYRIGHT` and
`cloudlibc-LICENSE` preserve the complete upstream component notices.

`dlmalloc-NOTICE.txt` reproduces lines 1–10 of the pinned
[`dlmalloc/src/malloc.c`](https://github.com/WebAssembly/wasi-libc/blob/2fc32bc81b9f07f8d9525edea59bfbaf760c06d6/dlmalloc/src/malloc.c#L1-L10).
`CC0-1.0.txt` is the complete official CC0 1.0 legal code referenced by that
notice, retrieved from Creative Commons.

Each LLVM runtime component has its complete, unchanged `LICENSE.TXT` and
`CREDITS.TXT` from the pinned revision. These include the upstream Apache
license, LLVM exceptions, and legacy license notices.

The two `*-source-NOTICES.txt` files preserve additional copyright and license
comment blocks verbatim. Each block is labelled with its upstream source path
and inclusive line range. WASI source paths are relative to
[the pinned wasi-libc tree](https://github.com/WebAssembly/wasi-libc/tree/2fc32bc81b9f07f8d9525edea59bfbaf760c06d6);
LLVM source paths are relative to
[the pinned LLVM tree](https://github.com/llvm/llvm-project/tree/4434dabb69916856b824f68a64b029c67175e532).

The source notice set conservatively covers runtime archive members selected
by the linker, their matching source candidates, and math/compiler-runtime
headers. Link-time optimization and final dead-code removal can discard parts
of those members. Inclusion of a notice does not assert that every named
function or architecture is present in the distributed Wasm module.
