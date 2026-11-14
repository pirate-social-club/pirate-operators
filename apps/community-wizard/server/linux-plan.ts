import {sameOperationalSelection} from "../../../packages/community-setup/operational-selection.ts";
import {recoveryPortFrom,requireJournalCapacity} from "./linux-journal-capacity.ts";
import {sameNamespaceAuthority} from "../../../packages/community-setup/shared-namespace-proof.ts";
import {sameSharedInstallation} from "../../../packages/community-setup/shared-linux-infrastructure.ts";
import { randomUUID } from "node:crypto";
import {
  fields,
  requireLinux,
  natural,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import {
  namespaceProofFrom,
  planFrom,
  fullLinuxV2PlanFrom,
  requirePlanIdentity,
  requirementsFrom,
} from "./linux-boundaries.ts";
import { canonical } from "./linux-journal.ts";
import {
  linuxOperations,
  unresolved,
  operationBytes,
} from "./linux-operations.ts";
import type { LinuxContext } from "./linux-context.ts";

export function linuxPlan(
  ctx: LinuxContext,
  operations: ReturnType<typeof linuxOperations>,
) {
  const { backend, naming, now, call, caps, draft, editable, current, change } =
    ctx;
  async function review() {
    const state = ctx.read();
    const d = draft(),
      revision = state.revision,
      c = await caps(),
      target = state.target,
      proof = state.namespace;
    editable(state);
    if(d.version === 3)requireLinux(!state.operation,"original_create_held","Reconcile the original create; this schema does not authorize a replacement or retry child.");
    requireLinux(
      c.operations.includes(d.mode) &&
        c.targets.includes(d.target.kind) &&
        Object.entries(d.features).every(
          ([key, v]) =>
            !v || c.features.includes(key as keyof typeof d.features),
        ),
      "feature_unavailable",
      "This Linux adapter cannot deploy all selected features. Correct the selection or install the missing backend capability.",
    );
    requireLinux(
      c.publicationSelection === d.services.publicationProfile && c.publicationProfiles.some(
        (p) => p.id === d.services.publicationProfile && p.verified,
      ) &&
        (!d.features.learning ||
          c.learningProfiles.some(
            (p) => p.id === d.services.learningProfile && p.verified,
          )),
      "service_profile_unverified",
      "Select verified publication and Learning service identities discovered by this runner.",
    );
    requireLinux(
      target?.supported &&
        proof?.status === "verified" &&
        proof.expiresAt > now(),
      "preflight_required",
      "Inspect a supported host and complete the separate controlled-TLD import proof.",
    );
    if (d.mode === "import")
      requireLinux(
        state.imported,
        "import_required",
        "Select the existing installation discovered on this host.",
      );
    if (d.mode === "restore")
      requireLinux(
        state.restore &&
          c.backup.formats.includes(state.restore.format) &&
          state.restore.sessionPolicies.includes(d.recovery.sessionPolicy) &&
          c.backup.sessionPolicies.includes(d.recovery.sessionPolicy),
        "restore_required",
        "Authenticate a compatible backup and select an actual supported session recovery policy.",
      );
    if(d.features.learning)requireLinux(c.policy?.speech,"speech_definition_unavailable","The selected service must define its admission unit before Learning review.");
    const fresh = namespaceProofFrom(
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
    requireLinux(
      fresh.status === "verified" && fresh.expiresAt > now(),
      "namespace_pending",
      "Current namespace authority is not verified. Reconcile the naming adapter before deploying.",
    );
    const plan = planFrom(
      await call(() =>
        backend.prepare({
          requestId: randomUUID(),
          draft: d,
          target,
          namespace: fresh,
          retainedIdentity: state.identity,
          previousOperation: state.operation ? {...operationBytes(state),plan:fullLinuxV2PlanFrom(state.operation.plan)} : null,
          imported: state.imported,
          restore: state.restore,
        }),
      ),
    );
    requireLinux(
      sameOperationalSelection(plan.profile.settings,d,plan.sessionPolicy) &&
        canonical(plan.operatorPolicy) === canonical(c.policy) &&
        plan.profile.runtime.sourceDigest === c.sourceDigest &&
        plan.targetInspectionId === target.id &&
        plan.targetFingerprint === target.fingerprint &&
        plan.namespaceProofId === fresh.id &&
        plan.expiresAt > now() &&
        plan.sessionPolicy === (d.version === 3 ? null : d.recovery.sessionPolicy) &&
        plan.restoreInspectionId === (state.restore?.id ?? null) &&
        plan.restoreManifestDigest ===
          (state.restore?.manifestDigest ?? null) &&
        plan.restoreCiphertextDigest ===
          (state.restore?.ciphertextDigest ?? null) &&
        plan.predecessorOperationId === (state.operation?.id ?? null),
      "plan_context",
      "The backend plan does not match the selected target, source, authority, recovery policy and settings.",
    );
    requireLinux(sameNamespaceAuthority(plan.profile.namespace,fresh),"namespace_plan","Review the exact shared namespace proof, permission role, original mapping and revisions.");
    if(state.imported)requireLinux(sameSharedInstallation(state.imported.infrastructure,plan.profile.infrastructure),"shared_identity_changed","Retain portable key, source and installation on import.");
    if(state.restore)requireLinux(sameSharedInstallation(state.restore.profile.infrastructure,plan.profile.infrastructure),"shared_identity_changed","Retain portable key, original mapping and shared source on restore.");
    if(state.operation)requireLinux(sameSharedInstallation(state.operation.plan.profile.infrastructure,plan.profile.infrastructure),"shared_identity_changed","A correction cannot rebind the original shared installation.");
    requirePlanIdentity(plan, state.identity);
    const confirmed = namespaceProofFrom(
      await call(() =>
        naming.revalidate({ proof: fresh, profile: plan.profile }),
      ),
      d.namespace.tld,
    );
    requireLinux(
      confirmed.status === "verified" &&
        confirmed.expiresAt > now() &&
        confirmed.id === fresh.id &&
        sameNamespaceAuthority(confirmed,fresh),
      "namespace_pending",
      "Current namespace rights changed while preparing the plan. Refresh the authority proof.",
    );
    requireLinux(
      (d.mode === "create" &&
        (plan.action === "create" || (d.version === 2 &&
          (Boolean(state.identity) &&
            plan.action === "upgrade" &&
            c.operations.includes("upgrade"))))) ||
        (d.mode === "import" && ["adopt", "upgrade"].includes(plan.action)) ||
        (d.mode === "restore" && plan.action === "restore"),
      "plan_action",
      "The backend must prepare the selected create/import/restore action.",
    );
    await change((s) => {
      current(s, revision);
      editable(s);
      s.plan = plan;
      s.namespace = confirmed;
      s.requirements = plan.requirements;
      s.message =
        "Review the complete application and selected Learning plan before deploying.";
    });
  }
  async function deploy(value: unknown) {
    const state = ctx.read();
    const input = fields(value, [
      "revision",
      "planDigest",
      "targetFingerprint",
      "approved",
    ]);
    if (state.operation?.plan.digest === input.planDigest) return; // Lost HTTP ACK reuses its original operation, never a replacement send.
    const revision = state.revision,
      plan = state.plan,
      c = await caps();
    requireLinux(
      plan &&
        input.approved === true &&
        input.planDigest === plan.digest &&
        input.targetFingerprint === plan.targetFingerprint &&
        plan.expiresAt > now() &&
        plan.profile.runtime.sourceDigest === c.sourceDigest &&
        plan.profile.settings.services.publicationProfile === c.publicationSelection &&
        canonical(plan.operatorPolicy) === canonical(c.policy) &&
        state.namespace?.status === "verified",
      "review_required",
      "Approve the current plan and exact host fingerprint before deploying.",
    );
    requireLinux(
      !state.secretRequest &&
        state.target &&
        plan.requirements.every((r) => r.state === "verified"),
      "service_verification_required",
      "Saved credentials are not readiness. Verify every selected service before deployment.",
    );
    if(plan.profile.settings.features.learning)requireLinux(c.policy?.providerBudget.enforcement!=="unverified" && c.policy?.providerBudget.evidenceRef && c.policy.providerBudget.proposalUsdCents===plan.profile.settings.limits.monthlyUsdCents,
      "provider_enforcement_unverified","The monthly value is a proposal; verify actual provider controls or the admitted alert/stop procedure before apply.");
    const requirements = requirementsFrom(
      await call(() =>
        backend.credentialRequirements({
          draft: plan.profile.settings,
          target: state.target!,
        }),
      ),
    );
    requireLinux(
      requirements.every((r) => r.state === "verified") &&
        canonical(requirements.map((r) => [r.id, r.role, r.scope])) ===
          canonical(plan.requirements.map((r) => [r.id, r.role, r.scope])),
      "service_verification_required",
      "Selected service verification changed. Verify services and review a fresh plan.",
    );
    if (plan.action === "restore")
      requireLinux(
        state.restore &&
          c.operations.includes("restore") &&
          c.backup.formats.includes(state.restore.format) &&
          plan.sessionPolicy !== null && c.backup.sessionPolicies.includes(plan.sessionPolicy),
        "restore_capability_changed",
        "The required backup or session recovery capability changed. Refresh the restore plan.",
      );
    const proof = state.namespace;
    requireLinux(
      proof?.status === "verified",
      "namespace_pending",
      "Verify current namespace authority before apply.",
    );
    const fresh = namespaceProofFrom(
      await call(() => naming.revalidate({ proof, profile: plan.profile })),
      plan.profile.settings.namespace.tld,
    );
    requireLinux(
      fresh.status === "verified" &&
        fresh.expiresAt > now() &&
        fresh.id === plan.namespaceProofId &&
        sameNamespaceAuthority(fresh,plan.profile.namespace),
      "namespace_pending",
      "Namespace authority changed or remains pending. Review a fresh plan.",
    );
    recoveryPortFrom(backend,c.sourceDigest);
    let launched = false;
    await change((s) => {
      if (s.operation?.plan.digest === plan.digest) return;
      current(s, natural(input.revision));
      current(s, revision);
      editable(s);
      requireLinux(
        !unresolved(s),
        "effects_unresolved",
        "Unknown original effects still block apply; editing and review do not authorize a replacement deployment.",
      );
      requireLinux(
        s.plan?.digest === plan.digest && plan.expiresAt > now(),
        "plan_changed",
        "Review the latest plan.",
      );
      if (s.operation) s.history = [...s.history, s.operation];
      launched = true;
      s.identity = plan.profile.identity;
      s.operation = {
        id: randomUUID(),
        kind: s.draft!.mode,
        draftRevision: s.revision,
        plan,
        startedAt: now(),
        state: "running",
        intent: null,
        results: [],
        capacityPhase:"binding",
        recoveryResultDigest:null,
        custody: "held",
        receiptRef: null,
        observationRevision: 0,
        message: "Deploying the reviewed application and selected services.",
      };
      requireJournalCapacity(s); // Reserve intent + first response + terminal BEFORE bind/effects.
    });
    if (launched) void operations.start();
  }
  return { review, deploy };
}
