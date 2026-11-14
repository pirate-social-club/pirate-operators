import { randomUUID } from "node:crypto";
import {
  LinuxInputError,
  fields,
  record,
  requireLinux,
  natural,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { requirementsFrom } from "./linux-boundaries.ts";
import { unresolved } from "./linux-operations.ts";
import type { LinuxContext } from "./linux-context.ts";

export function linuxCredentials(ctx: LinuxContext) {
  const { backend, naming, now, call, caps, draft, editable, current, change } =
    ctx;
  async function saveCredentials(value: unknown) {
    const state = ctx.read();
    const input = fields(value, ["revision", "values"]),
      values = record(input.values),
      d = draft();
    const ids = Object.keys(values);
    requireLinux(
      ids.length > 0 && ids.length <= 30,
      "credentials_required",
      "Enter the credentials required by the selected features.",
    );
    for (const id of ids)
      requireLinux(
        state.requirements.some((r) => r.id === id) &&
          typeof values[id] === "string" &&
          (values[id] as string).length > 0 &&
          (values[id] as string).length <= 4096 &&
          !/[\x00-\x1f]/.test(values[id] as string),
        "credential_scope",
        "Only enter the named credentials for this community's selected service scope.",
      );
    requireLinux(
      !unresolved(state),
      "effects_unresolved",
      "Credential writes must wait for the original ambiguous deployment effects to reconcile.",
    );
    const requestId = randomUUID();
    await change((s) => {
      current(s, natural(input.revision));
      editable(s);
      s.secretRequest = { id: requestId, fieldIds: ids };
      s.plan = null;
    });
    try {
      await call(() =>
        backend.saveCredentials({
          requestId,
          draft: d,
          values: values as Record<string, string>,
        }),
      );
      await reconcileCredentials();
    } catch {
      throw new LinuxInputError(
        "credential_write_uncertain",
        "A credential write may have completed. Reconcile its saved request before replacing credentials; values were not retained by the wizard.",
      );
    }
  }
  async function reconcileCredentials() {
    const state = ctx.read();
    const pending = state.secretRequest;
    requireLinux(
      pending,
      "credential_request_required",
      "No credential write is awaiting reconciliation.",
    );
    const result = await call(() =>
      backend.reconcileCredentials({ requestId: pending.id, draft: draft() }),
    );
    requireLinux(
      ["pending", "saved", "not-saved"].includes(result.state),
      "credential_receipt",
      "The credential adapter must reconcile the original write.",
    );
    const requirements = requirementsFrom(result.requirements);
    await change((s) => {
      if (s.secretRequest?.id !== pending.id) return;
      s.requirements = requirements;
      if (result.state !== "pending") {
        s.secretRequest = null;
        s.revision++;
      }
      s.plan = null;
    });
  }
  async function verifyCredentials() {
    const state = ctx.read();
    editable(state);
    const d = draft(),
      revision = state.revision;
    requireLinux(
      state.target && !state.secretRequest,
      "verification_pending",
      "Inspect the host and reconcile pending credential writes first.",
    );
    const requirements = requirementsFrom(
      await call(() =>
        backend.verifyCredentials({
          requestId: randomUUID(),
          draft: d,
          target: state.target!,
        }),
      ),
    );
    await change((s) => {
      current(s, revision);
      s.requirements = requirements;
      s.plan = null;
    });
  }

  return { saveCredentials, reconcileCredentials, verifyCredentials };
}
