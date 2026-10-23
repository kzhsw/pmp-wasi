// Install an actual npm tarball in isolation and exercise its public entry points.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '..'), execute = promisify(execFile);
const args = process.argv.slice(2), nodeOnly = args.includes('--node-only');
const positional = args.filter(value => value !== '--node-only');
assert(positional.length === 1 && !positional[0].startsWith('--'),
  'Usage: node scripts/package-e2e.mjs <local-package.tgz> [--node-only]');
assert(args.length === positional.length + Number(nodeOnly), 'Unknown or repeated package E2E option');
const tarball = resolve(positional[0]), reportPath = resolve(root, 'build/package-e2e-report.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
await mkdir(dirname(reportPath), { recursive: true });
await rm(reportPath, { force: true });
assert((await lstat(tarball)).isFile(), 'Package argument must be a local tarball file');
assert(/\.tgz$/.test(tarball), 'Package argument must have a .tgz extension');
const tarballSha256 = sha256(await readFile(tarball));

const consumer = await mkdtemp(resolve(tmpdir(), 'pmp-package-consumer-'));
const packageDir = resolve(consumer, 'node_modules/pmp-wasi');
const scenarioPath = resolve(root, 'test/package-scenario.mjs');
const report = { status: 'running', tarball: { name: tarball.split(sep).at(-1), sha256: tarballSha256 },
  nodeOnly, node: { version: process.version, coreModes: ['bytes', 'module'], adapterModes: ['bytes', 'module'] } };
const installFlags = ['--ignore-scripts', '--offline', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund'];
const childEnv = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', npm_config_update_notifier: 'false' };
const runChild = async (file, phase) => {
  // Keep linked optional SDK dependencies resolving within this consumer too.
  const output = await execute(process.execPath, ['--preserve-symlinks', file, phase], {
    cwd: consumer, env: childEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(output.stderr, '', `Consumer ${phase} wrote to stderr`);
  return JSON.parse(output.stdout);
};

async function packageFiles(directory, prefix = '') {
  const output = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + entry.name;
    assert(!entry.isSymbolicLink(), `Installed package contains a symlink: ${path}`);
    if (entry.isDirectory()) output.push(...await packageFiles(resolve(directory, entry.name), path + '/'));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

try {
  // The temporary directory has no repository ancestors or NODE_PATH packages.
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({
    name: 'pmp-wasi-package-consumer', private: true, type: 'module',
  }, null, 2) + '\n');
  const npmArgs = ['install', tarball, ...installFlags];
  const npm = process.env.npm_execpath;
  const install = await execute(npm ? process.execPath : 'npm', npm ? [npm, ...npmArgs] : npmArgs, {
    cwd: consumer, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(resolve(root, 'build/package-install.log'), install.stdout + install.stderr);
  report.install = { flags: installFlags, optionalPeerInitiallyAbsent: false };
  assert.equal(await realpath(packageDir), resolve(await realpath(consumer), 'node_modules/pmp-wasi'),
    'npm must extract the package rather than link to repository sources');
  const installed = await json(resolve(packageDir, 'package.json'));
  assert.equal(installed.name, 'pmp-wasi');
  assert.equal(installed.version, (await json(resolve(root, 'package.json'))).version);
  assert.deepEqual(installed.exports, {
    '.': { types: './src/index.d.ts', import: './src/index.js' },
    './gltf-transform': { types: './src/gltf-transform.d.ts', import: './src/gltf-transform.js' },
    './pmp.wasm': './dist/pmp.wasm', './include/pmp.h': './include/pmp.h',
  }, 'Packed public export map matches the package contract');
  const lock = await json(resolve(consumer, 'package-lock.json'));
  assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/pmp-wasi'],
    'Offline installation must install only the packed package');
  for (const name of ['@gltf-transform/core', 'property-graph']) {
    await assert.rejects(lstat(resolve(consumer, 'node_modules', name)), { code: 'ENOENT' },
      `Optional dependency ${name} must be absent for core-only validation`);
  }
  report.install.optionalPeerInitiallyAbsent = true;
  report.package = { name: installed.name, version: installed.version, private: installed.private };

  await copyFile(scenarioPath, resolve(consumer, 'scenario.mjs'));
  const nodeRunner = `import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runCore,runAdapter} from './scenario.mjs';
const expected=new URL('./node_modules/pmp-wasi/',import.meta.url);
assert.equal(import.meta.resolve('pmp-wasi'),new URL('src/index.js',expected).href);
assert.equal(import.meta.resolve('pmp-wasi/gltf-transform'),new URL('src/gltf-transform.js',expected).href);
assert.equal(import.meta.resolve('pmp-wasi/pmp.wasm'),new URL('dist/pmp.wasm',expected).href);
assert.equal(import.meta.resolve('pmp-wasi/include/pmp.h'),new URL('include/pmp.h',expected).href);
assert.match(await readFile(new URL(import.meta.resolve('pmp-wasi/include/pmp.h')),'utf8'),/#define PMP_ABI_VERSION 1u/);
const bytes=await readFile(new URL(import.meta.resolve('pmp-wasi/pmp.wasm')));
const module=await WebAssembly.compile(bytes);
assert.deepEqual(WebAssembly.Module.imports(module),[]);
let run=runCore;
if(process.argv[2]==='adapter'){
 const {Document}=await import('@gltf-transform/core');
 const adapter=await import('pmp-wasi/gltf-transform');
 run=source=>runAdapter(source,Document,adapter);
}
const result=await run(bytes);
assert.deepEqual(await run(module),result,'Installed bytes/module results differ');
process.stdout.write(JSON.stringify(result));
`;
  const runnerPath = resolve(consumer, 'node-runner.mjs');
  await writeFile(runnerPath, nodeRunner);
  const core = await runChild(runnerPath, 'core');
  report.coreWithoutPeer = core;
  console.log(`Packed core: ABI ${core.abi}, ${core.assertions} assertions per bytes/module mode, optional peer absent`);

  // Expose existing SDK installations only after proving the core is independent.
  const peers = ['@gltf-transform/core', 'property-graph'];
  for (const name of peers) {
    const source = resolve(root, 'node_modules', name), target = resolve(consumer, 'node_modules', name);
    assert((await lstat(source)).isDirectory(), `Install ${name} locally before running the optional adapter tests`);
    await mkdir(dirname(target), { recursive: true });
    await symlink(source, target, 'dir');
  }
  report.peers = Object.fromEntries(await Promise.all(peers.map(async name => [name,
    (await json(resolve(consumer, 'node_modules', name, 'package.json'))).version])));
  const wasmPath = resolve(packageDir, 'dist/pmp.wasm'), bytes = await readFile(wasmPath);
  report.wasm = { sha256: sha256(bytes), bytes: bytes.length };
  const files = await packageFiles(packageDir);
  const sourceFiles = new Map(files.map(file => [`package/${file}`, resolve(packageDir, file)]));
  sourceFiles.set('harness/scripts/package-e2e.mjs', resolve(root, 'scripts/package-e2e.mjs'));
  sourceFiles.set('harness/test/package-scenario.mjs', scenarioPath);
  sourceFiles.set('consumer/scenario.mjs', resolve(consumer, 'scenario.mjs'));
  sourceFiles.set('consumer/node-runner.mjs', runnerPath);
  for (const [name, entries] of [
    ['@gltf-transform/core', ['package.json', 'dist/index.js']],
    ['property-graph', ['package.json', 'dist/index.mjs']],
  ]) for (const entry of entries) sourceFiles.set(`peer/${name}/${entry}`, resolve(consumer, 'node_modules', name, entry));
  const fingerprints = async () => Object.fromEntries(await Promise.all([...sourceFiles].map(async ([name, path]) =>
    [name, sha256(await readFile(path))])));
  const sourceHashes = await fingerprints();
  report.sourceHashes = sourceHashes;
  const adapter = await runChild(runnerPath, 'adapter');
  const expected = { core, adapter };
  report.results = expected;
  console.log(`Packed adapter: ${adapter.cases.length} workflows, ${adapter.assertions} assertions per bytes/module mode`);

  if (!nodeOnly) {
    assert(process.env.ESBUILD_MODULE, 'Set ESBUILD_MODULE to an existing esbuild installation; no packages are downloaded');
    assert(process.env.PLAYWRIGHT_MODULE && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing installations, or explicitly use --node-only');
    const require = createRequire(import.meta.url), esbuild = require(process.env.ESBUILD_MODULE);
    const browserEntry = `import {runCore,runAdapter} from './scenario.mjs';
import {Document} from '@gltf-transform/core';
import * as adapter from 'pmp-wasi/gltf-transform';
window.runPackedPackage=async(mode)=>{
 const response=await fetch('/pmp.wasm');
 const source=mode==='streaming'?await WebAssembly.compileStreaming(response):await response.arrayBuffer();
 return {core:await runCore(source),adapter:await runAdapter(source,Document,adapter)};
};`;
    const bundle = await esbuild.build({ absWorkingDir: consumer,
      stdin: { contents: browserEntry, resolveDir: consumer, sourcefile: 'browser-entry.mjs' },
      bundle: true, write: false, metafile: true, preserveSymlinks: true,
      external: ['node:*'], platform: 'browser', format: 'esm', target: 'chrome93', logLevel: 'silent' });
    assert.equal(bundle.outputFiles.length, 1);
    const inputFiles = Object.keys(bundle.metafile.inputs).filter(file => !file.startsWith('<'));
    for (const file of inputFiles) {
      const absolute = isAbsolute(file) ? file : resolve(consumer, file);
      const withinConsumer = relative(consumer, absolute);
      assert(withinConsumer && !withinConsumer.startsWith('..' + sep) && !isAbsolute(withinConsumer),
        `Browser input escaped the installed consumer: ${file}`);
    }
    assert(inputFiles.some(file => file.replaceAll('\\', '/').endsWith('node_modules/pmp-wasi/src/index.js')),
      'Browser must bundle the installed core entry');
    assert(inputFiles.some(file => file.replaceAll('\\', '/').endsWith('node_modules/pmp-wasi/src/gltf-transform.js')),
      'Browser must bundle the installed optional entry');
    const bundleBytes = bundle.outputFiles[0].contents;
    assert(!/\b(?:import|require)\s*\(\s*["']node:/.test(new TextDecoder().decode(bundleBytes)),
      'Browser bundle retains a Node import');
    report.browserBundle = { sha256: sha256(bundleBytes), target: 'chrome93', inputs: inputFiles };
    const assets = new Map([
      ['/', { type: 'text/html; charset=utf-8', bytes: Buffer.from('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><title>Packed package E2E</title><script type="module" src="/bundle.js"></script>') }],
      ['/bundle.js', { type: 'text/javascript', bytes: bundleBytes }],
      ['/pmp.wasm', { type: 'application/wasm', bytes }],
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
      const context = await browser.newContext({ serviceWorkers: 'block' }), page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && assets.has(url.pathname)) return route.continue();
        errors.push('Request outside loopback asset allowlist');
        return route.abort();
      });
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.runPackedPackage === 'function', null, { timeout: 30000 });
      for (const mode of ['bytes', 'streaming']) {
        let timer;
        const result = await Promise.race([page.evaluate(mode => window.runPackedPackage(mode), mode),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Packed browser workflow timed out')), 30000); }),
        ]).finally(() => clearTimeout(timer));
        assert.deepEqual(result, expected, `Packed Chromium ${mode} results differ from Node`);
      }
      assert.deepEqual(errors, [], 'Browser reported errors');
      report.browser = { version: browser.version(), modes: ['bytes', 'streaming'], errors };
      console.log(`Packed Chromium ${browser.version()}: bytes/streaming match isolated Node exactly`);
    } finally {
      try { if (browser) await browser.close(); }
      finally { await new Promise(resolve => server.close(resolve)); }
    }
  }
  assert.deepEqual(await fingerprints(), sourceHashes, 'Installed package, peer or harness files changed during validation');
  assert.equal(sha256(await readFile(tarball)), report.tarball.sha256, 'Tarball changed during validation');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message };
  if (error.stderr) report.failure.stderr = error.stderr;
  throw error;
} finally {
  try { await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n'); }
  finally { await rm(consumer, { recursive: true, force: true }); }
}
