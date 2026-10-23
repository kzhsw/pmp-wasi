import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function verifyVendor() {
  const manifest = JSON.parse(readFileSync('vendor/manifest.json', 'utf8'));
  const paths = [];
  function pmpFiles(directory) {
    for (const entry of readdirSync(join('vendor', directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pmpFiles(path);
      else { assert(entry.isFile(), 'Vendor tree must contain regular files'); paths.push(path); }
    }
  }
  pmpFiles('pmp');
  assert.deepEqual(paths.sort(), [...manifest.pmp.map(file => file.path), 'pmp/LICENSE.txt'].sort(), 'Unexpected PMP source files');
  assert.equal(digest(readFileSync('vendor/pmp/LICENSE.txt')), manifest.pmpLicense, 'Changed PMP license');
  for (const file of manifest.pmp)
    assert.equal(digest(readFileSync(join('vendor', file.path))), file.adapted, `Changed vendor/${file.path}`);
  const files = [];
  function walk(relative) {
    for (const entry of readdirSync(join('vendor/eigen', relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else { assert(entry.isFile(), 'Vendor tree must contain regular files'); files.push(path); }
    }
  }
  walk('');
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(path + '\0').update(readFileSync(join('vendor/eigen', path)));
  assert.equal(files.length, manifest.eigen.files);
  assert.equal(hash.digest('hex'), manifest.eigen.sha256, 'Changed Eigen source tree');
}
