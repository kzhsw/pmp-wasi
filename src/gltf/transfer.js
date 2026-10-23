// SPDX-License-Identifier: MIT
// Geometry-only attribute correspondence. No glTF or Wasm objects are retained.
const NUMERIC_ARRAYS = new Set([Int8Array, Uint8Array, Uint8ClampedArray, Int16Array,
  Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array]);
const INTEGER_RANGES = new Map([[Int8Array, [-128, 127]], [Uint8Array, [0, 255]],
  [Uint8ClampedArray, [0, 255]], [Int16Array, [-32768, 32767]], [Uint16Array, [0, 65535]],
  [Int32Array, [-2147483648, 2147483647]], [Uint32Array, [0, 4294967295]]]);

function require(condition, message) {
  if (!condition) throw new TypeError(message);
}

function numeric(values, label, typed = false) {
  require(values && (NUMERIC_ARRAYS.has(values.constructor) || (!typed && Array.isArray(values))),
    `${label} must be a numeric ${typed ? 'typed array' : 'array'}`);
  for (let i = 0; i < values.length; ++i)
    require(typeof values[i] === 'number' && Number.isFinite(values[i]), `${label}[${i}] must be finite`);
}

function geometry(positions, indices, label) {
  numeric(positions, `${label} positions`);
  numeric(indices, `${label} indices`);
  require(positions.length % 3 === 0, `${label} positions must contain xyz rows`);
  require(indices.length % 3 === 0, `${label} indices must contain triangles`);
  const count = positions.length / 3;
  require(count <= 0xffffffff, `${label} has too many vertices`);
  for (let i = 0; i < indices.length; ++i)
    require(Number.isInteger(indices[i]) && indices[i] >= 0 && indices[i] < count,
      `${label} index ${i} is out of range`);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const scale = Math.max(...ab.map(Math.abs), ...ac.map(Math.abs));
    require(Number.isFinite(scale) && scale > 0, `${label} triangle ${i / 3} is degenerate or exceeds numeric range`);
    const x = ab.map(value => value / scale), y = ac.map(value => value / scale);
    const cross = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    require(cross.some(value => value !== 0), `${label} triangle ${i / 3} is degenerate`);
  }
  return count;
}

function mappingRows(mapping, sourceCount) {
  require(mapping && typeof mapping === 'object', 'mapping is required');
  const { indices, weights, distances } = mapping;
  numeric(indices, 'mapping indices');
  numeric(weights, 'mapping weights');
  require(indices.length % 3 === 0 && weights.length === indices.length, 'mapping must contain three indices and weights per row');
  const count = indices.length / 3;
  if (distances !== undefined) {
    numeric(distances, 'mapping distances');
    require(distances.length === count && distances.every(value => value >= 0), 'mapping distances have invalid size or values');
  }
  for (let i = 0; i < indices.length; i += 3) {
    let sum = 0;
    for (let c = 0; c < 3; ++c) {
      require(Number.isInteger(indices[i + c]) && indices[i + c] >= 0 && indices[i + c] < sourceCount,
        `mapping index ${i + c} is out of range`);
      require(weights[i + c] >= 0 && weights[i + c] <= 1, `mapping weight ${i + c} is out of range`);
      sum += weights[i + c];
    }
    require(Math.abs(sum - 1) <= 1e-6, `mapping row ${i / 3} weights must sum to one`);
  }
  return count;
}

const tieTolerance = (a, b) => 32 * Number.EPSILON * Math.max(a, b, Number.MIN_VALUE);

function boxDistance(node, x, y, z) {
  return Math.hypot(x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0,
    y < node.minY ? node.minY - y : y > node.maxY ? y - node.maxY : 0,
    z < node.minZ ? node.minZ - z : z > node.maxZ ? z - node.maxZ : 0);
}

