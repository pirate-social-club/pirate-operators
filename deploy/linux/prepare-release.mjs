#!/usr/bin/env node
/** Artifact producer for a fresh context. Never a Docker build-time source build. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, realpath, lstat, copyFile, chmod } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { artifactAssetSha256, readOwningGitSource } from './release-inputs.ts';
const run = promisify(execFile), own = dirname(fileURLToPath(import.meta.url));
const [sourceInput, profilePath, nativeBinary, outputInput] = process.argv.slice(2);
assert(sourceInput && profilePath && nativeBinary && outputInput && process.argv.length === 6);
const root = await realpath(sourceInput); assert.equal(root, sourceInput);
assert.equal(await realpath(own), join(root, 'deploy/linux'), 'Producer must run from the admitted source');
const output = join(await realpath(dirname(outputInput)), outputInput.split('/').at(-1));
assert.equal(output, outputInput); assert(!output.startsWith(root + '/'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const regular = async (path) => { const s = await lstat(path); assert(s.isFile() && s.nlink === 1); return readFile(path); };
const { head, tree } = await readOwningGitSource(root);
const { buildCommunityArtifacts, communityBuildEnvironment } = await import(pathToFileURL(join(root, 'harness/community-artifacts.ts')).href);
const { validateCommunityDeploymentProfile } = await import(pathToFileURL(join(root, 'services/community-deployment-profile.ts')).href);
await communityBuildEnvironment();
const profileBytes = await regular(profilePath);
const profile = validateCommunityDeploymentProfile(JSON.parse(profileBytes));
const selectors = { rewards: false, ownerPublishing: false, v4: false, rewardClosure: false, media: false, dance: false };
const artifact = await buildCommunityArtifacts({ sourceRoot: root, assetDirectory: 'apps/web/dist/live', target: 'linux', migrations: selectors });
assert.equal(artifact.entrypoint, 'services/linux-community.ts');
const native = await regular(nativeBinary);
assert.equal(sha(native), '620d9f7e5eb461067e08af17316aaa087445b4232e0e98e3dd146763bd9ab394');
const pins = JSON.parse(await readFile(join(own, 'backend-pins.json'), 'utf8'));
const producerSources = {};
for (const file of ['prepare-release.mjs', 'release-inputs.ts', 'split-migrations.py', 'backend-pins.json', 'Dockerfile',
  'launch.mjs', 'render-config.mjs', 'assets.worker.mjs', 'maintenance.worker.mjs',
  'UPSTREAM-LICENSE-MIT', 'WORKERD-LICENSE'])
  producerSources['deploy/linux/' + file] = sha(await regular(join(own, file)));
const modules = {}, bytes = {};
for (const [file, row] of Object.entries(pins.modules)) {
  bytes[file] = await regular(join(root, 'node_modules/miniflare/dist/src/workers', row.path));
  assert.equal(sha(bytes[file]), row.sha256); modules[file] = row.sha256;
}
const runtimeFiles = ['launch.mjs', 'render-config.mjs', 'assets.worker.mjs', 'maintenance.worker.mjs'];
const runtime = {};
for (const file of runtimeFiles) { bytes[file] = await regular(join(own, file)); runtime[file] = sha(bytes[file]); }
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2' };
const assets = {};
for (const [file, artifactDigest] of Object.entries(artifact.assets)) {
  const expectedSha256 = artifactAssetSha256(artifactDigest);
  const body = await regular(join(root, 'apps/web/dist/live', file)); assert.equal(sha(body), expectedSha256);
  assets[file] = { sha256: expectedSha256, contentType: mime[extname(file)] ?? 'application/octet-stream' };
}
const migrationRoot = join(root, 'apps/community-wizard/infra/migrations');
const split = await run('/usr/bin/python3', ['-B', join(own, 'split-migrations.py'), migrationRoot, JSON.stringify(artifact.migrations)],
  { maxBuffer: 4 * 1024 * 1024, timeout: 10000 });
const migrations = JSON.parse(split.stdout);
assert.deepEqual(migrations.map((x) => x.name), artifact.migrations);
for (const row of migrations) assert.equal(sha(await regular(join(migrationRoot, row.name))), row.sha256);
const identity = { schema: 'pirate.linux-release-identity/1', qualificationOnly: true, head, tree, profile,
  selectors, entrypoint: artifact.entrypoint, workerSha256: artifact.bundleSha256, assets,
  migrations: migrations.map(({ name, sha256 }) => ({ name, sha256 })), backend: pins, runtime,
  nativeWorkerdSha256: sha(native), imageBase: pins.imageBase, producerSources };
const releaseId = sha(JSON.stringify(identity));
await mkdir(output, { mode: 0o700 }); await mkdir(join(output, 'runtime')); await mkdir(join(output, 'release'));
const files = {};
async function save(relative, body) {
  const target = join(output, 'release', relative); await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body, { flag: 'wx', mode: 0o444 }); files[relative] = sha(body);
}
await save('application.mjs', artifact.bytes);
await save('migration-plan.json', JSON.stringify({ schema: 'pirate.linux-migration-plan/1', qualificationOnly: true,
  releaseSha256: releaseId, migrations }));
await save('asset-index.json', JSON.stringify(assets));
for (const row of migrations) await save('sql/' + row.name, await regular(join(migrationRoot, row.name)));
for (const file of Object.keys(artifact.assets)) {
  const body = await regular(join(root, 'apps/web/dist/live', file));
  assert.equal(sha(body), assets[file].sha256); await save('assets/' + file, body);
}
for (const file of Object.keys(modules)) await save(file, bytes[file]);
const license = await regular(join(own, 'UPSTREAM-LICENSE-MIT'));
assert.equal(sha(license), pins.backendLicenseSha256);
await save('UPSTREAM-LICENSE-MIT', license);
const nativeLicense = await regular(join(own, 'WORKERD-LICENSE'));
assert.equal(sha(nativeLicense), pins.workerdLicenseSha256);
await save('WORKERD-LICENSE', nativeLicense);
for (const file of runtimeFiles) await writeFile(join(output, 'runtime', file), bytes[file], { flag: 'wx', mode: 0o444 });
await writeFile(join(output, 'workerd'), native, { flag: 'wx', mode: 0o555 });
await copyFile(join(own, 'Dockerfile'), join(output, 'Dockerfile')); await chmod(join(output, 'Dockerfile'), 0o444);
await writeFile(join(output, 'release/release-manifest.json'), JSON.stringify({ schema: 'pirate.linux-release/1',
  releaseId, identity, files, sourcePaths: [...new Set([...artifact.sourcePaths, ...Object.keys(producerSources)])].sort(),
  sourceHashes: { ...artifact.sourceHashes, ...producerSources } }, null, 2) + '\n',
  { flag: 'wx', mode: 0o444 });
assert.deepEqual(await readOwningGitSource(root), { head, tree });
for (const [relative, digest] of Object.entries({ ...artifact.sourceHashes, ...producerSources }))
  assert.equal(sha(await regular(join(root, relative))), digest.replace(/^0x/, ''), relative);
assert.equal(sha(await regular(nativeBinary)), sha(native));
for (const [file, row] of Object.entries(pins.modules))
  assert.equal(sha(await regular(join(root, 'node_modules/miniflare/dist/src/workers', row.path))), row.sha256, file);
assert.deepEqual(await regular(profilePath), profileBytes);
console.log(JSON.stringify({ sourceHead: head, releaseId, output, workerSha256: artifact.bundleSha256,
  assets: Object.keys(assets).length, migrations: artifact.migrations, qualificationOnly: true, dockerExecuted: false }));
