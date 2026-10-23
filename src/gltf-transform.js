// SPDX-License-Identifier: MIT
// Optional glTF-Transform adapter. The core entry point does not import this file.
import { prepareGeometry, resolvePMP, runGeometry } from './gltf/geometry.js';
import { decoded, readAttribute, readAttributes, stageAttributes, validateSkinBindings, validateTransfer } from './gltf/attributes.js';

// glTF mode constants do not require importing the SDK's Primitive class.
const TRIANGLES = 4, TRIANGLE_STRIP = 5, TRIANGLE_FAN = 6;
const adapterOptions = new Set(['operation', 'unsupported', 'invalid', 'attributeTransfer', 'maxProjectionDistance',
  'normals', 'tangents', 'targetScope', 'filter', 'parameters', 'onReport', 'meshes', 'primitives', 'ratio',
  'forceNormals', 'seamTexcoord']);
const operations = ['decimate', 'remesh', 'subdivide', 'smooth', 'fillHoles', 'fair', 'normals', 'analyze'];
const defaults = { unsupported: 'skip', invalid: 'error', winding: 'ccw', splitVertices: true,
  attributeTransfer: 'project', maxProjectionDistance: Infinity, normals: 'recompute',
  tangents: 'drop', maxVertices: 5_000_000 };

function choice(value, allowed, name) {
  if (!allowed.includes(value)) throw new TypeError(`${name} must be ${allowed.join(' or ')}`);
}

function optionsFor(input, operation) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Expected an options object');
  const options = { ...defaults, ...input, operation };
  choice(operation, operations, 'operation');
  choice(options.unsupported, ['skip', 'error'], 'unsupported');
  choice(options.invalid, ['skip', 'error'], 'invalid');
  choice(options.attributeTransfer, ['project', 'strict'], 'attributeTransfer');
  choice(options.normals, ['recompute', 'preserve', 'drop'], 'normals');
  choice(options.tangents, ['preserve', 'drop'], 'tangents');
  if (operation === 'decimate') {
    options.targetScope ??= 'primitive';
    choice(options.targetScope, ['primitive', 'mesh', 'document'], 'targetScope');
  } else for (const key of ['ratio', 'targetScope', 'seamTexcoord']) {
    if (options[key] !== undefined) throw new TypeError(`${key} is only supported for decimation`);
  }
  choice(options.winding, ['ccw', 'cw'], 'winding');
  if (typeof options.splitVertices !== 'boolean') throw new TypeError('splitVertices must be a boolean');
  if (!(options.maxProjectionDistance >= 0) || typeof options.maxProjectionDistance !== 'number')
    throw new RangeError('maxProjectionDistance must be nonnegative');
  if (!Number.isSafeInteger(options.maxVertices) || options.maxVertices < 3 || options.maxVertices > 0x7fffffff)
    throw new RangeError('maxVertices must be an integer between 3 and 2147483647');
  for (const name of ['filter', 'parameters', 'onReport'])
    if (options[name] !== undefined && typeof options[name] !== 'function') throw new TypeError(`${name} must be a function`);
  for (const name of ['meshes', 'primitives'])
    if (options[name] !== undefined && !Array.isArray(options[name])) throw new TypeError(`${name} must be an array`);
  return options;
}

function triangleIndices(primitive, count) {
  const index = primitive.getIndices();
  let source;
  if (index) {
    const attribute = readAttribute(index, 'indices');
    if (attribute.size !== 1 || attribute.normalized ||
        !(attribute.array instanceof Uint8Array || attribute.array instanceof Uint16Array || attribute.array instanceof Uint32Array))
      throw new TypeError('Indices must be unsigned, unnormalized scalars');
    source = attribute.array;
  } else source = Uint32Array.from({ length: count }, (_, i) => i);
  for (const i of source) if (i >= count) throw new RangeError('Index exceeds vertex count');
  const mode = primitive.getMode();
  if (mode === TRIANGLES) {
    if (source.length % 3) throw new RangeError('Triangle index count must be divisible by three');
    return Uint32Array.from(source);
  }
  const indices = [];
  for (let i = 2; i < source.length; ++i) {
    const a = mode === TRIANGLE_FAN ? source[0] : source[i - 2];
    const b = mode === TRIANGLE_STRIP && i % 2 ? source[i] : source[i - 1];
    const c = mode === TRIANGLE_STRIP && i % 2 ? source[i - 1] : source[i];
    // Repeated strip connector indices produce no surface triangle.
    if (a !== b && b !== c && c !== a) indices.push(a, b, c);
  }
  return Uint32Array.from(indices);
}

