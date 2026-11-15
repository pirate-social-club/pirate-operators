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
import type { Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  hashJson,
  hashText,
  insist,
  integer,
  object,
  publicId,
  text,
} from "../../../packages/community/common.ts";
import {
  address,
  httpsOrigin,
} from "../../../packages/community/manifest-core.ts";
import { directoryInstanceId } from "../../../packages/community/shared-identity.ts";
import {
  parseWeb2ProfileDocument,
  web2ProfileDocument,
} from "../../../packages/community/web2-directory.ts";
import {
  validateWeb2Configuration,
  type Web2CommunityConfig,
} from "../../../packages/community/web2-config-manifest.ts";
import { preparePin } from "../../../packages/community/ipfs.ts";
import { prepareWeb2Registration } from "../../../packages/community/web2-registration-chain.ts";
import {
  assertDeployment,
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
import {
  isWeb2Deployment,
  validateCommunityDeploymentProfile,
  type Web2CommunityDeploymentProfile,
} from "../../../services/community-deployment-profile.ts";

export interface Web2WizardView {
  schema: "pirate.web2-wizard-view/1";
  revision: number;
  phase: Phase;
  busy: boolean;
  notice: string;
  policy: {
    chainId: number;
    serviceOrigin: string;
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
}
export interface Web2SetupInputs {
  policy: HostedPolicy;
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
  const { journal, save, checkInstallationPlan, checkObservation } =
    await createWeb2Journal(
      directoryInput,
      policy,
      input.hostInstallationId,
      clock,
    );
  const client = createHostedEnrollmentClient(policy, input.transport, clock);
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
      notice,
      policy: {
        chainId: policy.deployment.chainId,
        serviceOrigin: policy.serviceOrigin,
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
          controller: address(body.controller),
          publisher: address(body.publisher),
        };
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
          const communityKey = publicId(),
            installationId = publicId();
          const profile = parseWeb2ProfileDocument({
            ...policy.deployment,
            deploymentBlock: String(policy.deployment.deploymentBlock),
            communityKey,
            installationId,
            communityId: directoryInstanceId(
              policy.deployment.chainId,
              communityKey,
            ),
          });
          const config = validateWeb2Configuration(
            {
              schema: "pirate.community-config/4",
              chainId: profile.chainId,
              directory: profile.directory,
              communityKey,
              communityId: profile.communityId,
              installationId,
              controller: selected.controller,
              publisher: selected.publisher,
              configurationRevision: 1,
              postsContract: template.posts.address,
              operatorPayments: configuration.operatorPayments,
              learningRecords: "0x0000000000000000000000000000000000000000",
              app: { label: name, origin: selected.origin },
              feed: {
                signingKeyId: configuration.signingKeyId,
                endpoint: selected.origin + "/api/feed",
              },
              policies: configuration.policies,
              publisherRevocations: [],
            },
            profile,
          );
          const pin = await preparePin(
            new TextEncoder().encode(canonical(config)),
            "application/json",
          );
          const plan = prepareWeb2Registration(
            profile,
            config,
            pin.uri,
            policy.registrar,
            BigInt(policy.registrarRevision),
          );
          assertDeployment(policy, plan);
          const deployment = validateCommunityDeploymentProfile({
            ...template,
            schema: "pirate.community-deployment/2",
            name,
            origin: selected.origin,
            planId: plan.commitment.slice(2),
            directoryProfile: web2ProfileDocument(profile),
          });
          insist(isWeb2Deployment(deployment), "web2_deployment_required");
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
        if (!journal.installDraft) {
          insist(
            journal.request &&
              journal.enrollment &&
              journal.deployment &&
              journal.plan,
            "safe_registration_required",
            409,
          );
          journal.installDraft = linuxWeb2DraftFrom({
            schema: "pirate.linux-web2-draft/1",
            name: journal.request.name,
            origin: journal.request.origin,
            deployment: journal.deployment,
            enrollment: journal.enrollment,
            configuration: journal.plan.config,
          });
        }
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
  return {
    snapshot,
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
