// Relink the same verified LTO objects to isolate export groups' retained cost.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from './build.mjs';

process.chdir(resolve(import.meta.dirname, '..'));
const groups = {
  triangulation: ['pmp_triangulate', 'pmp_triangulate_face'],
  components: ['pmp_connected_components'],
  measurements: ['pmp_bounds', 'pmp_surface_area', 'pmp_volume', 'pmp_centroid',
    'pmp_mean_edge_length', 'pmp_min_edge_length', 'pmp_min_face_area'],
  curvature: ['pmp_curvature'],
  fairing: ['pmp_fair', 'pmp_minimize_area', 'pmp_minimize_curvature'],
};
const exports = JSON.parse(readFileSync('exports/core.json'));
const additions = Object.values(groups).flat();
assert.equal(additions.length, 14);
assert(additions.every(name => exports.includes(name)));
const baseline = exports.filter(name => !additions.includes(name));
const full = JSON.parse(readFileSync('build/report.json'));
mkdirSync('build/size', { recursive: true });
const reports = [];
for (const [name, added] of [['baseline', []], ...Object.entries(groups), ['all', additions]]) {
  const report = build({ directory: `build/size/${name}`, objectDirectory: 'build',
    exports: name === 'all' ? exports : [...baseline, ...added], quiet: true });
  const base = reports[0] || report;
  const result = { name, bytes: report.bytes, gzipBytes: report.gzipBytes,
    deltaBytes: report.bytes - base.bytes, deltaGzipBytes: report.gzipBytes - base.gzipBytes,
    sha256: report.sha256, exports: report.exports };
  reports.push(result);
  console.log(JSON.stringify(result));
}
assert.equal(reports[reports.length - 1].sha256, full.sha256,
  'Full relink differs from the production artifact');
writeFileSync('build/size/report.json', JSON.stringify({ toolchain: full.toolchain,
  note: 'Each group is added independently to the same current-source baseline. Deltas are not additive: LTO and gzip share code/data. Includes validation and attribute transfer. Compare historical release sizes separately.',
  groups, reports }, null, 2) + '\n');
