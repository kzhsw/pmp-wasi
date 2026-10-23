// SPDX-License-Identifier: MIT
// Accessor policy is confined to the optional adapter, never the core wrapper.
import { buildTransfer, transferAttribute, transferSkin, computeNormals } from './transfer.js';

const skinName = /^(JOINTS|WEIGHTS)_(\d+)$/;
const floatArray = array => array instanceof Float32Array;

export function readAttribute(accessor, semantic, count) {
  if (accessor.listExtensions().length) throw new TypeError(`${semantic}: accessor extensions are unsupported`);
  const array = accessor.getArray(), size = accessor.getElementSize();
  if (!array || !ArrayBuffer.isView(array) || array instanceof DataView || !size ||
      array.length % size || (count !== undefined && accessor.getCount() !== count))
    throw new TypeError(`${semantic}: invalid accessor storage or vertex count`);
  for (const value of array) if (!Number.isFinite(value)) throw new RangeError(`${semantic}: nonfinite component`);
  const required = semantic === 'POSITION' || semantic === 'NORMAL' ? 3 :
    semantic === 'TANGENT' ? 4 : /^TEXCOORD_\d+$/.test(semantic) ? 2 : skinName.test(semantic) ? 4 : null;
  if (required && size !== required) throw new TypeError(`${semantic}: expected ${required} components`);
  if (/^COLOR_\d+$/.test(semantic) && size !== 3 && size !== 4)
    throw new TypeError(`${semantic}: expected three or four components`);
  const normalized = accessor.getNormalized();
  if (floatArray(array) && normalized) throw new TypeError(`${semantic}: floats cannot be normalized integers`);
  return { accessor, array, size, normalized, semantic };
}

export function decoded(attribute) {
  const { array, normalized } = attribute;
  if (!normalized) return Float32Array.from(array);
  const max = array instanceof Int8Array ? 127 : array instanceof Int16Array ? 32767 :
    array instanceof Uint8Array ? 255 : array instanceof Uint16Array ? 65535 : 4294967295;
  return Float32Array.from(array, value => Math.max(-1, value / max));
}

export function readAttributes(primitive, count) {
  const attributes = new Map();
  for (const semantic of primitive.listSemantics())
    attributes.set(semantic, readAttribute(primitive.getAttribute(semantic), semantic, count));
  const targets = primitive.listTargets().map(target => {
    const channels = new Map();
    for (const semantic of target.listSemantics()) {
      if (!['POSITION', 'NORMAL', 'TANGENT'].includes(semantic))
        throw new TypeError(`Unsupported morph semantic ${semantic}`);
      // Morph tangent deltas are VEC3, unlike base tangents.
      const channel = readAttribute(target.getAttribute(semantic), `morph ${semantic}`, count);
      if (channel.size !== 3) throw new TypeError(`Morph ${semantic} must have three components`);
      channels.set(semantic, channel);
    }
    return { target, channels };
  });
  const skin = [];
  for (const [semantic, channel] of attributes) {
    const match = semantic.match(skinName);
    if (!match) continue;
    const set = Number(match[2]), joints = attributes.get(`JOINTS_${set}`), weights = attributes.get(`WEIGHTS_${set}`);
    if (!joints || !weights) throw new TypeError(`Skin set ${set} requires JOINTS and WEIGHTS`);
    if (match[1] === 'WEIGHTS') continue;
    if (!(joints.array instanceof Uint8Array || joints.array instanceof Uint16Array) || joints.normalized)
      throw new TypeError(`JOINTS_${set} must contain unsigned, unnormalized joint indices`);
    if (!(floatArray(weights.array) && !weights.normalized) &&
        !((weights.array instanceof Uint8Array || weights.array instanceof Uint16Array) && weights.normalized))
      throw new TypeError(`WEIGHTS_${set} must contain floats or normalized unsigned integers`);
    for (const weight of weights.array) if (weight < 0) throw new RangeError('Skin weights cannot be negative');
    skin.push({ set, joints: joints.array, weights: weights.array, normalized: weights.normalized });
  }
  if (skin.length) {
    for (let i = 0; i < count; ++i) {
      let sum = 0;
      for (const { weights } of skin) for (let c = 0; c < 4; ++c) sum += weights[i * 4 + c];
      if (!(sum > 0)) throw new RangeError(`Vertex ${i} has no positive skin weight`);
    }
  }
  return { attributes, targets, skin };
}

