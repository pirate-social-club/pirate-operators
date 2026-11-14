import {originalLinuxDraftFrom} from "../../../packages/community-setup/linux-create-profile.ts";
import { randomUUID } from "node:crypto";
import {
  fields,
  requireLinux,
  natural,
  targetFrom,
  linuxProfileFrom,
  type LinuxDraftV2,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import {
  targetInspectionFrom,
  requirementsFrom,
  namespaceProofFrom,
} from "./linux-boundaries.ts";
import { canonical, sameIdentity } from "./linux-journal.ts";
import type { LinuxContext } from "./linux-context.ts";

export function linuxSettings(ctx: LinuxContext) {
  const { backend, naming, now, call, caps, draft, editable, current, change } =
    ctx;
  async function destination(value: unknown) {
    const state = ctx.read();
    const input = fields(value, ["revision", "mode", "target"]),
      target = targetFrom(input.target);
    requireLinux(
      ["create", "import", "restore"].includes(String(input.mode)),
      "setup_mode",
      "Choose create, import or restore.",
    );
    const c=await caps();
    requireLinux(c.operations.includes(input.mode as LinuxDraftV2["mode"]) && c.targets.includes(target.kind),
      "setup_mode_unavailable","Select an action and target supported by this installed backend.");
    await change((s) => {
      current(s, natural(input.revision));
      editable(s);
      requireLinux(
        !s.operation,
        "retained_operation",
        "Preserve this original operation and its deployment identity; choose another private setup project for a different deployment.",
      );
      s.destination = { mode: input.mode as LinuxDraftV2["mode"], target };
      s.draft = null;
      s.target = null;
      s.namespace = null;
      s.imported = null;
      s.restore = null;
      s.backupId = null;
      s.backupDigest = null;
      s.plan = null;
      s.identity = null;
      s.requirements = [];
      s.revision++;
    });
  }
  async function configure(value: unknown) {
    const state = ctx.read();
    const input = fields(value, ["revision", "draft"]),
      parsed = originalLinuxDraftFrom(input.draft);
    await change((s) => {
      current(s, natural(input.revision));
      editable(s);
      requireLinux(!s.draft || s.draft.version === parsed.version,"profile_schema_changed",
        "Keep the saved schema and original installation; no V2/V3 conversion is supported.");
      if (s.operation && s.draft)
        requireLinux(
          canonical(s.draft.target) === canonical(parsed.target) &&
            s.draft.slug === parsed.slug &&
            s.draft.mode === parsed.mode && s.draft.version === parsed.version,
          "retained_identity",
          "Correct this deployment's settings without changing its retained host, mode or community identifier.",
        );
      if (canonical(s.draft) === canonical(parsed)) return;
      const oldTarget = s.draft?.target ?? s.destination?.target;
      const sameTarget =
        oldTarget && canonical(oldTarget) === canonical(parsed.target);
      const sameNamespace = Boolean(
        s.draft &&
          s.draft.origin === parsed.origin &&
          s.draft.namespace.tld === parsed.namespace.tld,
      );
      s.draft = parsed;
      s.destination = { mode: parsed.mode, target: parsed.target };
      s.revision++;
      s.namespaceChallenge=null;
      s.plan = null;
      if (!sameTarget) s.target = null;
      if (!sameNamespace) s.namespace = null;
      s.requirements = [];
      s.message =
        "Settings saved. Inspect the host and verify the selected services before review.";
    });
  }
  async function inspect() {
    const state = ctx.read();
    const selection = state.draft ?? state.destination;
    requireLinux(
      selection,
      "target_required",
      "Choose a local Linux or SSH target first.",
    );
    const revision = state.revision,
      c = await caps();
    requireLinux(
      c.targets.includes(selection.target.kind) &&
        (selection.target.kind === "local-linux" ||
          c.sshConnections
            .map((v) => v.id)
            .includes(selection.target.connectionRef)),
      "target_unavailable",
      "This backend does not support the selected Linux target.",
    );
    const target = targetInspectionFrom(
      await call(() =>
        backend.inspectTarget({
          requestId: randomUUID(),
          target: selection.target,
        }),
      ),
      selection,
    );
    const requirements = state.draft
      ? requirementsFrom(
          await call(() =>
            backend.credentialRequirements({ draft: state.draft!, target }),
          ),
        )
      : [];
    await change((s) => {
      current(s, revision);
      editable(s);
      if(s.draft?.mode==="create") {
        requireLinux(target.prepared,"shared_identity_unavailable","The actual backend must prepare and persist the shared identity and explicit installation mapping before proof.");
        requireLinux(!s.identity || canonical(s.identity)===canonical(target.prepared.identity),"identity_changed","Retain the original prepared resource identity.");
        requireLinux(canonical(target.prepared.settings)===canonical(s.draft),"prepared_settings_changed","The prepared shared identity must bind exact saved settings.");
        s.identity=target.prepared.identity;
      }
      s.target = target;
      s.requirements = requirements;
      s.plan = null;
    });
  }
  async function namespace() {
    const state = ctx.read();
    const d = draft(),
      revision = state.revision;
    const proof = namespaceProofFrom(
      await call(() =>
        naming.inspect({
          requestId: randomUUID(),
          tld: d.namespace.tld,
          hostingOrigin: d.origin,
          identity: state.identity,
        }),
      ),
      d.namespace.tld,
    );
    await change((s) => {
      current(s, revision);
      editable(s);
      s.namespace = proof;
      s.plan = null;
    });
  }
  async function importProfile(value: unknown) {
    const state = ctx.read();
    const input = fields(value, ["revision", "profile"]),
      profile = linuxProfileFrom(input.profile);
    await change((s) => {
      current(s, natural(input.revision));
      editable(s);
      requireLinux(
        (s.draft?.mode ?? s.destination?.mode) === "import" &&
          s.target?.supported,
        "import_target_required",
        "Inspect the existing host before importing its profile.",
      );
      requireLinux(
        s.target.existing.some((v) => canonical(v) === canonical(profile)),
        "import_identity_unverified",
        "The inspected host did not return this exact profile. Select its discovered installation.",
      );
      requireLinux(
        !s.operation ||
          (s.identity && sameIdentity(s.identity, profile.identity)),
        "retained_identity",
        "This original import attempt retains its captured community and resources.",
      );
      s.imported = profile;
      s.identity = profile.identity;
      s.draft = {
        ...profile.settings,
        mode: "import",
        target: s.target.target,
      };
      s.namespace = null;
      s.requirements = [];
      s.plan = null;
      s.revision++;
    });
  }

  return { destination, configure, inspect, namespace, importProfile };
}
