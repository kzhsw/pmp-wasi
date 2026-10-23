// Shared synthetic documents and invariants; no filesystem or browser globals.
import { Document } from '@gltf-transform/core';

export function fixture({ n = 5, rich = true, skin = rich, morph = rich, shared = false,
  positions, indices, mode = 4 } = {}) {
  const doc = new Document(), buffer = doc.createBuffer('geometry');
  const accessor = (name, type, array, normalized = false) => doc.createAccessor(name, buffer)
    .setType(type).setArray(array).setNormalized(normalized);
  if (!positions) {
    positions = [];
    for (let y = 0; y <= n; ++y) for (let x = 0; x <= n; ++x)
      positions.push(x / n, y / n, 0.1 * Math.sin(Math.PI * x / n) * Math.sin(Math.PI * y / n));
  }
  if (indices === undefined) {
    indices = [];
    for (let y = 0; y < n; ++y) for (let x = 0; x < n; ++x) {
      const a = y * (n + 1) + x, b = a + 1, d = a + n + 1, c = d + 1;
      indices.push(a, b, c, a, c, d);
    }
  }
  const count = positions.length / 3;
  const material = doc.createMaterial('material').setBaseColorFactor([0.2, 0.4, 0.6, 1]).setExtras({ retained: true });
  const primitive = doc.createPrimitive().setMode(mode).setMaterial(material).setExtras({ tag: 'primitive' })
    .setAttribute('POSITION', accessor('positions', 'VEC3', new Float32Array(positions)));
  if (indices !== null) primitive.setIndices(accessor('indices', 'SCALAR', new Uint16Array(indices)));
  if (rich) {
    const uv0 = [], uv1 = [], color = [], ids = [], custom = [], normals = [], tangents = [];
    for (let i = 0; i < count; ++i) {
      const x = positions[i * 3], y = positions[i * 3 + 1];
      uv0.push(x, y); uv1.push(2 * x + 0.1, 3 * y - 0.2);
      color.push(i % 256, (i * 3) % 256, (i * 7) % 256, 255);
      ids.push(i); custom.push(0.25 * i); normals.push(0, 0, 1); tangents.push(1, 0, 0, 1);
    }
    for (const [name, type, values, Type, normalized] of [
      ['TEXCOORD_0', 'VEC2', uv0, Float32Array], ['TEXCOORD_1', 'VEC2', uv1, Float32Array],
      ['COLOR_0', 'VEC4', color, Uint8Array, true], ['_ID', 'SCALAR', ids, Uint16Array],
      ['_CUSTOM', 'SCALAR', custom, Float32Array], ['NORMAL', 'VEC3', normals, Float32Array],
      ['TANGENT', 'VEC4', tangents, Float32Array],
    ]) primitive.setAttribute(name, accessor(name, type, new Type(values), normalized));
  }
  const mesh = doc.createMesh('mesh').addPrimitive(primitive).setExtras({ mesh: true });
  const node = doc.createNode('model').setMesh(mesh), scene = doc.createScene('scene').addChild(node);
  doc.getRoot().setDefaultScene(scene);
  if (shared) scene.addChild(doc.createNode('instance').setMesh(mesh).setTranslation([10, 0, 0]));
  if (skin) {
    const j0 = doc.createNode('joint0'), j1 = doc.createNode('joint1'), j2 = doc.createNode('joint2');
    j0.addChild(j1); j1.addChild(j2); scene.addChild(j0);
    const matrices = new Float32Array(48);
    for (let j = 0; j < 3; ++j) for (let i = 0; i < 4; ++i) matrices[j * 16 + i * 5] = 1;
    const skeleton = doc.createSkin('skin').addJoint(j0).addJoint(j1).addJoint(j2).setSkeleton(j0)
      .setInverseBindMatrices(accessor('inverseBindMatrices', 'MAT4', matrices));
    for (const model of scene.listChildren().filter(value => value.getMesh() === mesh)) model.setSkin(skeleton);
    for (let set = 0; set < 2; ++set) {
      const joints = new Uint16Array(count * 4), weights = set ? new Float32Array(count * 4) : new Uint8Array(count * 4);
      for (let i = 0; i < count; ++i) {
        joints.set(set ? [2, 0, 0, 0] : [0, 1, 0, 0], i * 4);
        weights.set(set ? [63 / 255, 0, 0, 0] : [128, 64, 0, 0], i * 4);
      }
      primitive.setAttribute(`JOINTS_${set}`, accessor(`joints${set}`, 'VEC4', joints));
      primitive.setAttribute(`WEIGHTS_${set}`, accessor(`weights${set}`, 'VEC4', weights, !set));
    }
    const sampler = doc.createAnimationSampler('rotation').setInput(accessor('times', 'SCALAR', new Float32Array([0, 1])))
      .setOutput(accessor('rotation', 'VEC4', new Float32Array([0, 0, 0, 1, 0, 0, 0.1, Math.sqrt(0.99)])));
    doc.createAnimation('joint-motion').addSampler(sampler).addChannel(doc.createAnimationChannel('joint-channel')
      .setTargetNode(j0).setTargetPath('rotation').setSampler(sampler));
  }
  if (morph) {
    const delta = new Float32Array(count * 3);
    for (let i = 0; i < count; ++i) delta[i * 3 + 2] = 0.01 + 0.005 * positions[i * 3];
    primitive.addTarget(doc.createPrimitiveTarget('shape').setAttribute('POSITION', accessor('morph-position', 'VEC3', delta))
      .setAttribute('NORMAL', accessor('morph-normal', 'VEC3', new Float32Array(count * 3)))
      .setAttribute('TANGENT', accessor('morph-tangent', 'VEC3', new Float32Array(count * 3))));
    mesh.setWeights([0.25]).setExtras({ mesh: true, targetNames: ['shape'] }); node.setWeights([0.5]);
    const sampler = doc.createAnimationSampler('weights').setInput(accessor('morph-times', 'SCALAR', new Float32Array([0, 1])))
      .setOutput(accessor('morph-weights', 'SCALAR', new Float32Array([0, 1])));
    doc.createAnimation('shape-motion').addSampler(sampler).addChannel(doc.createAnimationChannel('shape-channel')
      .setTargetNode(node).setTargetPath('weights').setSampler(sampler));
  }
  return { doc, mesh, primitive, node, material, accessor };
}