function closest(positions, indices, triangle, px, py, pz) {
  const offset = triangle * 3, a = indices[offset] * 3, b = indices[offset + 1] * 3, c = indices[offset + 2] * 3;
  const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
  const abx = positions[b] - ax, aby = positions[b + 1] - ay, abz = positions[b + 2] - az;
  const acx = positions[c] - ax, acy = positions[c + 1] - ay, acz = positions[c + 2] - az;
  const scale = Math.max(Math.abs(abx), Math.abs(aby), Math.abs(abz), Math.abs(acx), Math.abs(acy), Math.abs(acz));
  const ab = [abx / scale, aby / scale, abz / scale], ac = [acx / scale, acy / scale, acz / scale];
  const q = [(px - ax) / scale, (py - ay) / scale, (pz - az) / scale];
  const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
  const length = Math.hypot(...normal), unit = normal.map(value => value / length);
  const height = q[0] * unit[0] + q[1] * unit[1] + q[2] * unit[2];
  const projected = q.map((value, axis) => value - height * unit[axis]);
  let drop = 0;
  if (Math.abs(normal[1]) > Math.abs(normal[drop])) drop = 1;
  if (Math.abs(normal[2]) > Math.abs(normal[drop])) drop = 2;
  const x = (drop + 1) % 3, y = (drop + 2) % 3;
  const determinant = ab[x] * ac[y] - ab[y] * ac[x];
  const u = (projected[x] * ac[y] - projected[y] * ac[x]) / determinant;
  const v = (ab[x] * projected[y] - ab[y] * projected[x]) / determinant;
  if (u >= 0 && v >= 0 && u + v <= 1) return { weights: [1 - u - v, u, v], distance: Math.abs(height) * scale };
  let best = null;
  const rows = [a, b, c];
  for (let edge = 0; edge < 3; ++edge) {
    const first = rows[edge], next = (edge + 1) % 3, second = rows[next];
    const dx = positions[second] - positions[first], dy = positions[second + 1] - positions[first + 1], dz = positions[second + 2] - positions[first + 2];
    const edgeScale = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    const ex = dx / edgeScale, ey = dy / edgeScale, ez = dz / edgeScale;
    const t = Math.max(0, Math.min(1, (((px - positions[first]) / edgeScale) * ex +
      ((py - positions[first + 1]) / edgeScale) * ey + ((pz - positions[first + 2]) / edgeScale) * ez) /
      (ex * ex + ey * ey + ez * ez)));
    const point = [positions[first] * (1 - t) + positions[second] * t,
      positions[first + 1] * (1 - t) + positions[second + 1] * t,
      positions[first + 2] * (1 - t) + positions[second + 2] * t];
    const distance = Math.hypot(px - point[0], py - point[1], pz - point[2]);
    if (!best || distance < best.distance) {
      const weights = [0, 0, 0]; weights[edge] = 1 - t; weights[next] = t;
      best = { weights, distance };
    }
  }
  return best;
}

