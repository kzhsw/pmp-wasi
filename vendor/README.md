# Vendored sources

`upstream.json` pins PMP and its bundled Eigen. `manifest.json` records original
and adapted PMP file hashes and the unmodified Eigen tree hash. The build checks
the adapted inputs against that manifest without accessing the network.

PMP changes are recorded in `pmp.patch`: remove filesystem/stream declarations;
replace escaping exceptions with traps; expose checked native connectivity;
store bool properties as bytes; replace RTTI with checked per-type tokens; use
nonallocating property lookup/removal; and add direct span/reversed-span face
construction. Property arrays provide native row copying for triangulation
corner/face transfer; triangulation traps on an invalid split sentinel. Numerical
normals/features sources are unchanged. `pmp/error.h`
is the small new trap helper. Remeshing's singular 3x3 inverse returns a success
flag and retains the original weighted-centroid fallback, threshold and arithmetic.
Hole-filling cleanup/rethrow paths become fatal; successful cleanup is preserved.
Flip-energy operands in remeshing/hole filling are int64 to prevent signed
squaring overflow on high-valence fans. Two column loops use Eigen's index type
to keep warnings-as-errors builds clean. No SIMD adaptations are made to PMP or
Eigen. All patches are reviewed against the pinned source; native-reference
fixtures include the recoverable remeshing path.

Only the selected PMP files are vendored. Eigen headers remain unmodified,
including architecture-specific headers not selected by this single-threaded
Wasm build; unused headers contribute no code to the binary. There are no Eigen
tests, examples, build tools, or downloaded dependencies here. Preserve the
in-file copyright/license notices and `COPYING.*` texts.
