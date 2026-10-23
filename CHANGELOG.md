# Changelog

## 0.1.0 — prepared, unreleased

First release candidate, with matching ABI 1 C header, Wasm exports and JS wrapper.

- Decimation, uniform/adaptive remeshing, four subdivision modes, explicit/implicit
  smoothing and hole filling.
- Triangulation, fairing, normals, feature detection, curvature, connected
  components and mesh measurements.
- Zero-copy native views and typed properties, bulk construction, CW/CCW input
  and per-corner mappings.
- Optional glTF-Transform integration with document/mesh/primitive selection,
  budgets, attributes, multiple skin sets, morph targets and owned-copy transfer.
- One freestanding scalar Wasm artifact, zero imports/init/IO, a 16 KiB stack and
  one initial 64 KiB memory page. Chrome 75 core and Chrome 93 adapter feature
  baselines; historical versions are not execution-certified.
- MIT project license and bundled PMP, Eigen and pinned SDK runtime notices.
- Native upstream tests, Node/browser workflows, JS/C fuzzing, memory profiling
  and installed-tarball checks.

The release review also fixed skin validation for primitives shared across
multiple meshes: every affected skin is checked before graph mutation, including
owners outside the explicit selection. Development ABI 0 is no longer accepted
by the matching wrapper. Unimplemented proposals are not part of this package.
