// Exercise the built GitHub Pages demo with synthetic, redistributable assets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { fixture, geometry, graph, summary, validate } from '../test/gltf/fixtures.mjs';

const root = resolve(import.meta.dirname, '..');
const siteDirectory = resolve(root, 'build/demo');
const reportPath = resolve(root, 'build/demo-e2e-report.json');
const outputDirectory = resolve(root, 'build/demo-e2e');
const basePath = '/pmp-wasi/';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const io = new NodeIO();
const report = { status: 'running', node: process.version, deploymentPath: basePath, cases: [], assertions: 0 };
let browser, server, context, page, activeCase;
const errors = [], forbiddenRequests = [], requestedAssets = new Set();
const check = (condition, message) => { ++report.assertions; assert(condition, message); };
const equal = (actual, expected, message) => { ++report.assertions; assert.deepEqual(actual, expected, message); };

assert.equal(process.argv.length, 2, 'Usage: node scripts/demo-e2e.mjs (build the demo first)');
await mkdir(outputDirectory, { recursive: true });
await rm(reportPath, { force: true });

async function builtAssets(directory, prefix = '') {
  const assets = new Map();
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    check(!entry.isSymbolicLink(), `Demo output contains a symlink: ${prefix}${entry.name}`);
    const name = prefix + entry.name, path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      for (const [childName, asset] of await builtAssets(path, name + '/')) assets.set(childName, asset);
    } else {
      check(entry.isFile(), `Demo output is not a regular file: ${name}`);
      const bytes = await readFile(path);
      assets.set(name, { bytes, sha256: sha256(bytes) });
    }
  }
  return assets;
}

function counts(document) {
  return document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives()).reduce((result, primitive) => {
    result.vertices += primitive.getAttribute('POSITION')?.getCount() || 0;
    if (primitive.getMode() === 4) result.triangles += (primitive.getIndices()?.getCount()
      ?? primitive.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    return result;
  }, { vertices: 0, triangles: 0 });
}

const payload = (name, buffer, mimeType = 'model/gltf-binary') => ({ name, mimeType, buffer: Buffer.from(buffer) });

async function documents() {
  const grid = fixture({ n: 6, rich: true, skin: false, morph: false });
  grid.node.setTranslation([0.2, 0.1, 0]).setRotation([0, 0, Math.sin(0.15), Math.cos(0.15)]);
  const rich = await io.writeBinary(grid.doc);
  const animated = await io.writeBinary(fixture({ n: 4, rich: true, skin: true, morph: true, shared: true }).doc);
  const multiple = fixture({ n: 4, rich: true, skin: false, morph: false });
  const second = multiple.doc.createPrimitive().setMode(4).setMaterial(multiple.material)
    .setAttribute('POSITION', multiple.accessor('second-position', 'VEC3', new Float32Array([2, 0, 0, 3, 0, 0, 2, 1, 0])))
    .setIndices(multiple.accessor('second-indices', 'SCALAR', new Uint16Array([0, 1, 2])));
  multiple.doc.getRoot().getDefaultScene().addChild(multiple.doc.createNode('other-node')
    .setMesh(multiple.doc.createMesh('other-mesh').addPrimitive(second)));
  const multi = await io.writeBinary(multiple.doc);
  const plain = await io.writeBinary(fixture({ n: 6, rich: false }).doc);
  const hole = await io.writeBinary(fixture({ rich: false,
    positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1],
    indices: [0, 2, 1, 0, 1, 3, 0, 3, 2],
  }).doc);
  const textured = fixture({ n: 3, rich: true, skin: false, morph: false });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
  textured.material.setBaseColorTexture(textured.doc.createTexture('albedo').setImage(image).setMimeType('image/png'));
  const external = await io.writeJSON(textured.doc);
  check(external.json.buffers?.length === 1 && external.json.images?.length === 1,
    'External fixture has one buffer and one texture');
  const oldBufferURI = external.json.buffers[0].uri, oldImageURI = external.json.images[0].uri;
  const buffer = external.resources[oldBufferURI], texture = external.resources[oldImageURI];
  check(buffer && texture, 'External fixture includes companion bytes');
  external.json.buffers[0].uri = 'geometry.bin'; external.json.images[0].uri = 'albedo.png';
  const externalFiles = [payload('scene.gltf', JSON.stringify(external.json), 'model/gltf+json'),
    payload('geometry.bin', buffer, 'application/octet-stream'), payload('albedo.png', texture, 'image/png')];
  const remoteJSON = structuredClone(external.json);
  remoteJSON.buffers[0].uri = 'https://example.invalid/geometry.bin';
  const rejectedExtensions = ['EXT_demo_unknown', 'KHR_draco_mesh_compression', 'EXT_meshopt_compression'].map(name => {
    const json = structuredClone(external.json);
    json.extensionsUsed = [name]; json.extensionsRequired = [name];
    return { name, files: [payload('unsupported.gltf', JSON.stringify(json), 'model/gltf+json'), ...externalFiles.slice(1)] };
  });
  return { rich, animated, plain, multi, hole, externalFiles, externalImage: texture, rejectedExtensions,
    remoteFiles: [payload('remote.gltf', JSON.stringify(remoteJSON), 'model/gltf+json'), externalFiles[2]],
    heavy: await io.writeBinary(fixture({ n: 64, rich: false }).doc) };
}

