// Bounded seeded model-based checks, shared without changes by Node and WebIO.
import { instantiate } from '../../src/index.js';
import { process } from '../../src/gltf-transform.js';
import { fixture, geometry, graph, summary, validate } from './fixtures.mjs';
import { variants } from './scenarios.mjs';

const invalidVariants = [
  ['nonfinite position', f => { f.primitive.getAttribute('POSITION').getArray()[0] = NaN; }],
  ['out-of-range index', f => { f.primitive.getIndices().getArray()[0] = 65535; }],
  ['duplicate face', f => { const a = f.primitive.getIndices().getArray(); a.set(a.subarray(0, 3), 3); }],
  ['zero-area face', f => { const a = f.primitive.getAttribute('POSITION').getArray(); a.set(a.subarray(0, 3), 3); }],
  ['attribute cardinality', f => { f.primitive.getAttribute('TEXCOORD_1').setArray(new Float32Array(4)); }],
  ['negative skin weight', f => { f.primitive.getAttribute('WEIGHTS_1').getArray()[0] = -0.25; }],
  ['zero skin weights', f => { for (const set of [0, 1]) f.primitive.getAttribute(`WEIGHTS_${set}`).getArray().fill(0, 0, 4); }],
  ['normal-only morph', f => { f.primitive.listTargets()[0].setAttribute('POSITION', null); }],
  ['morph cardinality', f => { f.primitive.listTargets()[0].getAttribute('POSITION').setArray(new Float32Array(6)); }],
  ['invalid method enum', () => {}, { method: 'invalid' }],
  ['invalid projection distance', () => {}, { maxProjectionDistance: -1 }],
  ['negative iterations', () => {}, { iterations: -1 }],
  ['float normalized attribute', f => { f.primitive.getAttribute('TEXCOORD_0').setNormalized(true); }],
  ['incomplete triangle', f => { f.primitive.getIndices().setArray(new Uint16Array([0, 1, 2, 3])); }],
];

// Retain NaNs and signed zero in atomicity snapshots; JSON would hide both.
function capture(document) {
  const root = document.getRoot();
  return { graph: graph(document), accessors: root.listAccessors().map(accessor => ({ accessor,
    array: accessor.getArray(), values: accessor.getArray().slice() })),
  primitives: root.listMeshes().flatMap(mesh => mesh.listPrimitives().map(primitive => ({ primitive,
    indices: primitive.getIndices(), channels: primitive.listSemantics().map(name => [name, primitive.getAttribute(name)]),
    targets: primitive.listTargets().map(target => ({ target, channels: target.listSemantics().map(name => [name, target.getAttribute(name)]) })) }))) };
}
function unchanged(document, before, check, equal) {
  equal(graph(document), before.graph, 'rejected input preserves graph');
  const accessors = document.getRoot().listAccessors();
  check(accessors.length === before.accessors.length && accessors.every((a, i) => a === before.accessors[i].accessor), 'rejected input preserves accessor ownership');
  for (const { accessor, array, values } of before.accessors)
    check(accessor.getArray() === array && array.length === values.length && array.every((v, i) => Object.is(v, values[i])), 'rejected input preserves array identity and every value, including NaN');
  for (const { primitive, indices, channels, targets } of before.primitives) {
    check(primitive.getIndices() === indices && primitive.listSemantics().length === channels.length &&
      channels.every(([name, accessor]) => primitive.getAttribute(name) === accessor), 'rejected input preserves primitive accessor references');
    check(primitive.listTargets().length === targets.length && targets.every(({ target, channels }, i) => primitive.listTargets()[i] === target &&
      channels.every(([name, accessor]) => target.getAttribute(name) === accessor)), 'rejected input preserves morph references');
  }
}

