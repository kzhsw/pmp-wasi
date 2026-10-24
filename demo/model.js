// SPDX-License-Identifier: MIT
import { Document, GLB_BUFFER, MathUtils, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 1_000_000, MAX_TRIANGLES = 1_000_000, MAX_DRAWS = 10_000;
const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
const knownExtensions = new Set(ALL_EXTENSIONS.map(extension => extension.EXTENSION_NAME));
const decoder = new TextDecoder('utf-8', { fatal: true });
const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const fail = message => { throw new Error(message); };
const integer = (value, max = MAX_BYTES) => Number.isSafeInteger(value) && value >= 0 && value <= max;

// Inspect declarations before the SDK allocates sparse/interleaved accessor arrays.
function validateJSON(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.asset?.version !== '2.0')
    fail('Expected a glTF 2.0 asset.');
  const used = json.extensionsUsed || [], required = json.extensionsRequired || [];
  if (!Array.isArray(used) || !Array.isArray(required)) fail('Invalid glTF extension declarations.');
  for (const name of [...used, ...required]) {
    if (!knownExtensions.has(name)) fail(`Unsupported glTF extension: ${String(name)}. It cannot be preserved by this demo.`);
    if (name === 'KHR_draco_mesh_compression' || name === 'EXT_meshopt_compression')
      fail(`${name} needs a codec unavailable in this demo. Export an uncompressed GLB first.`);
    if (!used.includes(name)) fail(`Required extension ${name} is absent from extensionsUsed.`);
  }
  const stack = [[json, 0]];
  let entries = 0;
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (++entries > 250_000 || depth > 64) fail('The glTF structure is too large or deeply nested for this demo.');
    if (Array.isArray(value) && value.length > 50_000) fail('The glTF structure contains an excessive array.');
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extras') continue; // Application metadata has no extension semantics.
      if (key === 'extensions' && child && typeof child === 'object') {
        for (const name of Object.keys(child))
          if (!knownExtensions.has(name) || !used.includes(name))
            fail(`Unknown or undeclared glTF extension: ${name}. It cannot be preserved by this demo.`);
      }
      if (child && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  for (const key of ['accessors', 'bufferViews', 'buffers', 'images', 'meshes', 'nodes', 'scenes', 'skins', 'animations'])
    if (json[key] !== undefined && (!Array.isArray(json[key]) || json[key].length > 50_000))
      fail(`Invalid or excessive glTF ${key}.`);
  const views = json.bufferViews || [], buffers = json.buffers || [];
  for (const buffer of buffers)
    if (!buffer || !integer(buffer.byteLength)) fail('Invalid or excessive declared buffer size.');
  for (const view of views) {
    const buffer = buffers[view?.buffer];
    if (!buffer || !integer(view.byteOffset ?? 0) || !integer(view.byteLength) ||
        (view.byteOffset ?? 0) + view.byteLength > buffer.byteLength ||
        (view.byteStride !== undefined && (!integer(view.byteStride, 252) || view.byteStride < 4)))
      fail('Invalid glTF buffer view bounds.');
  }
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
  const components = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4, 5130: 8, 5131: 2 };
  let allocated = 0, rows = 0, triangles = 0, primitiveCount = 0;
  const range = (viewIndex, offset, count, stride, width) => {
    const view = views[viewIndex];
    if (!view || !integer(offset) || !integer(count, MAX_TRIANGLES * 3) ||
        (count ? offset + (count - 1) * stride + width : offset) > view.byteLength)
      fail('Accessor data exceeds its buffer view.');
  };
  for (const accessor of json.accessors || []) {
    const width = sizes[accessor?.type] * components[accessor?.componentType];
    if (!width || !integer(accessor.count, MAX_TRIANGLES * 3) ||
        (allocated += accessor.count * width * (accessor.sparse ? 2 : 1)) > 256 * 1024 * 1024)
      fail('Invalid or excessive decoded accessor size.');
    if (accessor.bufferView !== undefined) {
      const stride = views[accessor.bufferView]?.byteStride ?? width;
      if (stride < width) fail('Accessor byte stride is too small.');
      range(accessor.bufferView, accessor.byteOffset ?? 0, accessor.count, stride, width);
    }
    if (accessor.sparse) {
      const sparse = accessor.sparse, size = components[sparse.indices?.componentType];
      if (!integer(sparse.count, accessor.count) || ![5121, 5123, 5125].includes(sparse.indices?.componentType))
        fail('Invalid sparse accessor declaration.');
      range(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.count, size, size);
      range(sparse.values?.bufferView, sparse.values?.byteOffset ?? 0, sparse.count, width, width);
    }
  }
  for (const mesh of json.meshes || []) {
    if (!Array.isArray(mesh?.primitives)) fail('Mesh primitives must be an array.');
    for (const primitive of mesh.primitives) {
      if (++primitiveCount > MAX_DRAWS) fail('Too many mesh primitives for this demo.');
      const position = json.accessors?.[primitive.attributes?.POSITION];
      if (position && (rows += position.count) > MAX_ROWS) fail('The demo accepts at most 1,000,000 input vertex rows.');
      const count = primitive.indices === undefined ? position?.count || 0 : json.accessors?.[primitive.indices]?.count;
      if (!integer(count, MAX_TRIANGLES * 3)) fail('Invalid primitive index accessor.');
      const mode = primitive.mode ?? 4;
      if (!integer(mode, 6)) fail('Invalid primitive mode.');
      triangles += mode === 4 ? count / 3 : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
      if (triangles > MAX_TRIANGLES) fail('The demo accepts at most 1,000,000 triangles.');
    }
  }
  // Reject cycles and deep hierarchies before the graph library handles node parenting.
  const nodes = json.nodes || [], parents = new Int32Array(nodes.length), state = new Uint8Array(nodes.length);
  for (const node of nodes) {
    if (node.children !== undefined && !Array.isArray(node.children)) fail('Invalid node children.');
    for (const child of node.children || [])
      if (!integer(child, nodes.length - 1) || ++parents[child] > 1) fail('Invalid or multiply parented scene node.');
  }
  for (let root = 0; root < nodes.length; root++) {
    if (state[root] === 2) continue;
    const pending = [[root, false, 0]];
    while (pending.length) {
      const [index, leaving, depth] = pending.pop();
      if (leaving) { state[index] = 2; continue; }
      if (state[index] === 1 || depth > 128) fail('Cyclic or excessive scene hierarchy.');
      if (state[index] === 2) continue;
      state[index] = 1; pending.push([index, true, depth]);
      for (const child of nodes[index].children || []) pending.push([child, false, depth + 1]);
    }
  }
}

