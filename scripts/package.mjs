// Stage only a verified production build. npm pack runs this through prepack.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildInputHashes } from './build.mjs';
import { verifyVendor } from './vendor.mjs';
import { audit, auditLinkMap } from './wasm.mjs';
import { instantiate } from '../src/index.js';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
assert(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--pack',
  'Usage: node scripts/package.mjs [--pack]');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const pkg = json('package.json'), report = json('build/report.json');
const notices = json('licenses/runtime/manifest.json');
verifyVendor();
assert.deepEqual(report.inputHashes, buildInputHashes(), 'Stale build: run npm run build before packing');
assert.equal(report.diagnostic, undefined, 'Diagnostic Wasm must not be distributed');
assert.equal(report.compileOpt, '-O3');
assert.equal(report.linkOpt, undefined);
assert.equal(report.codegenOpt, undefined);
assert.deepEqual(report.optimize, ['-O3']);
assert(report.heapScratch && report.alignedMalloc && report.stackFirst);
assert.equal(report.stackBytes, 16384);
assert.equal(report.toolchain.sdkVersion, notices.sdkVersion, 'Runtime notices require the reviewed SDK version');
assert.equal(report.toolchain.binaryen, 'wasm-opt version 129 (version_129)');
assert.deepEqual(report.runtimeArchives, notices.runtimeArchives, 'Runtime archives differ from the reviewed notice set');
for (const file of notices.files)
  assert.equal(digest(readFileSync(`licenses/runtime/${file.path}`)), file.sha256, `Changed runtime notice ${file.path}`);
assert.deepEqual(readdirSync('licenses/runtime').sort(), [...notices.files.map(file => file.path), 'manifest.json'].sort());
const bytes = readFileSync('build/pmp-core.wasm');
assert.equal(digest(bytes), report.sha256, 'Wasm does not match the build report');
assert.equal(bytes.length, report.bytes);
auditLinkMap(readFileSync('build/core.map', 'utf8'));
const names = json('exports/core.json'), module = audit(bytes, names).module;
const e = await instantiate(module);
assert.equal(e.pmp_abi_version(), 1);
assert.equal(report.abiVersion, 1);
assert.equal(e.memory.buffer.byteLength, 65536);
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.repository.url, 'git+https://github.com/kzhsw/pmp-wasi.git');

// Recreate the generated directory so an earlier experiment cannot enter npm.
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/licenses/eigen', { recursive: true });
copyFileSync('build/pmp-core.wasm', 'dist/pmp.wasm');
copyFileSync('vendor/pmp/LICENSE.txt', 'dist/licenses/pmp-MIT.txt');
for (const file of readdirSync('vendor/eigen').filter(file => file.startsWith('COPYING.')))
  copyFileSync(`vendor/eigen/${file}`, `dist/licenses/eigen/${file}`);
const wrappers = ['src/index.js', 'src/index.d.ts', 'src/gltf-transform.js', 'src/gltf-transform.d.ts',
  'src/gltf/geometry.js', 'src/gltf/attributes.js', 'src/gltf/transfer.js'];
const upstream = json('upstream.json');
const metadata = { package: pkg.name, version: pkg.version, abiVersion: report.abiVersion,
  wasm: { file: 'pmp.wasm', bytes: report.bytes, gzipBytes: report.gzipBytes, sha256: report.sha256,
    imports: [], exports: names, features: report.features, stackBytes: report.stackBytes, initialMemoryBytes: 65536 },
  sources: { repository: pkg.repository.url,
    pmp: Object.fromEntries(['repository', 'revision', 'version', 'license'].map(key => [key, upstream.pmp[key]])),
    eigen: upstream.eigen, compiled: report.sources, inputHashes: report.inputHashes },
  toolchain: report.toolchain, runtimeArchives: report.runtimeArchives,
  wrappers: Object.fromEntries(wrappers.map(path => [path, digest(readFileSync(path))])) };
writeFileSync('dist/build.json', JSON.stringify(metadata, null, 2) + '\n');
console.log(`Staged ${pkg.name}@${pkg.version}: ABI 1, ${bytes.length} Wasm bytes, no imports`);

if (process.argv[2] === '--pack') {
  mkdirSync('build/release', { recursive: true });
  const args = ['pack', '--ignore-scripts', '--json', '--pack-destination', 'build/release'];
  const result = spawnSync(process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args, { encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  const [packed] = JSON.parse(result.stdout);
  const required = ['dist/pmp.wasm', 'dist/build.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'include/pmp.h',
    ...wrappers, ...notices.files.map(file => `licenses/runtime/${file.path}`)];
  const files = packed.files.map(file => file.path);
  for (const file of required) assert(files.includes(file), `Missing packed file ${file}`);
  const exact = new Set(['package.json', 'README.md', 'LICENSE', ...pkg.files.filter(file => !file.endsWith('/')),
    ...readdirSync('dist/licenses/eigen').map(file => `dist/licenses/eigen/${file}`), 'dist/licenses/pmp-MIT.txt',
    ...readdirSync('licenses/runtime').map(file => `licenses/runtime/${file}`)]);
  for (const file of files) assert(exact.has(file), `Unexpected packed file ${file}`);
  assert(!files.some(file => /(?:^|\/)(?:AGENTS\.md|node_modules|vendor|test|scripts|design|build)\//.test(file)));
  packed.sha256 = digest(readFileSync(resolve('build/release', packed.filename)));
  writeFileSync('build/release/package.json', JSON.stringify(packed, null, 2) + '\n');
  console.log(`Packed build/release/${packed.filename}: ${packed.size} bytes; SHA-256 ${packed.sha256}`);
}
