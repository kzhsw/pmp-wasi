// Run unchanged tests from the pinned PMP checkout against both the original
// implementation and this port's adapted native sources. This is a host test:
// it does not execute the Wasm binary or certify the C/JS bindings.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { verifyVendor } from './vendor.mjs';

const root = resolve(import.meta.dirname, '..');
process.chdir(root);
assert.equal(process.argv.length, 2, 'This runner accepts no command-line arguments');
assert(process.env.PMP_UPSTREAM_PATH, 'Set PMP_UPSTREAM_PATH to the existing pinned PMP checkout');
const upstream = resolve(process.env.PMP_UPSTREAM_PATH);
const pin = JSON.parse(readFileSync('upstream.json', 'utf8'));
const compiler = process.env.CXX ?? 'clang++';
const jobs = Number(process.env.UPSTREAM_TEST_JOBS ?? 2);
assert(Number.isInteger(jobs) && jobs >= 1 && jobs <= 32, 'UPSTREAM_TEST_JOBS must be 1..32');
const output = resolve('build/upstream-tests');
mkdirSync(output, { recursive: true });

const capture = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout.trim();
};
const git = ['-c', 'core.filemode=false', '-C', upstream];
const gtestRelative = 'external/googletest-1.18.0/googletest';
function verifyUpstream() {
  assert.equal(capture('git', [...git, 'rev-parse', 'HEAD']), pin.pmp.revision, 'Unexpected upstream revision');
  capture('git', [...git, 'diff', '--quiet', 'HEAD', '--',
    'src/pmp', 'tests', gtestRelative, pin.eigen.includeDirectory]);
}
verifyUpstream();
verifyVendor();
const manifestBytes = readFileSync('vendor/manifest.json');
const manifest = JSON.parse(manifestBytes);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of manifest.pmp)
  if (file.original)
    assert.equal(digest(readFileSync(join(upstream, 'src', file.path))), file.original,
      `Modified upstream ${file.path}`);

// Complete files are compiled, with every test enabled. The selected upstream
// tests contain no EXPECT_THROW/ASSERT_THROW, so trap behavior needs no override.
const algorithms = ['decimation', 'remeshing', 'subdivision', 'smoothing', 'hole_filling',
  'triangulation', 'utilities', 'differential_geometry', 'curvature', 'fairing'];
const dependencies = ['normals', 'features', 'numerics', 'laplace', 'distance_point_triangle', 'eigen',
  'surface_mesh', 'iterator'];
const testFiles = [...algorithms, ...dependencies].map(name => `tests/${name}_test.cpp`);
const expected = testFiles.flatMap(path => {
  const source = readFileSync(join(upstream, path), 'utf8');
  assert(!/\b(?:EXPECT|ASSERT)_THROW\s*\(/.test(source), `Review exception assertions in ${path}`);
  return [...source.matchAll(/^TEST(?:_F)?\(\s*(\w+)\s*,\s*(\w+)\s*\)/gm)]
    .map(match => `${match[1]}.${match[2]}`);
}).sort();
assert.equal(expected.length, 97, 'Review test scope after updating the pinned checkout');
const production = ['surface_mesh.cpp', ...['normals', 'features', 'decimation', 'subdivision',
  'distance_point_triangle', 'remeshing', 'curvature', 'smoothing', 'laplace', 'numerics',
  'differential_geometry', 'fairing', 'hole_filling', 'triangulation', 'utilities']
  .map(name => `algorithms/${name}.cpp`)];
const support = ['tests/helpers.cpp', 'src/pmp/algorithms/shapes.cpp'];
const allowedFallback = new Set(['algorithms/shapes.cpp', 'algorithms/shapes.h',
  'io/io.h', 'io/io_flags.h']);
const gtest = join(upstream, gtestRelative);
const gtestSources = ['src/gtest-all.cc', 'src/gtest_main.cc'].map(path => join(gtest, path));
const commonFlags = ['-std=c++20', '-O2', '-DNDEBUG', '-DEIGEN_DONT_PARALLELIZE', '-pthread'];
const environment = { ...process.env };
for (const key of Object.keys(environment))
  if (key.startsWith('GTEST_')) delete environment[key];

async function run(command, args, log, cwd = root) {
  const child = spawn(command, args, { cwd, env: environment, timeout: 600_000 });
  const chunks = [];
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => chunks.push(chunk));
  const result = await new Promise((accept, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => accept({ status, signal }));
  });
  const text = Buffer.concat(chunks).toString();
  writeFileSync(log, text);
  assert.equal(result.status, 0,
    `${command} failed (${result.status ?? result.signal}); see ${relative(root, log)}\n${text}`);
}

// -MMD output proves that the adapted build uses vendor PMP, including from
// unchanged upstream helper sources. Only the support declarations above may
// resolve into the reference tree. No IO implementation is linked in either mode.
function auditDependencies(path) {
  const tokens = readFileSync(path, 'utf8').replace(/\\\r?\n/g, ' ')
    .match(/(?:\\.|[^\s])+/g).slice(1).map(token => token.replace(/\\(.)/g, '$1'));
  for (const dependency of tokens) {
    const prefix = join(upstream, 'src/pmp') + '/';
    if (dependency.startsWith(prefix))
      assert(allowedFallback.has(dependency.slice(prefix.length)),
        `Adapted build unexpectedly uses upstream implementation: ${dependency}`);
  }
}

