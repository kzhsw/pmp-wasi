# 0.1.0 release review

The 0.1.0 package metadata is finalized for publication, including npm installation
instructions and links to the `main` branch at https://github.com/kzhsw/pmp-wasi.
Push and publication are separate from this review. Follow
[RELEASING.md](RELEASING.md) before publishing, including rechecking the final
tarball if metadata changes.

## Reviewed changes

- ABI 1 freezes the 51 implemented functions and native layouts. Header, binary,
  core wrapper and optional adapter match. Other ABIs are rejected; no shim or
  version negotiation is present. Proposed APIs remain outside npm.
- The package includes its Wasm asset, C header, declarations, user guides and
  dependency notices. README now covers loading, mesh processing and glTF usage;
  contributor and release procedures have separate documents.
- Shared glTF primitives now validate skins across every owning mesh, including
  owners outside selection. Regression tests proved the previous missed check
  and verify failure before graph mutation in Node and Chromium.
- Build provenance records source and runtime archive hashes, and reused objects
  are checked by content. Vendor verification rejects extra PMP files. Packaging
  rejects stale builds, diagnostic modules, experimental optimization settings,
  changed binaries and unreviewed runtime archives.
- The project retains MIT. PMP/Eigen notices accompany the package, with pinned
  corresponding-source links. Runtime notices were independently checked against
  13 complete upstream texts and 114 source comment excerpts.

## Candidate measurements

| Artifact | Size |
| --- | ---: |
| Wasm | 334,638 bytes |
| Wasm gzip | 125,248 bytes |
| Core JS | 4,655 bytes |
| Optional adapter, minified / gzip | 46,774 / 15,979 bytes |
| npm tarball, 43 files | 214,088 bytes |
| npm unpacked payload | 704,879 bytes |

Wasm SHA-256:
`9fcd942785a90b43f86047a08a5deed449a80031276ffac1eb9134bf76fbe7ad`

Candidate `pmp-wasi-0.1.0.tgz` SHA-256:
`1cb85558ae70f6d0aa489435662ae5af675a0975d919d623d03fc46ba04102e4`

The artifact has zero imports, no start/init, no retained IO/printf/thread or
exception-unwind symbols, 52 exports including memory, a 16 KiB stack and one
initial 64 KiB page. Of 356 function bodies, only `pmp_abi_version` differs from
the previously validated scalar ABI 0 artifact. Algorithm code size is unchanged.

Pre-push finalization changed package metadata and documentation only. The
production Wasm and JS sources are unchanged. All 122 unit tests passed again;
the final publishable tarball passed the isolated installation and Node/Chromium
gate, including bytes/module/streaming paths and six adapter workflows. The
earlier algorithm, fuzz and memory results below apply to the same native and
JS implementation.

## Completed gates

| Gate | Result |
| --- | --- |
| Node unit tests | 122 passed |
| Core E2E | 258 workflows / 870,628 assertions per load mode |
| Original / adapted native PMP suite | 97 / 97 unchanged tests passed |
| JS/Wasm fuzz | 256 seeds / 1,794,241 assertions |
| C11 ASan + UBSan fuzz | 256 seeds / 2,626,257 assertions |
| Synthetic glTF E2E | 44 scenarios + 256 seeds / 362,193 assertions per load mode |
| Installed tarball | Peer-free core and six adapter workflows passed in Node/Chromium |
| Native memory profile | 280 lifecycles / 4,538 assertions; zero tracked live allocations after destroy |
| glTF memory profile | 11 workloads × 8 lifetimes; backing plateau and zero native live allocations after destroy |
| Header / declarations | C11, C++20 and strict TypeScript 5.9.3 passed |
| npm dependency audit | Zero reported vulnerabilities |
| Package rejection probes | Five invalid candidates rejected before staging |
| Privacy audit | Candidate files, npm payload and commit history checked; no private model identifiers/assets or machine-specific home/mount paths |

Executed runtimes were Node 24.16.0 and Chromium 151.0.7922.34, using existing
Playwright 1.59.1. Chrome 75/76 and Chrome 93 remain feature baselines, not
historically executed certifications. TypeScript's optional SDK declarations
need the Float16 library definitions described in `COMPATIBILITY.md`; this adds
no Wasm feature. Private input configurations and reports are ignored and are
excluded from public commits, source archives and npm artifacts.
