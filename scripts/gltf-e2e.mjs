// Optional adapter E2E: local NodeIO and real-browser WebIO use identical tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { runScenarios } from '../test/gltf/scenarios.mjs';
import { runGltfFuzz } from '../test/gltf/fuzz.mjs';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const options = { nodeOnly: false, models: process.env.GLTF_MODELS || null, seed: 0x676c7400, seeds: 32 };
for (let i = 2; i < process.argv.length; ++i) {
  const option = process.argv[i];
  if (option === '--node-only') options.nodeOnly = true;
  else if (option === '--models') options.models = process.argv[++i];
  else if (option === '--seeds') options.seeds = Number(process.argv[++i]);
  else if (option === '--seed') options.seed = Number(process.argv[++i]);
  else throw new Error(`Unknown option ${option}`);
}
assert(Number.isInteger(options.seeds) && options.seeds > 0 && options.seeds <= 256);
assert(Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff);
const reportPath = 'build/gltf-e2e-report.json';
await mkdir('build/gltf', { recursive: true });
await rm(reportPath, { force: true });
const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytes = await readFile('build/pmp-core.wasm'), module = await WebAssembly.compile(bytes);
const sourceFiles = ['src/index.js', 'src/gltf-transform.js', 'src/gltf-transform.d.ts',
  'src/gltf/geometry.js', 'src/gltf/transfer.js', 'src/gltf/attributes.js',
  'test/gltf/fixtures.mjs', 'test/gltf/scenarios.mjs', 'test/gltf/fuzz.mjs',
  'scripts/gltf-e2e.mjs', 'package-lock.json'];
const fingerprints = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha256(await readFile(file))])));
const sourceHashes = await fingerprints();
let entries = [];
if (options.models) {
  const text = options.models.trim();
  const data = JSON.parse(text.startsWith('[') || text.startsWith('{') ? text : await readFile(text, 'utf8'));
  entries = Array.isArray(data) ? data : data.models;
  assert(Array.isArray(entries), 'Model config must be an array or {models:[...]}');
}
const models = await Promise.all(entries.map(async (entry, index) => {
  if (typeof entry === 'string') entry = { path: entry };
  assert(entry && typeof entry.path === 'string', 'Model config entry requires path');
  const modelBytes = await readFile(entry.path);
  return { name: entry.name || `local-model-${index}`, primitives: entry.primitives, options: entry.options,
    bytes: modelBytes, sha256: sha256(modelBytes) };
}));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const run = async source => {
  const scenarios = await runScenarios(source, io, models), fuzz = await runGltfFuzz(source, io, options);
  return JSON.parse(JSON.stringify({ cases: scenarios.cases, fuzz: fuzz.results, assertions: scenarios.assertions + fuzz.assertions }));
};
const report = { status: 'running', sourceHashes, artifactSha256: sha256(bytes), options: { ...options, models: Boolean(options.models) },
  node: process.version, models: models.map(({ name, bytes, sha256, primitives, options }) => ({ name, bytes: bytes.length, sha256, primitives, options })) };