function contextOf(document, mesh, primitive, meshIndex, primitiveIndex) {
  const vertices = primitive.getAttribute('POSITION')?.getCount() || 0;
  const elements = primitive.getIndices()?.getCount() ?? vertices;
  const mode = primitive.getMode();
  return { document, mesh, primitive, meshIndex, primitiveIndex, vertices,
    triangles: mode === 4 ? elements / 3 : mode === 5 || mode === 6 ? Math.max(0, elements - 2) : 0 };
}

function selectedContexts(document, options) {
  if (!document || typeof document.getRoot !== 'function') throw new TypeError('Expected a glTF-Transform Document');
  const rootMeshes = document.getRoot().listMeshes();
  const allPrimitives = new Set(rootMeshes.flatMap(mesh => mesh.listPrimitives()));
  if (options.meshes?.some(mesh => !rootMeshes.includes(mesh))) throw new TypeError('Selected mesh is not in this document');
  if (options.primitives?.some(primitive => !allPrimitives.has(primitive)))
    throw new TypeError('Selected primitive is not in a mesh of this document');
  const contexts = [], seen = new Set();
  rootMeshes.forEach((mesh, meshIndex) => {
    if (options.meshes && !options.meshes.includes(mesh)) return;
    mesh.listPrimitives().forEach((primitive, primitiveIndex) => {
      if (options.primitives && !options.primitives.includes(primitive)) return;
      const context = contextOf(document, mesh, primitive, meshIndex, primitiveIndex);
      if (options.filter && !options.filter(context)) return;
      if (seen.has(primitive)) {
        if (options.targetScope === 'mesh') throw new TypeError('A primitive shared by different meshes has an ambiguous mesh budget');
        return;
      }
      seen.add(primitive); contexts.push(context);
    });
  });
  return contexts;
}

function reportFor(context, operation, status, extra = {}) {
  return { operation, status, meshIndex: context.meshIndex, primitiveIndex: context.primitiveIndex,
    before: { vertices: context.vertices, triangles: context.triangles },
    after: { vertices: context.vertices, triangles: context.triangles }, ...extra };
}

function prepareJob(context, operation, base) {
  const overrides = base.parameters?.(context) ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('parameters must return an options object');
  for (const name of ['meshes', 'primitives', 'filter', 'parameters', 'onReport', 'targetScope', 'operation'])
    if (name in overrides) throw new TypeError(`parameters cannot override ${name}`);
  const merged = { ...base, ...overrides };
  if ('targetVertices' in overrides && !('ratio' in overrides)) delete merged.ratio;
  if ('ratio' in overrides && !('targetVertices' in overrides)) delete merged.targetVertices;
  const options = optionsFor(merged, operation);
  const { primitive } = context;
  if (![4, 5, 6].includes(primitive.getMode())) {
    if (options.unsupported === 'error') throw new TypeError('Only triangle, triangle-strip and triangle-fan primitives are supported');
    return { report: reportFor(context, operation, 'skipped', { reason: 'unsupported primitive mode' }) };
  }
  try {
    if (primitive.listExtensions().length) throw new TypeError('Primitive extensions require an explicit geometry policy');
    const accessor = primitive.getAttribute('POSITION');
    if (!accessor || !context.vertices) throw new TypeError('Triangle primitives require nonempty POSITION data');
    if (context.vertices > options.maxVertices) throw new RangeError('Input exceeds maxVertices');
    const position = readAttribute(accessor, 'POSITION');
    const original = { positions: decoded(position), indices: triangleIndices(primitive, context.vertices) };
    context.triangles = original.indices.length / 3;
    if (!original.indices.length) throw new RangeError('Primitive has no surface triangles');
    const geometry = prepareGeometry(original.positions, original.indices, options);
    const input = operation === 'analyze' ? null : readAttributes(primitive, context.vertices);
    options.forceNormals = operation === 'normals';
    if (input) { validateSkinBindings(input, context); validateTransfer(input, operation, options); }
    options.computeNormals = operation === 'normals' || (options.normals === 'recompute' && !!input?.attributes.has('NORMAL'));
    if (operation === 'normals' && options.normals !== 'recompute')
      throw new TypeError('recomputeNormals requires normals: recompute');
    if (operation === 'decimate') {
      // A glTF primitive must remain usable for normals and later mesh passes.
      options.aspectRatio ??= 5;
      const set = options.seamTexcoord === undefined ? 0 : options.seamTexcoord;
      if (set !== null && (!Number.isSafeInteger(set) || set < 0)) throw new RangeError('seamTexcoord must be null or a nonnegative integer');
      const uv = input.attributes.get(`TEXCOORD_${set}`);
      if (uv && set !== null) options.texcoords = decoded(uv);
    }
    return { context, operation, options, original, geometry, input };
  } catch (error) {
    if (options.invalid === 'skip' && (error instanceof TypeError || error instanceof RangeError))
      return { report: reportFor(context, operation, 'skipped', { reason: error.message }) };
    throw error;
  }
}