async function run(name, body) {
  activeCase = name;
  const start = performance.now(), assertions = report.assertions;
  const output = await body();
  report.cases.push({ name, assertions: report.assertions - assertions,
    milliseconds: Math.round(performance.now() - start), ...(output ? { output } : {}) });
  equal(errors, [], `${name}: browser errors`);
  equal(forbiddenRequests, [], `${name}: requests stay within the static asset allowlist`);
  console.log(`Demo: ${name}`);
}

async function waitState(expected) {
  await page.waitForFunction(expected => document.querySelector('[role="status"]')?.dataset.state === expected,
    expected, { timeout: 60000 });
  const text = await page.getByRole('status').innerText();
  if (expected === 'ready') check(!/\b(?:error|failed)\b/i.test(text), `Ready status must not report failure: ${text}`);
  return text;
}

async function load(files) {
  await page.locator('#file-input').setInputFiles(files);
  await waitState('ready');
  check(await page.locator('#download-button').isEnabled(), 'A loaded model is downloadable');
  check(await page.locator('#run-button').isEnabled(), 'A loaded model can be processed');
}

async function drop(files) {
  await page.locator('#drop-zone').evaluate((zone, files) => {
    const transfer = new DataTransfer();
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.base64), character => character.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files.map(file => ({ name: file.name, mimeType: file.mimeType, base64: file.buffer.toString('base64') })));
  await waitState('ready');
}

async function selectOperation(operation, parameters = {}, advanced = {}) {
  await page.locator('#operation').selectOption(operation);
  // Method changes can regenerate the remaining operation-specific controls.
  if (parameters.method !== undefined) await page.locator('#param-method').selectOption(parameters.method);
  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'method') continue;
    const input = page.locator(`#param-${key}`);
    check(await input.count() === 1, `${operation} has a ${key} control`);
    const tag = await input.evaluate(element => element.tagName);
    if (typeof value === 'boolean') await input.setChecked(value);
    else if (tag === 'SELECT') await input.selectOption(String(value));
    else await input.fill(String(value));
  }
  if (!(await page.locator('#advanced-options').isVisible()))
    await page.locator('details.advanced > summary').click();
  await page.locator('#advanced-options').fill(JSON.stringify(advanced));
}

async function operate(operation, parameters = {}, advanced = {}) {
  await selectOperation(operation, parameters, advanced);
  await page.locator('#run-button').click();
  await waitState('ready');
}

