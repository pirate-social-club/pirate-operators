import {
  createWeb2PublishingSetup,
  prepareWeb2WizardRegistration,
  type Web2PublishingInputs,
  type Web2PublishingView,
} from "./web2-publishing-setup.ts";
import {
  createWeb2StorageSetup,
  type Web2MediaStorageView,
  type Web2StorageOutcome,
} from "./web2-storage-setup.ts";
import type { CommunityMediaStorage } from "../../../deploy/linux/community-media-storage.ts";
import type {
  DnsView,
  Web2DnsSetup,
} from "./web2-dns-setup.ts";
import type { PublisherProofSigner } from "../../../deploy/linux/web2-operator-inputs.ts";
import { ownerOnly } from "../../../packages/community/owner-policy.ts";
import {
  createWeb2Journal,
  web2Wire as wire,
  type SelectionInput,
  type Phase,
} from "./web2-journal.ts";
import type { D1Database as HostedD1Database } from "@cloudflare/workers-types";
// The existing hosted engine uses the D1 type globally. Import only that type;
// do not replace this Node/browser project's Request and Response contracts.
declare global {
  interface D1Database extends HostedD1Database {}
}
import { isAddress, type Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  hashJson,
  hashText,
  insist,
  integer,
  object,
  text,
} from "../../../packages/community/common.ts";
import {
  address,
  httpsOrigin,
} from "../../../packages/community/manifest-core.ts";
import type { Web2CommunityConfig } from "../../../packages/community/web2-config-manifest.ts";
import {
  ownPolicy,
  parsePlan,
  planDocument,
  signature,
  type HostedPolicy,
} from "../../../packages/community/hosted-enrollment.ts";
import { initialRecipients } from "../../../packages/community/hosted-topup-chain.ts";
import { parseEnrollment } from "../../../packages/community/hosted-enrollment.ts";
import { createHostedEnrollmentClient } from "../../../packages/community-setup/hosted-enrollment-client.ts";
import {
  linuxWeb2DraftFrom,
  type HostedEnrollmentStatus,
  type LinuxWeb2Installation,
  type LinuxWeb2Observation,
  type LinuxWeb2PlanSummary,
} from "../../../packages/community-setup/linux-web2-profile.ts";
import type { Web2CommunityDeploymentProfile } from "../../../services/community-deployment-profile.ts";

function inputAddress(value: unknown, role: "controller" | "publisher") {
  insist(
    typeof value === "string" &&
      isAddress(value.trim(), { strict: true }) &&
      value.trim().toLowerCase() !== `0x${"0".repeat(40)}`,
    `web2_${role}_address_invalid`,
  );
  return address(value.trim().toLowerCase());
}
export interface Web2WizardView {
  schema: "pirate.web2-wizard-view/1";
  revision: number;
  phase: Phase;
  busy: boolean;
  signingOrigin:string|null;
  serverPublisher: {
    address: `0x${string}`;
    custodyBindingDigest: `0x${string}`;
  } | null;
  publishing: Web2PublishingView;
  notice: string;
  policy: {
    chainId: number;
    serviceOrigin: string;
    admissionPolicy: { version: string; sha256: string };
    controllerInitialWei: string;
    publisherInitialWei: string;
  };
  selection:
    | null
    | (SelectionInput & {
        communityId: Hex;
        installationId: Hex;
        configurationUri: string;
      });
  challenge: unknown | null;
  enrollment: HostedEnrollmentStatus | null;
  controllerAuthorized: boolean;
  fundingAuthorized: boolean;
  invitationCorrectionRequired: boolean;
  recipients: Array<{ address: Hex; value: string }>;
  installationAvailable: boolean;
  installPlan: LinuxWeb2PlanSummary | null;
  observation: LinuxWeb2Observation | null;
  /** Secret-free community media credential state. Null only where no vault
   * is configured at all; otherwise the exact committed generation state,
   * with the durable provider observation kept visibly separate. */
  mediaStorage: Web2MediaStorageView | null;
  /** Community-owned DNS verification state. Control proof and routing
   * observation are deliberately separate facts; null only where no DNS
   * module is configured. */
  dns: DnsView | null;
}
/** What an action reply adds to the view: storage actions carry their typed
 * outcome alongside the composed snapshot, so the browser never casts. */
