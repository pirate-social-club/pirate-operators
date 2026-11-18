import assert from "node:assert/strict";
import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest, immutableRecord } from "./installed-records.ts";
import type { OperationLease } from "./backend-state.ts";
import type { PublicIngress } from "./public-ingress.ts";

/** Only an explicit absence from the same host port is proof here. TLS,
 * application errors and timeouts do not authorize pre-create effects. */
export async function assertWeb2IngressUncreated(ingress: PublicIngress) {
  await lstat(ingress.configurationFile).then(
    () => assert.fail("native_expansion_ingress_already_retained"),
    error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; },
  );
  const ports = new Set([ingress.httpPort, ingress.httpsPort, Number(new URL(ingress.upstream).port)]);
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, signal: AbortSignal.timeout(1000) });
      socket.once("connect", () => { socket.destroy(); reject(Error("native_expansion_ingress_already_active")); });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve();
        else reject(error);
      });
    });
  }
}

export interface Web2ExpansionIntent {
  schema: "pirate.web2-expansion-bootstrap/1";
  installationId: string;
  operationId: string;
  nativeOriginalSha256: string;
  graphSha256: string;
  attachmentSha256: string;
}

/** Consume one original in the existing service lifetime. A crash or lost
 * callback after the fsynced marker is a hold, even if output is absent. */
export function createWeb2ExpansionPreparation(directory: string, lease: OperationLease) {
  let original: { identity: string; task: Promise<void> } | undefined;
  return (input: {
    intent: Readonly<Web2ExpansionIntent>;
    authorize(): Promise<void>;
    assertCurrent(): Promise<void>;
    execute(): Promise<void>;
  }) => {
    const intent = structuredClone(input.intent);
    assert(intent.schema === "pirate.web2-expansion-bootstrap/1" && intent.installationId === lease.installationId &&
      intent.operationId === lease.operationId, "native_expansion_bootstrap_lease_changed");
    const identity = canonicalDigest(intent);
    if (original) {
      assert(original.identity === identity, "native_expansion_original_changed");
      return original.task;
    }
    const task = (async () => {
      await lstat(join(directory, "web2-expansion-bootstrap.json")).then(
        () => assert.fail("native_expansion_bootstrap_requires_reconciliation"),
        error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; },
      );
      await input.authorize();
      await input.assertCurrent();
      await immutableRecord(directory, "web2-expansion-bootstrap", intent, lease);
      await input.assertCurrent();
      await input.execute();
      await input.assertCurrent();
    })();
    original = { identity, task };
    return task;
  };
}
