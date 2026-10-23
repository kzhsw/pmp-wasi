import { fixture, geometry, graph, summary, validate } from './fixtures.mjs';
import { instantiate } from '../../src/index.js';
import * as adapter from '../../src/gltf-transform.js';
import { KHRMaterialsVariants, KHRMeshQuantization } from '@gltf-transform/extensions';

export const variants = [
  ['decimate', { ratio: 0.7 }],
  ['remesh', { method: 'uniform', edgeLength: 0.24, iterations: 1, projection: true }],
  ['remesh', { method: 'adaptive', minEdgeLength: 0.14, maxEdgeLength: 0.28, approxError: 0.01, iterations: 1, projection: false }],
  ...['loop', 'catmullClark', 'quadTri', 'linear'].map(method => ['subdivide', { method, iterations: 1 }]),
  ...[false, true].map(uniformLaplace => ['smooth', { method: 'explicit', iterations: 2, uniformLaplace }]),
  ...[false, true].flatMap(uniformLaplace => [false, true].map(rescale => ['smooth', { method: 'implicit', timestep: 0.001, iterations: 1, uniformLaplace, rescale }])),
  ...['fair', 'area', 'curvature'].map(method => ['fair', { method, ...(method === 'fair' ? { k: 2 } : {}) }]),
  ['fillHoles', { maxEdges: 3, maxHoles: 1 }], ['normals', {}],
];
const hole = { positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2] };
export function addPrimitive(f, separateMesh = false) {
  const p = f.doc.createPrimitive().setMode(f.primitive.getMode()).setIndices(f.primitive.getIndices())
    .setMaterial(f.material).setExtras({ tag: 'second' });
  for (const semantic of f.primitive.listSemantics()) p.setAttribute(semantic, f.primitive.getAttribute(semantic));
  for (const target of f.primitive.listTargets()) p.addTarget(target);
  if (separateMesh) f.doc.createScene('second-scene').addChild(f.doc.createNode('second-node')
    .setMesh(f.doc.createMesh('second-mesh').addPrimitive(p)));
  else f.mesh.addPrimitive(p);
  return p;
}
export async function runScenarios(source, io, models = []) {
  let assertions = 0;
  const cases = [], check = (condition, message) => { ++assertions; if (!condition) throw new Error(message); };
  const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
  const rejects = (body, message) => { let error; try { body(); } catch (caught) { error = caught; }
    check(error instanceof Error && !(error instanceof WebAssembly.RuntimeError), message); return error; };
  const run = async (name, body) => { try { cases.push({ name, output: await body() }); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; } };
  const roundtrip = async (doc, processed = null) => {
    const encoded = await io.writeBinary(doc), restored = await io.readBinary(encoded);
    equal(summary(restored), summary(doc), 'GLB roundtrip preserves all numeric geometry/attribute summaries');
    equal(graph(restored), graph(doc), 'GLB roundtrip preserves scene/skin/animation/material graph');
    const selected = processed && new Set(processed.map(([mi, pi]) => restored.getRoot().listMeshes()[mi].listPrimitives()[pi]));
    validate(restored, check, primitive => !selected || selected.has(primitive));
    return { bytes: encoded.length, geometry: summary(restored) };
  };
  for (let i = 0; i < variants.length; ++i) {
    const [operation, options] = variants[i];
    await run(`${operation} ${JSON.stringify(options)}`, async () => {
      const input = operation === 'fillHoles' ? hole : {}, f = fixture(input), e = await instantiate(source);
      const beforeGraph = graph(f.doc), before = geometry(f.doc), original = f.primitive.getAttribute('POSITION').getCount();
      const reports = adapter.process(f.doc, e, { operation, ...options });
      check(Array.isArray(reports) && reports.length === 1 && reports[0].status === 'processed', 'one synchronous processed report');
      equal(graph(f.doc), beforeGraph, 'operation preserves graph and material identity');
      check(f.primitive.getMaterial() === f.material && f.node.getMesh() === f.mesh, 'existing graph objects retained');
      validate(f.doc, check);
      const count = f.primitive.getAttribute('POSITION').getCount();
      if (operation === 'decimate') check(count < original, 'decimation removes vertices');
      if (operation === 'subdivide') check(count > original, 'subdivision creates vertices');
      if (operation === 'fillHoles') check(f.primitive.getIndices().getCount() === 12, 'missing tetrahedron face filled');
      if (['decimate', 'smooth', 'fair', 'normals'].includes(operation)) {
        const sourceAttributes = new Map(before[0].attributes.map(a => [a[0], a]));
        const ids = f.primitive.getAttribute('_ID').getArray();
        for (const semantic of ['TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', '_CUSTOM', 'JOINTS_0', 'WEIGHTS_0', 'JOINTS_1', 'WEIGHTS_1']) {
          const a = f.primitive.getAttribute(semantic), values = a.getArray(), old = sourceAttributes.get(semantic)[4];
          check(values.every((value, index) => value === old[ids[Math.floor(index / a.getElementSize())] * a.getElementSize() + index % a.getElementSize()]), `${semantic}: exact original rows`);
        }
      } else {
        check(f.primitive.getAttribute('WEIGHTS_0').getArray() instanceof Float32Array, 'projected skin weights use float32');
      }
      const uv0 = f.primitive.getAttribute('TEXCOORD_0').getArray(), uv1 = f.primitive.getAttribute('TEXCOORD_1').getArray();
      const morph = f.primitive.listTargets()[0].getAttribute('POSITION').getArray();
      for (let row = 0; row < count; ++row) {
        check(Math.abs(uv1[row * 2] - (2 * uv0[row * 2] + 0.1)) < 1e-6 &&
          Math.abs(uv1[row * 2 + 1] - (3 * uv0[row * 2 + 1] - 0.2)) < 1e-6, 'two UV sets retain their affine correspondence');
        check(morph[row * 3] === 0 && morph[row * 3 + 1] === 0 &&
          Math.abs(morph[row * 3 + 2] - (0.01 + 0.005 * uv0[row * 2])) < 1e-8, 'morph POSITION deltas use the same exact/projected correspondence as UVs');
      }
      const normals = f.primitive.getAttribute('NORMAL').getArray();
      for (let j = 0; j < normals.length; j += 3)
        check(Math.abs(Math.hypot(...normals.subarray(j, j + 3)) - 1) < 3e-5, 'recomputed normals have unit length');
      const equivalent = fixture(input), fn = operation === 'normals' ? adapter.recomputeNormals : adapter[operation];
      await equivalent.doc.transform(fn(await instantiate(source), options));
      equal(summary(equivalent.doc), summary(f.doc), 'transform factory matches synchronous process');
      return roundtrip(f.doc);
    });
  }
  await run('analyze is read-only and mesh-local', async () => {
    const f = fixture({ shared: true }), e = await instantiate(source), before = geometry(f.doc), g = graph(f.doc);
    const position = f.primitive.getAttribute('POSITION'), reports = adapter.analyze(f.doc, e);
    check(reports.length === 1 && reports[0].status === 'analyzed', 'shared mesh analyzed once');
    check(reports[0].measurements.area > 0 && reports[0].measurements.components === 1, 'positive area and one grid component');
    equal(Array.from(reports[0].measurements.bounds.min).slice(0, 2), [0, 0], 'mesh-local minimum ignores translated node instance');
    equal(Array.from(reports[0].measurements.bounds.max).slice(0, 2), [1, 1], 'mesh-local maximum ignores translated node instance');
    equal(geometry(f.doc), before, 'analysis leaves arrays unchanged'); equal(graph(f.doc), g, 'analysis leaves graph unchanged');
    check(f.primitive.getAttribute('POSITION') === position, 'analysis retains accessor identity');
    return { measurements: reports[0].measurements, roundtrip: await roundtrip(f.doc) };
  });
  await run('shared accessors, mesh selection, primitive selection and filter', async () => {
    const f = fixture({ rich: false, shared: true }), second = addPrimitive(f), other = addPrimitive(f, true);
    const position = second.getAttribute('POSITION'), array = [...position.getArray()];
    const reports = adapter.process(f.doc, await instantiate(source), { operation: 'smooth', meshes: [f.mesh],
      primitives: [f.primitive, other], filter: context => context.primitive === f.primitive, method: 'explicit' });
    check(reports.filter(r => r.status === 'processed').length === 1, 'selection intersection processes one primitive once');
    check(second.getAttribute('POSITION') === position && other.getAttribute('POSITION') === position, 'unselected shared accessors retain identity');
    equal([...position.getArray()], array, 'shared input arrays remain unmodified');
    check(f.doc.getRoot().listNodes().filter(n => n.getMesh() === f.mesh).length === 2, 'shared mesh remains shared');
    return roundtrip(f.doc);
  });
  for (const targetScope of ['primitive', 'mesh', 'document']) await run(`decimation ${targetScope} budget and parameters`, async () => {
    const f = fixture({ rich: false }), second = addPrimitive(f, targetScope === 'document');
    const targetVertices = targetScope === 'primitive' ? 25 : 50;
    const reports = adapter.process(f.doc, await instantiate(source), { operation: 'decimate', targetVertices, targetScope, aspectRatio: 5 });
    equal(reports.map(report => report.targetVertices), [25, 25], 'budget apportioned equally across identical primitives');
    const g = fixture({ rich: false }), p = addPrimitive(g);
    const overridden = adapter.process(g.doc, await instantiate(source), { operation: 'decimate', targetVertices: 30, aspectRatio: 5,
      parameters: context => ({ targetVertices: context.primitive === p ? 28 : 25 }) });
    equal(overridden.map(report => report.targetVertices), [25, 28], 'per-primitive callback overrides parameters');
    check(second !== f.primitive, 'two distinct source primitives');
    return { budgets: reports.map(r => r.targetVertices), roundtrip: await roundtrip(f.doc) };
  });
  for (const [label, mode, positions, indices] of [
    ['strip', 5, [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], [0, 1, 2, 3]],
    ['fan', 6, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 3]],
    ['unindexed', 4, [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], null],
  ]) await run(`${label} conversion`, async () => {
    const f = fixture({ rich: false, positions, indices, mode });
    adapter.process(f.doc, await instantiate(source), { operation: 'normals' });
    validate(f.doc, check); check(f.primitive.getIndices().getCount() === 6, 'two indexed triangles');
    return roundtrip(f.doc);
  });
  await run('CW canonical output, preserved boundary and selected vertices', async () => {
    const f = fixture({ skin: false, morph: false }), indices = f.primitive.getIndices().getArray();
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    adapter.process(f.doc, await instantiate(source), { operation: 'decimate', ratio: 0.8, aspectRatio: 5, winding: 'cw', preserveBoundary: true, selectedVertices: [14, 15, 20, 21] });
    validate(f.doc, check); const normals = f.primitive.getAttribute('NORMAL');
    check(normals && normals.getArray().filter((_, i) => i % 3 === 2).every(z => z > 0), 'CW input produces CCW upward-facing output');
    return roundtrip(f.doc);
  });
  for (const [name, alter, options] of [
    ['invalid numeric parameter', () => {}, { operation: 'smooth', iterations: -1 }],
    ['unsupported selection option', () => {}, { operation: 'smooth', selectedVertices: [14] }],
    ['strict projection policy', () => {}, { operation: 'subdivide', attributeTransfer: 'strict' }],
    ['projection distance limit', () => {}, { operation: 'subdivide', maxProjectionDistance: 1e-12 }],
    ['unpaired skin channels', f => f.primitive.setAttribute('WEIGHTS_1', null), { operation: 'smooth' }],
    ['shared primitive with incompatible skin on another mesh', f => {
      const mesh = f.doc.createMesh().addPrimitive(f.primitive);
      const skin = f.doc.createSkin().addJoint(f.doc.getRoot().listSkins()[0].listJoints()[0]);
      f.doc.createNode().setMesh(mesh).setSkin(skin);
    }, { operation: 'smooth', filter: context => context.meshIndex === 0 }],
    ['normal-only morph target', f => f.primitive.listTargets()[0].setAttribute('POSITION', null), { operation: 'smooth' }],
    ['unsupported primitive extension', f => f.primitive.setExtension('KHR_materials_variants', f.doc.createExtension(KHRMaterialsVariants).createMappingList()), { operation: 'smooth' }],
    ['duplicate triangles', f => f.primitive.setIndices(f.accessor('bad-index', 'SCALAR', new Uint16Array([0, 1, 7, 0, 1, 7]))), { operation: 'smooth' }],
    ['invalid attribute cardinality after valid stage', f => addPrimitive(f).setAttribute('TEXCOORD_0', f.accessor('bad-uv', 'VEC2', new Float32Array(4))), { operation: 'smooth' }],
    ['callback throws while preparing second primitive', f => addPrimitive(f), { operation: 'smooth', parameters: context => { if (context.primitiveIndex === 1) throw new Error('callback failure'); return {}; } }],
    ['onReport throws after two stages', f => addPrimitive(f), { operation: 'smooth', onReport: report => { if (report.primitiveIndex === 1) throw new Error('report failure'); } }],
  ]) await run(`${name} is atomic`, async () => {
    const f = fixture(), e = await instantiate(source); alter(f);
    const before = geometry(f.doc), g = graph(f.doc), references = f.mesh.listPrimitives().map(p => p.getAttribute('POSITION'));
    rejects(() => adapter.process(f.doc, e, options), 'expected recoverable validation failure');
    equal(geometry(f.doc), before, 'all primitive arrays remain unchanged on failure'); equal(graph(f.doc), g, 'graph remains unchanged on failure');
    check(f.mesh.listPrimitives().every((p, i) => p.getAttribute('POSITION') === references[i]), 'accessor identities remain unchanged');
    return { unchanged: true };
  });
  await run('invalid skip and unsupported primitive modes', async () => {
    const f = fixture({ rich: false }), second = addPrimitive(f).setMode(1), original = second.getAttribute('POSITION');
    const e = await instantiate(source), reports = adapter.process(f.doc, e, { operation: 'smooth' });
    check(reports.some(r => r.status === 'skipped') && second.getAttribute('POSITION') === original, 'non-surface primitive skipped unchanged');
    rejects(() => adapter.process(f.doc, e, { operation: 'smooth', unsupported: 'error' }), 'strict unsupported mode rejection');
    const g = fixture({ rich: false }); addPrimitive(g).setAttribute('POSITION', g.accessor('bad-position', 'VEC3', new Float32Array([NaN, 0, 0])));
    const skipped = adapter.process(g.doc, await instantiate(source), { operation: 'smooth', invalid: 'skip' });
    check(skipped.some(r => r.status === 'processed') && skipped.some(r => r.status === 'skipped'), 'JS invalid skip preserves valid processing');
    return { skipped: reports.filter(r => r.status === 'skipped').length };
  });
  await run('fatal Wasm trap poisons source without cleanup or document edits', async () => {
    const f = fixture({ rich: false }), e = await instantiate(source), before = geometry(f.doc);
    let trapped = false, reentered = 0;
    const poisoned = Object.fromEntries(Object.entries(e).map(([name, value]) => [name, typeof value === 'function' ? (...args) => {
      if (trapped) { ++reentered; throw new Error('reentered poisoned instance'); }
      if (name === 'pmp_explicit_smoothing') { trapped = true; throw new WebAssembly.RuntimeError('injected fatal trap'); }
      return value(...args);
    } : value]));
    let error; try { adapter.process(f.doc, poisoned, { operation: 'smooth' }); } catch (caught) { error = caught; }
    check(error instanceof WebAssembly.RuntimeError && trapped, 'unexpected native trap is propagated');
    check(reentered === 0, 'no cleanup or view call follows a native trap'); equal(geometry(f.doc), before, 'trap leaves staged document unchanged');
    let poisonedError; try { adapter.process(f.doc, poisoned, { operation: 'smooth' }); } catch (caught) { poisonedError = caught; }
    check(poisonedError instanceof Error, 'poisoned source rejects reuse before Wasm');
    check(reentered === 0, 'poison rejection does not reenter exports');
    return { poisoned: true, reentered };
  });
  await run('supported source shapes and explicit normal/tangent preservation', async () => {
    const compiled = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
    const instance = await WebAssembly.instantiate(compiled, {});
    const summaries = [];
    for (const shape of [instance.exports, instance, { instance }, { exports: instance.exports }]) {
      const f = fixture(), target = f.primitive.listTargets()[0];
      target.setAttribute('POSITION', null);
      adapter.process(f.doc, shape, { operation: 'smooth', normals: 'preserve', tangents: 'preserve' });
      check(f.primitive.getAttribute('TANGENT') !== null && f.primitive.listTargets()[0].getAttribute('TANGENT') !== null,
        'explicit preservation retains base and morph tangents');
      summaries.push(summary(f.doc));
    }
    check(summaries.every(value => JSON.stringify(value) === JSON.stringify(summaries[0])), 'all documented source forms agree');
    return summaries[0];
  });
  await run('normalized quantized POSITION and normal/tangent drop policy', async () => {
    const f = fixture();
    f.doc.createExtension(KHRMeshQuantization).setRequired(true);
    const position = f.primitive.getAttribute('POSITION');
    position.setArray(Uint16Array.from(position.getArray(), value => Math.round(value * 65535))).setNormalized(true);
    f.node.setTranslation([4, -2, 1]).setScale([2, 3, 4]);
    const g = graph(f.doc);
    adapter.process(f.doc, await instantiate(source), { operation: 'smooth', normals: 'drop' });
    check(f.primitive.getAttribute('POSITION').getArray() instanceof Float32Array, 'quantized POSITION decoded to float32');
    check(f.primitive.getAttribute('NORMAL') === null && f.primitive.getAttribute('TANGENT') === null, 'base directions dropped by explicit/default policy');
    check(f.primitive.listTargets()[0].getAttribute('NORMAL') === null && f.primitive.listTargets()[0].getAttribute('TANGENT') === null,
      'morph directions follow the drop policy');
    equal(graph(f.doc), g, 'quantization decode preserves node transforms and graph');
    return roundtrip(f.doc);
  });
  await run('disconnected vertex fans split without welding seams', async () => {
    const options = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1, 0], indices: [0, 1, 2, 0, 3, 4] };
    const f = fixture(options), e = await instantiate(source);
    adapter.process(f.doc, e, { operation: 'normals' });
    check(f.primitive.getAttribute('POSITION').getCount() === 6, 'one disconnected fan receives an additional row');
    equal([...f.primitive.getAttribute('_ID').getArray()].sort((a, b) => a - b), [0, 0, 1, 2, 3, 4], 'split row retains its source vertex attributes');
    const rejected = fixture(options), before = geometry(rejected.doc);
    rejects(() => adapter.process(rejected.doc, e, { operation: 'normals', splitVertices: false }), 'explicit fan-splitting rejection');
    equal(geometry(rejected.doc), before, 'rejected fan splitting is atomic');
    return roundtrip(f.doc);
  });
  for (const model of models) await run(`real ${model.name}`, async () => {
    const doc = await io.readBinary(model.bytes), e = await instantiate(source), g = graph(doc);
    const primitives = (model.primitives || []).map(([mi, pi]) => doc.getRoot().listMeshes()[mi].listPrimitives()[pi]);
    const options = { operation: 'smooth', ...model.options };
    if (options.operation === 'smooth') { options.method ??= 'explicit'; options.iterations ??= 1; }
    const reports = adapter.process(doc, e, { ...options, ...(primitives.length ? { primitives } : {}) });
    check(reports.some(report => report.status === 'processed'), 'real document has processed primitives');
    equal(graph(doc), g, 'real graph, animation, skins and materials retained');
    // Unselected source primitives may intentionally have invalid topology; only
    // output cardinality/finite/index invariants are checked across the document.
    const processed = reports.filter(report => report.status === 'processed').map(report => [report.meshIndex, report.primitiveIndex]);
    const selected = new Set(processed.map(([mi, pi]) => doc.getRoot().listMeshes()[mi].listPrimitives()[pi]));
    validate(doc, check, primitive => selected.has(primitive));
    return { reports, roundtrip: await roundtrip(doc, processed) };
  });
  return { cases, assertions };
}
