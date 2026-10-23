// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { instantiate } from '../src/index.js';
import { analyze, process } from '../src/gltf-transform.js';
import { fixture, geometry } from './gltf/fixtures.mjs';

const module = await WebAssembly.compile(await readFile(new URL('../build/pmp-core.wasm', import.meta.url)));

test('repeated adapter edits release orphan graph properties and native memory plateaus', async () => {
  const e = await instantiate(module), f = fixture();
  const accessors = [], pages = [];
  for (let cycle = 0; cycle < 20; ++cycle) {
    process(f.doc, e, { operation: 'smooth', iterations: 0 });
    accessors.push(f.doc.getRoot().listAccessors().length);
    pages.push(e.memory.buffer.byteLength);
  }
  assert(accessors.every(count => count === accessors[0]), 'old target/attribute accessors do not accumulate');
  assert(pages.slice(3).every(count => count === pages[3]), 'native mesh lifetimes reach a backing plateau');
  assert.equal(f.primitive.listTargets().length, 1);
  assert.equal(f.doc.getRoot().listAnimations().length, 2);
});

test('morph zero deltas remain exactly zero when recomputing base and target normals', async () => {
  const e = await instantiate(module), f = fixture();
  f.primitive.listTargets()[0].getAttribute('POSITION').getArray().fill(0);
  process(f.doc, e, { operation: 'smooth' });
  const normals = f.primitive.listTargets()[0].getAttribute('NORMAL').getArray();
  assert(normals.every(value => value === 0));
});

test('normalized morph deltas retain exact storage on row-preserving paths', async () => {
  const e = await instantiate(module), f = fixture();
  const target = f.primitive.listTargets()[0], input = new Int16Array(target.getAttribute('POSITION').getArray().length);
  for (let i = 2; i < input.length; i += 3) input[i] = 100;
  target.getAttribute('POSITION').setArray(input).setNormalized(true);
  process(f.doc, e, { operation: 'smooth' });
  const output = f.primitive.listTargets()[0].getAttribute('POSITION');
  assert(output.getNormalized());
  assert.deepEqual(output.getArray(), input);
  const normals = f.primitive.listTargets()[0].getAttribute('NORMAL').getArray();
  assert(normals.every(Number.isFinite));
});

test('editing a shared morph target clones only the selected primitive target', async () => {
  const f = fixture(), e = await instantiate(module), target = f.primitive.listTargets()[0];
  const other = f.doc.createPrimitive().setIndices(f.primitive.getIndices());
  for (const name of f.primitive.listSemantics()) other.setAttribute(name, f.primitive.getAttribute(name));
  other.addTarget(target); f.mesh.addPrimitive(other);
  const position = target.getAttribute('POSITION'), normal = target.getAttribute('NORMAL');
  process(f.doc, e, { operation: 'subdivide', method: 'linear', primitives: [f.primitive] });
  assert.equal(other.listTargets()[0], target);
  assert.equal(target.getAttribute('POSITION'), position);
  assert.equal(target.getAttribute('NORMAL'), normal);
  assert.notEqual(f.primitive.listTargets()[0], target);
  assert.equal(other.getAttribute('POSITION').getCount(), 36);
  assert(f.primitive.getAttribute('POSITION').getCount() > 36);
});

test('analysis reports serialize ordinary arrays without changing graph identities', async () => {
  const f = fixture(), e = await instantiate(module), before = geometry(f.doc);
  const [report] = analyze(f.doc, { exports: e });
  assert(Array.isArray(report.measurements.bounds.min));
  assert(Array.isArray(report.measurements.centroid));
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.deepEqual(geometry(f.doc), before);
});

test('unequal document budgets add up exactly and per-primitive target overrides replace ratios', async () => {
  const f = fixture({ rich: false }), e = await instantiate(module);
  const p = f.doc.createPrimitive().setIndices(f.accessor('triangle', 'SCALAR', new Uint16Array([0, 1, 2])))
    .setAttribute('POSITION', f.accessor('triangle-position', 'VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])));
  f.mesh.addPrimitive(p);
  const report = process(f.doc, e, { operation: 'decimate', targetScope: 'document', targetVertices: 25 });
  assert.deepEqual(report.map(item => item.targetVertices), [22, 3]);
  const before = geometry(f.doc);
  assert.throws(() => process(f.doc, e, { operation: 'decimate', targetScope: 'document', targetVertices: 5 }), /at least 6/);
  assert.deepEqual(geometry(f.doc), before);
});

test('invalid mixed options and foreign selections fail without silently dropping parameters', async () => {
  const f = fixture({ rich: false }), e = await instantiate(module), other = fixture({ rich: false });
  const before = geometry(f.doc);
  for (const options of [{ operation: 'smooth', ratio: 0.5 }, { operation: 'normals', seamTexcoord: 0 },
    { operation: 'smooth', meshes: [other.mesh] }, { operation: 'smooth', method: 'explicit', timestep: 0.1 },
    { operation: 'decimate', ratio: 0.5, targetVertices: 10 }, { operation: 'smooth', madeUp: 1 }]) {
    assert.throws(() => process(f.doc, e, options));
    assert.deepEqual(geometry(f.doc), before);
  }
});

test('joint indices are valid for every skin attached to a shared mesh', async () => {
  const f = fixture({ shared: true }), e = await instantiate(module);
  const other = f.doc.getRoot().listNodes().find(node => node.getName() === 'instance');
  other.setSkin(f.doc.createSkin('short-skin').addJoint(f.doc.getRoot().listSkins()[0].listJoints()[0]));
  const before = geometry(f.doc), position = f.primitive.getAttribute('POSITION');
  assert.throws(() => process(f.doc, e, { operation: 'subdivide', method: 'linear' }), /Joint index/);
  assert.deepEqual(geometry(f.doc), before);
  assert.equal(f.primitive.getAttribute('POSITION'), position);
});

test('shared primitives validate skins on every owning mesh, including unselected owners', async () => {
  const f = fixture(), e = await instantiate(module);
  const otherMesh = f.doc.createMesh('other-owner').addPrimitive(f.primitive);
  const shortSkin = f.doc.createSkin('short-skin').addJoint(f.doc.getRoot().listSkins()[0].listJoints()[0]);
  f.doc.createNode('other-skinned-owner').setMesh(otherMesh).setSkin(shortSkin);
  const before = geometry(f.doc), position = f.primitive.getAttribute('POSITION');
  assert.throws(() => process(f.doc, e, { operation: 'subdivide', method: 'linear', meshes: [f.mesh] }), /Joint index/);
  assert.deepEqual(geometry(f.doc), before);
  assert.equal(f.primitive.getAttribute('POSITION'), position);

  const unskinned = fixture({ rich: false });
  const shared = unskinned.doc.createMesh().addPrimitive(unskinned.primitive);
  unskinned.doc.createNode().setMesh(shared).setSkin(unskinned.doc.createSkin().addJoint(unskinned.doc.createNode()));
  assert.throws(() => process(unskinned.doc, e, { operation: 'smooth', meshes: [unskinned.mesh] }), /requires joint\/weight/);
});
