import {sharedNamespaceRequests} from "./shared-namespace-requests.ts";
import { createLinuxContext } from "./linux-context.ts";
import { linuxOperations } from "./linux-operations.ts";
import { linuxSettings } from "./linux-settings.ts";
import { linuxCredentials } from "./linux-credentials.ts";
import { linuxRecovery } from "./linux-recovery.ts";
import { linuxPlan } from "./linux-plan.ts";
import type {
  OriginalLinuxDeploymentPort as LinuxDeploymentPort,
  NamespaceAuthorityPort,
} from "./linux-contracts.ts";
export async function createLinuxSetup(
  directory: string,
  backend: LinuxDeploymentPort,
  naming: NamespaceAuthorityPort,
  options: {
    now?: () => number;
    timeoutMs?: number;
    uploadTimeoutMs?: number;
  } = {},
) {
  const ctx = await createLinuxContext(directory, backend, naming, options);
  const operations = linuxOperations(
    backend,
    ctx.read,
    ctx.change,
    ctx.call,
    ctx.now,
  );
  return {
    snapshot: () => structuredClone(ctx.read()),
    capabilities: ctx.caps,
    ...linuxSettings(ctx),
    ...sharedNamespaceRequests(ctx),
    ...linuxCredentials(ctx),
    ...linuxRecovery(ctx),
    ...linuxPlan(ctx, operations),
    reconcile: operations.reconcile,
    cancel: operations.cancel,
    settled: operations.settled,
  };
}
export type LinuxSetup = Awaited<ReturnType<typeof createLinuxSetup>>;