export async function runGltfFuzz(source, io, { seed = 0x676c7400, seeds = 32 } = {}) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff || !Number.isInteger(seeds) || seeds < 1 || seeds > 256)
    throw new RangeError('Seed must be u32 and seed count between 1 and 256');
  let assertions = 0;
  const results = [];
  for (let iteration = 0; iteration < seeds; ++iteration) {
    const current = (seed + iteration) >>> 0;
    let state = current || 0x6d2b79f5, stage = 'construct';
    const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const unit = () => random() / 2 ** 32;
    const check = (condition, message) => { ++assertions; if (!condition) throw new Error(message); };
    const equal = (a, b, message) => check(JSON.stringify(a) === JSON.stringify(b), message);
    try {
      const n = 3 + random() % 5, scale = 0.8 + unit() * 0.4, offset = [unit(), -unit(), unit()];
      const positions = [];
      for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x) {
        const interior = x > 0 && y > 0 && x < n && y < n;
        positions.push(scale * (x / n + (interior ? (unit() - 0.5) * 0.02 / n : 0)) + offset[0],
          scale * (y / n + (interior ? (unit() - 0.5) * 0.02 / n : 0)) + offset[1],
          scale * 0.08 * Math.sin(Math.PI * x / n) * Math.sin(Math.PI * y / n) + offset[2]);
      }
      const rich = Boolean(random() & 1), options = { n, positions, rich, skin: rich && Boolean(random() & 1),
        morph: rich && Boolean(random() & 1), shared: Boolean(random() & 1) };
      const [operation, defaults] = variants[current % variants.length], parameters = { ...defaults };
      if (operation === 'fillHoles') Object.assign(options, { positions: [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2] });
      if (['decimate', 'remesh', 'subdivide'].includes(operation)) parameters.preserveBoundary = Boolean(random() & 1);
      if (operation === 'decimate') parameters.ratio = 0.65 + unit() * 0.25;
      if ((random() & 1) && operation !== 'normals') parameters.normals = 'preserve';
      const f = fixture(options), channels = new Map(), e = await instantiate(source);
      // Randomize render rows independently, preserving each accessor's format.
      if (rich) for (const semantic of ['TEXCOORD_0', 'TEXCOORD_1', 'COLOR_0', '_CUSTOM']) {
        const a = f.primitive.getAttribute(semantic), values = a.getArray();
        for (let i = 0; i < values.length; ++i) values[i] = semantic === 'COLOR_0' ? random() % 256 : unit() * 4 - 2;
        channels.set(semantic, values.slice());
      }
      if (options.skin) {
        for (let row = 0; row < f.primitive.getAttribute('POSITION').getCount(); ++row) {
          const cuts = [0, random() % 256, random() % 256, random() % 256, 255].sort((a, b) => a - b);
          for (let set = 0; set < 2; ++set) for (let c = 0; c < 4; ++c) {
            f.primitive.getAttribute(`JOINTS_${set}`).getArray()[row * 4 + c] = random() % 3;
            f.primitive.getAttribute(`WEIGHTS_${set}`).getArray()[row * 4 + c] = c < 2 ?
              (cuts[set * 2 + c + 1] - cuts[set * 2 + c]) / (set ? 255 : 1) : 0;
          }
        }
        for (const semantic of ['JOINTS_0', 'JOINTS_1', 'WEIGHTS_0', 'WEIGHTS_1'])
          channels.set(semantic, f.primitive.getAttribute(semantic).getArray().slice());
      }
      const indices = f.primitive.getIndices().getArray();
      for (let i = indices.length / 3 - 1; i > 0; --i) {
        const j = random() % (i + 1);
        for (let c = 0; c < 3; ++c) [indices[i * 3 + c], indices[j * 3 + c]] = [indices[j * 3 + c], indices[i * 3 + c]];
      }
      const winding = random() & 1 ? 'cw' : 'ccw';
      if (winding === 'cw') for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
      options.indices = Array.from(indices); parameters.winding = winding;
      const g = graph(f.doc);
      stage = operation;
      const reports = process(f.doc, e, { operation, ...parameters });
      check(reports.length === 1 && reports[0].status === 'processed', 'one processed source primitive');
      validate(f.doc, check); equal(graph(f.doc), g, 'graph and animation invariants');
      const first = summary(f.doc), oldGeometry = geometry(f.doc);
      stage = 'roundtrip';
      const restored = await io.readBinary(await io.writeBinary(f.doc));
      validate(restored, check); equal(summary(restored), first, 'roundtrip numeric/layout invariants');
      equal(graph(restored), g, 'roundtrip graph invariants');
      stage = 'invalid preflight';
      const [invalid, alter, invalidOptions = {}] = invalidVariants[current % invalidVariants.length];
      const bad = fixture({ n: 3 }); alter(bad);
      const beforeInvalid = capture(bad.doc);
      let error, nativeCalls = 0;
      const watched = Object.fromEntries(Object.entries(e).map(([name, value]) => [name, typeof value === 'function' ? (...args) => {
        if (name !== 'pmp_abi_version') ++nativeCalls;
        return value(...args);
      } : value]));
      try { process(bad.doc, watched, { operation: 'smooth', ...invalidOptions }); } catch (caught) { error = caught; }
      check(error instanceof Error && !(error instanceof WebAssembly.RuntimeError), `${invalid}: expected recoverable rejection`);
      check(nativeCalls === 0, `${invalid}: rejected before any native allocation or geometry operation`);
      unchanged(bad.doc, beforeInvalid, check, equal);
      equal(geometry(f.doc), oldGeometry, 'failed options preserve the previous valid result');
      stage = 'deterministic replay';
      const replay = fixture(options);
      for (const [semantic, values] of channels) replay.primitive.getAttribute(semantic).setArray(values.slice());
      process(replay.doc, await instantiate(source), { operation, ...parameters });
      equal(summary(replay.doc), first, 'seeded replay yields identical outputs');
      results.push({ seed: current, operation, n, rich, skin: options.skin, morph: options.morph, winding, invalid, output: first });
    } catch (cause) {
      const error = new Error(`glTF fuzz seed=${current} stage=${stage}: ${cause.message}`);
      error.seed = current; error.stage = stage; error.cause = cause; throw error;
    }
  }
  return { seed, seeds, assertions, results };
}