function targetFor(options, count, minimum) {
  if (options.targetVertices !== undefined && options.ratio !== undefined)
    throw new TypeError('Choose targetVertices or ratio, not both');
  if (options.targetVertices !== undefined) {
    if (!Number.isSafeInteger(options.targetVertices) || options.targetVertices < minimum)
      throw new RangeError(`targetVertices must be an integer of at least ${minimum}`);
    return Math.min(count, options.targetVertices);
  }
  const ratio = options.ratio ?? 0.5;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1)
    throw new RangeError('ratio must be greater than zero and at most one');
  return Math.max(minimum, Math.floor(count * ratio));
}

function allocateTargets(jobs, options) {
  const selected = jobs.filter(job => job.context);
  if (options.targetScope === 'primitive') {
    for (const job of selected) job.options.targetVertices = targetFor(job.options, job.context.vertices, 3);
    return;
  }
  if (selected.some(job => job.options.targetVertices !== options.targetVertices || job.options.ratio !== options.ratio))
    throw new TypeError('Per-primitive target overrides require targetScope: primitive');
  const groups = new Map();
  for (const job of selected) {
    const key = options.targetScope === 'mesh' ? job.context.mesh : null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(job);
  }
  for (const group of groups.values()) {
    const total = group.reduce((sum, job) => sum + job.context.vertices, 0);
    const minimum = group.length * 3, target = targetFor(options, total, minimum), remaining = target - minimum;
    const capacity = total - minimum;
    const quotas = group.map((job, index) => {
      const quota = capacity ? remaining * (job.context.vertices - 3) / capacity : 0;
      job.options.targetVertices = 3 + Math.floor(quota);
      return { job, index, fraction: quota - Math.floor(quota) };
    });
    let extra = target - group.reduce((sum, job) => sum + job.options.targetVertices, 0);
    quotas.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
    for (const { job } of quotas) if (extra-- > 0) ++job.options.targetVertices;
  }
}

function makeAccessor(document, data, buffer, created) {
  const accessor = data.original ? data.original.clone() : document.createAccessor().setType(data.type);
  created.push(accessor);
  accessor.setArray(data.array).setNormalized(data.normalized).setBuffer(buffer).setSparse(false);
  return accessor;
}

function createEdits(document, stages) {
  const created = [], edits = [];
  let newBuffer;
  try {
    for (const stage of stages) {
      const { primitive } = stage.job.context;
      const buffer = primitive.getAttribute('POSITION').getBuffer() || document.getRoot().listBuffers()[0] ||
        (newBuffer ||= document.createBuffer());
      const attributes = new Map();
      for (const [name, data] of stage.attributes) attributes.set(name, makeAccessor(document, data, buffer, created));
      const count = stage.output.positions.length / 3;
      const indexArray = count <= 65535 ? Uint16Array.from(stage.output.indices) : stage.output.indices;
      const indices = makeAccessor(document, { original: primitive.getIndices(), array: indexArray,
        normalized: false, type: 'SCALAR' }, buffer, created);
      const targets = stage.targets.map(({ original, channels }) => {
        const target = original.clone(); created.push(target);
        for (const semantic of target.listSemantics()) target.setAttribute(semantic, null);
        for (const [name, data] of channels) target.setAttribute(name, makeAccessor(document, data, buffer, created));
        return target;
      });
      edits.push({ primitive, attributes, indices, targets });
    }
    return edits;
  } catch (error) {
    for (const property of created.reverse()) property.dispose();
    if (newBuffer) newBuffer.dispose();
    throw error;
  }
}

