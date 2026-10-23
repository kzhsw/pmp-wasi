// Minimal binary inspection for build invariants, not a runtime dependency.
import assert from 'node:assert/strict';

// Chrome 75: memory.copy/fill, saturating conversions and sign extension.
// Keep the compiler/SDK metadata separate from the final runtime requirement.
export const targetFeatures = Object.freeze(['+bulk-memory-opt', '+nontrapping-fptoint', '+sign-ext']);
const sdkFeatures = [...targetFeatures, '+bulk-memory', '+call-indirect-overlong',
  '+extended-const', '+multivalue', '+mutable-globals', '+reference-types'];

function reader(bytes) {
  let offset = 0;
  return {
    get offset() { return offset; },
    get done() { return offset === bytes.length; },
    byte() { assert(offset < bytes.length, 'Truncated Wasm'); return bytes[offset++]; },
    uint() {
      let result = 0;
      for (let shift = 0; shift <= 28; shift += 7) {
        const b = this.byte();
        if (shift === 28) assert((b & 0xf0) === 0, 'Invalid u32 LEB');
        result += (b & 127) * 2 ** shift;
        if (!(b & 128)) return result;
      }
      throw new Error('Invalid LEB');
    },
    take(length) {
      assert(length <= bytes.length - offset, 'Truncated Wasm section');
      const result = bytes.subarray(offset, offset + length);
      offset += length;
      return result;
    },
    string() { return new TextDecoder('utf-8', { fatal: true }).decode(this.take(this.uint())); },
  };
}

export function inspect(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);
  const module = new WebAssembly.Module(bytes);
  const sections = reader(bytes.subarray(8));
  const exports = new Map(), bodies = [], features = [];
  let start = false, memories = 0;
  while (!sections.done) {
    const id = sections.byte();
    const part = reader(sections.take(sections.uint()));
    if (id === 0 && part.string() === 'target_features') {
      const count = part.uint();
      for (let i = 0; i < count; ++i) features.push(String.fromCharCode(part.byte()) + part.string());
    } else if (id === 5) {
      memories = part.uint();
      assert.equal(memories, 1, 'Expected one memory');
      const flags = part.uint();
      assert.equal(flags & ~1, 0, 'Memory must be unshared wasm32');
      part.uint();
      if (flags & 1) part.uint();
    } else if (id === 7) {
      const count = part.uint();
      for (let i = 0; i < count; ++i) exports.set(part.string(), { kind: part.byte(), index: part.uint() });
    } else if (id === 8) start = true;
    else if (id === 10) {
      const count = part.uint();
      for (let i = 0; i < count; ++i) bodies.push(part.take(part.uint()));
    }
  }
  const imports = WebAssembly.Module.imports(module);
  return { module, exports, bodies, imports, features: features.sort(), start, memories };
}

export function audit(bytes, expectedExports, { linked = false } = {}) {
  // Structural/metadata checks. Build and audit tests additionally validate the
  // actual instructions with Binaryen after stripping SDK feature metadata.
  const info = inspect(bytes);
  assert.deepEqual(info.imports, [], 'Host imports are forbidden');
  assert.equal(info.start, false, 'Start functions are forbidden');
  assert.equal(info.memories, 1);
  assert.deepEqual([...info.exports.keys()].sort(), [...expectedExports].sort(), 'Unexpected exports');
  for (const name of expectedExports) assert.equal(info.exports.get(name).kind, name === 'memory' ? 2 : 0);
  checkFeatures(info.features, linked ? sdkFeatures : targetFeatures);
  if (!linked) assert.deepEqual(info.features, targetFeatures, 'Unexpected runtime feature baseline');
  return info;
}

function checkFeatures(features, allowed) {
  assert(features.length > 0, 'Missing target_features baseline');
  assert.equal(new Set(features).size, features.length, 'Duplicate feature metadata');
  for (const feature of features) assert(allowed.includes(feature), `Unapproved feature: ${feature}`);
}

// Binaryen reads input target_features and can expand its enabled feature set.
// Remove that metadata BEFORE invoking it with the explicit runtime limit. All
// instruction/section bytes remain unchanged; unsupported instructions must fail
// validation. Binaryen emits fresh metadata for the validated final feature set.
export function stripTargetFeatures(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0]);
  const sections = reader(bytes.subarray(8)), parts = [bytes.subarray(0, 8)];
  while (!sections.done) {
    const start = sections.offset, id = sections.byte();
    const part = sections.take(sections.uint());
    if (id !== 0 || reader(part).string() !== 'target_features')
      parts.push(bytes.subarray(start + 8, sections.offset + 8));
  }
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

export function binaryenFlags(features = targetFeatures) {
  checkFeatures(features, targetFeatures);
  const names = new Map([
    ['bulk-memory-opt', 'bulk-memory-opt'],
    ['nontrapping-fptoint', 'nontrapping-float-to-int'], ['sign-ext', 'sign-ext'],
  ]);
  return ['--mvp-features', ...features.map(feature => `--enable-${names.get(feature.slice(1))}`)];
}

export function auditLinkMap(map) {
  const forbidden = /\b(?:__stack_chk\w*|__wasilibc\w*|__wasi_\w*|__stdio\w*|__wasm_call_dtors|\w*printf\w*|\w*scanf\w*|puts|fputs|putchar|fputc|getchar|fgetc|gets|fgets|fopen|freopen|fclose|fread|fwrite|fflush|fseek|ftell|setvbuf|perror|stdin|stdout|stderr|open|openat|close|read|write|readv|writev|lseek|stat|fstat|unlink|rename|mkdir|opendir|readdir|socket|connect|bind|listen|accept|recv\w*|send\w*|poll|select|pthread_\w*|thrd_\w*|mtx_\w*|cnd_\w*|omp_\w*|__kmpc_\w*|random_get|clock_\w*|time|gettimeofday|rand|srand|random|srandom|getenv|setenv|unsetenv|putenv|environ|system|exec\w*|fork|exit|_Exit|_exit|atexit|proc_exit|__cxa_(?:throw|allocate_exception|free_exception|begin_catch|end_catch|rethrow|atexit)|_Unwind_\w*|(?:basic_)?(?:iostream|ostream|istream|streambuf)|thread|mutex|condition_variable)\b/;
  for (const line of map.split('\n')) assert(!forbidden.test(line), `Forbidden live symbol: ${line}`);
  assert(!map.includes('.command_export'), 'Command export wrappers must be absent');
}
