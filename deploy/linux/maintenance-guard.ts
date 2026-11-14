import assert from "node:assert/strict";
import { join } from "node:path";
import { createJSON, hash, privateDirectory, privateFile, type OperationLease } from "./backend-state.ts";

/** Actual persistent guard. Every maintained service-start owner must invoke
 * assertStartAllowed; connecting it to the full service graph is still required. */
export async function createMaintenanceGuard(directory: string, lease: OperationLease) {
  await privateDirectory(directory); let expected: string | undefined;
  return {
    async enterMaintenance() {
      await lease.assertHeld(); assert(expected === undefined);
      try {
        const file=await privateFile(join(directory,"maintenance-guard.json"),65536);
        try {const bytes=await file.readFile(),prior=JSON.parse(bytes.toString("utf8"));
          assert(prior.installationId===lease.installationId && prior.operationId===lease.operationId &&
            prior.intent.sha256===lease.intentRef.sha256 && JSON.stringify(prior.holder)===JSON.stringify(lease.holder),
            "maintenance_original_owner_required");expected=hash(bytes);return;
        } finally {await file.close();}
      } catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
      const ref = await createJSON(directory, "maintenance-guard", {
        schema: "pirate.maintenance-guard/1", installationId: lease.installationId,
        operationId: lease.operationId, intent: lease.intentRef, holder: lease.holder,
      });
      expected = ref.sha256;
    },
    async assertMaintenanceHeld() {
      await lease.assertHeld(); assert(expected !== undefined);
      const file = await privateFile(join(directory, "maintenance-guard.json"), 65536);
      try { assert.equal(hash(await file.readFile()), expected, "maintenance_guard_changed"); }
      finally { await file.close(); }
    },
  };
}
export async function assertStartAllowed(directory: string) {
  await privateDirectory(directory);
  try {
    const file = await privateFile(join(directory, "maintenance-guard.json"), 65536);
    await file.close(); throw new Error("deployment_in_maintenance_reconcile_original_operation");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
