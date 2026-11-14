import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { runOwnedCommand } from "./backend-command.ts";
import { createJSON, hash, privateDirectory, privateFile, rawDigest, type OperationLease } from "./backend-state.ts";
import { readJSON, verifyCiphertext, withRecoveryKeyFd } from "./backup-staging.ts";
import type { CohortIdentity } from "./cohort-manifest.ts";

export interface ColdBackupReceipt {
  archiveSha256: string; manifestSha256: string; encryptedBytes: number;
  output: string; sourceMachineIdSha256: string; identity: CohortIdentity;
  roles: string[]; writerFenceSha256: string;
}
export type ColdRecoveryDescriptor = Omit<ColdBackupReceipt, "output">;
interface ColdContext {
  lease: OperationLease; node: string; nodeSha256: string; codecCli: string; codecCliSha256: string;
  outputDirectory: string; environment: NodeJS.ProcessEnv; cwd: string; signal: AbortSignal;
  // Operator/helper authorization is required from the installed secret owner.
  // There is no browser-controlled verified flag or default successful owner.
  authorize(action: "cold-create" | "cold-restore", installationId: string): Promise<void>;
}
const machineId = async () => {
  const bytes = await readFile("/etc/machine-id");
  assert((bytes.length === 32 || bytes.length === 33) && /^[a-f0-9]{32}\n?$/.test(bytes.toString("ascii")), "backup_host_identity_unavailable");
  return hash(bytes);
};
async function verifyCodec(context: ColdContext) {
  // Source is independently pinned, not selected from an untrusted request.
  const fs = await import("node:fs/promises");
  assert.equal(await fs.realpath(context.codecCli), context.codecCli);
  const file = await fs.open(context.codecCli, "r");
  try { assert.equal(createHash("sha256").update(await file.readFile()).digest("hex"), context.codecCliSha256); }
  finally { await file.close(); }
}
function separateFromRoots(path: string, roots: string[]) {
  assert(roots.every((root) => path !== root && !path.startsWith(root + "/") && !root.startsWith(path + "/")), "backup_output_inside_captured_state");
}

/** Actual stop/capture/encrypt/readback sequence. Uses the unchanged codec CLI
 * through inherited fd3; never claims a protocol factory is a usable backend. */
async function createColdBackup(context: ColdContext, input: {
  identity: CohortIdentity; roots: Record<string, string>; output: string; recoveryKey: Uint8Array;
  fence: { enter(): Promise<{ relativePath: string; sha256: string }>; assertCold(): Promise<unknown> };
}) {
  await context.lease.assertHeld(); await context.authorize("cold-create", context.lease.installationId);
  assert(!context.signal.aborted && input.recoveryKey.byteLength === 32);
  await privateDirectory(context.outputDirectory); await privateDirectory(dirname(input.output)); await verifyCodec(context);
  for (const path of [context.outputDirectory, dirname(input.output)]) separateFromRoots(path, Object.values(input.roots));
  const fence = await input.fence.enter(); assert(rawDigest(fence.sha256));
  const identity = { ...structuredClone(input.identity), writerFenceSha256: fence.sha256 };
  // identity is an opaque server-owned archive binding. No chain, registry,
  // namespace authority or per-TLD contract identity is derived by this module.
  const request = { version: 1, identity, roots: input.roots, output: input.output };
  const name = "seal-" + hash(context.lease.operationId).slice(0, 32);
  const ref = await createJSON(context.outputDirectory, name, request);
  const result = await runOwnedCommand({ lease: context.lease, executable: context.node,
    executableSha256: context.nodeSha256, argv: [context.codecCli, "seal", join(context.outputDirectory, ref.relativePath), "--key-fd=3"],
    environment: context.environment, cwd: context.cwd, outputDirectory: context.outputDirectory,
    name, seconds: 300, signal: context.signal, keyMaterial: input.recoveryKey });
  const response = await privateFile(result.stdoutPath, 65536);
  let sealed: { kind: string; archiveSha256: string; manifestSha256: string; encryptedBytes: number; output: string };
  try { sealed = JSON.parse(await response.readFile("utf8")); } finally { await response.close(); }
  assert(sealed.kind === "encrypted-state-artifact" && sealed.output === input.output && rawDigest(sealed.archiveSha256) &&
    rawDigest(sealed.manifestSha256) && Number.isSafeInteger(sealed.encryptedBytes) && sealed.encryptedBytes > 0);
  await verifyCiphertext(input.output, "0x" + sealed.archiveSha256, sealed.encryptedBytes);
  await input.fence.assertCold(); await context.lease.assertHeld();
  const receipt: ColdBackupReceipt = { archiveSha256: sealed.archiveSha256, manifestSha256: sealed.manifestSha256,
    encryptedBytes: sealed.encryptedBytes, output: sealed.output, sourceMachineIdSha256: await machineId(),
    identity, roles: Object.keys(input.roots).sort(), writerFenceSha256: fence.sha256 };
  await context.lease.record("encrypted-cohort-complete", receipt);
  const { output, ...descriptor } = receipt;
  await createJSON(context.outputDirectory, "recovery-descriptor-" + hash(context.lease.operationId).slice(0, 32), {
    schema: "pirate.cold-recovery-descriptor/1", backup: descriptor,
  });
  // Keep maintenance and the exclusive operation until the real lifecycle
  // checks are performed. This function does not restart an unqualified app.
  return receipt;
}

