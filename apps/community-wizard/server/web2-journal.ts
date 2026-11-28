import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  insist,
  integer,
  object,
  text,
} from "../../../packages/community/common.ts";
import {
  address,
  httpsOrigin,
} from "../../../packages/community/manifest-core.ts";
import { web2ProfileDocument } from "../../../packages/community/web2-directory.ts";
import {
  assertDeployment,
  parsePlan,
  planDocument,
  policyHash,
  signature,
  type HostedPolicy,
} from "../../../packages/community/hosted-enrollment.ts";
import {
  checkedHostedPreparation,
  type PreparedHostedEnrollment,
} from "../../../packages/community-setup/hosted-enrollment-client.ts";
import {
  hostedEnrollmentStatusFrom,
  linuxWeb2DraftFrom,
  type HostedEnrollmentStatus,
  type LinuxWeb2Draft,
  type LinuxWeb2Observation,
  type LinuxWeb2PlanSummary,
} from "../../../packages/community-setup/linux-web2-profile.ts";
import { parseInstallationPlanCommitment } from "../../../packages/community/web2-installation-commitment.ts";
import {
  isWeb2Deployment,
  validateCommunityDeploymentProfile,
  type Web2CommunityDeploymentProfile,
} from "../../../services/community-deployment-profile.ts";
export interface SelectionInput {
  name: string;
  origin: string;
  controller: Hex;
  publisher: Hex;
}
export type Phase =
  | "empty"
  | "prepared"
  | "pending"
  | "unknown"
  | "registered"
  | "funded"
  | "running";
export interface Journal {
  schema: "pirate.web2-wizard-original/1";
  revision: number;
  policyHash: Hex;
  phase: Phase;
  pending: string | null;
  rejectedAuthorizations: Array<{
    controller: Hex | null;
    recipients: Array<{ recipient: Hex; signature: Hex }> | null;
  }>;
  request: SelectionInput | null;
  plan: ReturnType<typeof planDocument> | null;
  deployment: Web2CommunityDeploymentProfile | null;
  prepared: PreparedHostedEnrollment | null;
  controllerSignature: Hex | null;
  recipientProofs: Array<{ recipient: Hex; signature: Hex }> | null;
  enrollment: HostedEnrollmentStatus | null;
  installDraft: LinuxWeb2Draft | null;
  installPlan: LinuxWeb2PlanSummary | null;
  installationCommitment: unknown | null;
  observation: LinuxWeb2Observation | null;
}
const MAX = 1_048_576;
export const web2Wire = <T>(v: T): T =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x)),
  );

