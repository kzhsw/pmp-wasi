import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { audit, auditLinkMap, binaryenFlags, stripTargetFeatures, targetFeatures } from './wasm.mjs';
import { verifyVendor } from './vendor.mjs';

const root = resolve(import.meta.dirname, '..');
export function build(options = {}) {
  process.chdir(root);
  verifyVendor();
  const directory = options.directory ?? (options.profile ? 'build/memory' : 'build');
  assert(!options.profile || resolve(directory) !== resolve(root, 'build'),
    'Diagnostic builds must not overwrite the production build directory');
  const file = name => join(directory, name);
  const compileOpt = options.compileOpt ?? '-O3';
  const linkOpt = options.linkOpt;
  const codegenOpt = options.codegenOpt;
  const optimize = options.optimize ?? ['-O3'];
  const heapScratch = options.heapScratch ?? true;
  const alignedMalloc = options.alignedMalloc ?? true;
  const stackFirst = options.stackFirst ?? true;
  const stackBytes = 16 * 1024;
  assert(['-O2', '-O3', '-Os', '-Oz'].includes(compileOpt));
  assert([undefined, 0, 1, 2, 3].includes(linkOpt) && [undefined, 0, 1, 2, 3].includes(codegenOpt));
  const sdk = process.env.WASI_SDK_PATH;
  const binaryen = process.env.BINARYEN_PATH;
  assert(sdk && binaryen, 'Set WASI_SDK_PATH and BINARYEN_PATH to existing toolchain directories');
  const cxx = join(sdk, 'bin/clang++');
  const capture = (exe, args) => {
    const result = spawnSync(exe, args, { encoding: 'utf8' });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const toolchain = { compiler: capture(cxx, ['--version']).split('\n')[0],
    target: capture(cxx, ['-print-target-triple']),
    binaryen: capture(join(binaryen, 'bin/wasm-opt'), ['--version']) };
  assert(/^wasm32-.*wasi/.test(toolchain.target), 'Compiler must target wasm32 WASI');
  const run = (exe, args) => {
    const result = spawnSync(exe, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${exe} failed (${result.status ?? result.signal})`);
  };
  const exports = options.exports ?? JSON.parse(readFileSync('exports/core.json', 'utf8'));
  assert(exports.length === new Set(exports).size);
  const planned = JSON.parse(readFileSync('wasm-exports.json', 'utf8'));
  assert(exports.every(name => planned.includes(name)));
  const profileExports = options.profile ? ['pmp_profile_get', 'pmp_profile_reset', 'pmp_profile_self_test'] : [];
  const allExports = [...exports, ...profileExports];
  const header = readFileSync('include/pmp.h', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [...header.matchAll(/\b(pmp_\w+)\s*\([^;{}]*\)\s*;/g)].map(match => match[1]);
  const implemented = JSON.parse(readFileSync('exports/core.json', 'utf8')).filter(name => name !== 'memory');
  assert.deepEqual(declarations.sort(), implemented.sort(), 'Public header must declare exactly the implemented functions');
  const abiVersion = Number(header.match(/^#define PMP_ABI_VERSION (\d+)u$/m)[1]);
  run(cxx, ['-mcpu=mvp', '-x', 'c', '-std=c11', '-Wall', '-Wextra', '-Werror',
    '-fsyntax-only', 'include/pmp.h']);
  const sources = ['src/core.cpp', 'src/algorithms.cpp', 'src/inspection.cpp', 'src/triangulation.cpp', 'src/runtime.cpp', 'vendor/pmp/surface_mesh.cpp',
    ...['normals', 'features', 'decimation', 'subdivision', 'distance_point_triangle',
      'remeshing', 'curvature', 'smoothing', 'laplace', 'numerics', 'differential_geometry',
      'fairing', 'hole_filling', 'triangulation', 'utilities'].map(name => `vendor/pmp/algorithms/${name}.cpp`)];
  mkdirSync(directory, { recursive: true });
  const targetFlags = ['-mcpu=mvp', '-mbulk-memory-opt', '-mnontrapping-fptoint', '-msign-ext'];
  const flags = [...targetFlags, '-std=c++20', compileOpt, '-flto', '-ffreestanding', '-fno-exceptions', '-fno-rtti',
    '-ffunction-sections', '-fdata-sections', '-DNDEBUG', '-DEIGEN_DONT_PARALLELIZE',
    '-Wall', '-Wextra', '-Werror', '-Iinclude', '-Ivendor', '-isystem', 'vendor/eigen'];
  // Eigen's default 128 KiB alloca limit exceeds the 16 KiB Wasm stack.
  // Limit=0 moves positive dynamic buffers to the heap; EIGEN_NO_ALLOCA alone
  // does not compile this Eigen version's triangular matrix/vector templates.
  if (heapScratch) flags.push('-DEIGEN_STACK_ALLOCATION_LIMIT=0');
  if (alignedMalloc) flags.push('-DEIGEN_MALLOC_ALREADY_ALIGNED=1');
  if (alignedMalloc) {
    // malloc must satisfy max_align_t; Eigen's scalar target needs 16 bytes.
    // Fail compilation if a future target or Eigen configuration changes that.
    writeFileSync(file('config-check.cpp'), '#include <cstddef>\n#include <Eigen/Core>\n' +
      'static_assert(alignof(std::max_align_t) >= EIGEN_DEFAULT_ALIGN_BYTES);\n' +
      'static_assert(EIGEN_DEFAULT_ALIGN_BYTES == 16);\n');
    run(cxx, [...flags, '-fsyntax-only', file('config-check.cpp')]);
  }
  // Object reuse is restricted to identical sources, headers and compiler flags.
  // All vendored inputs are verified above; their manifest includes Eigen's hash.
  const signature = createHash('sha256').update(JSON.stringify({ flags, sources, toolchain }));
  for (const path of [...sources.filter(path => path.startsWith('src/')), 'src/mesh.hpp',
    'include/pmp.h', 'vendor/manifest.json']) signature.update(path).update(readFileSync(path));
  const objectSignature = signature.digest('hex');
  const objectDirectory = options.objectDirectory ?? directory;
  if (options.objectDirectory)
    assert.equal(JSON.parse(readFileSync(join(objectDirectory, 'objects.json'))).signature,
      objectSignature, 'Cannot reuse stale objects or objects built with different flags');
  const objects = sources.map((source, i) => {
    const object = join(objectDirectory, `${i}.o`);
    if (!options.objectDirectory)
      run(cxx, [...flags, '-MMD', '-MF', file(`${i}.d`), '-c', source, '-o', object]);
    return object;
  });
  if (!options.objectDirectory)
    writeFileSync(file('objects.json'), JSON.stringify({ signature: objectSignature, sources, flags }));
  // Diagnostic-only allocator interception. Production objects and ABI stay
  // identical; compile the hooks separately so cached LTO objects remain usable.
  const wrappers = options.profile ? ['malloc', 'calloc', 'realloc', 'free',
    'aligned_alloc', 'posix_memalign', '__libc_malloc', '__libc_calloc', '__libc_free'] : [];
  if (options.profile) {
    const object = file('memory-profile.o');
    run(cxx, [...flags, '-fno-builtin', '-c', 'test/memory-profile.cpp', '-o', object]);
    objects.push(object);
  }
  run(cxx, [...targetFlags, compileOpt, '-flto', '-nostartfiles', ...objects, '-o', file('core.link.wasm'),
    `-Wl,--no-entry,--export-memory,--gc-sections,--export=__wasm_call_ctors,-z,stack-size=${stackBytes}` +
    (stackFirst ? ',--stack-first' : '') +
    (linkOpt === undefined ? '' : `,--lto-O${linkOpt}`) +
    (codegenOpt === undefined ? '' : `,--lto-CGO${codegenOpt}`) +
    `,-Map=${file('core.map')},--why-extract=${file('archives.tsv')}`,
    ...allExports.filter(name => name !== 'memory').map(name => `-Wl,--export=${name}`),
    ...wrappers.map(name => `-Wl,--wrap=${name}`)]);
  auditLinkMap(readFileSync(file('core.map'), 'utf8'));
  const linkedBytes = readFileSync(file('core.link.wasm'));
  const linked = audit(linkedBytes, [...allExports, '__wasm_call_ctors'], { linked: true });
  const featureFlags = binaryenFlags();
  const ctor = linked.exports.get('__wasm_call_ctors');
  assert.deepEqual([...linked.bodies[ctor.index]], [0, 11], 'Refusing to remove a nonempty constructor');
  const graph = [...linked.exports.keys()].map(name => name === '__wasm_call_ctors'
    ? { name, export: name } : { name, export: name, root: true });
  writeFileSync(file('graph.json'), JSON.stringify(graph));
  writeFileSync(file('core.target.wasm'), stripTargetFeatures(linkedBytes));
  run(join(binaryen, 'bin/wasm-metadce'), [file('core.target.wasm'), ...featureFlags, `--graph-file=${file('graph.json')}`, '--emit-target-features', '-o', file('core.pruned.wasm')]);
  run(join(binaryen, 'bin/wasm-opt'), [file('core.pruned.wasm'), ...featureFlags, ...optimize, '--emit-target-features', '--strip-debug', '--strip-producers', '--strip-dwarf', '-o', file('core.optimized.wasm')]);
  const bytes = readFileSync(file('core.optimized.wasm'));
  const final = audit(bytes, allExports);
  assert.deepEqual(final.features, targetFeatures, 'Unexpected Chrome 75 feature baseline');
  const instance = new WebAssembly.Instance(final.module, {});
  assert.equal(instance.exports.pmp_abi_version(), abiVersion);
  const mesh = instance.exports.pmp_mesh_create();
  instance.exports.pmp_mesh_destroy(mesh);
  copyFileSync(file('core.optimized.wasm'), file('pmp-core.wasm'));
  const report = { bytes: bytes.length, gzipBytes: gzipSync(bytes).length,
    sha256: createHash('sha256').update(bytes).digest('hex'), jsBytes: readFileSync('src/index.js').length,
    features: final.features, linkedFeatures: linked.features, targetFlags,
    exports: allExports.length, imports: [], sources, toolchain, compileOpt, linkOpt, codegenOpt, optimize,
    objectSignature, flags, heapScratch, alignedMalloc, stackFirst, stackBytes,
    ...(options.profile ? { diagnostic: true, wrappers,
      profileSource: 'test/memory-profile.cpp',
      profileSourceSha256: createHash('sha256').update(readFileSync('test/memory-profile.cpp')).digest('hex') } : {}) };
  writeFileSync(file('report.json'), JSON.stringify(report, null, 2) + '\n');
  if (!options.quiet) console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) build();