/** Exact original rows, or nearest-triangle projection with deterministic ties. */
export function buildTransfer(sourcePositions, sourceIndices, targetPositions, options = {}) {
  require(options && typeof options === 'object', 'transfer options must be an object');
  const sourceCount = geometry(sourcePositions, sourceIndices, 'source');
  numeric(targetPositions, 'target positions');
  require(targetPositions.length % 3 === 0, 'target positions must contain xyz rows');
  const count = targetPositions.length / 3, { sourceIds, maxDistance = Infinity } = options;
  require(typeof maxDistance === 'number' && maxDistance >= 0 && !Number.isNaN(maxDistance), 'maxDistance must be nonnegative');
  const result = { indices: new Uint32Array(count * 3), weights: new Float64Array(count * 3), distances: new Float64Array(count) };
  if (sourceIds !== undefined) {
    numeric(sourceIds, 'source IDs');
    require(sourceIds.length === count, 'source IDs must match target rows');
    for (let row = 0; row < count; ++row) {
      const id = sourceIds[row];
      require(Number.isInteger(id) && id >= 0 && id < sourceCount, `source ID ${row} is out of range`);
      result.indices.fill(id, row * 3, row * 3 + 3); result.weights[row * 3] = 1;
    }
    return result;
  }
  const triangles = sourceIndices.length / 3;
  require(!count || triangles > 0, 'projection requires at least one source triangle');
  if (!count) return result;
  const order = Uint32Array.from({ length: triangles }, (_, i) => i);
  const bounds = new Float64Array(triangles * 6), centers = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; ++t) for (let axis = 0; axis < 3; ++axis) {
    const a = sourcePositions[sourceIndices[t * 3] * 3 + axis], b = sourcePositions[sourceIndices[t * 3 + 1] * 3 + axis],
      c = sourcePositions[sourceIndices[t * 3 + 2] * 3 + axis];
    bounds[t * 6 + axis] = Math.min(a, b, c); bounds[t * 6 + axis + 3] = Math.max(a, b, c);
    centers[t * 3 + axis] = a / 3 + b / 3 + c / 3;
  }
  const nodes = [{ start: 0, end: triangles }], pending = [0];
  while (pending.length) {
    const id = pending.pop(), node = nodes[id];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = node.start; i < node.end; ++i) for (let axis = 0; axis < 3; ++axis) {
      const t = order[i];
      min[axis] = Math.min(min[axis], bounds[t * 6 + axis]); max[axis] = Math.max(max[axis], bounds[t * 6 + axis + 3]);
      cmin[axis] = Math.min(cmin[axis], centers[t * 3 + axis]); cmax[axis] = Math.max(cmax[axis], centers[t * 3 + axis]);
    }
    [node.minX, node.minY, node.minZ] = min; [node.maxX, node.maxY, node.maxZ] = max;
    if (node.end - node.start <= 8) continue;
    let axis = 0;
    for (let a = 1; a < 3; ++a) if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;
    order.subarray(node.start, node.end).sort((a, b) => centers[a * 3 + axis] - centers[b * 3 + axis] || a - b);
    const middle = Math.floor((node.start + node.end) / 2);
    node.left = nodes.length; node.right = nodes.length + 1;
    nodes.push({ start: node.start, end: middle }, { start: middle, end: node.end });
    pending.push(node.right, node.left);
  }
  const stack = [];
  for (let row = 0; row < count; ++row) {
    const px = targetPositions[row * 3], py = targetPositions[row * 3 + 1], pz = targetPositions[row * 3 + 2];
    let bestDistance = Infinity, bestTriangle = 0xffffffff, bestWeights;
    stack.length = 0; stack.push(0);
    while (stack.length) {
      const node = nodes[stack.pop()], lower = boxDistance(node, px, py, pz);
      if (Number.isFinite(bestDistance) && lower > bestDistance + tieTolerance(lower, bestDistance)) continue;
      if (node.left !== undefined) {
        const left = boxDistance(nodes[node.left], px, py, pz), right = boxDistance(nodes[node.right], px, py, pz);
        if (left <= right) stack.push(node.right, node.left); else stack.push(node.left, node.right);
      } else for (let i = node.start; i < node.end; ++i) {
        const triangle = order[i], candidate = closest(sourcePositions, sourceIndices, triangle, px, py, pz);
        if (!Number.isFinite(candidate.distance)) continue;
        const tie = Number.isFinite(bestDistance) && Math.abs(candidate.distance - bestDistance) <= tieTolerance(candidate.distance, bestDistance);
        if (candidate.distance < bestDistance && !tie || tie && triangle < bestTriangle) {
          bestDistance = candidate.distance; bestTriangle = triangle; bestWeights = candidate.weights;
        }
      }
    }
    require(bestWeights && Number.isFinite(bestDistance), `target ${row} projection exceeds numeric range`);
    require(bestDistance <= maxDistance, `target ${row} exceeds maxDistance (${bestDistance} > ${maxDistance})`);
    result.indices.set(sourceIndices.subarray ? sourceIndices.subarray(bestTriangle * 3, bestTriangle * 3 + 3) :
      sourceIndices.slice(bestTriangle * 3, bestTriangle * 3 + 3), row * 3);
    // u + v <= 1 can hold while evaluating (1 - u) - v gives a tiny
    // negative residual. Repair only arithmetic roundoff in generated maps;
    // public attribute/skin mapping validation remains strict.
    const tolerance = 32 * Number.EPSILON;
    require(bestWeights.every(value => Number.isFinite(value) && value >= -tolerance && value <= 1 + tolerance),
      `target ${row} projection produced invalid barycentric weights`);
    const clamped = bestWeights.map(value => Math.max(0, Math.min(1, value)));
    const sum = clamped[0] + clamped[1] + clamped[2];
    require(sum > 0 && Number.isFinite(sum), `target ${row} projection produced invalid barycentric weights`);
    for (let c = 0; c < 3; ++c) result.weights[row * 3 + c] = clamped[c] / sum;
    result.distances[row] = bestDistance;
  }
  return result;
}

