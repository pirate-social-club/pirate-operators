import {
  createWeb2PublishingSetup,
  prepareWeb2WizardRegistration,
  type Web2PublishingInputs,
  type Web2PublishingView,
} from "./web2-publishing-setup.ts";
import type { Web2FilebaseCredentials, Web2FilebaseView } from "./web2-filebase-credentials.ts";
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
import { sharedBytes32 } from "../../../packages/community/shared-identity.ts";
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
  isWeb2PracticeSelection,
  type Web2PracticeSelection,
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
  pairingOnly?: true;
  signingOrigin:string|null;
  serverPublisher: {
    address: `0x${string}`;
    custodyBindingDigest: `0x${string}`;
  } | null;
  publishing: Web2PublishingView;
  filebase?: Web2FilebaseView;
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
  privateStudyAvailable?: true;
  privatePracticeSelection?: Web2PracticeSelection;
  installationSelection?: "off" | Web2PracticeSelection;
  installPlan: LinuxWeb2PlanSummary | null;
  observation: LinuxWeb2Observation | null;
}
export interface Web2SetupInputs {
  policy: HostedPolicy;
  pairingOnly?: true;
  /** Exact public HTTPS helper origin, from authenticated host configuration. */
  signingOrigin?:string;
  /** In restricted custody, select the publisher through the admitted identity-only broker. */
  publisherIdentity?: Pick<PublisherProofSigner, "selected">;
  /** Native publisher authorization is needed only when obtaining its enrollment proof. */
  publisherProof?: PublisherProofSigner;
  publishing?: Web2PublishingInputs;
  filebaseCredentials?: Web2FilebaseCredentials;
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
  const pairingOnly = input.pairingOnly === true;
  insist(!pairingOnly || !input.installation, "web2_pairing_only", 403);
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
  const publisherIdentity = input.publisherIdentity ?? input.publisherProof;
  async function selectPublisher() {
    insist(publisherIdentity, "publisher_custody_binding_unavailable", 503);
    const selected = await publisherIdentity.selected();
    exact(object(selected), ["address", "custodyBindingDigest"]);
    return {
      address: address(selected.address),
      custodyBindingDigest: sharedBytes32(selected.custodyBindingDigest),
    };
  }
  const publishing = await createWeb2PublishingSetup(directoryInput, {
    hostInstallationId: input.hostInstallationId,
    publisher: publisherIdentity && { selected: selectPublisher },
    publishing: input.publishing,
    now: clock,
  });
  const serverPublisher = publisherIdentity ? await selectPublisher() : null;
  const filebase = pairingOnly ? undefined : input.filebaseCredentials;
  await filebase?.restore();
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
      ...(pairingOnly ? { pairingOnly: true as const } : {}),
      signingOrigin,
      serverPublisher,
      publishing: publishing.snapshot(),
      ...(filebase ? { filebase: filebase.snapshot() } : {}),
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
      ...(input.installation?.privateStudyAvailable === true ? { privateStudyAvailable: true as const } : {}),
      ...(input.installation?.privatePracticeSelection ? { privatePracticeSelection: input.installation.privatePracticeSelection } : {}),
      ...(journal.installDraft ? { installationSelection: journal.installDraft.privatePractice ?? "off" as const } : {}),
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
    insist(!pairingOnly, "web2_pairing_only", 403);
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
      if (action === "filebase-check" || action === "filebase-save") {
        insist(filebase, "web2_filebase_onboarding_unavailable", 503);
        if (action === "filebase-check") {
          exact(body, []);
          await filebase.connect();
        } else {
          exact(body, ["token"]);
          await filebase.save(body.token);
          journal.revision++;
          await save();
        }
      } else {
        if (!journal.prepared && (action === "prepare" || action === "resume-prepare"))
          await filebase?.assertReady();
        await runSetupAction(action, body);
      }
    } finally {
      busy = false;
    }
    return snapshot();
  }
  async function runSetupAction(action: string, body: Record<string, unknown>) {
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
        Object.assign(body, journal.request, {
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
          "name",
          "origin",
          "controller",
          "publisher",
          "inviteToken",
          "noticeAccepted",
        ]);
        insist(body.noticeAccepted === true, "pilot_notice_required", 409);
        const name = text(body.name, 63);
        insist(!/[<>\x00-\x1f]/.test(name), "invalid_community_name");
        const selected: SelectionInput = {
          name,
          origin: httpsOrigin(body.origin),
          controller: inputAddress(body.controller, "controller"),
          publisher: inputAddress(body.publisher, "publisher"),
        };
        if (!journal.request) {
          insist(
            serverPublisher,
            "publisher_custody_binding_unavailable",
            503,
          );
          const selectedPublisher = await selectPublisher();
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
              // A retained signature may come from a redeem whose outcome is unknown.
              const observed = await client.status(journal.prepared, journal.controllerSignature);
              insist(
                observed.operations.some(op => op.kind === "registration" && op.state === "consumed"),
                "safe_registration_required",
                409,
              );
              const currentPublisher = await selectPublisher();
              insist(
                r.address === serverPublisher.address &&
                  canonical(currentPublisher) === canonical(serverPublisher),
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
          action === "install" ? ["planId", "planDigest", "approved"] :
            action === "installation-prepare" && Object.hasOwn(body, "privatePractice") ? ["privatePractice"] : [],
        );
        if (action !== "installation-prepare")
          insist(journal.installPlan, "web2_installation_review_required", 409);
        const draft = enrollmentDraft();
        if (action === "installation-prepare") {
          insist(!Object.hasOwn(body, "privatePractice") || isWeb2PracticeSelection(body.privatePractice),
            "web2_private_practice_selection_invalid", 409);
          const selection = isWeb2PracticeSelection(body.privatePractice) ? body.privatePractice : undefined;
          if (journal.installDraft)
            insist(journal.installDraft.privatePractice === selection,
              "web2_original_practice_selection_changed", 409);
          if (selection)
            insist((input.installation.privatePracticeSelection ??
              (input.installation.privateStudyAvailable === true ? "study-v5" : undefined)) === selection,
              "web2_private_study_unavailable", 503);
          if (selection) draft.privatePractice = selection;
        }
        const retained = action !== "installation-prepare" ? journal.installPlan : null;
        if (retained && action === "install")
          insist(body.approved === true && body.planId === retained.planId && body.planDigest === retained.planDigest,
            "web2_installation_review_changed", 409);
        // Only the installed backend can verify the original grant after the
        // signed revision-two transition. Initial preparation and all other
        // paths keep the ordinary revision-one check.
        const expanded = retained && input.installation.verifyExpandedPublishing
          ? await input.installation.verifyExpandedPublishing({ planId: retained.planId, planDigest: retained.planDigest },
              structuredClone(journal.installDraft ?? draft))
          : undefined;
        if (expanded !== "expanded") await publishing.attachment(draft);
        if (!journal.installDraft) journal.installDraft = draft;
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
    }
  }
  return {
    snapshot,
    publishingAttachment: publishing.attachment,
    send(action: string, value: unknown) {
      if (busy)
        return Promise.reject(new CommunityError("web2_revision_changed", 409));
      const task = run(action, value);
      active = task.catch(() => {});
      return task;
    },
    async settled() {
      await active;
    },
  };
}
export type Web2Setup = Awaited<ReturnType<typeof createWeb2Setup>>;
