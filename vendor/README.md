# Vendored sources

`upstream.json` pins PMP and its bundled Eigen. `manifest.json` records original
and adapted PMP file hashes and the unmodified Eigen tree hash. The build checks
the adapted inputs against that manifest without accessing the network.

PMP changes are recorded in `pmp.patch`: remove filesystem/stream declarations;
replace escaping core exceptions with traps; expose checked native connectivity;
store bool properties as bytes; replace RTTI with checked per-type tokens; use
nonallocating property lookup/removal; and add direct span/reversed-span face
construction. Numerical normals/features sources are unchanged. `pmp/error.h`
is the small new trap helper. The singular-inverse failure path in `mat_vec.h`
is currently fatal; before adding remeshing, its recoverable fallback must be
implemented and tested as required by `DESIGN.md`.

Only the selected PMP files are vendored. Eigen headers remain unmodified,
including architecture-specific headers not selected by this single-threaded
Wasm build; unused headers contribute no code to the binary. There are no Eigen
tests, examples, build tools, or downloaded dependencies here. Preserve the
in-file copyright/license notices and `COPYING.*` texts.
