import './app.css';
import { Preview } from './preview.js';

const $ = id => document.getElementById(id);
const number = (key, label, value, min = 0, max, step = 'any') => ({ key, label, value, min, max, step, type: 'number' });
const select = (key, label, choices, value = choices[0][0]) => ({ key, label, choices, value, type: 'select' });
const check = (key, label, value) => ({ key, label, value, type: 'checkbox' });
const iterations = value => number('iterations', 'Iterations', value, 1, 20, 1);
const operations = {
  decimate: { help: 'Reduce vertex count while preserving the surface. Constraints may prevent reaching the requested target.', fields: () => [
    number('ratio', 'Keep ratio', .5, .01, 1, .01), number('targetVertices', 'Or target vertices', '', 3, 500000, 1),
    select('targetScope', 'Budget scope', [['document', 'Whole selection'], ['mesh', 'Per mesh'], ['primitive', 'Per primitive']]),
    number('aspectRatio', 'Maximum aspect ratio', 5), number('normalDeviation', 'Normal deviation (°)', 0, 0, 180),
    check('preserveBoundary', 'Preserve boundary', false),
  ] },
  remesh: { help: 'Improve triangle shape and spacing. Edge lengths and projection error use mesh-local units.', fields: method => [
    select('method', 'Method', [['uniform', 'Uniform'], ['adaptive', 'Adaptive']], method || 'uniform'),
    ...(method === 'adaptive' ? [number('minEdgeLength', 'Minimum edge', .05, .000001), number('maxEdgeLength', 'Maximum edge', .2, .000001), number('approxError', 'Approximation error', .01, .000001)] : [number('edgeLength', 'Target edge length', .15, .000001)]),
    iterations(3), check('projection', 'Project to surface', true), check('preserveBoundary', 'Preserve boundary', false),
  ] },
  subdivide: { help: 'Refine each surface. Vertex count can grow quickly; the vertex limit is checked before subdivision.', fields: () => [
    select('method', 'Method', [['loop', 'Loop'], ['catmullClark', 'Catmull–Clark'], ['quadTri', 'Quad–tri'], ['linear', 'Linear']]),
    number('iterations', 'Iterations', 1, 1, 5, 1), select('boundary', 'Boundary', [['interpolate', 'Interpolate'], ['preserve', 'Preserve']]),
  ] },
  smooth: { help: 'Reduce noise without changing topology. Large iteration counts can shrink or flatten geometry.', fields: method => [
    select('method', 'Method', [['explicit', 'Explicit'], ['implicit', 'Implicit']], method || 'explicit'),
    ...(method === 'implicit' ? [number('timestep', 'Time step', .001, .000001), check('rescale', 'Rescale volume', true)] : [iterations(3)]),
    check('uniformLaplace', 'Uniform Laplacian', false),
  ] },
  fillHoles: { help: 'Close eligible boundary loops. Outer boundaries also count as holes; inspect the result before keeping it.', fields: () => [
    number('maxEdges', 'Maximum loop edges', 32, 3, 1000, 1), number('maxHoles', 'Maximum holes', 10, 0, 1000, 1),
    number('maxPerimeter', 'Maximum perimeter', '', 0),
  ] },
  fair: { help: 'Fair interior vertices while keeping boundary constraints. Closed surfaces need an explicit selectedVertices constraint in advanced options.', fields: () => [
    select('method', 'Method', [['fair', 'Higher-order fairing'], ['area', 'Minimize area'], ['curvature', 'Minimize curvature']]),
    number('k', 'Order (fairing only)', 2, 1, 3, 1),
  ] },
  normals: { help: 'Recompute smooth vertex normals. Geometry and topology stay unchanged.', fields: () => [] },
  analyze: { help: 'Inspect area, bounds, connected components and edge lengths in mesh-local units. Volume is meaningful for closed surfaces.', fields: () => [] },
};

