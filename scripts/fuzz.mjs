// SPDX-License-Identifier: MIT
// Deterministic bounded model testing, not a coverage-guided fuzzer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { runFuzz } from '../test/fuzz-js.mjs';
import { verifyVendor } from './vendor.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const options = { seed: 1, seeds: 32, js: true, native: true, rebuild: false };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; ++i) {
  const arg = args[i];
  if (arg === '--js-only') { assert(options.js, 'Choose only one mode'); options.native = false; }
  else if (arg === '--native-only') { assert(options.native, 'Choose only one mode'); options.js = false; }
  else if (arg === '--rebuild') options.rebuild = true;
  else if (arg === '--seed' || arg === '--seeds') {
    const value = args[++i];
    assert(value !== undefined && /^\d+$/.test(value), `${arg} requires an unsigned integer`);
    options[arg.slice(2)] = Number(value);
  } else throw new Error(`Unknown argument ${arg}; use --js-only/--native-only, --seed N, --seeds 1..256, --rebuild`);
}
assert(Number.isInteger(options.seed) && options.seed >= 0 && options.seed <= 0xffffffff, '--seed must fit u32');
assert(Number.isInteger(options.seeds) && options.seeds >= 1 && options.seeds <= 256, '--seeds must be between 1 and 256');
mkdirSync('build', { recursive: true });
const report = { kind: 'bounded deterministic model fuzzing', seed: options.seed, seeds: options.seeds };
const run = (command, arguments_, extra = {}) => {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${command} failed (${result.signal ?? result.status})\n${result.stderr}`);
    error.stderr = result.stderr;
    throw error;
  }
  return result;
};
let mode = 'setup';
try {
  if (options.js) {
    mode = 'js';
    const bytes = readFileSync('build/pmp-core.wasm');
    report.js = { ...await runFuzz(bytes, options), wasmSha256: createHash('sha256').update(bytes).digest('hex') };
    console.log(`JS fuzz: ${report.js.seeds} seeds, ${report.js.assertions} assertions`);
  }
  if (options.native) {
    mode = 'native-build';
    verifyVendor();
    const directory = 'build/fuzz-native';
    mkdirSync(directory, { recursive: true });
    const cc = process.env.FUZZ_CC ?? 'gcc', cxx = process.env.FUZZ_CXX ?? 'g++';
    const common = ['-O1', '-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-fno-omit-frame-pointer'];
    const cpp = [...common, '-std=c++20', '-DNDEBUG', '-DEIGEN_DONT_PARALLELIZE', '-fno-exceptions', '-fno-rtti',
      '-Iinclude', '-Ivendor', '-isystem', 'vendor/eigen'];
    const sources = ['src/core.cpp', 'src/algorithms.cpp', 'src/inspection.cpp', 'src/triangulation.cpp',
      'vendor/pmp/surface_mesh.cpp', ...['normals', 'features', 'decimation', 'subdivision', 'distance_point_triangle',
        'remeshing', 'curvature', 'smoothing', 'laplace', 'numerics', 'differential_geometry', 'fairing',
        'hole_filling', 'triangulation', 'utilities'].map(name => `vendor/pmp/algorithms/${name}.cpp`)];
    const compilers = [run(cc, ['--version']).stdout.split('\n')[0], run(cxx, ['--version']).stdout.split('\n')[0]];
    const context = () => createHash('sha256').update(JSON.stringify({ cc, cxx, cpp, compilers }))
      .update(readFileSync('vendor/manifest.json')).update(readFileSync('include/pmp.h')).update(readFileSync('src/mesh.hpp')).digest('hex');
    const fingerprint = () => {
      const digest = createHash('sha256').update(context());
      for (const source of ['test/fuzz.c', ...sources]) digest.update(source).update(readFileSync(source));
      return digest.digest('hex');
    };
    const key = fingerprint(), metadata = join(directory, 'config.json'), executable = join(directory, 'fuzz-native');
    const cached = existsSync(metadata) && existsSync(executable) && JSON.parse(readFileSync(metadata, 'utf8')).key === key;
    if (options.rebuild || !cached) {
      const objects = sources.map((source, index) => {
        const object = join(directory, `${index}.o`), stamp = join(directory, `${index}.sha256`);
        const objectKey = () => createHash('sha256').update(context()).update(source).update(readFileSync(source)).digest('hex');
        const expected = objectKey();
        if (!options.rebuild && existsSync(object) && existsSync(stamp) && readFileSync(stamp, 'utf8') === expected) return object;
        // Deliberately one compiler job: instrumented Eigen translation units use substantial memory.
        run(cxx, [...cpp, '-c', source, '-o', object]);
        assert.equal(objectKey(), expected, `${source} or its headers changed during compilation`);
        writeFileSync(stamp, expected);
        return object;
      });
      const harness = join(directory, 'harness.o');
      run(cc, [...common, '-std=c11', '-Wall', '-Wextra', '-Werror', '-Iinclude', '-c', 'test/fuzz.c', '-o', harness]);
      run(cxx, [...common, ...objects, harness, '-o', executable]);
      assert.equal(fingerprint(), key, 'Native fuzz inputs changed while compiling; rebuild before testing');
      writeFileSync(metadata, JSON.stringify({ key, compilers, sanitizers: ['address', 'undefined'], language: 'C11', sources }, null, 2) + '\n');
    }
    mode = 'native';
    const asanRuntime = run(cxx, ['-print-file-name=libasan.so']).stdout.trim();
    assert(existsSync(asanRuntime), 'GCC AddressSanitizer runtime is unavailable');
    const environment = { ...process.env,
      // Keep ASan first even when the host has system-wide preloads.
      LD_PRELOAD: asanRuntime + (process.env.LD_PRELOAD ? `:${process.env.LD_PRELOAD}` : ''),
      ASAN_OPTIONS: process.env.ASAN_OPTIONS ?? 'detect_leaks=1:halt_on_error=1:abort_on_error=1',
      UBSAN_OPTIONS: process.env.UBSAN_OPTIONS ?? 'halt_on_error=1:print_stacktrace=1' };
    const result = run(`./${executable}`, [String(options.seed), String(options.seeds)], { env: environment, timeout: 30000 });
    writeFileSync(join(directory, 'last-run.log'), result.stderr);
    report.native = { ...JSON.parse(result.stdout), fingerprint: key, compilers, asanRuntime,
      sanitizers: ['address', 'undefined'], language: 'C11' };
    console.log(`Native C11 fuzz (ASan + UBSan): ${report.native.seeds} seeds, ${report.native.assertions} assertions`);
  }
  writeFileSync('build/fuzz-report.json', JSON.stringify(report, null, 2) + '\n');
  rmSync('build/fuzz-failure.json', { force: true });
} catch (error) {
  const matches = [...(error.stderr ?? '').matchAll(/FUZZ seed=(\d+) stage=([^\n]+)/g)];
  const last = matches.at(-1), failedSeed = error.seed ?? (last ? Number(last[1]) : options.seed);
  const failure = { mode, seed: failedSeed, stage: error.stage ?? last?.[2],
    replay: `node scripts/fuzz.mjs --${mode.startsWith('native') ? 'native' : 'js'}-only --seed ${failedSeed} --seeds 1`,
    error: error.stack, stderr: error.stderr };
  writeFileSync('build/fuzz-failure.json', JSON.stringify(failure, null, 2) + '\n');
  console.error(`${failure.replay}\nFailure saved to build/fuzz-failure.json`);
  throw error;
}