try {
  const expected = await run(bytes);
  assert.deepEqual(await run(module), expected, 'Node bytes/module results differ');
  report.results = expected;
  console.log(`Node: ${expected.cases.length} scenarios, ${expected.fuzz.length} seeds, ${expected.assertions} assertions per mode`);
  if (!options.nodeOnly) {
    assert(process.env.ESBUILD_MODULE, 'Set ESBUILD_MODULE to an existing esbuild installation; no packages are downloaded');
    assert(process.env.PLAYWRIGHT_MODULE && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'Set existing Playwright module/browser environment variables');
    const require = createRequire(import.meta.url), esbuild = require(process.env.ESBUILD_MODULE);
    const entry = `import {WebIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {runScenarios} from './test/gltf/scenarios.mjs';
import {runGltfFuzz} from './test/gltf/fuzz.mjs';
window.runGltfE2E=async(mode,options)=>{
 const response=await fetch('/core.wasm');
 const source=mode==='streaming'?await WebAssembly.compileStreaming(response):await response.arrayBuffer();
 const modelConfig=await (await fetch('/models.json')).json();
 const models=await Promise.all(modelConfig.map(async(model)=>({...model,bytes:new Uint8Array(await(await fetch(model.url)).arrayBuffer())})));
 const io=new WebIO().registerExtensions(ALL_EXTENSIONS);
 const scenarios=await runScenarios(source,io,models),fuzz=await runGltfFuzz(source,io,options);
 return JSON.parse(JSON.stringify({cases:scenarios.cases,fuzz:fuzz.results,assertions:scenarios.assertions+fuzz.assertions}));
};`;
    const bundle = await esbuild.build({ stdin: { contents: entry, resolveDir: root, sourcefile: 'gltf-browser-entry.mjs' },
      // Core 4.5.1's unused NodeIO has dynamic node: imports. Resolve them as
      // external during bundling, then require tree shaking to remove them.
      external: ['node:*'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'chrome93', logLevel: 'silent' });
    assert(bundle.outputFiles.length === 1);
    assert(!/\b(?:import|require)\s*\(\s*["']node:/.test(new TextDecoder().decode(bundle.outputFiles[0].contents)), 'Browser bundle retains a Node import');
    const assets = new Map([
      ['/', { type: 'text/html', bytes: Buffer.from('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>glTF adapter E2E</title><script type="module" src="/bundle.js"></script>') }],
      ['/bundle.js', { type: 'text/javascript', bytes: bundle.outputFiles[0].contents }],
      ['/core.wasm', { type: 'application/wasm', bytes }],
      ['/models.json', { type: 'application/json', bytes: Buffer.from(JSON.stringify(models.map((model, index) => ({
        name: model.name, primitives: model.primitives, options: model.options, url: `/model-${index}.glb`,
      })))) }],
      ...models.map((model, index) => [`/model-${index}.glb`, { type: 'model/gltf-binary', bytes: model.bytes }]),
    ]);
    const server = createServer((request, response) => {
      const asset = assets.get(new URL(request.url, 'http://localhost').pathname);
      if (request.method !== 'GET' || !asset) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store' }).end(asset.bytes);
    });
    let browser;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const origin = `http://127.0.0.1:${server.address().port}`, { chromium } = require(process.env.PLAYWRIGHT_MODULE);
      browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
        args: (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean) });
      const page = await browser.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin && assets.has(new URL(route.request().url()).pathname)) return route.continue();
        errors.push('Request outside loopback asset allowlist'); return route.abort();
      });
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.runGltfE2E === 'function');
      for (const mode of ['bytes', 'streaming']) {
        let timer;
        const result = await Promise.race([page.evaluate(({ mode, options }) => window.runGltfE2E(mode, options), { mode, options: { seed: options.seed, seeds: options.seeds } }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser glTF workflow timed out')), 120000); })]).finally(() => clearTimeout(timer));
        assert.deepEqual(result, expected, `Browser ${mode} results differ from Node`);
      }
      assert.deepEqual(errors, []);
      report.browser = { version: browser.version(), bundleTarget: 'chrome93', modes: ['bytes', 'streaming'], errors };
      report.browserBundleSha256 = sha256(bundle.outputFiles[0].contents);
      console.log(`Chromium ${browser.version()}: both modes match Node exactly`);
    } finally {
      try { if (browser) await browser.close(); } finally { await new Promise(resolve => server.close(resolve)); }
    }
  }
  assert.deepEqual(await fingerprints(), sourceHashes, 'Adapter/test sources changed during validation');
  assert.equal(sha256(await readFile('build/pmp-core.wasm')), report.artifactSha256, 'Wasm artifact changed during validation');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = { message: error.message, seed: error.seed, stage: error.stage };
  throw error;
} finally { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