const results = [];
for (const mode of ['reference', 'adapted']) {
  const directory = join(output, mode);
  mkdirSync(directory, { recursive: true });
  const implementation = mode === 'adapted' ? resolve('vendor/pmp') : join(upstream, 'src/pmp');
  const flags = [...commonFlags,
    ...(mode === 'adapted' ? ['-fno-exceptions', '-fno-rtti', '-I' + resolve('vendor')] : []),
    '-I' + join(upstream, 'src'), '-I' + join(gtest, 'include'), '-I' + gtest,
    '-isystem', mode === 'adapted' ? resolve('vendor/eigen') : join(upstream, pin.eigen.includeDirectory)];
  const sources = [...production.map(path => join(implementation, path)),
    ...support.map(path => join(upstream, path)), ...testFiles.map(path => join(upstream, path)),
    ...gtestSources];
  const objects = sources.map((_, i) => join(directory, `${i}.o`));
  console.log(`[${mode}] Compiling ${sources.length} host translation units (${jobs} jobs)`);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: jobs }, async () => {
    while (!failed && next < sources.length) {
      const index = next++;
      try {
        const dependency = join(directory, `${index}.d`);
        await run(compiler, [...flags, '-MMD', '-MF', dependency,
          '-c', sources[index], '-o', objects[index]], join(directory, `${index}.log`));
        if (mode === 'adapted') auditDependencies(dependency);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  const completed = await Promise.allSettled(workers);
  const failure = completed.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const executable = join(directory, 'runner');
  await run(compiler, ['-pthread', ...objects, '-o', executable], join(directory, 'link.log'));
  const json = join(directory, 'gtest.json');
  await run(executable, ['--gtest_filter=*', '--gtest_repeat=1', '--gtest_shuffle=0',
    '--gtest_output=json:' + json], join(directory, 'run.log'), directory);
  const report = JSON.parse(readFileSync(json, 'utf8'));
  const cases = report.testsuites.flatMap(suite => suite.testsuite.map(test => ({
    name: `${suite.name}.${test.name}`, status: test.status, result: test.result,
  })));
  assert.equal(report.failures, 0);
  assert.equal(report.disabled, 0);
  assert.deepEqual(cases.map(test => test.name).sort(), expected, 'Test scope was filtered or changed');
  assert(cases.every(test => test.status === 'RUN' && test.result === 'COMPLETED'), 'Tests were skipped');
  results.push({ mode, tests: report.tests, failures: report.failures, flags,
    executableSha256: digest(readFileSync(executable)),
    implementationSources: production.map(path => relative(root, join(implementation, path))),
    report: relative(root, json), log: relative(root, join(directory, 'run.log')) });
  console.log(`[${mode}] ${report.tests} unchanged upstream tests passed`);
}

// Reject a concurrent source update rather than combining two vendor snapshots.
verifyUpstream();
verifyVendor();
assert.equal(digest(readFileSync('vendor/manifest.json')), digest(manifestBytes), 'Vendor changed during the run');
const allTests = readdirSync(join(upstream, 'tests')).filter(name => name.endsWith('_test.cpp'));
const excluded = {
  'analysis_test.cpp': 'Analysis API is outside the implemented export scope.',
  'geodesics_test.cpp': 'Geodesics API is outside the implemented export scope.',
  'parameterization_test.cpp': 'Parameterization API is outside the implemented export scope.',
  'io_test.cpp': 'Host file IO is deliberately excluded from the production port.',
  'shapes_test.cpp': 'Shape generators are unchanged host-only fixture support.',
  'regression_test.cpp': 'Optional upstream regression suite also requires analysis and host IO; disabled by upstream default.',
};
for (const file of allTests)
  assert(testFiles.includes(`tests/${file}`) || excluded[file], `Unreviewed upstream test file: ${file}`);
const report = {
  kind: 'native-upstream-suite', upstreamRevision: pin.pmp.revision,
  compiler: capture(compiler, ['--version']).split('\n')[0],
  target: capture(compiler, ['-dumpmachine']), vendorManifestSha256: digest(manifestBytes),
  testFiles, tests: expected, exclusions: excluded, excludedCasesWithinSelectedFiles: [],
  hostOnlySupport: support, allowedAdaptedUpstreamFallback: [...allowedFallback],
  sourceSha256: Object.fromEntries([...testFiles, ...support].map(path =>
    [path, digest(readFileSync(join(upstream, path)))])),
  limitations: ['Runs original and adapted C++ implementations on the host, not Wasm or C/JS bindings.',
    'Includes internal native utilities beyond exported Wasm entry points; does not mark those APIs implemented.',
    'Selected original suites exercise successful calls; Wasm trap/preflight cases belong to the separate JS suites.'],
  results,
};
const reportPath = join(output, 'report.json');
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`Scope and results: ${relative(root, reportPath)}`);