export function validateSkinBindings(input, context) {
  // Editing a shared primitive affects every owning mesh, even when selection
  // reached it through only one mesh. Check every affected node's joint table.
  const root = context.document.getRoot();
  const owners = new Set(root.listMeshes().filter(mesh => mesh.listPrimitives().includes(context.primitive)));
  const skins = root.listNodes()
    .filter(node => owners.has(node.getMesh()) && node.getSkin()).map(node => node.getSkin());
  if (input.skin.length && !input.skin.some(channel => channel.set === 0))
    throw new TypeError('Skin attributes require JOINTS_0 and WEIGHTS_0');
  if (!skins.length) return;
  if (!input.skin.length) throw new TypeError('A primitive attached to a skin requires joint/weight attributes');
  const jointCount = skins.reduce((min, skin) => Math.min(min, skin.listJoints().length), Infinity);
  for (const { joints } of input.skin) for (const joint of joints)
    if (joint >= jointCount) throw new RangeError('Joint index exceeds a skin attached to this shared mesh');
}

export function validateTransfer(input, operation, options) {
  const topology = ['remesh', 'subdivide', 'fillHoles'].includes(operation);
  if (options.attributeTransfer === 'strict' && topology) {
    const needsTransfer = [...input.attributes.keys()].some(name => name !== 'POSITION' &&
      !(name === 'NORMAL' && options.normals !== 'preserve') && !(name === 'TANGENT' && options.tangents === 'drop'));
    if (needsTransfer || input.targets.length) throw new TypeError(`${operation} needs projected attribute transfer`);
  }
  if (input.targets.some(target => target.channels.has('NORMAL')) && !input.attributes.has('NORMAL') && !options.forceNormals)
    throw new TypeError('Morph normal deltas require base normals');
  if (options.normals === 'recompute') {
    for (const { channels } of input.targets) {
      if (channels.has('NORMAL') && !channels.has('POSITION'))
        throw new TypeError('Recomputing morph normals requires a POSITION delta in that target; choose normals: preserve or drop');
    }
  }
}

function normalizeDirections(array, stride) {
  for (let i = 0; i < array.length; i += stride) {
    const length = Math.hypot(array[i], array[i + 1], array[i + 2]);
    if (length > 0) for (let c = 0; c < 3; ++c) array[i + c] /= length;
  }
  return array;
}