function parse(bytes, binary) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES)
    fail('Select a nonempty model with at most 100 MiB of files.');
  if (!binary) return { json: JSON.parse(decoder.decode(bytes)), resources: Object.create(null) };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 20 || view.getUint32(0, true) !== 0x46546c67 ||
      view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== bytes.length)
    fail('Invalid glTF 2.0 binary header or length.');
  let json, bin, offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail('Truncated GLB chunk header.');
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > bytes.length) fail('Invalid GLB chunk bounds.');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a && offset === 12) json = JSON.parse(decoder.decode(chunk));
    else if (type === 0x004e4942 && json && !bin) bin = chunk;
    else fail('Unsupported or misplaced GLB chunk.');
    offset += 8 + length;
  }
  if (!json) fail('Missing GLB JSON chunk.');
  const resources = Object.create(null);
  if (bin) resources[GLB_BUFFER] = bin;
  return { json, resources };
}

function localURI(uri) {
  if (typeof uri !== 'string' || !uri || /^[a-z][a-z\d+.-]*:/i.test(uri) || /^[\\/]/.test(uri) || /[?#\\]/.test(uri))
    fail(`Only supplied local resources and data URIs are allowed: ${String(uri).slice(0, 160)}`);
  try { return decodeURIComponent(uri); } catch { fail('A resource URI has invalid percent encoding.'); }
}

function pathKey(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop(); else parts.push(part);
  }
  return parts.join('/');
}

async function readPrepared(prepared, supplied = [], mainPath = '') {
  validateJSON(prepared.json);
  const consumed = new Set(), resources = prepared.resources;
  let resourceBytes = 0;
  for (const resource of [...(prepared.json.buffers || []), ...(prepared.json.images || [])]) {
    if (resource.uri === undefined) {
      if (resource.byteLength !== undefined && resource.byteLength > (resources[GLB_BUFFER]?.byteLength ?? 0))
        fail('The declared GLB buffer exceeds the supplied binary chunk.');
      continue;
    }
    const uri = resource.uri;
    if (typeof uri !== 'string') fail('Resource URI must be a string.');
    if (/^data:/i.test(uri)) {
      if (!/^data:[^,]*,/i.test(uri)) fail('Invalid data URI.');
      resourceBytes += uri.length; // Conservative bound on decoded payloads.
      if (resourceBytes > MAX_BYTES * 1.4) fail('Embedded resources exceed the demo memory limit.');
      continue;
    }
    const decoded = localURI(uri), base = mainPath.slice(0, mainPath.lastIndexOf('/') + 1);
    const target = pathKey(base + decoded);
    let matches = supplied.filter(file => file.path === target);
    if (!matches.length) matches = supplied.filter(file => file.path.split('/').pop() === decoded.split('/').pop());
    if (matches.length !== 1) fail(matches.length ? `Ambiguous resource filename: ${uri}` : `Missing companion file: ${uri}`);
    const file = matches[0]; consumed.add(file);
    resources[uri] = file.bytes;
    if (resource.byteLength !== undefined && resource.byteLength > file.bytes.byteLength)
      fail(`Buffer ${uri} is shorter than its declared size.`);
  }
  for (const file of supplied) if (!consumed.has(file)) fail(`Unused companion file: ${file.path}. Select only one model and its resources.`);
  return io.readJSON(prepared);
}

export async function loadFiles(files) {
  files = Array.from(files);
  if (!files.length || files.length > 1024) fail('Select one GLB or glTF file and its companion files (at most 1,024 files).');
  let total = 0;
  const paths = new Set();
  const selected = files.map(file => {
    if (!integer(file.size) || (total += file.size) > MAX_BYTES) fail('The selected files exceed the 100 MiB demo limit.');
    const path = pathKey(file.webkitRelativePath || file.name);
    if (!path || paths.has(path)) fail(`Ambiguous filename: ${file.name}`);
    paths.add(path); return { file, path };
  });
  const models = selected.filter(file => /\.(glb|gltf)$/i.test(file.path));
  if (models.length !== 1) fail('Select exactly one .glb or .gltf model, plus any buffers and textures it references.');
  const main = models[0];
  for (const entry of selected) entry.bytes = new Uint8Array(await entry.file.arrayBuffer());
  const prepared = parse(main.bytes, /\.glb$/i.test(main.path));
  const document = await readPrepared(prepared, selected.filter(file => file !== main), main.path);
  return { document, name: main.file.name };
}

// Worker operations reparse exported bytes, so a failed operation has no retained graph to corrupt.
export async function readBytes(bytes) {
  return readPrepared(parse(bytes, true));
}

function attribute(accessor, size, count, name) {
  if (!accessor) return null;
  const array = accessor.getArray(), width = accessor.getElementSize();
  if (!array || accessor.getCount() !== count || !size.includes(width)) fail(`Invalid ${name} preview accessor.`);
  const result = new Float32Array(count * width), row = [];
  for (let i = 0; i < count; i++) {
    accessor.getElement(i, row); // SDK decoding includes normalized integer/quantized attributes.
    for (let j = 0; j < width; j++) {
      if (!Number.isFinite(row[j]) || Math.abs(row[j]) > 3.4e38) fail(`Nonfinite ${name} preview component.`);
      result[i * width + j] = row[j];
    }
  }
  return result;
}

function geometry(primitive) {
  const position = primitive.getAttribute('POSITION'), count = position?.getCount() || 0;
  if (!count || count > MAX_ROWS) fail('Triangle primitives need valid POSITION data within the demo limit.');
  const index = primitive.getIndices(), source = index?.getArray(), mode = primitive.getMode();
  if (index && (!source || index.getType() !== 'SCALAR' || index.getNormalized() ||
      !(source instanceof Uint8Array || source instanceof Uint16Array || source instanceof Uint32Array)))
    fail('Preview indices must be unnormalized unsigned scalar integers.');
  const length = source ? source.length : count;
  if (mode === 4 && length % 3) fail('Triangle index count must be divisible by three.');
  const max = mode === 4 ? length / 3 : Math.max(0, length - 2);
  if (max > MAX_TRIANGLES) fail('Preview exceeds 1,000,000 triangles.');
  for (let i = 0; i < length; i++) if ((source ? source[i] : i) >= count) fail('A preview index exceeds its vertex count.');
  const indices = new Uint32Array(max * 3);
  let cursor = 0;
  if (mode === 4) {
    for (let i = 0; i < length; i++) indices[cursor++] = source ? source[i] : i;
  } else for (let i = 2; i < length; i++) {
    const a = source ? source[mode === 6 ? 0 : i - 2] : mode === 6 ? 0 : i - 2;
    const bIndex = mode === 5 && i % 2 ? i : i - 1, cIndex = mode === 5 && i % 2 ? i - 1 : i;
    const b = source ? source[bIndex] : bIndex, c = source ? source[cIndex] : cIndex;
    if (a !== b && b !== c && c !== a) { indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c; }
  }
  const colors = attribute(primitive.getAttribute('COLOR_0'), [3, 4], count, 'COLOR_0');
  let rgba = colors;
  if (colors?.length === count * 3) {
    rgba = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { rgba[i * 4] = colors[i * 3]; rgba[i * 4 + 1] = colors[i * 3 + 1]; rgba[i * 4 + 2] = colors[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
  }
  return { positions: attribute(position, [3], count, 'POSITION'),
    normals: attribute(primitive.getAttribute('NORMAL'), [3], count, 'NORMAL'), colors: rgba,
    indices: cursor === indices.length ? indices : indices.slice(0, cursor),
    color: primitive.getMaterial()?.getBaseColorFactor().slice() || [0.28, 0.65, 0.82, 1] };
}

function multiply(a, b) {
  const result = new Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    result[column * 4 + row] = sum;
  }
  return result;
}

export async function makeResult(document, name, reports = []) {
  const root = document.getRoot(), meshes = root.listMeshes(), primitives = [], cache = new Map(), warnings = new Set();
  let vertices = 0, triangles = 0, primitiveCount = 0, displayedRows = 0, displayedTriangles = 0;
  for (const mesh of meshes) for (const primitive of mesh.listPrimitives()) {
    if (++primitiveCount > MAX_DRAWS) fail('Too many mesh primitives for this demo.');
    vertices += primitive.getAttribute('POSITION')?.getCount() || 0;
    if (vertices > MAX_ROWS) fail('The demo accepts at most 1,000,000 input vertex rows.');
    if (![4, 5, 6].includes(primitive.getMode())) { warnings.add('Points and lines are retained in the GLB but omitted from the surface preview.'); continue; }
    const data = cache.get(primitive) || geometry(primitive); cache.set(primitive, data);
    triangles += data.indices.length / 3;
    if (triangles > MAX_TRIANGLES) fail('The demo accepts at most 1,000,000 triangles.');
  }
  const addMesh = (mesh, matrix) => {
    if (matrix.length !== 16 || !matrix.every(Number.isFinite)) fail('Invalid node transform.');
    const meshIndex = meshes.indexOf(mesh);
    for (const primitive of mesh.listPrimitives()) {
      const data = cache.get(primitive); if (!data) continue;
      displayedRows += data.positions.length / 3; displayedTriangles += data.indices.length / 3;
      if (displayedRows > MAX_ROWS || displayedTriangles > MAX_TRIANGLES || primitives.length >= MAX_DRAWS)
        fail('Scene instances exceed the preview limit: 1,000,000 rows/triangles and 10,000 draws.');
      primitives.push({ ...data, matrix, meshIndex });
    }
  };
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const pending = scene ? scene.listChildren().slice() : root.listNodes().filter(node => !node.getParentNode());
  const seen = new Set();
  while (pending.length) {
    const node = pending.pop();
    if (seen.has(node)) fail('Invalid repeated or cyclic scene node.');
    seen.add(node); for (const child of node.listChildren()) pending.push(child);
    const mesh = node.getMesh(); if (!mesh) continue;
    const world = node.getWorldMatrix(), instancing = node.getExtension('EXT_mesh_gpu_instancing');
    if (!instancing) { addMesh(mesh, world); continue; }
    const attributes = instancing.listAttributes(), count = attributes[0]?.getCount() || 0;
    if (!count || count > MAX_ROWS || attributes.some(accessor => accessor.getCount() !== count)) fail('Invalid GPU instance attributes.');
    const translation = instancing.getAttribute('TRANSLATION'), rotation = instancing.getAttribute('ROTATION'), scale = instancing.getAttribute('SCALE');
    for (let i = 0; i < count; i++) {
      const t = translation ? translation.getElement(i, []) : [0, 0, 0];
      const r = rotation ? rotation.getElement(i, []) : [0, 0, 0, 1];
      const s = scale ? scale.getElement(i, []) : [1, 1, 1];
      addMesh(mesh, multiply(world, MathUtils.compose(t, r, s, identity())));
    }
  }
  if (!scene && !root.listNodes().length) {
    warnings.add('This asset has no scene nodes; the preview places each mesh at the origin.');
    for (const mesh of meshes) addMesh(mesh, identity());
  }
  if (!primitives.length) fail('This asset has no surface triangles to preview.');
  if (root.listSkins().length || root.listAnimations().length || meshes.some(mesh => mesh.listPrimitives().some(primitive => primitive.listTargets().length)))
    warnings.add('Preview shows base geometry only. Skin, morph and animation data are retained in the exported GLB.');
  if (root.listTextures().length) warnings.add('Preview uses material and vertex colors. Textures are retained in the exported GLB.');
  // A GLB has one buffer. Reassign storage metadata without modifying accessor arrays.
  const buffers = root.listBuffers();
  if (buffers.length > 1) {
    for (const accessor of root.listAccessors()) accessor.setBuffer(buffers[0]);
    for (const buffer of buffers.slice(1)) buffer.dispose();
  }
  const bytes = await io.writeBinary(document);
  if (bytes.byteLength > MAX_BYTES) fail('The resulting GLB exceeds the 100 MiB demo limit.');
  return { name: typeof name === 'string' ? name : 'model.glb', bytes, preview: { primitives },
    summary: { vertices, triangles, meshes: meshes.length, primitives: primitiveCount },
    meshes: meshes.map((mesh, index) => ({ index, name: mesh.getName() || `Mesh ${index + 1}` })),
    reports: [...reports, ...Array.from(warnings, reason => ({ status: 'warning', reason }))] };
}

export function createSample() {
  const document = new Document(), buffer = document.createBuffer('Sample geometry');
  const segments = 64, rings = 31, count = segments * rings + 2;
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), colors = new Float32Array(count * 4);
  const indices = new Uint16Array(segments * rings * 6);
  positions[1] = normals[1] = 1; positions[(count - 1) * 3 + 1] = normals[(count - 1) * 3 + 1] = -1;
  for (let ring = 0; ring < rings; ring++) for (let segment = 0; segment < segments; segment++) {
    const theta = (ring + 1) * Math.PI / (rings + 1), phi = segment * Math.PI * 2 / segments;
    const index = 1 + ring * segments + segment, x = Math.sin(theta) * Math.cos(phi), y = Math.cos(theta), z = Math.sin(theta) * Math.sin(phi);
    const radius = 1 + 0.12 * Math.sin(theta * 6 + Math.cos(phi * 3)) * Math.sin(theta) ** 2 + 0.05 * Math.sin(phi * 7) * Math.sin(theta) ** 3;
    positions[index * 3] = x * radius; positions[index * 3 + 1] = y * radius; positions[index * 3 + 2] = z * radius;
    normals[index * 3] = x; normals[index * 3 + 1] = y; normals[index * 3 + 2] = z;
  }
  for (let i = 0; i < count; i++) { colors[i * 4] = 0.55 + positions[i * 3 + 1] * 0.2; colors[i * 4 + 1] = 0.8; colors[i * 4 + 2] = 0.95; colors[i * 4 + 3] = 1; }
  let cursor = 0;
  const triangle = (a, b, c) => { indices[cursor++] = a; indices[cursor++] = b; indices[cursor++] = c; };
  for (let segment = 0; segment < segments; segment++) {
    const next = (segment + 1) % segments;
    triangle(0, 1 + next, 1 + segment);
    for (let ring = 0; ring < rings - 1; ring++) {
      const a = 1 + ring * segments + segment, b = 1 + ring * segments + next, c = a + segments, d = b + segments;
      triangle(a, b, c); triangle(b, d, c);
    }
    triangle(count - 1, 1 + (rings - 1) * segments + segment, 1 + (rings - 1) * segments + next);
  }
  const accessor = (name, type, array) => document.createAccessor(name, buffer).setType(type).setArray(array);
  const position = accessor('POSITION', 'VEC3', positions), normal = accessor('NORMAL', 'VEC3', normals);
  const color = accessor('COLOR_0', 'VEC4', colors), index = accessor('indices', 'SCALAR', indices);
  const scene = document.createScene('Wavy spheres'); document.getRoot().setDefaultScene(scene);
  for (let i = 0; i < 2; i++) {
    const material = document.createMaterial().setBaseColorFactor(i ? [0.95, 0.55, 0.3, 1] : [0.45, 0.8, 1, 1]).setRoughnessFactor(0.65);
    const primitive = document.createPrimitive().setAttribute('POSITION', position).setAttribute('NORMAL', normal).setAttribute('COLOR_0', color).setIndices(index).setMaterial(material);
    const mesh = document.createMesh(i ? 'Small sphere' : 'Wavy sphere').addPrimitive(primitive);
    const node = document.createNode(mesh.getName()).setMesh(mesh);
    if (i) node.setTranslation([1.5, -0.5, 0]).setScale([0.42, 0.42, 0.42]);
    scene.addChild(node);
  }
  return document;
}
