// Run the same alternating benchmark in Node or an existing local browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { instantiate } from '../src/index.js';
import { runBenchmark } from './benchmark.mjs';

process.chdir(resolve(import.meta.dirname, '..'));
const args = process.argv.slice(2), browserMode = args.includes('--browser');
const paths = args.filter(path => path !== '--browser');
assert(paths.every(path => !path.startsWith('--')), 'Unknown benchmark option');
if (!paths.length) paths.push('build/pmp-core.wasm');
const buffers = await Promise.all(paths.map(path => readFile(path)));
const fixtures = JSON.parse(await readFile('test/fixtures/native-algorithms.json', 'utf8'));
let result;
if (!browserMode) {
  const variants = await Promise.all(buffers.map(async (bytes, i) => ({ path: paths[i],
    exports: await instantiate(bytes), samples: new Map() })));
  result = { node: process.version, ...runBenchmark(variants, fixtures) };
} else {
  assert(process.env.PLAYWRIGHT_MODULE && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing installations');
  const assets = new Map([
    ['/', ['text/html', '<title>PMP benchmark</title>']],
    ['/src/index.js', ['text/javascript', await readFile('src/index.js')]],
    ['/scripts/benchmark.mjs', ['text/javascript', await readFile('scripts/benchmark.mjs')]],
    ...buffers.map((bytes, i) => [`/variant/${i}.wasm`, ['application/wasm', bytes]]),
  ]);
  const server = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (request.method !== 'GET' || !asset) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': asset[0], 'Cache-Control': 'no-store' }).end(asset[1]);
  });
  const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE);
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean) });
    const page = await browser.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === origin ?
      route.continue() : route.abort());
    await page.goto(origin);
    result = await page.evaluate(async ({ paths, fixtures }) => {
      const { instantiate } = await import('/src/index.js');
      const { runBenchmark } = await import('/scripts/benchmark.mjs');
      const variants = await Promise.all(paths.map(async (path, i) => ({ path,
        exports: await instantiate(await (await fetch(`/variant/${i}.wasm`)).arrayBuffer()), samples: new Map() })));
      return runBenchmark(variants, fixtures);
    }, { paths, fixtures });
    assert.deepEqual(errors, []);
    result.chromium = browser.version();
  } finally {
    try { if (browser) await browser.close(); }
    finally { await new Promise(resolve => server.close(resolve)); }
  }
}
console.log(JSON.stringify(result, null, 2));
