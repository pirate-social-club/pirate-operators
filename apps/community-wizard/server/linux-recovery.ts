import { randomUUID, createHash } from "node:crypto";
import {
  LinuxInputError,
  fields,
  requireLinux,
  text,
  reference,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { sameIdentity } from "./linux-journal.ts";
import { restoreInspectionFrom } from "./linux-boundaries.ts";
import { custodyHeld } from "./linux-operations.ts";
import type { RestoreInspection } from "./linux-contracts.ts";
import type { LinuxContext } from "./linux-context.ts";

export function linuxRecovery(ctx: LinuxContext) {
  const { backend, naming, now, call, caps, draft, editable, current, change } =
    ctx;
  async function stageBackup(
    bytes: AsyncIterable<Uint8Array>,
    byteLength: number,
  ) {
    const state = ctx.read();
    requireLinux(state.uploadRequest || !state.namespaceRequest,"reconciliation_required","Recover the original namespace request before starting a new encrypted upload.");
    const c = await caps();
    requireLinux(
      (state.draft?.mode ?? state.destination?.mode) === "restore" &&
        c.operations.includes("restore") &&
        byteLength > 0 &&
        byteLength <= c.backup.maxBytes,
      "backup_unavailable",
      "Select a supported encrypted backup within this backend's upload limit.",
    );
    const revision = state.revision;
    const requestId = state.uploadRequest?.id ?? randomUUID();
    await change((s) => {
      current(s, revision);
      requireLinux(
        !custodyHeld(s) &&
          !s.secretRequest &&
          (!s.namespaceRequest || Boolean(s.uploadRequest && s.uploadRequest.id===requestId && s.uploadRequest.byteLength===byteLength)) &&
          (!s.uploadRequest ||
            (s.uploadRequest.id === requestId &&
              s.uploadRequest.byteLength === byteLength)),
        "reconciliation_required",
        "Resume the same encrypted upload before selecting different backup bytes.",
      );
      s.uploadRequest = { id: requestId, byteLength };
      s.plan = null;
    });
    let seen = 0,
      completed = false;
    const ciphertext = createHash("sha256");
    const checked = async function* () {
      for await (const chunk of bytes) {
        requireLinux(
          chunk instanceof Uint8Array,
          "backup_bytes",
          "Upload the original encrypted backup bytes.",
        );
        seen += chunk.byteLength;
        requireLinux(
          seen <= byteLength,
          "backup_size",
          "The encrypted upload exceeded its declared size. Resume the original upload.",
        );
        ciphertext.update(chunk);
        yield chunk;
      }
      requireLinux(
        seen === byteLength,
        "backup_size",
        "The encrypted upload was interrupted. Resume the same backup.",
      );
      completed = true;
    };
    const result = await call(
      () => backend.stageBackup({ requestId, bytes: checked(), byteLength }),
      ctx.uploadTimeoutMs,
    );
    requireLinux(
      completed && seen === byteLength,
      "backup_incomplete",
      "The backend did not durably consume the complete encrypted backup. Reconcile or resume the same upload.",
    );
    const backupId = reference(result.backupId),
      ciphertextDigest = `0x${ciphertext.digest("hex")}`;
    requireLinux(
      result.ciphertextDigest === ciphertextDigest,
      "backup_digest",
      "The staged encrypted backup digest differs. Resume the original upload before inspecting it.",
    );
    await change((s) => {
      requireLinux(
        s.uploadRequest?.id === requestId,
        "upload_changed",
        "Resume the original backup upload.",
      );
      s.backupId = backupId;
      s.backupDigest = ciphertextDigest;
      s.restore = null;
      s.uploadRequest = null;
      // An already retained upload may be recovered alongside a retained proof.
      // Do not invalidate that proof's captured settings revision on its receipt.
      if(!s.namespaceRequest)s.revision++;
    });
  }
  async function inspectBackup(value: unknown) {
    const state = ctx.read();
    const c = await caps();
    requireLinux(c.operations.includes("restore") && c.backup.maxBytes > 0 && state.draft?.version !== 3,
      "backup_unavailable","This installed profile does not support guided restore; no recovery key is consumed.");
    const input = fields(value, ["recoveryKey"]),
      key = text(input.recoveryKey, 4096),
      revision = state.revision,
      backupId = state.backupId;
    requireLinux(
      backupId && !state.uploadRequest,
      "backup_required",
      "Finish uploading the encrypted backup before entering its separate recovery key.",
    );
    let inspection: RestoreInspection;
    try {
      inspection = restoreInspectionFrom(
        await call(() => backend.inspectBackup({ backupId, recoveryKey: key })),
        backupId,
        state.backupDigest!,
        c.backup.formats,
      );
    } catch {
      throw new LinuxInputError(
        "backup_not_authenticated",
        "The backup could not be authenticated and validated. Check the separate recovery key, supported format and backend compatibility.",
      );
    }
    await change((s) => {
      current(s, revision);
      editable(s);
      requireLinux(
        !s.operation ||
          (s.identity && sameIdentity(s.identity, inspection.profile.identity)),
        "retained_identity",
        "This original restore attempt retains its captured community and resources; select its matching backup.",
      );
      s.restore = inspection;
      s.identity = inspection.profile.identity;
      const selected = s.draft ?? s.destination;
      requireLinux(
        selected && inspection.sessionPolicies.length > 0,
        "settings_required",
        "Select a destination host and a supported session recovery policy first.",
      );
      s.draft = {
        ...inspection.profile.settings,
        mode: "restore",
        target: selected.target,
        recovery: {
          sessionPolicy: inspection.sessionPolicies.includes("revoke-existing")
            ? "revoke-existing"
            : inspection.sessionPolicies[0],
        },
      };
      s.namespace = null;
      s.requirements = [];
      s.plan = null;
      s.revision++;
    });
  }

  return { stageBackup, inspectBackup };
}