export type Web2ActionView = Web2WizardView & {
  outcome?: Web2StorageOutcome;
};
export interface Web2SetupInputs {
  policy: HostedPolicy;
  /** Exact public HTTPS helper origin, from authenticated host configuration. */
  signingOrigin?:string;
  publisherProof?: PublisherProofSigner;
  publishing?: Web2PublishingInputs;
  notice: string;
  /** Actual shared deployment inputs, before any community exists. No dummy ID. */
  deployment: Omit<
    Web2CommunityDeploymentProfile,
    "schema" | "name" | "origin" | "planId" | "directoryProfile"
  >;
  configuration: {
    operatorPayments: Web2CommunityConfig["operatorPayments"];
    signingKeyId: string;
    policies: Web2CommunityConfig["policies"];
  };
  /** Real selected content transport. The deterministic URI is fixed before this effect. */
  pinConfiguration(input: {
    operationId: Hex;
    uri: string;
    bytes: Uint8Array;
    sha256: Hex;
  }): Promise<void>;
  installation?: LinuxWeb2Installation;
  /** Community-owned media credential custody, constructed by the bootstrap
   * with the real key channel. Absent only where no vault exists. */
  mediaStorage?: CommunityMediaStorage;
  dns?: Web2DnsSetup;
  /** Trusted persistent host identity; distinct from the Directory installation ID. */
  hostInstallationId?: string;
  transport?: typeof fetch;
  clock?: () => number;
}
export async function createWeb2Setup(
  directoryInput: string,
  input: Web2SetupInputs,
) {
  const policy = ownPolicy(input.policy),
    clock = input.clock ?? (() => Math.floor(Date.now() / 1000));
  insist(policy.deployment.chainId === 6343, "wrong_application_chain");
  insist(
    hashText(input.notice) === policy.noticeSha256,
    "hosted_notice_changed",
    503,
  );
  if (input.installation)
    insist(
      typeof input.hostInstallationId === "string" &&
        input.hostInstallationId.length > 0 &&
        input.hostInstallationId.length <= 256,
      "web2_host_identity_required",
      503,
    );
  const template = structuredClone(input.deployment),
    configuration = structuredClone(input.configuration);
  exact(object(template), [
    "postingPeriod",
    "rpcUrl",
    "ipfsGateways",
    "managedOrigin",
    "posts",
    "freshness",
  ]);
  exact(object(configuration), [
    "operatorPayments",
    "signingKeyId",
    "policies",
  ]);
  const notice = input.notice;
  const signingOrigin=input.signingOrigin === undefined ? null : httpsOrigin(input.signingOrigin);
  const { journal, save, checkInstallationPlan, checkObservation } =
    await createWeb2Journal(
      directoryInput,
      policy,
      input.hostInstallationId,
      clock,
    );
  const client = createHostedEnrollmentClient(policy, input.transport, clock);
  const publishing = await createWeb2PublishingSetup(directoryInput, {
    hostInstallationId: input.hostInstallationId,
    publisher: input.publisherProof,
    publishing: input.publishing,
    now: clock,
  });
  const serverPublisher = input.publisherProof
    ? await input.publisherProof.selected()
    : null;
  const storage = createWeb2StorageSetup({
    storage: input.mediaStorage ?? null,
  });
  // The vault is the durable record; this cache mirrors it for the synchronous
  // view. It refreshes at startup (restart recovery) and after each storage
  // action, the only paths through which generations change.
  let storageCache = await storage.read();
  let busy = false,
    active: Promise<unknown> = Promise.resolve();
  function snapshot(): Web2WizardView {
    const e = journal.prepared
      ? parseEnrollment(journal.prepared.enrollment)
      : null;
    return structuredClone({
      schema: "pirate.web2-wizard-view/1",
      revision: journal.revision,
      phase: journal.phase,
      busy,
      signingOrigin,
      serverPublisher,
      publishing: publishing.snapshot(),
      mediaStorage: storageCache,
      dns: input.dns?.snapshot() ?? null,
      notice,
      policy: {
        chainId: policy.deployment.chainId,
        serviceOrigin: policy.serviceOrigin,
        admissionPolicy: configuration.policies.admission,
        controllerInitialWei: policy.controllerInitialWei,
        publisherInitialWei: policy.publisherInitialWei,
      },
      selection:
        journal.request && journal.plan
          ? {
              ...journal.request,
              communityId: journal.plan.config.communityId,
              installationId: journal.plan.config.installationId,
              configurationUri: journal.plan.uri,
            }
          : null,
      challenge: journal.prepared?.typedData ?? null,
      enrollment: journal.enrollment,
      controllerAuthorized: Boolean(journal.controllerSignature),
      fundingAuthorized: Boolean(journal.recipientProofs),
      invitationCorrectionRequired: journal.invitationRefused,
      recipients: e
        ? initialRecipients(e, policy)
            .filter((r) => r.value > 0n)
            .map((r) => ({ address: r.address, value: String(r.value) }))
        : [],
      installationAvailable: Boolean(input.installation),
      installPlan: journal.installPlan,
      observation: journal.observation
        ? {
            planId: journal.observation.planId,
            planDigest: journal.observation.planDigest,
            installationId: journal.observation.installationId,
            state: journal.observation.state,
          }
        : null,
    });
  }
  function enrollmentDraft() {
    insist(
      journal.request &&
        journal.enrollment &&
        journal.deployment &&
        journal.plan,
      "safe_registration_required",
      409,
    );
    return linuxWeb2DraftFrom({
      schema: "pirate.linux-web2-draft/1",
      name: journal.request.name,
      origin: journal.request.origin,
      deployment: journal.deployment,
      enrollment: journal.enrollment,
      configuration: journal.plan.config,
    });
  }
  async function run(action: string, value: unknown) {
    const body = object(structuredClone(value));
    const revision = integer(body.revision, 0, Number.MAX_SAFE_INTEGER);
    insist(
      !busy && revision === journal.revision,
      "web2_revision_changed",
      409,
    );
    delete body.revision;
    busy = true;
    try {
      if (action === "resume-prepare") {
        exact(
          body,
          journal.invitationRefused ? ["inviteToken", "noticeAccepted"] : [],
        );
        insist(
          journal.request && journal.inviteToken,
          "web2_prepare_required",
          409,
        );
        // Only the operator-supplied roles carry forward: the community name
        // and origin are never body input anymore. Preparation re-derives them
        // from the DNS proof, and the original-selection consistency check
        // below refuses any drift from the journaled request.
        Object.assign(body, {
          controller: journal.request.controller,
          publisher: journal.request.publisher,
          inviteToken: journal.invitationRefused
            ? body.inviteToken
            : journal.inviteToken,
          noticeAccepted: journal.invitationRefused
            ? body.noticeAccepted
            : true,
        });
        action = "prepare";
      }
      if (action === "prepare") {
        exact(body, [
          "controller",
          "publisher",
          "inviteToken",
          "noticeAccepted",
        ]);
        insist(body.noticeAccepted === true, "pilot_notice_required", 409);
        // The community name and origin are never operator-typed at this
        // step: preparation consumes the DNS-proven selection, so the
        // enrollment can only ever be prepared for the hostname the operator
        // actually proved control of. The same origin is what the signing
        // window shows and what the registrar's installed-site check reads.
        insist(input.dns, "web2_dns_unavailable", 503);
        const dnsState = input.dns.snapshot();
        insist(
          dnsState.verifiedHostname !== null && dnsState.selection !== null,
          "web2_dns_control_required",
          409,
        );
        const selected: SelectionInput = {
          name: dnsState.selection.name,
          origin: httpsOrigin(`https://${dnsState.verifiedHostname}`),
          controller: inputAddress(body.controller, "controller"),
          publisher: inputAddress(body.publisher, "publisher"),
        };
        if (!journal.request) {
          insist(
            input.publisherProof && serverPublisher,
            "publisher_custody_binding_unavailable",
            503,
          );
          const selectedPublisher = await input.publisherProof.selected();
          insist(
            canonical(selectedPublisher) === canonical(serverPublisher) &&
              selected.publisher === serverPublisher.address &&
              selected.controller !== serverPublisher.address,
            "web2_server_publisher_changed",
            409,
          );
          insist(
            ownerOnly(configuration.policies.admission),
            "web2_first_song_configuration_required",
            409,
          );
        }
        const inviteToken = text(body.inviteToken, 1024);
        insist(/^[a-f0-9]{64}$/.test(inviteToken), "invalid_invite");
        if (journal.request) {
          insist(
            canonical(selected) === canonical(journal.request) &&
              (inviteToken === journal.inviteToken ||
                (journal.invitationRefused &&
                  !journal.prepared &&
                  journal.pending === null)),
            "web2_original_selection_changed",
            409,
          );
          journal.inviteToken = inviteToken;
          journal.invitationRefused = false;
        } else {
          const { plan, deployment } = await prepareWeb2WizardRegistration(
            policy,
            configuration,
            template,
            selected,
          );
          journal.request = selected;
          journal.inviteToken = inviteToken;
          journal.plan = wire(planDocument(plan));
          journal.deployment = deployment;
        }
        if (!journal.prepared) {
          // Fence every attempt, including a retry after a failed earlier save.
          journal.revision++;
          journal.pending = "prepare";
          journal.phase = "pending";
          await save();
          const plan = parsePlan(journal.plan),
            bytes = new TextEncoder().encode(canonical(plan.config));
          await input.pinConfiguration({
            operationId: plan.commitment,
            uri: plan.uri,
            bytes,
            sha256: hashJson(plan.config),
          });
          journal.prepared = await client.prepare(plan, journal.inviteToken!);
        }
        journal.phase = "prepared";
      } else if (
        action === "redeem" ||
        action === "topup" ||
        action === "reconcile"
      ) {
        exact(
          body,
          action === "redeem" && Object.hasOwn(body, "signature")
            ? ["signature"]
            : action === "topup" && Object.hasOwn(body, "proofs")
              ? ["proofs"]
              : [],
        );
        insist(journal.prepared, "web2_prepare_required", 409);
        if (action === "redeem" && Object.hasOwn(body, "signature")) {
          insist(
            journal.rejectedAuthorizations.length < 32,
            "web2_authorization_limit",
            409,
          );
          const proof = signature(body.signature);
          insist(
            journal.controllerSignature === null ||
              journal.controllerSignature === proof,
            "web2_original_authorization_changed",
            409,
          );
          journal.controllerSignature = proof;
        }
        insist(
          journal.controllerSignature,
          "web2_controller_proof_required",
          409,
        );
        if (action === "topup" && Object.hasOwn(body, "proofs")) {
          insist(
            journal.recipientProofs !== null &&
              canonical(body.proofs) === canonical(journal.recipientProofs),
            "web2_browser_publisher_proof_refused",
            403,
          );
          insist(
            Array.isArray(body.proofs) && body.proofs.length <= 2,
            "recipient_proofs_required",
          );
          const proofs = body.proofs.map((value) => {
            const p = object(value);
            exact(p, ["recipient", "signature"]);
            return {
              recipient: address(p.recipient),
              signature: signature(p.signature),
            };
          });
          insist(
            journal.recipientProofs === null ||
              canonical(proofs) === canonical(journal.recipientProofs),
            "web2_original_authorization_changed",
            409,
          );
          journal.recipientProofs = proofs;
        }
        if (action === "topup" && !journal.recipientProofs) {
          insist(
            input.publisherProof && serverPublisher,
            "publisher_custody_binding_unavailable",
            503,
          );
          const e = parseEnrollment(journal.prepared.enrollment),
            proofs = [];
          for (const r of initialRecipients(e, policy).filter(
            (r) => r.value > 0n,
          )) {
            if (r.address === e.plan.config.controller)
              proofs.push({
                recipient: r.address,
                signature: journal.controllerSignature,
              });
            else {
              insist(
                r.address === serverPublisher.address,
                "web2_server_publisher_changed",
                409,
              );
              const proof = await input.publisherProof.signEnrollment({
                operationId: hashJson({
                  enrollmentId: e.id,
                  purpose: "publisher-enrollment-proof",
                  custodyBindingDigest: serverPublisher.custodyBindingDigest,
                }),
                prepared: structuredClone(journal.prepared),
              });
              insist(
                proof.recipient === r.address,
                "web2_server_publisher_changed",
                409,
              );
              proofs.push({
                recipient: r.address,
                signature: signature(proof.signature),
              });
            }
          }
          journal.recipientProofs = proofs;
          await save();
        }
        if (action === "topup")
          insist(journal.recipientProofs, "recipient_proofs_required", 409);
        journal.revision++;
        journal.pending = action;
        journal.phase = "pending";
        await save();
        journal.enrollment =
          action === "redeem"
            ? await client.redeem(journal.prepared, journal.controllerSignature)
            : action === "topup"
              ? await client.topup(
                  journal.prepared,
                  journal.controllerSignature,
                  journal.recipientProofs,
                )
              : await client.status(
                  journal.prepared,
                  journal.controllerSignature,
                );
        journal.phase =
          journal.observation?.state === "running"
            ? "running"
            : journal.enrollment.operations.length > 1 &&
                journal.enrollment.operations.every(
                  (o) => o.state === "consumed",
                )
              ? "funded"
              : journal.enrollment.operations.some(
                    (o) => o.kind === "registration" && o.state === "consumed",
                  )
                ? "registered"
                : "pending";
      } else if (action.startsWith("publishing-")) {
        insist(
          journal.request &&
            journal.enrollment &&
            journal.deployment &&
            journal.plan,
          "safe_registration_required",
          409,
        );
        const draft = enrollmentDraft();
        await publishing.act(action, body, draft);
      } else if (
        action === "installation-prepare" ||
        action === "install" ||
        action === "installation-status"
      ) {
        insist(input.installation, "web2_installation_unavailable", 503);
        exact(
          body,
          action === "install" ? ["planId", "planDigest", "approved"] : [],
        );
        if (action !== "installation-prepare")
          insist(journal.installPlan, "web2_installation_review_required", 409);
        await publishing.attachment(enrollmentDraft());
        if (!journal.installDraft) journal.installDraft = enrollmentDraft();
        journal.revision++;
        journal.pending = action;
        await save();
        if (!journal.installPlan) {
          const proposed = await input.installation.prepare(
            structuredClone(journal.installDraft),
          );
          checkInstallationPlan(proposed, journal.installDraft);
          journal.installPlan = proposed;
          await save();
        }
        const p = journal.installPlan;
        checkInstallationPlan(p, journal.installDraft);
        const selection = { planId: p.planId, planDigest: p.planDigest };
        if (action === "install")
          insist(
            body.approved === true &&
              body.planId === p.planId &&
              body.planDigest === p.planDigest,
            "web2_installation_review_changed",
            409,
          );
        if (action !== "installation-prepare") {
          const observation =
            action === "install"
              ? await input.installation.apply(selection)
              : await input.installation.status(selection);
          checkObservation(observation, p);
          journal.observation = observation;
          journal.phase =
            observation.state === "running" ? "running" : "pending";
        }
      } else insist(false, "unknown_web2_action", 404);
      journal.pending = null;
      journal.revision++;
      await save();
    } catch (error) {
      if (
        error instanceof CommunityError &&
        error.code === "hosted_invitation_refused"
      ) {
        journal.invitationRefused = true;
        journal.pending = null;
        journal.phase = "pending";
      }
      if (
        error instanceof CommunityError &&
        error.code === "hosted_authorization_refused"
      ) {
        journal.rejectedAuthorizations.push(
          structuredClone({
            controller: journal.controllerSignature,
            recipients: journal.recipientProofs,
          }),
        );
        journal.controllerSignature = null;
        journal.recipientProofs = null;
        journal.pending = null;
        journal.phase = journal.enrollment ? "registered" : "prepared";
      }
      if (journal.pending) journal.phase = "unknown";
      journal.revision++;
      await save();
      if (
        !(
          error instanceof CommunityError &&
          error.code === "hosted_acknowledgement_unknown"
        )
      )
        throw error;
    } finally {
      busy = false;
    }
    return snapshot();
  }
  // Storage actions never touch the enrollment journal: the vault carries
  // its own immutable generations, so no revision fencing or journal mutation
  // applies. They share the busy serialization so a storage effect cannot
  // interleave with an enrollment effect mid-write.
  async function runStorage(action: string, value: unknown) {
    const body = object(structuredClone(value));
    delete body.revision;
    busy = true;
    let outcome: Web2StorageOutcome;
    try {
      outcome = await storage.act(action, body);
      storageCache = await storage.read();
    } finally {
      busy = false;
    }
    // The snapshot is composed only after busy clears: the operator must never
    // receive a completed outcome wrapped in a still-busy view.
    const view: Web2ActionView = Object.assign(snapshot(), { outcome });
    return view;
  }
  // DNS actions never touch the enrollment journal: the DNS module carries
  // its own journaled proof state, and verification must be possible before
  // any wallet connection or enrollment preparation. They share the busy
  // serialization for the same reason storage actions do.
  async function runDns(action: string, value: unknown) {
    insist(input.dns, "web2_dns_unavailable", 503);
    const dns = input.dns;
    const body = object(structuredClone(value));
    delete body.revision;
    busy = true;
    try {
      if (action === "dns-select") await dns.select(body);
      else if (action === "dns-check") await dns.check();
      else throw new CommunityError("web2_action_unknown", 400);
    } finally {
      busy = false;
    }
    return snapshot();
  }
  return {
    snapshot,
    publishingAttachment: publishing.attachment,
    send(action: string, value: unknown) {
      if (busy)
        return Promise.reject(new CommunityError("web2_revision_changed", 409));
      const task = action.startsWith("storage-")
        ? runStorage(action, value)
        : action.startsWith("dns-")
          ? runDns(action, value)
          : run(action, value);
      active = task.catch(() => {});
      return task;
    },
    async settled() {
      await active;
    },
  };
}
export type Web2Setup = Awaited<ReturnType<typeof createWeb2Setup>>;
