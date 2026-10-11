import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';

// Review this exact list before adding anything to a distribution.
const releaseFiles = [
  '.gitattributes',
  '.gitignore',
  'LICENSE',
  'LICENSE-STATUS.md',
  'README.md',
  'RELEASE-MANIFEST.json',
  'demo/app.js',
  'demo/build-bundle.mjs',
  'demo/core.js',
  'demo/index.html',
  'demo/styles.css',
  'package-lock.json',
  'package.json',
  'scripts/verify-release.mjs',
  'src/caption-bridge.mjs',
  'src/plain-record-snapshot.mjs',
  'src/subtitle-controller.mjs',
  'src/timeline.mjs',
  'tests/demo.test.mjs',
  'tests/plain-record-snapshot.test.mjs',
  'tests/subtitle-controller.test.mjs',
].sort();
const manifestName = 'RELEASE-MANIFEST.json';
const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--write'),
  'usage: node scripts/verify-release.mjs [--write]');
const writeMode = args[0] === '--write';

async function inspectDirectory(relative = '') {
  const files = [];
  for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
    // Development metadata is never copied into the release allowlist.
    if (relative === '' && ['.git', 'node_modules'].includes(entry.name)) continue;
    const name = relative + entry.name;
    assert.ok(!entry.isSymbolicLink(), `symlinks are not release files: ${name}`);
    if (entry.isDirectory()) {
      assert.ok(releaseFiles.some((file) => file.startsWith(name + '/')),
        `unreviewed directory: ${name}`);
      files.push(...await inspectDirectory(name + '/'));
    }
    else {
      assert.ok(entry.isFile(), `not a regular release file: ${name}`);
      files.push(name);
    }
  }
  return files;
}

const actualFiles = (await inspectDirectory()).sort();
const requiredFiles = releaseFiles.filter((name) => !(writeMode && name === manifestName));
const missing = requiredFiles.filter((name) => !actualFiles.includes(name));
const unexpected = actualFiles.filter((name) => !releaseFiles.includes(name));
assert.deepEqual(missing, [], `missing release files: ${missing.join(', ')}`);
assert.deepEqual(unexpected, [], `unreviewed files: ${unexpected.join(', ')}`);

const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(pkg.private, true, 'npm publication must remain disabled');
assert.equal(pkg.license, 'MIT', 'the approved source license must be retained');
assert.equal(pkg.type, 'module');
assert.equal(pkg.engines?.node, '>=24');
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  assert.deepEqual(Object.keys(pkg[field] ?? {}), [], `unexpected ${field}`);
}
assert.deepEqual(pkg.files, releaseFiles, 'package files must match the exact release allowlist');
assert.deepEqual(pkg.scripts, {
  'build:demo': 'node demo/build-bundle.mjs',
  test: 'node --test tests/*.test.mjs',
  'verify:release': 'node scripts/verify-release.mjs',
  'refresh:manifest': 'node scripts/verify-release.mjs --write',
}, 'only reviewed local scripts are permitted');
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.deepEqual(Object.keys(lock.packages ?? {}), [''], 'lockfile must contain no external packages');
assert.equal(lock.packages[''].license, pkg.license);
assert.equal(lock.packages[''].version, pkg.version);

const files = [];
for (const path of releaseFiles.filter((name) => name !== manifestName)) {
  const data = await readFile(new URL(path, root));
  assert.ok(!data.includes(0), `binary data is not allowed: ${path}`);
  files.push({ path, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
const manifest = {
  schemaVersion: 1,
  packageName: pkg.name,
  packageVersion: pkg.version,
  publicationStatus: 'public-source-release; npm publication disabled',
  scope: 'Only the exact release allowlist; no repository history or local audit material.',
  selfExclusion: 'This manifest is allowlisted but does not hash itself. The Git commit identifies the complete release.',
  files,
};
const manifestUrl = new URL(manifestName, root);
if (writeMode) {
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${files.length} file hashes; ${releaseFiles.length} allowlisted files including the manifest.`);
} else {
  const saved = JSON.parse(await readFile(manifestUrl, 'utf8'));
  assert.deepEqual(saved, manifest, 'release contents differ from the reviewed manifest');
  console.log(`Verified ${releaseFiles.length} allowlisted files, hashes, zero package dependencies and publication guards.`);
}
