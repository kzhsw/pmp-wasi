// Exercise the same public JS/Wasm workflow in Node and a real browser.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { audit } from './wasm.mjs';
import { runScenario } from '../test/e2e/scenario.mjs';
import { runAlgorithms } from '../test/e2e/algorithms.mjs';

const root = resolve(import.meta.dirname, '..');
const nodeOnly = process.argv.includes('--node-only');
assert(process.argv.slice(2).every(argument => argument === '--node-only'), 'Unknown E2E option');
const reportPath = resolve(root, nodeOnly ? 'build/e2e-node-report.json' : 'build/e2e-report.json');
await rm(reportPath, { force: true });
const files = ['/test/e2e/index.html', '/test/e2e/scenario.mjs', '/test/e2e/algorithms.mjs',
  '/src/index.js', '/build/pmp-core.wasm', '/test/fixtures/native-core.json', '/test/fixtures/native-algorithms.json', '/exports/core.json'];
const assets = new Map(await Promise.all(files.map(async path => [path, await readFile(root + path)])));
const bytes = assets.get('/build/pmp-core.wasm');
const fixtures = JSON.parse(assets.get('/test/fixtures/native-core.json'));
const algorithmFixtures = JSON.parse(assets.get('/test/fixtures/native-algorithms.json'));
const exports = JSON.parse(assets.get('/exports/core.json'));
const module = audit(bytes, exports).module;
const run = async source => {
  const core = await runScenario(source, fixtures, exports);
  const algorithms = await runAlgorithms(source, algorithmFixtures);
  return { cases: [...core.cases, ...algorithms.cases], assertions: core.assertions + algorithms.assertions };
};
const expected = await run(bytes);
assert(expected.cases.length > 0 && expected.assertions > 0);
assert.deepEqual(await run(module), expected, 'Node bytes/module results differ');
const report = { artifactSha256: createHash('sha256').update(bytes).digest('hex'),
  node: { version: process.version, modes: ['bytes', 'module'] },
  assertionsPerRun: expected.assertions, cases: expected.cases };
console.log(`Node ${process.version}: ${expected.cases.length} workflows, ${expected.assertions} assertions per load mode`);

if (!nodeOnly) {
  assert(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to the existing Playwright module');
  assert(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, 'Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to an installed browser');
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
  const mime = { html: 'text/html; charset=utf-8', mjs: 'text/javascript', js: 'text/javascript',
    json: 'application/json', wasm: 'application/wasm' };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const body = assets.get(path === '/' ? '/test/e2e/index.html' : path);
    if (!body || request.method !== 'GET') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': mime[(path === '/' ? 'index.html' : path).split('.').at(-1)],
      'Cache-Control': 'no-store' }).end(body);
  });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: (process.env.PLAYWRIGHT_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean) });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      errors.push(`Unexpected external request: ${route.request().url()}`);
      return route.abort();
    });
    await page.goto(origin, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.runPmpE2E === 'function');
    for (const mode of ['bytes', 'streaming']) {
      let timer;
      const result = await Promise.race([
        page.evaluate(mode => window.runPmpE2E(mode), mode),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser workflow timed out')), 30000); }),
      ]).finally(() => clearTimeout(timer));
      assert.deepEqual(result, expected, `Chromium ${mode} results differ from Node`);
      assert.equal(await page.locator('output').textContent(), `${mode}: ${expected.cases.length} workflows passed`);
    }
    assert.deepEqual(errors, [], 'Browser reported errors');
    report.chromium = { version: browser.version(), modes: ['bytes', 'streaming'], errors };
    console.log(`Chromium ${browser.version()}: both load modes match Node exactly`);
  } finally {
    try { if (browser) await browser.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}
await mkdir(resolve(root, 'build'), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