function commitEdits(edits) {
  const oldAccessors = new Set(), oldTargets = new Set();
  for (const { primitive, attributes, indices, targets } of edits) {
    for (const accessor of primitive.listAttributes()) oldAccessors.add(accessor);
    if (primitive.getIndices()) oldAccessors.add(primitive.getIndices());
    for (const target of primitive.listTargets()) {
      for (const accessor of target.listAttributes()) oldAccessors.add(accessor);
      oldTargets.add(target); primitive.removeTarget(target);
    }
    for (const semantic of primitive.listSemantics()) primitive.setAttribute(semantic, null);
    for (const [name, accessor] of attributes) primitive.setAttribute(name, accessor);
    for (const target of targets) primitive.addTarget(target);
    primitive.setIndices(indices).setMode(TRIANGLES);
  }
  // glTF-Transform root ownership alone does not make an accessor live.
  for (const target of oldTargets) if (!target.listParents().length) target.dispose();
  for (const accessor of oldAccessors)
    if (accessor.listParents().every(parent => parent.propertyType === 'Root')) accessor.dispose();
}

/** Stage all selected primitives, then commit their accessor replacements together. */
export function process(document, source, input) {
  const options = optionsFor(input, input?.operation);
  const pmp = resolvePMP(source);
  const contexts = selectedContexts(document, options);
  const jobs = contexts.map(context => prepareJob(context, options.operation, options));
  if (options.operation === 'decimate') allocateTargets(jobs, options);
  const reports = [], stages = [];
  for (const job of jobs) {
    if (job.report) { reports.push(job.report); continue; }
    const output = runGeometry(pmp, job.geometry, job.operation,
      Object.fromEntries(Object.entries(job.options).filter(([key]) => !adapterOptions.has(key))));
    if (output.measurements) {
      const m = output.measurements;
      if (m.bounds) m.bounds = { min: Array.from(m.bounds.min), max: Array.from(m.bounds.max) };
      if (m.centroid) m.centroid = Array.from(m.centroid);
    }
    const analysis = job.operation === 'analyze';
    const stage = analysis ? null : stageAttributes(job.input, job.original, output, job.options);
    const report = reportFor(job.context, job.operation, analysis ? 'analyzed' : 'processed', {
      after: { vertices: output.positions.length / 3, triangles: output.indices.length / 3 },
      details: output.details, ...(output.measurements ? { measurements: output.measurements } : {}),
      ...(stage ? { transfer: stage.transfer, maxProjectionDistance: stage.maxProjectionDistance } : {}),
      ...(job.operation === 'decimate' ? { targetVertices: job.options.targetVertices } : {}),
    });
    reports.push(report);
    if (stage) stages.push({ ...stage, output, job });
  }
  // Callback errors cannot leave a partially committed document.
  if (options.onReport) for (const report of reports) options.onReport(report);
  if (stages.length) commitEdits(createEdits(document, stages));
  return reports;
}

function transform(operation, source, options = {}) {
  const run = async document => { process(document, source, { ...options, operation }); };
  Object.defineProperty(run, 'name', { value: `pmp:${operation}` });
  return run;
}

export const decimate = (source, options) => transform('decimate', source, options);
export const remesh = (source, options) => transform('remesh', source, options);
export const subdivide = (source, options) => transform('subdivide', source, options);
export const smooth = (source, options) => transform('smooth', source, options);
export const fillHoles = (source, options) => transform('fillHoles', source, options);
export const fair = (source, options) => transform('fair', source, options);
export const recomputeNormals = (source, options) => transform('normals', source, options);
export const analyze = (document, source, options = {}) => process(document, source, { ...options, operation: 'analyze' });
