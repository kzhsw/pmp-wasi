const VERTEX = `#version 300 es
precision highp float;
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec4 color;
uniform mat4 viewProjection;
uniform vec4 baseColor;
out vec3 worldPosition;
out vec3 worldNormal;
out vec4 vertexColor;
void main() {
  worldPosition = position;
  worldNormal = normal;
  vertexColor = color * baseColor;
  gl_Position = viewProjection * vec4(position, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 worldPosition;
in vec3 worldNormal;
in vec4 vertexColor;
uniform vec3 eye;
uniform bool wire;
out vec4 outputColor;
void main() {
  if (wire) {
    outputColor = vec4(0.035, 0.065, 0.10, 0.72);
    return;
  }
  vec3 n = worldNormal;
  if (dot(n, n) < 0.000001) n = cross(dFdx(worldPosition), dFdy(worldPosition));
  n = dot(n, n) > 0.0000000001 ? normalize(n) : vec3(0.0, 1.0, 0.0);
  vec3 view = normalize(eye - worldPosition);
  if (dot(n, view) < 0.0) n = -n;
  vec3 light = normalize(vec3(0.45, 0.85, 0.65));
  float diffuse = max(dot(n, light), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.7, 0.1, -0.5))), 0.0);
  float specular = pow(max(dot(n, normalize(light + view)), 0.0), 40.0) * 0.12;
  vec3 rgb = max(vertexColor.rgb, vec3(0.0)) * (0.32 + 0.65 * diffuse + 0.14 * fill) + specular;
  outputColor = vec4(pow(clamp(rgb, 0.0, 1.0), vec3(1.0 / 2.2)), clamp(vertexColor.a, 0.0, 1.0));
}`;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const FOV = Math.PI * 42 / 180;
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));