/** Interpolate continuous channels; categorical channels select the first maximum corner. */
export function transferAttribute(array, itemSize, mapping, options = {}) {
  numeric(array, 'attribute', true);
  require(Number.isInteger(itemSize) && itemSize > 0 && array.length % itemSize === 0, 'attribute itemSize is invalid');
  require(options && typeof options === 'object', 'attribute options must be an object');
  const { normalized = false, discrete = false } = options;
  require(typeof normalized === 'boolean' && typeof discrete === 'boolean', 'attribute flags must be booleans');
  const range = INTEGER_RANGES.get(array.constructor);
  require(!normalized || range, 'normalized attributes require integer storage');
  const count = mappingRows(mapping, array.length / itemSize), result = new array.constructor(count * itemSize);
  const categorical = discrete || range && !normalized;
  for (let row = 0; row < count; ++row) {
    const offset = row * 3, indices = mapping.indices, weights = mapping.weights;
    let corner = 0;
    for (let c = 1; c < 3; ++c) if (weights[offset + c] > weights[offset + corner]) corner = c;
    if (categorical || weights[offset + corner] === 1) {
      const source = indices[offset + corner] * itemSize;
      result.set(array.subarray(source, source + itemSize), row * itemSize);
      continue;
    }
    const sum = weights[offset] + weights[offset + 1] + weights[offset + 2];
    for (let component = 0; component < itemSize; ++component) {
      let value = 0;
      for (let c = 0; c < 3; ++c) {
        let source = array[indices[offset + c] * itemSize + component];
        if (normalized) source = Math.max(range[0] < 0 ? -1 : 0, source / range[1]);
        value += source * (weights[offset + c] / sum);
      }
      if (normalized) value = Math.round(Math.max(range[0] < 0 ? -1 : 0, Math.min(1, value)) * range[1]);
      require(Number.isFinite(value), 'interpolated attribute exceeds numeric range');
      result[row * itemSize + component] = value;
      require(Number.isFinite(result[row * itemSize + component]), 'interpolated attribute exceeds storage range');
    }
  }
  return result;
}