async function download() {
  const pending = page.waitForEvent('download');
  await page.locator('#download-button').click();
  const event = await pending;
  equal(await event.failure(), null, 'GLB download succeeds');
  check(/\.glb$/i.test(event.suggestedFilename()), 'Download uses a GLB filename');
  const bytes = await readFile(await event.path());
  check(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67, 'Download contains a GLB header');
  const doc = await io.readBinary(bytes);
  return { bytes, doc };
}

async function uiCounts(document) {
  const expected = counts(document);
  for (const field of ['vertices', 'triangles']) {
    const displayed = Number((await page.locator(`#${field}-after`).innerText()).replace(/[^0-9]/g, ''));
    equal(displayed, expected[field], `Displayed ${field} match the downloadable document`);
  }
}

function inspect(document) {
  validate(document, check);
  for (const mesh of document.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const normal = primitive.getAttribute('NORMAL');
    if (!normal) continue;
    for (let row = 0; row < normal.getCount(); ++row)
      check(Math.abs(Math.hypot(...normal.getElement(row, [])) - 1) < 5e-5, 'Exported normals have unit length');
  }
  return { ...counts(document), geometry: summary(document) };
}

async function preview(name) {
  const canvas = page.locator('#preview');
  await canvas.waitFor({ state: 'visible' });
  check(await canvas.evaluate(element => element.width > 0 && element.height > 0), 'Preview canvas has a backing buffer');
  // CSS paints behind this transparent canvas. Inspect its framebuffer before
  // compositing clears it, so a CSS gradient cannot stand in for rendered mesh.
  const framebuffer = await canvas.evaluate(element => new Promise(resolve => {
    const gl = element.getContext('webgl2');
    if (!gl) { resolve({ available: false }); return; }
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true }));
    // The F handler queues its draw before this callback in the same frame.
    requestAnimationFrame(() => {
      const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
      const beforeError = gl.getError(), clearColor = Array.from(gl.getParameter(gl.COLOR_CLEAR_VALUE));
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let drawnPixels = 0, coloredPixels = 0, transparentPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] > 0) {
          ++drawnPixels;
          if (pixels[i] || pixels[i + 1] || pixels[i + 2]) ++coloredPixels;
        } else ++transparentPixels;
      }
      resolve({ available: true, width, height, beforeError, afterError: gl.getError(),
        clearColor, drawnPixels, coloredPixels, transparentPixels });
    });
  }));
  check(framebuffer.available, 'Preview exposes a WebGL 2 context');
  equal(framebuffer.beforeError, 0, 'Preview rendering leaves no WebGL error');
  equal(framebuffer.afterError, 0, 'Framebuffer readback leaves no WebGL error');
  equal(framebuffer.clearColor, [0, 0, 0, 0], 'Preview clears the framebuffer to transparent pixels');
  check(framebuffer.drawnPixels > Math.max(32, framebuffer.width * framebuffer.height * 0.005)
    && framebuffer.coloredPixels > 32 && framebuffer.transparentPixels > 0,
  'WebGL framebuffer contains colored mesh pixels against its transparent clear');
  const file = `demo-e2e/${name}.png`;
  await canvas.screenshot({ path: resolve(root, 'build', file) });
  return { screenshot: file, framebuffer };
}