export function graph(doc) {
  const root = doc.getRoot(), named = list => list.map(value => value.getName());
  return {
    nodes: root.listNodes().map(node => ({ name: node.getName(), mesh: node.getMesh()?.getName() || null,
      skin: node.getSkin()?.getName() || null, children: named(node.listChildren()),
      // Matrix/TRS conversion during GLB writing can differ by a few double ULPs.
      matrix: node.getMatrix().map(value => Math.round(value * 1e12) / 1e12), weights: node.getWeights() }))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    skins: root.listSkins().map(skin => ({ name: skin.getName(), joints: named(skin.listJoints()),
      matrices: Array.from(skin.getInverseBindMatrices()?.getArray() || []) })),
    animations: root.listAnimations().map(animation => ({ name: animation.getName(), channels: animation.listChannels().map(channel => ({
      node: channel.getTargetNode()?.getName(), path: channel.getTargetPath(), interpolation: channel.getSampler().getInterpolation() || 'LINEAR',
      input: Array.from(channel.getSampler().getInput().getArray()), output: Array.from(channel.getSampler().getOutput().getArray()),
    })) })),
    meshes: root.listMeshes().map(mesh => ({ name: mesh.getName(), weights: mesh.getWeights(), extras: mesh.getExtras(),
      primitives: mesh.listPrimitives().map(primitive => ({ extras: primitive.getExtras(), material: primitive.getMaterial()?.getName(), targets: primitive.listTargets().length })) })),
    materials: root.listMaterials().map(material => ({ name: material.getName(), extras: material.getExtras(), factor: material.getBaseColorFactor() })),
  };
}
export function geometry(doc) {
  return doc.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives().map(primitive => ({
    mode: primitive.getMode(), indices: primitive.getIndices() ? Array.from(primitive.getIndices().getArray()) : null,
    attributes: primitive.listSemantics().sort().map(name => { const a = primitive.getAttribute(name); return [name, a.getType(), a.getNormalized(), a.getArray().constructor.name, Array.from(a.getArray())]; }),
    targets: primitive.listTargets().map(target => target.listSemantics().sort().map(name => [name, Array.from(target.getAttribute(name).getArray())])),
  })));
}
export function validate(doc, check, topology = () => true) {
  for (const mesh of doc.getRoot().listMeshes()) for (const primitive of mesh.listPrimitives()) {
    const position = primitive.getAttribute('POSITION'), count = position.getCount();
    check(position.getArray() instanceof Float32Array && position.getArray().every(Number.isFinite), 'finite float32 positions');
    check(primitive.getMode() === 4 && primitive.getIndices() !== null, 'canonical indexed triangles');
    const indices = primitive.getIndices().getArray();
    check(indices.length % 3 === 0 && indices.every(i => i >= 0 && i < count), 'valid output indices');
    if (topology(primitive)) {
      const positions = position.getArray(), edges = new Map(), faces = new Set();
      for (let i = 0; i < indices.length; i += 3) {
        const [a, b, c] = indices.subarray(i, i + 3), key = [a, b, c].sort((x, y) => x - y).join(':');
        check(!faces.has(key), 'no duplicate output triangle'); faces.add(key);
        const u = [0, 1, 2].map(k => positions[b * 3 + k] - positions[a * 3 + k]);
        const v = [0, 1, 2].map(k => positions[c * 3 + k] - positions[a * 3 + k]);
        check(Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) > 0,
          'positive output triangle area');
        for (const [from, to] of [[a, b], [b, c], [c, a]]) {
          const edge = `${Math.min(from, to)}:${Math.max(from, to)}`, previous = edges.get(edge);
          check(!previous || previous.count === 1 && previous.from === to && previous.to === from, 'manifold consistently oriented output edges');
          edges.set(edge, { from, to, count: (previous?.count || 0) + 1 });
        }
      }
    }
    for (const attribute of primitive.listAttributes()) check(attribute.getCount() === count && attribute.getArray().every(Number.isFinite), 'attribute cardinality and finite values');
    for (const target of primitive.listTargets()) for (const attribute of target.listAttributes())
      check(attribute.getCount() === count && attribute.getArray().every(Number.isFinite), 'morph cardinality and finite deltas');
    const sets = primitive.listSemantics().filter(name => /^JOINTS_\d+$/.test(name)).map(name => Number(name.split('_')[1]));
    for (let row = 0; row < count && sets.length; ++row) {
      let sum = 0;
      for (const set of sets) {
        const joints = primitive.getAttribute(`JOINTS_${set}`), weights = primitive.getAttribute(`WEIGHTS_${set}`);
        check(Boolean(weights) && joints.getCount() === weights.getCount(), 'paired skin channels');
        const values = weights.getElement(row, []), ids = joints.getElement(row, []);
        for (let i = 0; i < 4; ++i) { check(values[i] >= 0 && ids[i] >= 0 && Number.isInteger(ids[i]), 'valid joint influence'); sum += values[i]; }
      }
      check(Math.abs(sum - 1) < 2e-5, 'normalized skin influence sum');
    }
  }
}
export function summary(doc) {
  const round = value => Math.round(value * 1e5) / 1e5;
  const hash = array => { let h = 2166136261; for (const value of array) { h ^= Math.round(value * 1e5); h = Math.imul(h, 16777619); } return h >>> 0; };
  return doc.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives().map(primitive => ({
    vertices: primitive.getAttribute('POSITION').getCount(), triangles: primitive.getIndices()?.getCount() / 3,
    positionHash: hash(primitive.getAttribute('POSITION').getArray()),
    bounds: [primitive.getAttribute('POSITION').getMin([]).map(round), primitive.getAttribute('POSITION').getMax([]).map(round)],
    attributes: primitive.listSemantics().sort().map(name => { const a = primitive.getAttribute(name); return [name, a.getArray().constructor.name, a.getNormalized(), a.getCount(), hash(a.getArray())]; }),
    morphs: primitive.listTargets().map(target => target.listSemantics().sort().map(name => [name, hash(target.getAttribute(name).getArray())])),
  })));
}