/** Actual fresh-target restore, retaining all startup fences. A second-host
 * condition is checked from this host's real machine ID. Independent machine,
 * storage and application acceptance still need their own complete proof. */
async function restoreColdBackup(context: ColdContext, input: {
  backup: ColdRecoveryDescriptor; localCiphertext: string; stagingDirectory: string; target: string; recoveryKey: Uint8Array;
}) {
  await context.lease.assertHeld(); await context.authorize("cold-restore", context.lease.installationId);
  await verifyCodec(context); assert(!context.signal.aborted && input.recoveryKey.byteLength === 32);
  assert.notEqual(await machineId(), input.backup.sourceMachineIdSha256, "backup_second_host_required");
  await privateDirectory(input.stagingDirectory); await privateDirectory(dirname(input.target));
  try { await lstat(input.target); throw new Error("backup_restore_target_not_fresh"); }
  catch (error) { assert((error as NodeJS.ErrnoException).code === "ENOENT", "backup_restore_target_not_fresh"); }
  await verifyCiphertext(input.localCiphertext, "0x" + input.backup.archiveSha256, input.backup.encryptedBytes);
  const request = { version: 1, archive: input.localCiphertext, archiveSha256: input.backup.archiveSha256,
    expectedIdentity: input.backup.identity, expectedRoles: input.backup.roles,
    stagingDirectory: input.stagingDirectory, target: input.target };
  const name = "restore-" + hash(context.lease.operationId).slice(0, 32), ref = await createJSON(context.outputDirectory, name, request);
  const result = await runOwnedCommand({ lease: context.lease, executable: context.node, executableSha256: context.nodeSha256,
    argv: [context.codecCli, "restore", join(context.outputDirectory, ref.relativePath), "--key-fd=3"],
    environment: context.environment, cwd: context.cwd, outputDirectory: context.outputDirectory,
    name, seconds: 300, signal: context.signal, keyMaterial: input.recoveryKey });
  const restored = await readJSON(join(input.target, "restored-cohort.json")) as {
    state: string; archiveSha256: string; manifestSha256: string; identity: CohortIdentity; roles: string[];
  };
  assert.equal(restored.state, "restored-fenced"); assert.equal(restored.archiveSha256, input.backup.archiveSha256);
  assert.equal(restored.manifestSha256, input.backup.manifestSha256);
  assert.deepEqual(restored.identity, input.backup.identity); assert.deepEqual(restored.roles, input.backup.roles);
  for (const role of input.backup.roles) {
    const fence = await readJSON(join(input.target, role, "restore-fence.json")) as {
      schema: string; archiveSha256: string; manifestSha256: string; identity: CohortIdentity;
    };
    assert.equal(fence.schema, "pirate.restore-fence/1"); assert.equal(fence.archiveSha256, restored.archiveSha256);
    assert.equal(fence.manifestSha256, restored.manifestSha256); assert.deepEqual(fence.identity, restored.identity);
  }
  await context.lease.record("restore-fenced-readback", { target: input.target, restored, sourceReceipt: result.facts,
    targetMachineIdSha256: await machineId(), readiness: "UNPROVED", startupFencesRemoved: false });
  return { state: "restored-fenced" as const, restored, domainReconciliation: "REQUIRED" as const };
}
export async function createColdBackupFromFd(context: ColdContext, input: Omit<Parameters<typeof createColdBackup>[1], "recoveryKey">) {
  return withRecoveryKeyFd(3, (recoveryKey) => createColdBackup(context, { ...input, recoveryKey }), Object.values(input.roots));
}
export async function restoreColdBackupFromFd(context: ColdContext, input: Omit<Parameters<typeof restoreColdBackup>[1], "recoveryKey">) {
  return withRecoveryKeyFd(3, (recoveryKey) => restoreColdBackup(context, { ...input, recoveryKey }), [input.target, input.stagingDirectory]);
}