let fields = [], original = null, current = null, worker = null, pending = null, sequence = 0, viewer;
const format = value => value.toLocaleString('en-US');
function status(message, state = 'ready') { $('status').textContent = message; $('status').dataset.state = state; }
function controls() {
  const busy = Boolean(pending), loaded = Boolean(current);
  $('transform-controls').disabled = busy || !loaded;
  for (const id of ['download-button', 'original-button', 'result-button', 'reset-button', 'fit-button']) $(id).disabled = busy || !loaded;
  $('sample-button').disabled = busy || !viewer;
  $('file-input').disabled = busy || !viewer;
  $('wireframe').disabled = !viewer;
  $('cancel-button').hidden = !busy;
  $('transform-form').setAttribute('aria-busy', String(busy));
}
function renderFields(method) {
  const operation = operations[$('operation').value];
  $('operation-help').textContent = operation.help;
  fields = operation.fields(method);
  $('parameters').replaceChildren(...fields.map(field => {
    const label = document.createElement('label');
    const input = document.createElement(field.type === 'select' ? 'select' : 'input');
    input.id = `param-${field.key}`;
    if (field.type === 'select') {
      for (const [value, text] of field.choices) input.add(new Option(text, value));
      input.value = field.value;
    } else {
      input.type = field.type;
      if (field.type === 'checkbox') { input.checked = field.value; label.className = 'check wide'; }
      else {
        input.value = field.value; input.min = field.min; input.step = field.step;
        if (field.max !== undefined) input.max = field.max;
        input.required = field.value !== '';
      }
    }
    if (field.type === 'checkbox') label.append(input, document.createTextNode(field.label));
    else label.append(document.createTextNode(field.label), input);
    if (field.key === 'method' && ['remesh', 'smooth'].includes($('operation').value))
      input.addEventListener('change', () => renderFields(input.value));
    return label;
  }));
}
function options() {
  const output = { operation: $('operation').value, attributeTransfer: $('attribute-transfer').value,
    maxVertices: Number($('max-vertices').value) };
  for (const field of fields) {
    const input = $(`param-${field.key}`);
    if (field.type === 'checkbox') output[field.key] = input.checked;
    else if (input.value !== '') output[field.key] = field.type === 'number' ? Number(input.value) : input.value;
  }
  const extra = JSON.parse($('advanced-options').value || '{}');
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Additional options must be a JSON object.');
  for (const key of ['operation', 'meshes', 'primitives', 'filter', 'parameters', 'onReport', '__proto__', 'constructor', 'prototype'])
    if (Object.hasOwn(extra, key)) throw new Error(`Use the selection and operation controls instead of "${key}".`);
  Object.assign(output, extra);
  if (output.operation === 'decimate' && output.targetVertices !== undefined) delete output.ratio;
  if (output.operation === 'fair' && output.method !== 'fair') delete output.k;
  if (!Number.isSafeInteger(output.maxVertices) || output.maxVertices < 3 || output.maxVertices > 500000)
    throw new Error('The demo vertex limit must be an integer between 3 and 500,000.');
  return output;
}
function showReports(reports) {
  const container = $('report'); container.replaceChildren();
  $('report-panel').hidden = !reports.length;
  const table = document.createElement('table'), header = table.createTHead().insertRow();
  for (const title of ['Mesh / primitive', 'Status', 'Vertices', 'Triangles']) {
    const th = document.createElement('th'); th.textContent = title; header.append(th);
  }
  const body = table.createTBody();
  for (const report of reports) {
    if (report.before && report.after) {
      const row = body.insertRow();
      for (const value of [`${report.meshIndex} / ${report.primitiveIndex}`, report.status,
        `${format(report.before.vertices)} → ${format(report.after.vertices)}`,
        `${format(report.before.triangles)} → ${format(report.after.triangles)}`]) row.insertCell().textContent = value;
    }
    if (report.reason) { const p = document.createElement('p'); p.textContent = report.reason; container.append(p); }
    if (report.measurements) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(report.measurements, null, 2); container.append(pre); }
  }
  if (body.rows.length) container.prepend(table);
}
function display(which, fit = false) {
  const model = which === 'original' ? original : current;
  if (!model) return;
  viewer.setModel(model.preview, { fit });
  $('original-button').setAttribute('aria-pressed', String(which === 'original'));
  $('result-button').setAttribute('aria-pressed', String(which === 'result'));
}
function accept(result, newOriginal) {
  // Upload first: a failed preview must not replace the last downloadable result.
  viewer.setModel(result.preview, { fit: newOriginal });
  current = result;
  if (newOriginal) original = result;
  $('original-button').setAttribute('aria-pressed', 'false'); $('result-button').setAttribute('aria-pressed', 'true');
  $('empty-state').hidden = true; $('model-name').textContent = result.name;
  for (const key of ['vertices', 'triangles']) {
    $(`${key}-before`).textContent = format(original.summary[key]); $(`${key}-after`).textContent = format(current.summary[key]);
  }
  const selected = newOriginal ? '' : $('mesh').value;
  $('mesh').replaceChildren(new Option('Whole model', ''), ...result.meshes.map(mesh => new Option(`${mesh.index}: ${mesh.name || 'Unnamed mesh'}`, String(mesh.index))));
  $('mesh').value = selected;
  showReports(result.reports || []);
}
function stop(message) {
  if (!pending) return;
  clearTimeout(pending.timer); pending = null;
  worker?.terminate(); worker = null;
  status(message, current ? 'ready' : 'error'); controls();
}
function request(type, payload = {}) {
  if (pending) return;
  if (!worker) {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (!pending || data.id !== pending.id) return;
      const job = pending; clearTimeout(job.timer); pending = null;
      try {
        if (!data.ok) throw new Error(data.error);
        accept(data.data, job.type !== 'transform');
        const seconds = ((performance.now() - job.started) / 1000).toFixed(2);
        const warnings = (data.data.reports || []).filter(report => report.status === 'warning' || report.status === 'skipped').length;
        status(`${job.type === 'transform' ? 'Transform complete' : 'Model loaded'} · ${seconds}s${warnings ? ` · ${warnings} note(s) in operation details` : ''}.`);
      } catch (error) { status(error.message, 'error'); }
      controls();
    };
    worker.onerror = event => { event.preventDefault(); stop(`Processing failed: ${event.message || 'worker error'}`); $('status').dataset.state = 'error'; };
  }
  const id = ++sequence;
  pending = { id, type, started: performance.now(), timer: setTimeout(() => stop('Stopped after 120 seconds. The previous result is unchanged; try a smaller mesh or fewer iterations.'), 120000) };
  status(type === 'transform' ? 'Processing geometry…' : 'Opening model…', 'busy'); controls();
  // File objects are immutable and structured cloned; current GLB stays owned by the UI.
  try { worker.postMessage({ id, type, ...payload }); }
  catch (error) { stop(error.message); $('status').dataset.state = 'error'; }
}
function load(files) { if (!pending && viewer && files.length) request('load', { files: Array.from(files) }); }
try { viewer = new Preview($('preview')); }
catch (error) { status(`Preview unavailable: ${error.message}`, 'error'); }
$('preview').addEventListener('previewerror', event => { status(event.detail.message, 'error'); });
$('operation').addEventListener('change', () => renderFields());
$('sample-button').addEventListener('click', () => request('sample'));
$('file-input').addEventListener('change', event => { load(event.target.files); event.target.value = ''; });
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => {
  if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); $('drop-zone').classList.add('dragover'); }
});
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('drop-zone').classList.remove('dragover'); });
document.addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); load(event.dataTransfer?.files || []); });
$('transform-form').addEventListener('submit', event => {
  event.preventDefault(); if (!current || pending) return;
  try { request('transform', { bytes: current.bytes, name: current.name, options: options(), meshIndex: $('mesh').value === '' ? null : Number($('mesh').value) }); }
  catch (error) { status(error.message, 'error'); }
});
$('cancel-button').addEventListener('click', () => stop('Operation cancelled. The previous result is unchanged.'));
$('original-button').addEventListener('click', () => { try { display('original'); } catch (error) { status(error.message, 'error'); } });
$('result-button').addEventListener('click', () => { try { display('result'); } catch (error) { status(error.message, 'error'); } });
$('reset-button').addEventListener('click', () => { try { accept(original, true); status('Restored the original model.'); controls(); } catch (error) { status(error.message, 'error'); } });
$('fit-button').addEventListener('click', () => viewer.fit());
$('wireframe').addEventListener('change', event => { try { viewer.setWireframe(event.target.checked); } catch (error) { event.target.checked = false; status(error.message, 'error'); } });
$('download-button').addEventListener('click', () => {
  if (!current || pending) return;
  const url = URL.createObjectURL(new Blob([current.bytes], { type: 'model/gltf-binary' }));
  const link = document.createElement('a'); link.href = url;
  link.download = current.name.replace(/\.(glb|gltf)$/i, '').replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 100) + '-processed.glb';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
});
window.addEventListener('pagehide', event => {
  worker?.terminate(); worker = null;
  if (pending) { clearTimeout(pending.timer); pending = null; status('Processing stopped. The previous result is unchanged.'); controls(); }
  // The browser may restore this page and its canvas from the back/forward cache.
  if (!event.persisted) viewer?.dispose();
});
renderFields(); controls();