export async function createWeb2Journal(
  directoryInput: string,
  policy: Readonly<HostedPolicy>,
  hostInstallationId: string | undefined,
  clock: () => number,
) {
  const directory = resolve(directoryInput);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  insist(
    (await realpath(directory)) === directory &&
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid!() &&
      !(stat.mode & 0o077),
    "private_web2_state_required",
    503,
  );
  const path = join(directory, "web2-wizard-original.json");
  const markerPath = join(directory, "web2-wizard-initialized.json");
  const markerBytes =
    JSON.stringify({
      schema: "pirate.web2-wizard-initialized/1",
      policyHash: policyHash(policy),
    }) + "\n";
  async function markerExists() {
    try {
      const meta = await lstat(markerPath);
      insist(
        meta.isFile() &&
          !meta.isSymbolicLink() &&
          meta.nlink === 1 &&
          meta.uid === process.getuid!() &&
          !(meta.mode & 0o077) &&
          meta.size < 4096,
        "web2_original_unreadable",
        503,
      );
      insist(
        (await readFile(markerPath, "utf8")) === markerBytes,
        "web2_original_unreadable",
        503,
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async function ensureMarker() {
    if (await markerExists()) return;
    const handle = await open(markerPath, "wx", 0o600);
    try {
      await handle.writeFile(markerBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  }
  await markerExists();
  let journal: Journal;
  try {
    const meta = await lstat(path);
    insist(
      meta.isFile() &&
        !meta.isSymbolicLink() &&
        meta.nlink === 1 &&
        meta.uid === process.getuid!() &&
        !(meta.mode & 0o077) &&
        meta.size <= MAX,
      "web2_original_unreadable",
      503,
    );
    journal = JSON.parse(await readFile(path, "utf8"));
    const legacy = journal as unknown as Record<string, unknown>;
    if (Object.hasOwn(legacy, "inviteToken")) {
      insist(
        legacy.inviteToken === null ||
          (typeof legacy.inviteToken === "string" && /^[a-f0-9]{64}$/.test(legacy.inviteToken)),
        "web2_original_changed",
        503,
      );
      delete legacy.inviteToken;
    }
    if (Object.hasOwn(legacy, "invitationRefused")) {
      insist(typeof legacy.invitationRefused === "boolean", "web2_original_changed", 503);
      delete legacy.invitationRefused;
    }
    if (!Object.hasOwn(legacy, "installationCommitment"))
      legacy.installationCommitment = null;
    exact(object(journal), [
      "schema",
      "revision",
      "policyHash",
      "phase",
      "pending",
      "rejectedAuthorizations",
      "request",
      "plan",
      "deployment",
      "prepared",
      "controllerSignature",
      "recipientProofs",
      "enrollment",
      "installDraft",
      "installPlan",
      "installationCommitment",
      "observation",
    ]);
    insist(
      journal.schema === "pirate.web2-wizard-original/1" &&
        journal.policyHash === policyHash(policy) &&
        [
          "empty",
          "prepared",
          "pending",
          "unknown",
          "registered",
          "funded",
          "running",
        ].includes(journal.phase),
      "web2_original_changed",
      503,
    );
    integer(journal.revision, 0, Number.MAX_SAFE_INTEGER);
    insist(
      Array.isArray(journal.rejectedAuthorizations) &&
        journal.rejectedAuthorizations.length <= 32,
      "web2_original_changed",
    );
    for (const rejected of journal.rejectedAuthorizations) {
      exact(object(rejected), ["controller", "recipients"]);
      if (rejected.controller !== null) signature(rejected.controller);
      if (rejected.recipients !== null) {
        insist(
          Array.isArray(rejected.recipients) && rejected.recipients.length <= 2,
          "web2_original_changed",
        );
        for (const proof of rejected.recipients) {
          exact(object(proof), ["recipient", "signature"]);
          address(proof.recipient);
          signature(proof.signature);
        }
      }
    }
    insist(
      journal.pending === null ||
        [
          "prepare",
          "redeem",
          "topup",
          "reconcile",
          "installation-prepare",
          "install",
          "installation-status",
        ].includes(journal.pending),
      "web2_original_changed",
    );
    if (journal.plan) {
      const plan = parsePlan(journal.plan);
      assertDeployment(policy, plan);
      const r = object(journal.request);
      exact(r, ["name", "origin", "controller", "publisher"]);
      insist(
        text(r.name, 63) === plan.config.app.label &&
          httpsOrigin(r.origin) === plan.config.app.origin &&
          address(r.controller) === plan.config.controller &&
          address(r.publisher) === plan.config.publisher,
        "web2_original_changed",
      );
      const d = validateCommunityDeploymentProfile(journal.deployment);
      insist(
        isWeb2Deployment(d) &&
          canonical(d.directoryProfile) ===
            canonical(web2ProfileDocument(plan.profile)) &&
          d.name === plan.config.app.label &&
          d.origin === plan.config.app.origin &&
          d.posts.address === plan.config.postsContract,
        "web2_original_changed",
      );
    } else
      insist(
        journal.request === null &&
          journal.deployment === null &&
          journal.prepared === null,
        "web2_original_changed",
      );
    if (journal.prepared) {
      insist(journal.plan, "web2_original_changed");
      const p = journal.prepared;
      const checked = checkedHostedPreparation(
        {
          schema: p.schema,
          enrollmentId: p.enrollmentId,
          expiresAt: p.expiresAt,
          typedData: p.typedData,
        },
        parsePlan(journal.plan),
        policy,
        Math.min(clock(), p.expiresAt - 1),
      );
      insist(canonical(checked) === canonical(p), "web2_original_changed", 503);
    }
    if (journal.enrollment) {
      journal.enrollment = hostedEnrollmentStatusFrom(journal.enrollment);
      insist(
        journal.prepared &&
          journal.plan &&
          journal.enrollment.enrollmentId === journal.prepared.enrollmentId &&
          journal.enrollment.configurationUri === journal.plan.uri &&
          canonical(journal.enrollment.profile) ===
            canonical(journal.plan.profile),
        "web2_original_changed",
      );
    }
    if (journal.installDraft) {
      journal.installDraft = linuxWeb2DraftFrom(journal.installDraft);
      insist(
        journal.plan &&
          canonical(journal.installDraft.configuration) ===
            canonical(journal.plan.config) &&
          canonical(journal.installDraft.deployment) ===
            canonical(journal.deployment) &&
          journal.installDraft.enrollment.enrollmentId ===
            journal.prepared?.enrollmentId,
        "web2_original_changed",
      );
    }
    if (journal.recipientProofs) {
      insist(
        Array.isArray(journal.recipientProofs) &&
          journal.recipientProofs.length <= 2,
        "web2_original_changed",
      );
      for (const proof of journal.recipientProofs) {
        exact(object(proof), ["recipient", "signature"]);
        address(proof.recipient);
        signature(proof.signature);
      }
    }
    if (journal.controllerSignature) signature(journal.controllerSignature);
    if (journal.installPlan)
      checkInstallationPlan(journal.installPlan, journal.installDraft);
    if (journal.installationCommitment !== null) {
      let commitment;
      try {
        commitment = parseInstallationPlanCommitment(
          journal.installationCommitment,
        );
      } catch {
        throw new CommunityError("web2_original_changed", 503);
      }
      insist(
        journal.prepared &&
          journal.plan &&
          journal.installPlan &&
          commitment.enrollmentId === journal.prepared.enrollmentId &&
          commitment.communityId === journal.plan.profile.communityId &&
          commitment.installationId === journal.plan.profile.installationId &&
          commitment.generation === journal.installPlan.binding.generation &&
          commitment.planId === journal.installPlan.binding.planId &&
          commitment.durableScope === journal.installPlan.binding.durableScope &&
          commitment.releaseArtifactDigest ===
            journal.installPlan.binding.releaseArtifactDigest &&
          commitment.releaseSourceDigest ===
            journal.installPlan.binding.releaseSourceDigest &&
          commitment.targetDigest === journal.installPlan.binding.targetDigest &&
          commitment.hostFingerprint ===
            journal.installPlan.binding.hostFingerprint,
        "web2_original_changed",
        503,
      );
      journal.installationCommitment = commitment;
    }
    if (journal.observation)
      checkObservation(journal.observation, journal.installPlan);
    if (journal.pending) journal.phase = "unknown";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new CommunityError("web2_original_unreadable", 503);
    if (await markerExists())
      throw new CommunityError("web2_original_missing", 503);
    journal = {
      schema: "pirate.web2-wizard-original/1",
      revision: 0,
      policyHash: policyHash(policy),
      phase: "empty",
      pending: null,
      rejectedAuthorizations: [],
      request: null,
      plan: null,
      deployment: null,
      prepared: null,
      controllerSignature: null,
      recipientProofs: null,
      enrollment: null,
      installDraft: null,
      installPlan: null,
      installationCommitment: null,
      observation: null,
    };
  }
  function checkInstallationPlan(
    p: LinuxWeb2PlanSummary,
    draft: LinuxWeb2Draft | null,
  ) {
    exact(object(p), ["planId", "planDigest", "installationId", "binding", "summary"]);
    insist(
      draft &&
        /^[a-f0-9]{64}$/.test(p.planDigest) &&
        typeof p.planId === "string" &&
        p.planId.length > 0 &&
        p.planId.length <= 256 &&
        typeof p.installationId === "string" &&
        p.installationId.length > 0 &&
        p.installationId.length <= 256 &&
        (!hostInstallationId || p.installationId === hostInstallationId),
      "web2_installation_context_changed",
      503,
    );
    exact(object(p.binding), [
      "generation",
      "planId",
      "durableScope",
      "releaseArtifactDigest",
      "releaseSourceDigest",
      "targetDigest",
      "hostFingerprint",
    ]);
    insist(
      Number.isSafeInteger(p.binding.generation) &&
        p.binding.generation > 0 &&
        p.binding.planId === p.planId &&
        /^[0-9a-f]{64}$/.test(p.binding.durableScope) &&
        /^0x[0-9a-f]{64}$/.test(p.binding.releaseArtifactDigest) &&
        /^0x[0-9a-f]{64}$/.test(p.binding.releaseSourceDigest) &&
        /^[0-9a-f]{64}$/.test(p.binding.targetDigest) &&
        typeof p.binding.hostFingerprint === "string" &&
        p.binding.hostFingerprint.length > 0 &&
        p.binding.hostFingerprint.length <= 256,
      "web2_installation_context_changed",
      503,
    );
    exact(object(p.summary), [
      "communityId",
      "origin",
      "name",
      "controller",
      "publisher",
      "registrationTransaction",
      "verifiedListing",
      "namesEnabled",
      "learningEnabled",
      "danceEnabled",
    ]);
    const s = p.summary,
      c = draft.configuration,
      r = draft.enrollment.operations.find(
        (op) => op.kind === "registration" && op.state === "consumed",
      );
    insist(
      s.communityId === c.communityId &&
        s.origin === c.app.origin &&
        s.name === c.app.label &&
        s.controller === c.controller &&
        s.publisher === c.publisher &&
        s.registrationTransaction === (r?.transactionHash ?? null) &&
        s.verifiedListing === false &&
        s.namesEnabled === false &&
        s.learningEnabled === false &&
        s.danceEnabled === false,
      "web2_installation_context_changed",
      503,
    );
  }
  function checkObservation(
    o: LinuxWeb2Observation,
    p: LinuxWeb2PlanSummary | null,
  ) {
    exact(object(o), [
      "planId",
      "planDigest",
      "installationId",
      "state",
      ...(Object.hasOwn(o, "reason") ? ["reason"] : []),
    ]);
    insist(
      p &&
        o.planId === p.planId &&
        o.planDigest === p.planDigest &&
        o.installationId === p.installationId &&
        ["prepared", "starting", "running", "unavailable"].includes(o.state),
      "web2_installation_context_changed",
      503,
    );
  }
  async function save() {
    const bytes = JSON.stringify(web2Wire(journal)) + "\n";
    insist(Buffer.byteLength(bytes) <= MAX, "web2_original_full", 409);
    const temporary = join(directory, `.web2-${randomUUID()}.tmp`),
      handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
      const parent = await open(directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      // Both files are durable before effects; a missing original on the next
      // construction cannot be silently treated as first use.
      await ensureMarker();
    } finally {
      await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
      });
    }
  }

  return { journal, save, checkInstallationPlan, checkObservation };
}
