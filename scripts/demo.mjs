// Build/serve the standalone demo using the reviewed Wasm snapshot and local esbuild.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildInputHashes } from './build.mjs';
import { verifyVendor } from './vendor.mjs';
import { audit } from './wasm.mjs';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 1 && args[0] === '--serve', 'Usage: node scripts/demo.mjs [--serve]');
const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require(process.env.ESBUILD_MODULE || 'esbuild'); }
catch { throw new Error('Set ESBUILD_MODULE to an existing esbuild installation, or install the locked development dependencies.'); }
assert.equal(esbuild.version, '0.28.1', 'Use the pinned esbuild 0.28.1');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = JSON.parse(await readFile('demo/wasm.json', 'utf8'));
const bytes = await readFile('demo/pmp.wasm');
verifyVendor();
assert.equal(metadata.wasm.sha256, digest(bytes), 'Demo Wasm hash differs from the reviewed build');
assert.deepEqual(metadata.sources.inputHashes, buildInputHashes(), 'Native sources changed: rebuild and refresh demo/pmp.wasm and demo/wasm.json');
for (const [file, hash] of Object.entries(metadata.wrappers))
  assert.equal(digest(await readFile(file)), hash, `Changed wrapper ${file}: review and refresh the demo snapshot`);
const exports = JSON.parse(await readFile('exports/core.json', 'utf8'));
const module = audit(bytes, exports).module;
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.equal(new WebAssembly.Instance(module, {}).exports.pmp_abi_version(), metadata.abiVersion);

const output = 'build/demo';
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const bundle = await esbuild.build({ entryPoints: { app: 'demo/app.js', worker: 'demo/worker.js' },
  outdir: output, bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm',
  target: 'chrome93', minify: true, legalComments: 'inline', external: ['node:*'], logLevel: 'silent' });
for (const [file, info] of Object.entries(bundle.metafile.outputs)) {
  assert(!info.imports.length, `Demo must not retain external runtime imports: ${file}`);
}
for (const file of bundle.outputFiles) {
  assert(!/\b(?:import|require)\s*\(\s*["']node:/.test(file.text), 'Demo retains a Node import');
  await writeFile(file.path, file.contents);
}
await copyFile('demo/index.html', `${output}/index.html`);
await copyFile('demo/pmp.wasm', `${output}/pmp.wasm`);
await copyFile('demo/wasm.json', `${output}/wasm.json`);
await writeFile(`${output}/.nojekyll`, '');

const licenses = new Map([
  ['pmp-wasi-MIT.txt', 'LICENSE'], ['pmp-MIT.txt', 'vendor/pmp/LICENSE.txt'],
  ['gltf-transform-core-MIT.txt', 'node_modules/@gltf-transform/core/LICENSE.md'],
  ['gltf-transform-extensions-MIT.txt', 'node_modules/@gltf-transform/extensions/LICENSE.md'],
  ['property-graph-MIT.txt', 'node_modules/property-graph/LICENSE'],
  ['ktx-parse-MIT.txt', 'node_modules/ktx-parse/LICENSE'],
  ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
]);
for (const file of (await readdir('vendor/eigen')).filter(file => file.startsWith('COPYING.')))
  licenses.set(`eigen/${file}`, `vendor/eigen/${file}`);
const notices = JSON.parse(await readFile('licenses/runtime/manifest.json', 'utf8'));
assert.deepEqual(metadata.runtimeArchives, notices.runtimeArchives);
for (const file of notices.files) {
  assert.equal(digest(await readFile(`licenses/runtime/${file.path}`)), file.sha256);
  licenses.set(`runtime/${file.path}`, `licenses/runtime/${file.path}`);
}
licenses.set('runtime/manifest.json', 'licenses/runtime/manifest.json');
for (const [name, source] of licenses) {
  await mkdir(resolve(output, 'licenses', name, '..'), { recursive: true });
  await copyFile(source, `${output}/licenses/${name}`);
}
await writeFile(`${output}/licenses.html`, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo licenses · pmp-wasi</title><link rel="stylesheet" href="./app.css"><body><section class="workspace"><h1>Demo licenses</h1><p><a href="./">← Back to the demo</a></p><p>The demo bundles pmp-wasi, glTF-Transform and their dependencies. Each retains its own license.</p><p>Corresponding native source: <a href="https://github.com/kzhsw/pmp-wasi">pmp-wasi repository</a>. The <a href="./wasm.json">build record</a> identifies the exact source inputs and runtime archives; the notices link to pinned upstream sources.</p><ul>${[...licenses.keys()].map(name => `<li><a href="./licenses/${name}">${name}</a></li>`).join('')}</ul></section></body></html>\n`);
const assets = new Map();
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, path = resolve(directory, entry.name);
    assert(!entry.isSymbolicLink(), 'Demo assets must not be symlinks');
    if (entry.isDirectory()) await collect(path, name + '/');
    else assets.set(name, await readFile(path));
  }
}
await collect(output);
const report = { esbuild: esbuild.version, wasmSha256: digest(bytes), files: Object.fromEntries(
  [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) =>
    [name, { bytes: data.length, gzipBytes: gzipSync(data).length, sha256: digest(data) }])) };
await writeFile('build/demo-build-report.json', JSON.stringify(report, null, 2) + '\n');
for (const name of ['app.js', 'app.css', 'worker.js', 'pmp.wasm'])
  console.log(`${name}: ${report.files[name].bytes} bytes / ${report.files[name].gzipBytes} gzip`);

if (args[0] === '--serve') {
  const port = Number(process.env.PORT || 4173);
  assert(Number.isInteger(port) && port > 0 && port <= 65535, 'PORT must be 1–65535');
  const server = createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
    const data = assets.get(name);
    if (request.method !== 'GET' || !data) { response.writeHead(404).end(); return; }
    const ext = name.split('.').at(-1), types = { html: 'text/html', js: 'text/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json' };
    response.writeHead(200, { 'Content-Type': types[ext] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(data);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Demo: http://127.0.0.1:${port}`));
}
