#!/usr/bin/env node
// Run only inside an admitted local operation with an outer watchdog. The key
// arrives through a dedicated inherited fd, never argv, environment or JSON.
import assert from "node:assert/strict";
import { readSync } from "node:fs";
import { captureSnapshot, exactKeys, regular, validateIdentity } from "./cohort-manifest.ts";
import { restoreSnapshot, sealSnapshot } from "./cohort-archive.ts";

const [action, requestPath, keyFd] = process.argv.slice(2);
assert(process.argv.length === 5 && ["seal", "restore"].includes(action!) &&
  requestPath && keyFd === "--key-fd=3", "cohort_cli_arguments_invalid");
const requestFile = await regular(requestPath);
let request: unknown;
try {
  const s = await requestFile.stat();
  assert(s.size <= 64 * 1024 && (s.mode & 0o077) === 0, "cohort_request_not_private");
  request = JSON.parse(await requestFile.readFile("utf8"));
} finally { await requestFile.close(); }
const key = Buffer.alloc(33); let length = 0;
try {
  // The supplying process must close its write side; the outer watchdog also
  // bounds malformed/stalled input. An extra byte is refused, never ignored.
  while (length < key.length) {
    const bytes = readSync(3, key, length, key.length - length, null);
    if (bytes === 0) break; length += bytes;
  }
  assert.equal(length, 32, "cohort_key_size");
  if (action === "seal") {
    exactKeys(request, ["version", "identity", "roots", "output"]);
    assert.equal(request.version, 1); validateIdentity(request.identity);
    assert(request.roots !== null && typeof request.roots === "object" &&
      !Array.isArray(request.roots) && Object.values(request.roots).every((value) => typeof value === "string"), "cohort_roots_invalid");
    assert(typeof request.output === "string", "cohort_output_invalid");
    const snapshot = await captureSnapshot(request.identity, request.roots as Record<string, string>);
    console.log(JSON.stringify(await sealSnapshot({ snapshot, key: key.subarray(0, 32), output: request.output })));
  } else {
    exactKeys(request, ["version", "archive", "archiveSha256", "expectedIdentity", "expectedRoles", "stagingDirectory", "target"]);
    assert.equal(request.version, 1); validateIdentity(request.expectedIdentity);
    assert([request.archive, request.archiveSha256, request.stagingDirectory, request.target]
      .every((value) => typeof value === "string") && Array.isArray(request.expectedRoles) &&
      request.expectedRoles.every((value) => typeof value === "string"), "cohort_restore_request_invalid");
    console.log(JSON.stringify(await restoreSnapshot({
      archive: request.archive as string, archiveSha256: request.archiveSha256 as string,
      expectedIdentity: request.expectedIdentity, expectedRoles: request.expectedRoles as string[],
      stagingDirectory: request.stagingDirectory as string, target: request.target as string,
      key: key.subarray(0, 32),
    })));
  }
} finally { key.fill(0); }