function program(gl) {
  const shaders = [];
  const result = gl.createProgram();
  if (!result) throw new Error('WebGL could not create the preview program.');
  try {
    for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]]) {
      const shader = gl.createShader(kind);
      if (!shader) throw new Error('WebGL could not create a preview shader.');
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Preview shader failed: ${gl.getShaderInfoLog(shader) || 'unknown error'}`);
      }
      gl.attachShader(result, shader);
    }
    gl.linkProgram(result);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) {
      throw new Error(`Preview shader link failed: ${gl.getProgramInfoLog(result) || 'unknown error'}`);
    }
    return result;
  } catch (error) {
    gl.deleteProgram(result);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
}

function point(p, i, m) {
  const x = p[i], y = p[i + 1], z = p[i + 2];
  return [m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalTransform(m) {
  const columns = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const scales = columns.map((c) => Math.hypot(...c));
  if (scales.some((s) => !s || !Number.isFinite(s))) return null;
  const [a, b, c] = columns.map((v, i) => v.map((n) => n / scales[i]));
  const cofactors = [cross(b, c), cross(c, a), cross(a, b)];
  const det = a[0] * cofactors[0][0] + a[1] * cofactors[0][1] + a[2] * cofactors[0][2];
  // A singular transform has no inverse normal matrix. Use geometric normals.
  if (Math.abs(det) < 1e-12) return null;
  return {scales, cofactors, sign: Math.sign(det)};
}

function normal(n, i, transform) {
  if (!transform) return [0, 0, 0];
  const {scales, cofactors, sign} = transform;
  let weights = [n[i] / scales[0], n[i + 1] / scales[1], n[i + 2] / scales[2]];
  let size = Math.max(...weights.map(Math.abs));
  // Logarithmic weights cover finite matrices with extreme nonuniform scales.
  if (!Number.isFinite(size) || (!size && (n[i] || n[i + 1] || n[i + 2]))) {
    const logs = scales.map((s, k) => n[i + k] ? Math.log(Math.abs(n[i + k])) - Math.log(s) : -Infinity);
    const largest = Math.max(...logs);
    weights = logs.map((l, k) => Math.sign(n[i + k]) * Math.exp(l - largest));
    size = 1;
  }
  if (!size) return [0, 0, 0];
  const result = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 3; j++) result[j] += cofactors[k][j] * (weights[k] / size) * sign;
  }
  const length = Math.hypot(...result);
  return length ? result.map((v) => v / length) : [0, 0, 0];
}

function viewProjection(eye, aspect, near, far) {
  const z = eye.map((v) => v / Math.hypot(...eye));
  const x = [z[2], 0, -z[0]];
  const length = Math.hypot(...x);
  for (let i = 0; i < 3; i++) x[i] /= length;
  const y = cross(z, x);
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    0, 0, -Math.hypot(...eye), 1];
  const f = 1 / Math.tan(FOV / 2), d = 1 / (near - far);
  const projection = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * d, -1,
    0, 0, 2 * far * near * d, 0];
  const result = new Float32Array(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) result[column * 4 + row] += projection[k * 4 + row] * view[column * 4 + k];
    }
  }
  return result;
}

/** A small, on-demand geometry preview. Matrices use glTF's column-major layout. */
export class Preview {
  constructor(canvas, {maxVertices = 3_000_000, maxTriangles = 3_000_000, maxBytes = 256 * 1024 * 1024} = {}) {
    this.canvas = canvas;
    this.limits = {maxVertices, maxTriangles, maxBytes};
    if (Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n <= 0)) {
      throw new Error('Preview limits must be positive safe integers.');
    }
    const gl = canvas.getContext('webgl2', {alpha: true, antialias: true, premultipliedAlpha: true});
    if (!gl) throw new Error('WebGL 2 is unavailable. Enable hardware acceleration or try another browser.');
    this.gl = gl;
    this._program = program(gl);
    this._uniforms = Object.fromEntries(['viewProjection', 'baseColor', 'eye', 'wire']
      .map((name) => [name, gl.getUniformLocation(this._program, name)]));
    this._primitives = [];
    this._radius = 1;
    this._zoom = 1;
    this._yaw = 0.65;
    this._pitch = 0.3;
    this._wireframe = false;
    this._frame = null;
    this._disposed = false;
    this.error = null;
    this._listeners = [];
    this._touchAction = canvas.style.touchAction;
    this._tabIndex = canvas.getAttribute('tabindex');
    this._label = canvas.getAttribute('aria-label');
    canvas.style.touchAction = 'none';
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    if (!this._label) canvas.setAttribute('aria-label', '3D mesh preview. Drag to orbit, scroll to zoom. Arrow keys rotate, plus and minus zoom, F fits.');
    const on = (name, handler, options) => {
      canvas.addEventListener(name, handler, options);
      this._listeners.push([name, handler, options]);
    };
    on('webglcontextlost', () => this._fail(new Error('The WebGL preview context was lost. Reload the page to restore it.')));
    on('pointerdown', (event) => {
      if (event.button !== 0 || this.error || this._pointer) return;
      this._pointer = {id: event.pointerId, x: event.clientX, y: event.clientY};
      canvas.setPointerCapture(event.pointerId);
      canvas.focus({preventScroll: true});
    });
    on('pointermove', (event) => {
      const pointer = this._pointer;
      if (!pointer || pointer.id !== event.pointerId) return;
      const scale = Math.max(100, Math.min(canvas.clientWidth, canvas.clientHeight));
      this._yaw -= (event.clientX - pointer.x) * 5 / scale;
      this._pitch = clamp(this._pitch + (event.clientY - pointer.y) * 5 / scale, -1.5, 1.5);
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      this._request();
    });
    const end = (event) => {
      if (this._pointer?.id !== event.pointerId) return;
      this._pointer = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    on('pointerup', end);
    on('pointercancel', end);
    on('lostpointercapture', end);
    on('wheel', (event) => {
      if (this.error) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
      this._zoom = clamp(this._zoom * Math.exp(clamp(delta * 0.001, -1, 1)), 0.03, 100);
      this._request();
    }, {passive: false});
    on('keydown', (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || this.error) return;
      const step = event.shiftKey ? 0.2 : 0.08;
      if (event.key === 'ArrowLeft') this._yaw -= step;
      else if (event.key === 'ArrowRight') this._yaw += step;
      else if (event.key === 'ArrowUp') this._pitch = clamp(this._pitch + step, -1.5, 1.5);
      else if (event.key === 'ArrowDown') this._pitch = clamp(this._pitch - step, -1.5, 1.5);
      else if (event.key === '+' || event.key === '=') this._zoom = clamp(this._zoom / 1.15, 0.03, 100);
      else if (event.key === '-' || event.key === '_') this._zoom = clamp(this._zoom * 1.15, 0.03, 100);
      else if (event.key.toLowerCase() === 'f' || event.key === 'Home') this._zoom = 1;
      else return;
      event.preventDefault();
      this._request();
    });
    this._resize = () => this._request();
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(canvas);
    window.addEventListener('resize', this._resize);
    this._request();
  }

  _assert() {
    if (this._disposed) throw new Error('The mesh preview has been disposed.');
    if (this.error || this.gl.isContextLost()) throw this.error || new Error('The WebGL preview context is lost.');
  }

  _check() {
    if (this.gl.isContextLost()) throw new Error('The WebGL preview context is lost.');
    const error = this.gl.getError();
    if (error !== this.gl.NO_ERROR) throw new Error(`WebGL could not upload the preview (error ${error}). Try a smaller model.`);
  }

  _delete(primitives) {
    for (const p of primitives) {
      this.gl.deleteVertexArray(p.vao);
      for (const buffer of p.buffers) this.gl.deleteBuffer(buffer);
    }
  }

  _buffer(p, target, data) {
    const gl = this.gl, buffer = gl.createBuffer();
    if (!buffer) throw new Error('WebGL could not allocate the preview. Try a smaller model.');
    p.buffers.push(buffer);
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    this._check();
    return buffer;
  }

  setModel(model, {fit = true} = {}) {
    this._assert();
    if (!Array.isArray(model?.primitives) || model.primitives.length > 4096) throw new Error('Invalid preview primitive list.');
    let vertices = 0, triangles = 0, bytes = 0;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const source = model.primitives.map((p) => {
      if (!(p.positions instanceof Float32Array) || p.positions.length % 3 ||
          !(p.indices instanceof Uint32Array) || p.indices.length % 3 ||
          (p.normals != null && (!(p.normals instanceof Float32Array) || p.normals.length !== p.positions.length)) ||
          (p.colors != null && (!(p.colors instanceof Float32Array) || p.colors.length !== p.positions.length / 3 * 4))) {
        throw new Error('Preview requires float positions/normals/RGBA colors and triangle Uint32 indices.');
      }
      const count = p.positions.length / 3, matrix = p.matrix ?? IDENTITY;
      const color = p.color ?? [0.56, 0.68, 0.81, 1];
      if (matrix.length !== 16 || Array.from(matrix).some((v) => !Number.isFinite(v)) ||
          Math.abs(matrix[3]) + Math.abs(matrix[7]) + Math.abs(matrix[11]) > 1e-10 || Math.abs(matrix[15] - 1) > 1e-8 ||
          color.length !== 4 || Array.from(color).some((v) => !Number.isFinite(v))) throw new Error('Invalid preview transform or color.');
      vertices += count;
      triangles += p.indices.length / 3;
      // Includes CPU/GPU wire indices and temporary transformed attributes.
      bytes += count * (p.colors ? 64 : 48) + p.indices.length * 24;
      if (vertices > this.limits.maxVertices || triangles > this.limits.maxTriangles || bytes > this.limits.maxBytes) {
        throw new Error('The model exceeds the preview memory limit. Try a smaller model.');
      }
      for (const data of [p.positions, p.normals, p.colors]) {
        if (data) for (const value of data) if (!Number.isFinite(value)) throw new Error('Preview attributes contain a non-finite value.');
      }
      for (const index of p.indices) if (index >= count) throw new Error('Preview index is outside its vertex array.');
      for (let i = 0; i < p.positions.length; i += 3) {
        const v = point(p.positions, i, matrix);
        for (let k = 0; k < 3; k++) {
          if (!Number.isFinite(v[k])) throw new Error('A preview world position is outside the finite numeric range.');
          min[k] = Math.min(min[k], v[k]);
          max[k] = Math.max(max[k], v[k]);
        }
      }
      return {...p, matrix, color};
    });
    const center = min.map((n, k) => vertices ? n / 2 + max[k] / 2 : 0);
    const extents = min.map((n, k) => vertices ? max[k] / 2 - n / 2 : 0);
    const scale = Math.max(...extents) || 1;
    const radius = Math.hypot(...extents.map((e) => e / scale)) || 1;
    const gl = this.gl, uploaded = [];
    try {
      for (const p of source) {
        if (!p.indices.length) continue;
        const gpu = {vao: gl.createVertexArray(), buffers: [], count: p.indices.length, color: p.color, indices: null, wire: null};
        uploaded.push(gpu);
        if (!gpu.vao) throw new Error('WebGL could not allocate preview geometry.');
        gpu.indices = p.indices.slice();
        gl.bindVertexArray(gpu.vao);
        const positions = new Float32Array(p.positions.length);
        const normals = p.normals ? new Float32Array(p.normals.length) : null;
        const transform = p.normals ? normalTransform(p.matrix) : null;
        for (let i = 0; i < positions.length; i += 3) {
          const v = point(p.positions, i, p.matrix);
          for (let k = 0; k < 3; k++) positions[i + k] = v[k] / scale - center[k] / scale;
          if (normals) normals.set(normal(p.normals, i, transform), i);
        }
        for (const [location, size, data] of [[0, 3, positions], [1, 3, normals], [2, 4, p.colors]]) {
          if (!data) { gl.disableVertexAttribArray(location); continue; }
          this._buffer(gpu, gl.ARRAY_BUFFER, data);
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
        }
        gpu.elements = this._buffer(gpu, gl.ELEMENT_ARRAY_BUFFER, p.indices);
      }
      if (this._wireframe) this._lines(uploaded);
    } catch (error) {
      this._delete(uploaded);
      throw error;
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    this._delete(this._primitives);
    this._primitives = uploaded;
    this._radius = radius;
    if (fit) this._zoom = 1;
    this._request();
  }

  _lines(primitives) {
    const gl = this.gl, created = [];
    try {
      for (const p of primitives) {
        if (p.wire) continue;
        const lines = new Uint32Array(p.count * 2);
        for (let i = 0, j = 0; i < p.count; i += 3) {
          const [a, b, c] = p.indices.subarray(i, i + 3);
          lines[j++] = a; lines[j++] = b; lines[j++] = b;
          lines[j++] = c; lines[j++] = c; lines[j++] = a;
        }
        gl.bindVertexArray(p.vao);
        const before = p.buffers.length;
        try { p.wire = this._buffer(p, gl.ELEMENT_ARRAY_BUFFER, lines); }
        finally { if (p.buffers.length > before) created.push([p, p.buffers.at(-1)]); }
      }
      for (const p of primitives) p.indices = null;
    } catch (error) {
      for (const [p, buffer] of created) {
        gl.deleteBuffer(buffer);
        p.buffers.splice(p.buffers.indexOf(buffer), 1);
        p.wire = null;
      }
      throw error;
    } finally { gl.bindVertexArray(null); }
  }

  fit() { this._assert(); this._zoom = 1; this._request(); }

  setWireframe(value) {
    this._assert();
    if (value) this._lines(this._primitives);
    this._wireframe = Boolean(value);
    this._request();
  }

  _fail(error) {
    if (this.error || this._disposed) return;
    this.error = error;
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._frame = null;
    this._delete(this._primitives);
    this._primitives = [];
    this.canvas.dispatchEvent(new CustomEvent('previewerror', {detail: error}));
  }

  _request() {
    if (this._frame !== null || this._disposed || this.error) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = null;
      try { this._render(); } catch (error) { this._fail(error); }
    });
  }

  _render() {
    this._assert();
    const gl = this.gl, canvas = this.canvas, bounds = canvas.getBoundingClientRect();
    const limit = Math.min(4096, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const ratio = Math.min(window.devicePixelRatio || 1, 2, limit / Math.max(bounds.width, bounds.height, 1));
    const width = Math.max(1, Math.round(bounds.width * ratio)), height = Math.max(1, Math.round(bounds.height * ratio));
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const halfFov = Math.atan(Math.tan(FOV / 2) * Math.min(1, width / height));
    const distance = this._radius / Math.sin(halfFov) * 1.08 * this._zoom;
    const eye = [distance * Math.cos(this._pitch) * Math.sin(this._yaw), distance * Math.sin(this._pitch), distance * Math.cos(this._pitch) * Math.cos(this._yaw)];
    gl.useProgram(this._program);
    gl.uniformMatrix4fv(this._uniforms.viewProjection, false, viewProjection(eye, width / height,
      Math.max(this._radius * 0.0001, distance - this._radius * 1.5), distance + this._radius * 3));
    gl.uniform3fv(this._uniforms.eye, eye);
    gl.vertexAttrib3f(1, 0, 0, 0);
    gl.vertexAttrib4f(2, 1, 1, 1, 1);
    gl.uniform1i(this._uniforms.wire, 0);
    if (this._wireframe) { gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1); }
    for (const p of this._primitives) {
      gl.bindVertexArray(p.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.elements);
      gl.uniform4fv(this._uniforms.baseColor, p.color);
      gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    if (this._wireframe) {
      gl.uniform1i(this._uniforms.wire, 1);
      for (const p of this._primitives) {
        gl.bindVertexArray(p.vao);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.wire);
        gl.drawElements(gl.LINES, p.count * 2, gl.UNSIGNED_INT, 0);
      }
    }
    gl.bindVertexArray(null);
    this._check();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._frame !== null) cancelAnimationFrame(this._frame);
    this._observer.disconnect();
    window.removeEventListener('resize', this._resize);
    for (const args of this._listeners) this.canvas.removeEventListener(...args);
    if (this._pointer && this.canvas.hasPointerCapture(this._pointer.id)) this.canvas.releasePointerCapture(this._pointer.id);
    this.canvas.style.touchAction = this._touchAction;
    for (const [attribute, value] of [['tabindex', this._tabIndex], ['aria-label', this._label]]) {
      if (value === null) this.canvas.removeAttribute(attribute); else this.canvas.setAttribute(attribute, value);
    }
    this._delete(this._primitives);
    this._primitives = [];
    this.gl.deleteProgram(this._program);
  }
}