// Returns detached JS data only. Creating graph objects is a separate commit step.
export function stageAttributes(input, original, output, options) {
  const exact = output.sourceIds !== undefined;
  const mapping = exact ? null : buildTransfer(original.positions, original.indices, output.positions, {
    maxDistance: options.maxProjectionDistance,
  });
  let identicalRows = exact && output.sourceIds.length * 3 === original.positions.length;
  if (exact) {
    if (output.sourceIds.length !== output.positions.length / 3) throw new RangeError('Source ID count does not match output');
    const count = original.positions.length / 3;
    for (let row = 0; row < output.sourceIds.length; ++row) {
      const id = output.sourceIds[row];
      if (!Number.isInteger(id) || id < 0 || id >= count) throw new RangeError('Invalid output source ID');
      if (id !== row) identicalRows = false;
    }
  }
  const attributes = new Map(), targets = [];
  const mapChannel = channel => {
    let array;
    if (identicalRows) array = channel.array.slice();
    else if (exact) {
      // IDs are checked once above. Avoid building and revalidating a three-corner
      // interpolation map for every channel when PMP retained complete rows.
      array = new channel.array.constructor(output.sourceIds.length * channel.size);
      for (let row = 0; row < output.sourceIds.length; ++row) {
        const source = output.sourceIds[row] * channel.size;
        array.set(channel.array.subarray(source, source + channel.size), row * channel.size);
      }
    } else array = transferAttribute(channel.array, channel.size, mapping, {
      normalized: channel.normalized, discrete: !channel.normalized && !floatArray(channel.array),
    });
    return { original: channel.accessor, normalized: channel.normalized, array };
  };
  for (const [semantic, channel] of input.attributes) {
    if (semantic === 'POSITION' || semantic === 'NORMAL' && options.normals !== 'preserve' ||
        semantic === 'TANGENT' && options.tangents === 'drop' || !exact && skinName.test(semantic)) continue;
    const value = mapChannel(channel);
    // Explicit preservation with new topology interpolates directions, not their magnitude.
    if (!exact && (semantic === 'NORMAL' || semantic === 'TANGENT')) {
      const direction = decoded({ array: value.array, normalized: value.normalized });
      normalizeDirections(direction, channel.size);
      if (semantic === 'TANGENT') for (let v = 0; v < direction.length / 4; ++v) {
        let corner = 0;
        for (let c = 1; c < 3; ++c) if (mapping.weights[v * 3 + c] > mapping.weights[v * 3 + corner]) corner = c;
        direction[v * 4 + 3] = channel.array[mapping.indices[v * 3 + corner] * 4 + 3] < 0 ? -1 : 1;
      }
      value.array = direction; value.normalized = false;
    }
    attributes.set(semantic, value);
  }
  attributes.set('POSITION', { original: input.attributes.get('POSITION').accessor,
    array: output.positions, normalized: false });
  const baseNormal = input.attributes.get('NORMAL');
  if (options.normals === 'recompute' && (baseNormal || options.forceNormals)) {
    attributes.set('NORMAL', { original: baseNormal?.accessor, array: input.targets.some(target => target.channels.has('NORMAL')) ?
      computeNormals(output.positions, output.indices) : output.normals || computeNormals(output.positions, output.indices), normalized: false, type: 'VEC3' });
  }
  if (!exact && input.skin.length) {
    for (const channel of transferSkin(input.skin, mapping)) {
      attributes.set(`JOINTS_${channel.set}`, { original: input.attributes.get(`JOINTS_${channel.set}`).accessor,
        array: channel.joints, normalized: false });
      attributes.set(`WEIGHTS_${channel.set}`, { original: input.attributes.get(`WEIGHTS_${channel.set}`).accessor,
        array: channel.weights, normalized: false });
    }
  }
  for (const target of input.targets) {
    const channels = new Map();
    for (const [semantic, channel] of target.channels) {
      if (semantic === 'NORMAL' && options.normals !== 'preserve' ||
          semantic === 'TANGENT' && options.tangents === 'drop') continue;
      const value = mapChannel(channel);
      // Morph deltas may have integer storage under quantization; output explicit float deltas.
      if (!exact) {
        value.array = transferAttribute(decoded(channel), 3, mapping);
        value.normalized = false;
      }
      channels.set(semantic, value);
    }
    if (options.normals === 'recompute' && target.channels.has('NORMAL')) {
      const delta = decoded(channels.get('POSITION'));
      const positions = Float32Array.from(output.positions, (value, i) => value + delta[i]);
      const normals = computeNormals(positions, output.indices);
      const base = attributes.get('NORMAL');
      if (!base) throw new TypeError('Morph normal deltas require base normals');
      for (let i = 0; i < normals.length; ++i) normals[i] -= base.array[i];
      channels.set('NORMAL', { original: target.channels.get('NORMAL').accessor, array: normals, normalized: false });
    }
    targets.push({ original: target.target, channels });
  }
  return { attributes, targets, transfer: exact ? 'exact' : 'projected',
    maxProjectionDistance: exact ? 0 : mapping.distances.reduce((max, distance) => Math.max(max, distance), 0) };
}
