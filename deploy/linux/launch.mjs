#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { renderConfig } from './render-config.mjs';
const mode = process.argv[2]; assert(['initialize', 'serve'].includes(mode) && process.argv.length === 3);
const release = '/opt/pirate/release', state = '/var/lib/pirate';
const sha = (body) => createHash('sha256').update(body).digest('hex');
const regular = async (path) => { const s = await lstat(path); assert(s.isFile() && !s.isSymbolicLink()); return readFile(path); };
const manifest = JSON.parse(await regular(release + '/release-manifest.json'));
assert.equal(manifest.schema, 'pirate.linux-release/1'); assert.equal(manifest.identity.qualificationOnly, true);
assert.equal(sha(JSON.stringify(manifest.identity)), manifest.releaseId);
assert.deepEqual(Object.keys(manifest.identity.selectors).sort(),
  ['rewards', 'ownerPublishing', 'v4', 'rewardClosure', 'media', 'dance'].sort());
assert(Object.values(manifest.identity.selectors).every((v) => v === false), 'Unsupported feature composition');
assert.equal(manifest.identity.entrypoint, 'services/linux-community.ts');
async function tree(path, prefix = '') {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name; assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) found.push(...await tree(path + '/' + entry.name, name + '/'));
    else { assert(entry.isFile()); found.push(name); }
  }
  return found;
}
assert.deepEqual((await tree(release)).sort(), [...Object.keys(manifest.files), 'release-manifest.json'].sort());
for (const [name, digest] of Object.entries(manifest.files)) {
  assert(!name.startsWith('/') && !name.split('/').includes('..'));
  assert.equal(sha(await regular(release + '/' + name)), digest, name);
}
for (const [name, digest] of Object.entries(manifest.identity.runtime))
  assert.equal(sha(await regular('/opt/pirate/runtime/' + name)), digest, name);
assert.equal(sha(await regular('/opt/pirate/workerd')), manifest.identity.nativeWorkerdSha256);
assert.equal(process.version, 'v24.18.1');
const s = await lstat(state); assert(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.getuid());
const marker = state + '/initialized-release.json';
try {
  await lstat(state + '/restore-fence.json');
  throw new Error('Restored state requires admitted identity, authority, revocation and pending-work reconciliation before serving');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (mode === 'initialize') {
  assert.deepEqual(await readdir(state), [], 'Fresh create refuses pre-existing state; restore needs its own reviewed admission');
  for (const name of ['d1', 'media']) await mkdir(state + '/' + name, { mode: 0o700 });
} else {
  const initialized = JSON.parse(await regular(marker));
  assert.equal(initialized.releaseId, manifest.releaseId); assert.equal(initialized.origin, manifest.identity.profile.origin);
  assert.equal(initialized.communityId, manifest.identity.profile.directoryProfile.communityId);
}
await mkdir('/tmp/pirate', { mode: 0o700 });
const migrationPlan = (await regular(release + '/migration-plan.json')).toString('utf8');
const assetIndex = (await regular(release + '/asset-index.json')).toString('utf8');
const config = renderConfig(manifest, mode, migrationPlan, assetIndex);
await writeFile('/tmp/pirate/config.capnp', config, { flag: 'wx', mode: 0o600 });
const child = spawn('/opt/pirate/workerd', ['serve', '--experimental', '/tmp/pirate/config.capnp'],
  { cwd: release, env: { PATH: '/usr/bin:/bin', TZ: 'UTC' }, stdio: ['ignore', 'inherit', 'inherit'] });
const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
let stopRequested = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopRequested = true; child.kill(signal); });
console.log(JSON.stringify({ event: 'native-start', mode, pid: child.pid, releaseId: manifest.releaseId }));
if (mode === 'initialize') {
  try {
    const response = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 20000;
      const attempt = () => {
        const request = http.request({ socketPath: '/tmp/pirate/initialize.sock', path: '/initialize', method: 'POST', timeout: 5000 }, (res) => {
          let body = ''; res.on('data', (part) => { body += part; if (body.length > 65536) res.destroy(new Error('Initialization response too large')); });
          res.on('error', reject); res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
        });
        request.on('timeout', () => request.destroy(new Error('Initialization timeout')));
        request.on('error', (error) => { if (error.code === 'ENOENT' && Date.now() < deadline && !stopRequested) setTimeout(attempt, 50); else reject(error); });
        request.end();
      };
      attempt();
    });
    assert(response.initialized && response.releaseSha256 === manifest.releaseId && !stopRequested);
    child.kill('SIGTERM'); const exited = await result; assert.equal(exited.code, 0); assert.equal(exited.signal, null);
    await writeFile(marker, JSON.stringify({ releaseId: manifest.releaseId, origin: manifest.identity.profile.origin,
      communityId: manifest.identity.profile.directoryProfile.communityId, initialization: response }) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ event: 'initialized', releaseId: manifest.releaseId }));
  } catch (error) {
    child.kill('SIGTERM');
    const stopped = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
    if (stopped === null) {
      child.kill('SIGKILL');
      await Promise.race([result, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
    throw error;
  }
} else {
  const exited = await result;
  console.log(JSON.stringify({ event: 'native-exit', mode, ...exited, requestedStop: stopRequested }));
  if (exited.code !== 0 || exited.signal !== null || !stopRequested) process.exitCode = 1;
}
