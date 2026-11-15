/** Foreground installation-control ownership only. Persistent app containers
 * and data survive a clean stop. This never clears a backup/writer barrier.
 * A crash retains the lock and requires explicit reconciliation, never stealing. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireOperation,
  installationReference,
  privateDirectory,
  privateFile,
  processIdentity,
  syncDirectory,
  type OperationLease,
} from "./backend-state.ts";

export async function acquireWeb2ServiceControl(
  directory: string,
  installationId: string,
) {
  await privateDirectory(directory);
  assert(installationReference(installationId));
  const holder = await processIdentity(process.pid);
  assert(holder, "web2_service_holder_unavailable");
  const operationId = "web2-service-" + randomUUID();
  const path = join(directory, "active-web2-service.json");
  const bytes = Buffer.from(
    JSON.stringify({
      schema: "pirate.web2-service-control/1",
      installationId,
      operationId,
      holder,
    }) + "\n",
  );
  const lock = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const identity = await lock.stat();
  try {
    await lock.writeFile(bytes);
    await lock.sync();
  } finally {
    await lock.close();
  }
  await syncDirectory(directory);
  // Every boot owns a fresh append-only evidence namespace. Existing install
  // originals, resource IDs and backup barriers are not rebound or removed.
  const boot = await mkdtemp(join(directory, "service-boot-"));
  await syncDirectory(directory);
  const original = await acquireOperation(
    boot,
    operationId,
    installationId,
    { kind: "web2-service-control", controlDirectory: directory },
    holder.pidNamespace,
  );
  let closed = false,
    closing = false,
    unlinked = false;
  async function assertHeld() {
    assert(!closed, "web2_service_control_closed");
    await original.assertHeld();
    const current = await privateFile(path, 65536);
    try {
      const info = await current.stat();
      assert(
        info.dev === identity.dev &&
          info.ino === identity.ino &&
          (await current.readFile()).equals(bytes),
        "web2_service_control_changed",
      );
    } finally {
      await current.close();
    }
  }
  const lease: OperationLease = {
    ...original,
    assertHeld,
    async record(phase, facts) {
      assert(!closing, "web2_service_control_stopping");
      await assertHeld();
      return original.record(phase, facts);
    },
  };
  return {
    lease,
    /** Call only after this foreground owner's paired listener and ingress have
     * stopped. This does not stop/release/adopt any persistent container. */
    async closeControl() {
      if (closed) return;
      assert(!closing, "web2_service_control_stopping");
      closing = true;
      try {
        if (unlinked) {
          // A failed final directory sync is not a successful close. The same
          // owner may retry that sync, without deleting any successor's lock.
          await syncDirectory(directory);
          closed = true;
          return;
        }
        await assertHeld();
        await original.record("web2-service-control-stopped", {
          controlDirectory: directory,
          persistentResourcesRetained: true,
          backupAndWriterBarriersReleased: false,
        });
        await assertHeld();
        const current = await lstat(path);
        assert(
          current.dev === identity.dev &&
            current.ino === identity.ino &&
            current.nlink === 1,
          "web2_service_control_changed_before_close",
        );
        await unlink(path);
        unlinked = true;
        await syncDirectory(directory);
        closed = true;
      } finally {
        closing = false;
      }
    },
  };
}
