// Development experiments only. Production defaults change only after review.
// Run upstream, native sanitizer, JS fuzz and browser gates before this pass.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { build } from './build.mjs';
import { runScenario } from '../test/e2e/scenario.mjs';
import { runAlgorithms } from '../test/e2e/algorithms.mjs';
import { runExtensions } from '../test/e2e/extensions.mjs';
import { runFuzz } from '../test/fuzz-js.mjs';

process.chdir(resolve(import.meta.dirname, '..'));
const arguments_ = process.argv.slice(2);
assert(arguments_.length <= 1 && arguments_.every(value => ['--build', '--bench'].includes(value)),
  'Usage: node scripts/tune.mjs [--build|--bench]');
const directory = 'build/tuning';
mkdirSync(directory, { recursive: true });
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const exports = read('exports/core.json');
const fixtures = ['core', 'algorithms', 'extensions'].map(name => read(`test/fixtures/native-${name}.json`));
// No fast-math, precision reductions, SIMD, or newer Wasm features.
const candidates = [
  { name: 'baseline', objectDirectory: 'build' },
  { name: 'clang-o2', compileOpt: '-O2' },
  { name: 'clang-os', compileOpt: '-Os' },
  { name: 'clang-oz', compileOpt: '-Oz' },
  { name: 'lto-o2', objectDirectory: 'build', linkOpt: 2 },
  { name: 'lto-codegen3', objectDirectory: 'build', codegenOpt: 3 },
  { name: 'binaryen-o4', objectDirectory: 'build', optimize: ['-O4'] },
  { name: 'binaryen-os', objectDirectory: 'build', optimize: ['-Os'] },
  { name: 'binaryen-oz', objectDirectory: 'build', optimize: ['-Oz'] },
  { name: 'binaryen-converge', objectDirectory: 'build', optimize: ['-O3', '--converge'] },
];
const reportPath = `${directory}/report.json`;
if (arguments_[0] !== '--bench') {
  const report = { candidates: [], note: 'Each candidate passes exact import/export/feature audits, all shared workflows, and 32 JS/Wasm fuzz seeds. Timing is a separate step so compiler CPU load does not distort measurements.' };
  for (const { name, ...options } of candidates) {
    console.log(`Building and validating ${name}`);
    const output = `${directory}/${name}`;
    const buildReport = build({ ...options, directory: output, quiet: true });
    const bytes = readFileSync(`${output}/pmp-core.wasm`);
    const module = new WebAssembly.Module(bytes);
    const results = [await runScenario(module, fixtures[0], exports),
      await runAlgorithms(module, fixtures[1]), await runExtensions(module, fixtures[2])];
    const fuzz = await runFuzz(module, { seed: 0x504d5000, seeds: 32 });
    report.candidates.push({ name, ...buildReport,
      workflows: results.reduce((sum, result) => sum + result.cases.length, 0),
      assertions: results.reduce((sum, result) => sum + result.assertions, 0),
      fuzz: { seed: fuzz.seed, seeds: fuzz.seeds, assertions: fuzz.assertions },
      artifactSha256: createHash('sha256').update(bytes).digest('hex') });
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`${name}: ${buildReport.bytes} bytes / ${buildReport.gzipBytes} gzip; validation passed`);
  }
}
if (arguments_[0] !== '--build') {
  const report = read(reportPath);
  assert.equal(report.candidates.length, candidates.length, 'Finish all candidate validations before timing');
  for (const candidate of report.candidates) {
    const path = `${directory}/${candidate.name}/pmp-core.wasm`;
    assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), candidate.artifactSha256);
  }
  const paths = candidates.map(({ name }) => `${directory}/${name}/pmp-core.wasm`);
  for (const repeat of [1, 2]) {
    const result = spawnSync(process.execPath, ['scripts/bench.mjs', ...paths],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr);
    JSON.parse(result.stdout);
    writeFileSync(`${directory}/node-${repeat}.json`, result.stdout);
    console.log(`Alternating Node benchmark ${repeat} complete`);
  }
}