try {
  const assets = await builtAssets(siteDirectory);
  for (const name of ['index.html', 'app.js', 'app.css', 'worker.js', 'pmp.wasm'])
    check(assets.has(name), `Build the demo before testing: missing ${name}`);
  report.assets = Object.fromEntries([...assets].map(([name, asset]) => [name,
    { bytes: asset.bytes.length, sha256: asset.sha256 }]));
  report.harnessSha256 = sha256(await readFile(import.meta.filename));
  const fixtures = await documents();
  assert(process.env.PLAYWRIGHT_MODULE && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    'Set PLAYWRIGHT_MODULE and PLAYWRIGHT_CHROMIUM_EXECUTABLE to existing installations; nothing is downloaded');
  const require = createRequire(import.meta.url), { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
  const routes = new Map([...assets].map(([name, asset]) => [basePath + name, asset]));
  routes.set(basePath, assets.get('index.html'));
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const asset = routes.get(url.pathname);
    if (request.method !== 'GET' || !asset) { response.writeHead(404).end(); return; }
    const extension = extname(url.pathname) || '.html';
    response.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(asset.bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromiumArgs = (process.env.PLAYWRIGHT_CHROMIUM_ARGS || '').split(/\s+/).filter(Boolean);
  // Modern headless Chromium requires explicit permission for its software WebGL implementation.
  if (!chromiumArgs.includes('--enable-unsafe-swiftshader')) chromiumArgs.push('--enable-unsafe-swiftshader');
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, headless: true, args: chromiumArgs });
  report.browser = { version: browser.version(), launchArguments: chromiumArgs };
  context = await browser.newContext({ acceptDownloads: true, serviceWorkers: 'block', viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['data:', 'blob:'].includes(url.protocol)) return route.continue();
    if (url.origin === origin && routes.has(url.pathname)) {
      requestedAssets.add(url.pathname);
      return route.continue();
    }
    forbiddenRequests.push({ protocol: url.protocol, sameOrigin: url.origin === origin,
      path: url.origin === origin ? url.pathname : '(external)', case: activeCase || 'startup' });
    return route.abort();
  });
  await context.routeWebSocket('**/*', route => {
    forbiddenRequests.push({ protocol: 'websocket:', case: activeCase || 'startup' });
    route.close();
  });
  page = await context.newPage();
  page.on('pageerror', error => errors.push({ type: 'pageerror', message: error.message, case: activeCase || 'startup' }));
  page.on('console', message => { if (message.type() === 'error')
    errors.push({ type: 'console', message: message.text(), case: activeCase || 'startup' }); });
  page.setDefaultTimeout(15000);
  await page.goto(origin + basePath, { waitUntil: 'load' });

  await run('built-in sample and rendered preview', async () => {
    await page.locator('#sample-button').click();
    await waitState('ready');
    const { doc } = await download();
    check(counts(doc).triangles > 0, 'Sample includes triangles');
    await uiCounts(doc);
    check((await page.locator('#model-name').innerText()).trim().length > 0, 'Loaded model has a visible name');
    return { ...inspect(doc), preview: await preview('desktop-preview') };
  });

  await run('GLB picker, linear subdivision, attribute transfer and reset', async () => {
    await load(payload('grid.glb', fixtures.rich));
    const source = await io.readBinary(fixtures.rich), before = counts(source);
    for (const field of ['vertices', 'triangles']) equal(Number((await page.locator(`#${field}-before`).innerText()).replace(/[^0-9]/g, '')),
      before[field], `Original ${field} match the imported GLB`);
    await operate('subdivide', { method: 'linear', iterations: 1 });
    const result = await download();
    equal(counts(result.doc).triangles, before.triangles * 4, 'Linear subdivision splits each triangle into four');
    check(counts(result.doc).vertices > before.vertices, 'Linear subdivision creates vertices');
    equal(graph(result.doc), graph(source), 'Subdivision retains nodes, transforms, material and extras');
    const primitive = result.doc.getRoot().listMeshes()[0].listPrimitives()[0];
    for (const name of ['TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', '_CUSTOM', '_ID', 'NORMAL'])
      check(Boolean(primitive.getAttribute(name)), `Subdivision retains ${name}`);
    const uv0 = primitive.getAttribute('TEXCOORD_0'), uv1 = primitive.getAttribute('TEXCOORD_1');
    for (let row = 0; row < uv0.getCount(); ++row) {
      const a = uv0.getElement(row, []), b = uv1.getElement(row, []);
      check(Math.abs(b[0] - (2 * a[0] + 0.1)) < 2e-6 && Math.abs(b[1] - (3 * a[1] - 0.2)) < 2e-6,
        'Exported UV channels retain their affine correspondence');
    }
    await uiCounts(result.doc);
    await page.locator('#original-button').click();
    equal(await page.locator('#original-button').getAttribute('aria-pressed'), 'true', 'Original preview is selected');
    await preview('original-preview');
    await page.locator('#result-button').click();
    equal(await page.locator('#result-button').getAttribute('aria-pressed'), 'true', 'Result preview is selected');
    await page.locator('#wireframe').check();
    await page.locator('#fit-button').click();
    await preview('result-wireframe');
    await page.locator('#wireframe').uncheck();
    const output = inspect(result.doc);
    await page.locator('#reset-button').click(); await waitState('ready');
    equal(geometry((await download()).doc), geometry(source), 'Reset restores the complete original geometry and attributes');
    return output;
  });

  await run('skinned morph GLB preserves its graph and projected attributes', async () => {
    await load(payload('animated-grid.glb', fixtures.animated));
    const source = await io.readBinary(fixtures.animated);
    await operate('subdivide', { method: 'linear', iterations: 1 });
    const { doc } = await download(), root = doc.getRoot();
    equal(graph(doc), graph(source), 'Subdivision preserves shared mesh instances, skins, animations and weights');
    equal(counts(doc).triangles, counts(source).triangles * 4, 'Skinned geometry is subdivided');
    equal(root.listSkins().length, 1, 'Export retains the skin');
    equal(root.listAnimations().length, 2, 'Export retains joint and morph animations');
    const primitive = root.listMeshes()[0].listPrimitives()[0];
    equal(primitive.listTargets().length, 1, 'Export retains the morph target');
    for (const name of ['JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1'])
      check(Boolean(primitive.getAttribute(name)), `Export retains ${name}`);
    const morph = primitive.listTargets()[0].getAttribute('POSITION'), uv = primitive.getAttribute('TEXCOORD_0');
    check(Boolean(morph), 'Export retains morph POSITION deltas');
    for (let row = 0; row < uv.getCount(); ++row) {
      const delta = morph.getElement(row, []), coordinates = uv.getElement(row, []);
      check(delta[0] === 0 && delta[1] === 0 && Math.abs(delta[2] - (0.01 + 0.005 * coordinates[0])) < 1e-7,
        'Morph deltas and UVs use the same projected correspondence');
    }
    await uiCounts(doc);
    return { skins: root.listSkins().length, animations: root.listAnimations().length,
      morphTargets: primitive.listTargets().length, ...inspect(doc) };
  });

  await run('GLB drop', async () => {
    await drop([payload('dropped-grid.glb', fixtures.plain)]);
    equal(geometry((await download()).doc), geometry(await io.readBinary(fixtures.plain)), 'Dropped GLB geometry is retained');
  });

  await run('mesh selection preserves the other mesh', async () => {
    await load(payload('two-meshes.glb', fixtures.multi));
    const source = await io.readBinary(fixtures.multi), before = geometry(source);
    await page.locator('#mesh').selectOption('0');
    await operate('subdivide', { method: 'linear', iterations: 1 });
    const { doc } = await download(), after = geometry(doc);
    equal(after[1], before[1], 'Unselected mesh is byte-for-byte unchanged at accessor level');
    equal(after[0].indices.length, before[0].indices.length * 4, 'Selected mesh is subdivided');
    equal(graph(doc), graph(source), 'Selection preserves the scene graph');
    await page.locator('#mesh').selectOption('');
    return inspect(doc);
  });

  await run('glTF with local buffer and texture companions', async () => {
    await load(fixtures.externalFiles);
    const { doc } = await download();
    equal(doc.getRoot().listTextures().length, 1, 'Companion texture survives GLB export');
    equal(Buffer.from(doc.getRoot().listTextures()[0].getImage()), Buffer.from(fixtures.externalImage), 'Texture bytes survive export');
    check(Boolean(doc.getRoot().listMaterials()[0].getBaseColorTexture()), 'Material keeps its texture binding');
    return inspect(doc);
  });

  for (const [name, files, pattern] of [
    ['missing companion rejection', [fixtures.externalFiles[0], fixtures.externalFiles[2]], /(?:missing|not found|companion|resource|buffer)/i],
    ['remote URI rejection without network', fixtures.remoteFiles, /(?:remote|external|https|URI|local|resource)/i],
  ]) await run(name, async () => {
    const before = geometry((await download()).doc);
    await page.locator('#file-input').setInputFiles(files);
    const message = await waitState('error');
    check(pattern.test(message), 'Rejected resource has an actionable error');
    equal(geometry((await download()).doc), before, 'Rejected import preserves the current downloadable document');
    await load(payload('recovered-grid.glb', fixtures.plain));
  });

  for (const extension of fixtures.rejectedExtensions) await run(`${extension.name} rejection preserves the current model`, async () => {
    const before = geometry((await download()).doc);
    await page.locator('#file-input').setInputFiles(extension.files);
    const message = await waitState('error');
    check(message.includes(extension.name), 'Unsupported extension error identifies the declaration');
    check(/(?:unsupported|unavailable|codec)/i.test(message), 'Unsupported extension has an actionable error');
    equal(geometry((await download()).doc), before, 'Unsupported extension preserves the current downloadable geometry');
    await load(payload('extension-recovery.glb', fixtures.plain));
  });

  const operations = [
    ['decimate', { ratio: 0.7 }],
    ['remesh', { method: 'uniform', edgeLength: 0.2, iterations: 1, projection: true }],
    ['remesh', { method: 'adaptive', minEdgeLength: 0.12, maxEdgeLength: 0.25, approxError: 0.01, iterations: 1, projection: false }],
    ...['loop', 'catmullClark', 'quadTri'].map(method => ['subdivide', { method, iterations: 1 }]),
    ['smooth', { method: 'explicit', iterations: 2, uniformLaplace: false }],
    ['smooth', { method: 'implicit', timestep: 0.001, uniformLaplace: false, rescale: true }],
    ['fillHoles', { maxEdges: 3, maxHoles: 1 }],
    ...['fair', 'area', 'curvature'].map(method => ['fair', { method, ...(method === 'fair' ? { k: 2 } : {}) }]),
    ['normals', {}], ['analyze', {}],
  ];
  for (const [operation, parameters] of operations) await run(`${operation} ${parameters.method || ''}`.trim(), async () => {
    const input = operation === 'fillHoles' ? fixtures.hole : fixtures.plain;
    await load(payload(`${operation}-input.glb`, input));
    await page.locator('#mesh').selectOption('');
    const source = await io.readBinary(input), original = counts(source);
    await operate(operation, parameters);
    const { doc } = await download(), after = counts(doc);
    equal(graph(doc), graph(source), `${operation} retains the scene graph and materials`);
    if (operation === 'decimate') check(after.vertices < original.vertices, 'Decimation reduces vertex count');
    if (operation === 'subdivide') check(after.vertices > original.vertices, 'Subdivision creates vertices');
    if (operation === 'fillHoles') equal(after.triangles, 4, 'Hole filling closes the missing tetrahedron face');
    if (operation === 'analyze') equal(geometry(doc), geometry(source), 'Analysis leaves geometry unchanged');
    if (operation === 'normals') check(Boolean(doc.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('NORMAL')), 'Normals operation creates normals');
    await uiCounts(doc);
    return inspect(doc);
  });

  await run('invalid options and malformed GLB recover without data loss', async () => {
    await load(payload('transaction.glb', fixtures.rich));
    await operate('subdivide', { method: 'linear', iterations: 1 });
    const before = geometry((await download()).doc);
    await page.locator('#advanced-options').fill('{');
    await page.locator('#run-button').click(); await waitState('error');
    equal(geometry((await download()).doc), before, 'Malformed JSON preserves the last result');
    await selectOperation('decimate', { ratio: 0.5 }, { ratio: -1 });
    await page.locator('#run-button').click(); await waitState('error');
    equal(geometry((await download()).doc), before, 'Rejected algorithm options preserve the last result');
    await page.locator('#file-input').setInputFiles(payload('malformed.glb', Buffer.from('not a GLB')));
    await waitState('error');
    equal(geometry((await download()).doc), before, 'Malformed GLB preserves the last result');
    await load(payload('valid-again.glb', fixtures.plain));
    await operate('normals');
    return inspect((await download()).doc);
  });

  await run('repeated imports retain the latest complete model', async () => {
    for (const [name, bytes] of [['first.glb', fixtures.rich], ['second.glb', fixtures.multi], ['third.glb', fixtures.plain]]) {
      await load(payload(name, bytes));
      equal(geometry((await download()).doc), geometry(await io.readBinary(bytes)), 'Repeated import has no stale geometry');
      check((await page.locator('#model-name').innerText()).includes(name), 'Visible filename updates on repeated import');
    }
  });

  await run('worker cancellation preserves the prior result and recovers', async () => {
    await load(payload('cancellation-grid.glb', fixtures.heavy));
    const original = geometry((await download()).doc);
    await selectOperation('subdivide', { method: 'linear', iterations: 3 });
    await page.locator('#run-button').click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.dataset.state === 'busy');
    check(await page.locator('#cancel-button').isEnabled(), 'Busy operation can be cancelled');
    await page.locator('#cancel-button').click();
    check(/cancel/i.test(await waitState('ready')), 'Cancellation is visible in status');
    equal(geometry((await download()).doc), original, 'Cancellation preserves the last complete document');
    await load(payload('after-cancellation.glb', fixtures.plain));
    await operate('normals');
    return { cancelled: true, recovery: counts((await download()).doc) };
  });

  await run('mobile layout and keyboard controls', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout has no horizontal overflow');
    await page.locator('#fit-button').focus();
    await page.keyboard.press('Enter');
    await page.locator('#original-button').focus(); await page.keyboard.press('Enter');
    await page.locator('#result-button').focus(); await page.keyboard.press('Enter');
    const mobile = await preview('mobile-preview');
    await page.screenshot({ path: resolve(outputDirectory, 'mobile-page.png'), fullPage: true });
    return mobile;
  });

  equal(errors, [], 'Demo has no page or console errors');
  equal(forbiddenRequests, [], 'No workflow attempts an off-origin or unlisted network request');
  check(requestedAssets.has(basePath + 'worker.js') && requestedAssets.has(basePath + 'pmp.wasm'),
    'Worker and Wasm load from the GitHub Pages subpath');
  equal(Object.fromEntries([...await builtAssets(siteDirectory)].map(([name, asset]) => [name,
    { bytes: asset.bytes.length, sha256: asset.sha256 }])), report.assets, 'Built assets remain unchanged during E2E');
  equal(sha256(await readFile(import.meta.filename)), report.harnessSha256, 'Test harness remains unchanged during E2E');
  report.requestedAssets = [...requestedAssets].sort();
  report.status = 'passed';
  console.log(`Demo Chromium ${report.browser.version}: ${report.cases.length} cases, ${report.assertions} assertions`);
} catch (error) {
  report.status = 'failed'; report.failure = { case: activeCase || 'startup', message: error.message };
  if (page) {
    try {
      report.failure.status = await page.getByRole('status').innerText({ timeout: 1000 });
      await page.screenshot({ path: resolve(outputDirectory, 'failure.png'), fullPage: true, timeout: 5000 });
    } catch { /* Preserve the original test failure if the page was already lost. */ }
  }
  throw error;
} finally {
  report.browserErrors = errors; report.forbiddenRequests = forbiddenRequests;
  try { if (browser) await browser.close(); }
  finally {
    try { if (server?.listening) await new Promise(resolve => server.close(resolve)); }
    finally {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
    }
  }
}
