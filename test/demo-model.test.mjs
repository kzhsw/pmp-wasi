import assert from 'node:assert/strict';
import test from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { createSample, loadFiles, makeResult, readBytes } from '../demo/model.js';
import { fixture, geometry, graph } from './gltf/fixtures.mjs';

const io = new NodeIO();
const file = (name, bytes) => new File([bytes], name);
const jsonFile = json => file('scene.gltf', JSON.stringify(json));

test('demo GLB roundtrip preserves rich scene, skin, morph and custom data', async () => {
  const source = fixture({ n: 3, rich: true, shared: true }).doc;
  const input = await io.writeBinary(source);
  const loaded = await loadFiles([file('rich.glb', input)]);
  const result = await makeResult(loaded.document, loaded.name);
  const exported = await readBytes(result.bytes);
  assert.deepEqual(geometry(exported), geometry(source));
  assert.deepEqual(graph(exported), graph(source));
  assert.equal(result.preview.primitives.length, 2);
  assert.notDeepEqual(result.preview.primitives[0].matrix, result.preview.primitives[1].matrix);
  assert(result.reports.some(report => /base geometry/.test(report.reason)));
  assert.equal(result.summary.vertices, 16);
});

test('demo resolves local companions and data URIs without any network access', async () => {
  const source = fixture({ n: 2, rich: false }).doc;
  const original = await io.writeJSON(source);
  const buffer = original.resources[original.json.buffers[0].uri];
  const external = structuredClone(original.json);
  external.buffers[0].uri = 'buffers/local%20data.bin';
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Model loading must never fetch resources');
  try {
    const loaded = await loadFiles([jsonFile(external), file('local data.bin', buffer)]);
    assert.deepEqual(geometry(loaded.document), geometry(source));
    const embedded = structuredClone(external);
    embedded.buffers[0].uri = 'data:application/octet-stream;base64,' + Buffer.from(buffer).toString('base64');
    const fromData = await loadFiles([jsonFile(embedded)]);
    assert.deepEqual(geometry(fromData.document), geometry(source));
    await assert.rejects(loadFiles([jsonFile(external)]), /Missing companion/);
    await assert.rejects(loadFiles([jsonFile(external), file('local data.bin', buffer), file('unused.png', 'x')]), /Unused companion/);
    const remote = structuredClone(external); remote.buffers[0].uri = 'https://example.invalid/geometry.bin';
    await assert.rejects(loadFiles([jsonFile(remote)]), /Only supplied local resources/);
  } finally { globalThis.fetch = savedFetch; }
});

test('demo rejects unsupported extensions, excessive allocation and malformed graph declarations', async () => {
  const { json } = await io.writeJSON(fixture({ n: 2, rich: false }).doc);
  for (const extension of ['VENDOR_unknown', 'KHR_draco_mesh_compression', 'EXT_meshopt_compression']) {
    const model = structuredClone(json); model.extensionsUsed = [extension];
    await assert.rejects(loadFiles([jsonFile(model)]), /Unsupported glTF extension|needs a codec/);
  }
  const oversized = structuredClone(json); oversized.accessors[0].count = 2 ** 32;
  await assert.rejects(loadFiles([jsonFile(oversized)]), /excessive decoded accessor/);
  const cyclic = structuredClone(json); cyclic.nodes[0].children = [0];
  await assert.rejects(loadFiles([jsonFile(cyclic)]), /Cyclic/);
  const unknown = structuredClone(json); unknown.meshes[0].primitives[0].extensions = { VENDOR_unknown: {} };
  await assert.rejects(loadFiles([jsonFile(unknown)]), /Unknown or undeclared/);
  await assert.rejects(loadFiles([file('a.glb', 'x'), file('b.glb', 'x')]), /exactly one/);
  await assert.rejects(loadFiles([file('a.glb', 'x'), file('a.glb', 'x')]), /Ambiguous/);
});

test('demo GLB parser handles truncated and malformed containers with bounded errors', async () => {
  const bytes = await io.writeBinary(fixture({ n: 2, rich: false }).doc);
  for (let length = 0; length < bytes.length; length += Math.max(1, Math.floor(bytes.length / 80)))
    await assert.rejects(readBytes(bytes.slice(0, length)), Error);
  for (const [offset, value] of [[4, 1], [8, 0xffffffff], [12, 0xffffffff], [16, 0]]) {
    const malformed = bytes.slice(); new DataView(malformed.buffer).setUint32(offset, value, true);
    await assert.rejects(readBytes(malformed), Error);
  }
  const recovered = await readBytes(bytes);
  assert.equal(recovered.getRoot().listMeshes().length, 1);
});

test('demo preview decodes normalized colors and strip winding, retaining source mode on export', async () => {
  const source = fixture({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
    indices: [0, 1, 2, 3], mode: 5, rich: true, skin: false, morph: false }).doc;
  const result = await makeResult(source, 'strip.glb');
  const primitive = result.preview.primitives[0];
  assert.deepEqual([...primitive.indices], [0, 1, 2, 1, 3, 2]);
  assert.equal(primitive.colors[3], 1);
  assert(Math.abs(primitive.colors[4] - 1 / 255) < 1e-8);
  assert.equal((await readBytes(result.bytes)).getRoot().listMeshes()[0].listPrimitives()[0].getMode(), 5);
  assert.equal(result.summary.triangles, 2);
});

test('demo snapshot verifies finite geometry and includes both generated sample meshes', async () => {
  const result = await makeResult(createSample(), 'sample.glb');
  assert.equal(result.meshes.length, 2);
  assert.equal(result.summary.triangles, 7936);
  assert.equal(result.preview.primitives.length, 2);
  const malformed = fixture({ n: 2, rich: false }).doc;
  malformed.getRoot().listMeshes()[0].listPrimitives()[0].getAttribute('POSITION').getArray()[0] = NaN;
  await assert.rejects(makeResult(malformed, 'bad.glb'), /Nonfinite POSITION/);
});
