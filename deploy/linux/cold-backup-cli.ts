#!/usr/bin/env node
// Local operator CLI only. No HTTP listener or new wizard/public port.
// Future execution requires separate Root runtime/provider authorization.
import assert from "node:assert/strict";
import { readSync } from "node:fs";
import { privateFile, hash, rawDigest, acquireOperation, processIdentity } from "./backend-state.ts";
import { createColdWriterFence, type ColdWriterPlan } from "./cold-writer-fence.ts";
import { createMaintenanceGuard } from "./maintenance-guard.ts";
import { createColdBackupFromFd, restoreColdBackupFromFd, type ColdRecoveryDescriptor } from "./cold-backup-operation.ts";
import { exportEncryptedBackup, importEncryptedBackup } from "./backup-transport.ts";
import type { CohortIdentity } from "./cohort-manifest.ts";
import { readRetainedOperation } from "./retained-operation-readback.ts";

const args = process.argv.slice(2);
assert(args.length === 7 && args[0] === "--request" && args[2] === "--grant" &&
  args[4] === "--grant-sha256" && args[6] === "--execute", "cold_cli_exact_arguments_required");
async function document(path: string) {
  const file = await privateFile(path, 1048576);
  try { const bytes = await file.readFile(); return { bytes, value: JSON.parse(bytes.toString("utf8")) }; }
  finally { await file.close(); }
}
const grant = await document(args[3]!); assert.equal(hash(grant.bytes), args[5]);
const request = await document(args[1]!), config = request.value;
assert(grant.value.schema === "pirate.local-cold-operation-grant/1" && grant.value.requestSha256 === hash(request.bytes) &&
  grant.value.admission === true && grant.value.status === "ADMITTED_LOCAL_BACKUP_ONCE" &&
  grant.value.expiresAt > Date.now() && grant.value.installationId === config.installationId &&
  grant.value.operationId === config.operationId && grant.value.uid === process.getuid!(), "cold_cli_authorization_mismatch");
assert(config.version === 1 && ["create", "export", "import", "restore", "reconcile-local"].includes(config.action));
assert(grant.value.allowedActions.includes(config.action) && rawDigest(config.installationId));
const native = await processIdentity(process.pid);
assert(native && native.pidNamespace === grant.value.hostPidNamespace && native.networkNamespace === grant.value.networkNamespace,
  "cold_cli_native_host_frame_unproved");
// A complete exact code/tool forest must be bound by the admitting caller.
assert(Array.isArray(grant.value.inputPins) && grant.value.inputPins.length > 0, "cold_cli_input_forest_required");
for (const pin of grant.value.inputPins as Array<{ path: string; sha256: string }>) {
  const fs = await import("node:fs/promises");
  const info = await fs.lstat(pin.path); assert(info.isFile() && !info.isSymbolicLink());
  assert.equal(hash(await fs.readFile(pin.path)), pin.sha256, "cold_cli_input_changed");
}
const lease = await acquireOperation(config.operationDirectory, config.operationId, config.installationId,
  { requestPath: args[1], requestSha256: hash(request.bytes), grantPath: args[3], grantSha256: hash(grant.bytes), action: config.action }, grant.value.hostPidNamespace);
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort(new Error("operator_cancelled")));
process.once("SIGINT", () => controller.abort(new Error("operator_cancelled")));
const context = { lease, node: config.node, nodeSha256: config.nodeSha256, codecCli: config.codecCli,
  codecCliSha256: config.codecCliSha256, outputDirectory: config.outputDirectory,
  environment: config.environment, cwd: config.cwd, signal: controller.signal,
  authorize: async (_action: "cold-create" | "cold-restore", installationId: string) => {
    await lease.assertHeld(); assert.equal(installationId, grant.value.installationId);
    assert(grant.value.expiresAt > Date.now() && !controller.signal.aborted);
  } };
async function providerAuthority() {
  await lease.assertHeld(); assert(grant.value.providerEffects === true && grant.value.expiresAt > Date.now());
}
function managedTransportCredentials() {
  const material = Buffer.alloc(8193); let size = 0;
  try {
    while (size < material.length) {
      const n = readSync(4, material, size, material.length - size, null); if (n === 0) break; size += n;
    }
    assert(size > 0 && size <= 8192, "backup_managed_credentials_size");
    return JSON.parse(material.subarray(0, size).toString("utf8"));
  } finally { material.fill(0); }
}
let failure: unknown;
try {
  if (config.action === "reconcile-local") {
    const value = await readRetainedOperation({ originalDirectory: config.originalOperationDirectory,
      operationId: config.operationId, installationId: config.installationId,
      expectedIntentDigest: config.originalIntentDigest, observationLease: lease });
    await lease.record("cold-cli-result", value);
  } else if (config.action === "create") {
    const maintenance = await createMaintenanceGuard(config.maintenanceDirectory, lease);
    const fence = await createColdWriterFence({ lease, plan: config.writerPlan as ColdWriterPlan,
      inventoryFile: config.writerInventoryFile, executable: config.docker, executableSha256: config.dockerSha256,
      socket: config.dockerSocket, privateDockerConfig: config.privateDockerConfig,
      outputDirectory: config.outputDirectory, cwd: config.cwd, environment: config.environment,
      signal: controller.signal, controller: maintenance });
    const value = await createColdBackupFromFd(context, { identity: config.archiveIdentity as CohortIdentity,
      roots: config.writerPlan.roots, output: config.archiveOutput, fence });
    await lease.record("cold-cli-result", value);
  } else if (config.action === "restore") {
    const value = await restoreColdBackupFromFd(context, { backup: config.backup as ColdRecoveryDescriptor,
      localCiphertext: config.localCiphertext, stagingDirectory: config.stagingDirectory, target: config.freshTarget });
    await lease.record("cold-cli-result", value);
  } else {
    const credentials = managedTransportCredentials();
    const value = config.action === "export" ? await exportEncryptedBackup({ lease,
      receipt: config.backup, profile: config.storageProfile, credentials, signal: controller.signal, ticketDirectory: config.outputDirectory,
      authorizeProviderWrite: providerAuthority }) : await importEncryptedBackup({ lease, key: config.objectKey,
      archiveSha256: config.backup.archiveSha256, encryptedBytes: config.backup.encryptedBytes,
      destination: config.localCiphertext, destinationDirectory: config.localCiphertextDirectory,
      profile: config.storageProfile, credentials, signal: controller.signal, authorizeProviderRead: providerAuthority });
    await lease.record("cold-cli-result", value);
  }
} catch (error) {
  failure = error; await lease.record("cold-cli-failure", { type: error instanceof Error ? error.name : "unknown",
    correction: "Preserve this original operation, maintenance guard, raw evidence and partial bytes; reconcile before retrying." });
} finally {
  let postguard = true;
  try {
    for (const pin of grant.value.inputPins as Array<{ path: string; sha256: string }>) {
      const fs = await import("node:fs/promises"); assert.equal(hash(await fs.readFile(pin.path)), pin.sha256);
    }
  } catch (error) { postguard = false; failure ??= error; }
  // No lease/fence release or restart based on an empty list/outcome text.
  // Actual domain reconciliation, application health and independent custody
  // must precede the owning lifecycle's eventual release.
  await lease.record("cold-cli-terminal", { failed: failure !== undefined, cancelled: controller.signal.aborted,
    postguard, maintenanceMayBeHeld: true, operationLeaseRetained: true, applicationReadiness: "UNPROVED" });
}
if (failure !== undefined) process.exitCode = 1;