/** Merge categorical joint influences across all four-component source sets. */
export function transferSkin(channels, mapping) {
  require(Array.isArray(channels) && channels.length > 0, 'skin channels must be a nonempty array');
  require(channels.every(channel => channel && typeof channel === 'object'), 'skin channels must be objects');
  const ordered = channels.slice().sort((a, b) => a.set - b.set), sets = new Set();
  let vertices, wide = false;
  for (const channel of ordered) {
    require(Number.isSafeInteger(channel.set) && channel.set >= 0 && !sets.has(channel.set), 'skin set IDs must be distinct nonnegative integers');
    sets.add(channel.set);
    const { joints, weights, normalized = false } = channel;
    require(joints instanceof Uint8Array || joints instanceof Uint16Array, 'skin joints require Uint8Array or Uint16Array');
    require(weights instanceof Float32Array || weights instanceof Uint8Array || weights instanceof Uint16Array, 'skin weights require Float32Array, Uint8Array or Uint16Array');
    require(typeof normalized === 'boolean' && (!normalized || !(weights instanceof Float32Array)), 'skin normalized flag is invalid');
    require(joints.length % 4 === 0 && joints.length === weights.length, 'skin sets require four joint/weight pairs per vertex');
    if (vertices === undefined) vertices = joints.length / 4;
    require(joints.length / 4 === vertices, 'skin sets must have the same vertex count');
    numeric(weights, 'skin weights');
    require(weights.every(value => value >= 0), 'skin weights must be nonnegative');
    wide = wide || joints instanceof Uint16Array;
  }
  const totals = new Float64Array(vertices), divisors = ordered.map(channel => channel.normalized ?
    (channel.weights instanceof Uint8Array ? 255 : 65535) : 1);
  for (let row = 0; row < vertices; ++row) {
    for (let set = 0; set < ordered.length; ++set) for (let c = 0; c < 4; ++c)
      totals[row] += ordered[set].weights[row * 4 + c] / divisors[set];
    require(totals[row] > 0 && Number.isFinite(totals[row]), `skin vertex ${row} must have positive total weight`);
  }
  const count = mappingRows(mapping, vertices), JointArray = wide ? Uint16Array : Uint8Array;
  const result = ordered.map(channel => ({ set: channel.set, joints: new JointArray(count * 4), weights: new Float32Array(count * 4) }));
  for (let row = 0; row < count; ++row) {
    const merged = new Map(), offset = row * 3;
    const baryTotal = mapping.weights[offset] + mapping.weights[offset + 1] + mapping.weights[offset + 2];
    for (let c = 0; c < 3; ++c) {
      const vertex = mapping.indices[offset + c], bary = mapping.weights[offset + c] / baryTotal;
      if (!bary) continue;
      for (let set = 0; set < ordered.length; ++set) for (let influence = 0; influence < 4; ++influence) {
        const index = vertex * 4 + influence, weight = ordered[set].weights[index] / divisors[set] / totals[vertex] * bary;
        if (!weight) continue;
        const joint = ordered[set].joints[index];
        merged.set(joint, (merged.get(joint) || 0) + weight);
      }
    }
    const ranked = Array.from(merged).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, ordered.length * 4);
    const total = ranked.reduce((sum, pair) => sum + pair[1], 0);
    require(total > 0 && Number.isFinite(total), 'projected skin row must have positive total weight');
    let stored = 0;
    for (let i = 0; i < ranked.length; ++i) {
      const channel = result[Math.floor(i / 4)], index = row * 4 + i % 4;
      channel.joints[index] = ranked[i][0]; channel.weights[index] = ranked[i][1] / total;
      stored += channel.weights[index];
    }
    // Correct the final float32 rounding residual on the largest influence.
    result[0].weights[row * 4] += 1 - stored;
  }
  return result;
}

/** Angle-weighted triangle normals, matching PMP's vertex-normal convention. */
export function computeNormals(positions, indices) {
  const count = geometry(positions, indices, 'normal geometry'), sums = new Float64Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const x = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
    const y = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
    const scale = Math.max(...x.map(Math.abs), ...y.map(Math.abs));
    const u = x.map(value => value / scale), v = y.map(value => value / scale);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const magnitude = Math.hypot(...normal), unit = normal.map(value => value / magnitude);
    const corners = [a, b, c];
    for (let corner = 0; corner < 3; ++corner) {
      const vertex = corners[corner], next = corners[(corner + 1) % 3], previous = corners[(corner + 2) % 3];
      const first = [positions[next] - positions[vertex], positions[next + 1] - positions[vertex + 1], positions[next + 2] - positions[vertex + 2]];
      const second = [positions[previous] - positions[vertex], positions[previous + 1] - positions[vertex + 1], positions[previous + 2] - positions[vertex + 2]];
      const firstLength = Math.hypot(...first), secondLength = Math.hypot(...second);
      const cosine = first.reduce((sum, value, axis) => sum + (value / firstLength) * (second[axis] / secondLength), 0);
      const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
      for (let axis = 0; axis < 3; ++axis) sums[vertex + axis] += unit[axis] * angle;
    }
  }
  const result = new Float32Array(positions.length);
  for (let vertex = 0; vertex < count; ++vertex) {
    const offset = vertex * 3, length = Math.hypot(sums[offset], sums[offset + 1], sums[offset + 2]);
    require(Number.isFinite(length), 'summed normals exceed numeric range');
    if (length) for (let axis = 0; axis < 3; ++axis) result[offset + axis] = sums[offset + axis] / length;
  }
  return result;
}
