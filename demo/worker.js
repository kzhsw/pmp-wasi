// SPDX-License-Identifier: MIT
import { instantiate } from '../src/index.js';
import { process } from '../src/gltf-transform.js';
import { createSample, loadFiles, makeResult, readBytes } from './model.js';

let modulePromise;
function wasmModule() {
  return modulePromise ||= (async () => {
    const response = await fetch(new URL('./pmp.wasm', import.meta.url));
    if (!response.ok) throw new Error(`Unable to load PMP WebAssembly (${response.status}).`);
    return WebAssembly.compile(await response.arrayBuffer());
  })().catch(error => { modulePromise = undefined; throw error; });
}

function transferables(result) {
  const buffers = new Set([result.bytes.buffer]);
  for (const primitive of result.preview.primitives)
    for (const key of ['positions', 'normals', 'colors', 'indices', 'matrix'])
      if (ArrayBuffer.isView(primitive[key])) buffers.add(primitive[key].buffer);
  return Array.from(buffers);
}

async function handle(message) {
  if (!message || !Number.isSafeInteger(message.id)) throw new Error('Invalid worker request.');
  if (message.type === 'sample') return makeResult(createSample(), 'wavy-spheres.glb');
  if (message.type === 'load') {
    const { document, name } = await loadFiles(message.files || []);
    return makeResult(document, name);
  }
  if (message.type !== 'transform') throw new Error('Unknown demo operation.');
  const document = await readBytes(message.bytes);
  const input = message.options;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected operation options.');
  const meshes = document.getRoot().listMeshes();
  if (message.meshIndex != null && (!Number.isInteger(message.meshIndex) || message.meshIndex < 0 || message.meshIndex >= meshes.length))
    throw new Error('The selected mesh is no longer available.');
  // Never reuse a native instance after an operation, including validation failures or traps.
  const pmp = await instantiate(await wasmModule());
  const maxVertices = input.maxVertices === undefined ? 500_000 : Math.min(input.maxVertices, 500_000);
  const options = { ...input, maxVertices, meshes: message.meshIndex == null ? undefined : [meshes[message.meshIndex]] };
  const reports = process(document, pmp, options);
  return makeResult(document, message.name || 'model.glb', reports);
}

self.onmessage = async event => {
  const id = event.data?.id;
  try {
    const data = await handle(event.data);
    self.postMessage({ id, ok: true, data }, transferables(data));
  } catch (error) {
    const message = error instanceof WebAssembly.RuntimeError
      ? 'The mesh operation trapped. Its worker instance was discarded; try a different operation or mesh.'
      : error instanceof Error ? error.message : String(error);
    self.postMessage({ id, ok: false, error: message.slice(0, 1000) });
  }
};
