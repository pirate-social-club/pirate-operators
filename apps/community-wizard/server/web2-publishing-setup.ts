import type { Web2SetupInputs } from "./web2-setup.ts";
import type { SelectionInput } from "./web2-journal.ts";
import { publicId } from "../../../packages/community/common.ts";
import { directoryInstanceId } from "../../../packages/community/shared-identity.ts";
import {
  parseWeb2ProfileDocument as parseProfile,
  web2ProfileDocument,
} from "../../../packages/community/web2-directory.ts";
import { validateWeb2Configuration, type Web2CommunityConfig } from "../../../packages/community/web2-config-manifest.ts";
import { preparePin } from "../../../packages/community/ipfs.ts";
import { prepareWeb2Registration } from "../../../packages/community/web2-registration-chain.ts";
import {
  assertDeployment,
  type HostedPolicy,
} from "../../../packages/community/hosted-enrollment.ts";
import {
  isWeb2Deployment,
  validateCommunityDeploymentProfile,
} from "../../../services/community-deployment-profile.ts";
import type { Address, Hex } from "viem";
import {
  canonical,
  CommunityError,
  exact,
  hashJson,
  insist,
  object,
} from "../../../packages/community/common.ts";
import { address } from "../../../packages/community/manifest-core.ts";
import { ownerOnly } from "../../../packages/community/owner-policy.ts";
import { ownerAuthorizationTypedData, ownerAuthorizationRecord } from "../../../packages/community/owner-authorization-typed-data.ts";
import { validateOwnerAuthorization, requireAuthorizedOwner } from "../../../packages/community/owner-authorization.ts";
import { readWeb2Community } from "../../../packages/community/web2-directory-reader.ts";
import { parseWeb2ProfileDocument } from "../../../packages/community/web2-directory.ts";
import type { LinuxWeb2Draft } from "../../../packages/community-setup/linux-web2-profile.ts";
import {
  authenticateWeb2Enrollment,
  ownWeb2ChainAuthority,
  type Web2ChainAuthority,
} from "../../../deploy/linux/web2-profile-authority.ts";
import {
  configuredGrantSelection,
  publishingAttachment,
  requireGrantObservation,
} from "../../../deploy/linux/web2-publishing-attachment.ts";
import type {
  ManagedOwnerGrantPort,
  OwnerGrantScope,
  PublisherProofSigner,
  Web2PublishingAttachment,
} from "../../../deploy/linux/web2-operator-inputs.ts";
import { createWeb2SigningJournal } from "./web2-signing-journal.ts";
import { web2Wire } from "./web2-journal.ts";

export interface Web2PublishingInputs {
  chain: Web2ChainAuthority;
  grants: ManagedOwnerGrantPort;
}
export type Web2PublishingView = ReturnType<
  Awaited<ReturnType<typeof createWeb2PublishingSetup>>["snapshot"]
>;

export async function createWeb2PublishingSetup(
  directory: string,
  input: {
    hostInstallationId?: string;
    publisher?: PublisherProofSigner;
    publishing?: Web2PublishingInputs;
    now(): number;
  },
) {
  const journal = await createWeb2SigningJournal(directory),
    chain = input.publishing
      ? ownWeb2ChainAuthority(input.publishing.chain)
      : null;
  function snapshot() {
    const j = journal.value;
    if (!j) return null;
    insist(chain, "web2_publishing_authority_unavailable", 503);
    const typedData = web2Wire(
      ownerAuthorizationTypedData(j.authorization, {
        schema: "pirate.community-config/4",
        chainId: j.selection.scope.chainId,
        directory: chain.deployment.directory,
        communityId: j.selection.scope.communityId,
      }),
    );
    return {
      // The authenticated admission reference remains service-side.
      selection: {
        grant: j.selection.grant,
        selectionDigest: j.selection.selectionDigest,
      },
      authorization: j.authorization,
      typedData,
      requestDigest: hashJson(typedData),
      live:input.now()>=j.authorization.validFrom&&input.now()<j.authorization.expiresAt,
      authorized: Boolean(j.accepted),
      attached: Boolean(j.attachment),
      pending: j.attachmentPending,
    };
  }
  async function context(draft: LinuxWeb2Draft, ownerWallet: Address) {
    insist(
      chain && input.publisher && input.publishing && input.hostInstallationId,
      "web2_publishing_authority_unavailable",
      503,
    );
    await authenticateWeb2Enrollment(chain, draft);
    const config = draft.configuration;
    insist(
      config.configurationRevision === 1 &&
        config.chainId === 6343 &&
        ownerOnly(config.policies.admission),
      "web2_first_song_configuration_required",
      409,
    );
    const selected = await input.publisher.selected();
    insist(
      selected.address === config.publisher &&
        selected.address !== config.controller,
      "web2_server_publisher_changed",
      409,
    );
    const scope: OwnerGrantScope = {
      schema: "pirate.web2-owner-grant-scope/1",
      enrollmentId: draft.enrollment.enrollmentId,
      installationId: config.installationId,
      hostInstallationId: input.hostInstallationId,
      deploymentDigest: hashJson(draft.deployment),
      communityId: config.communityId,
      origin: config.app.origin,
      controller: config.controller,
      ownerWallet,
      policy: config.policies.admission,
      chainId: 6343,
      postsContract: config.postsContract,
      publisher: config.publisher,
    };
    const currentConfiguration = async () => {
      const read = await readWeb2Community(
        chain.client,
        parseWeb2ProfileDocument(draft.deployment.directoryProfile),
        {
          now: chain.now,
          maxSafeBlockAgeSeconds: chain.maxSafeBlockAgeSeconds,
        },
        chain.send,
      );
      insist(
        read.eligibility.status === "available" &&
          canonical(read.config) === canonical(config),
        "web2_first_song_configuration_changed",
        409,
      );
      return read.config;
    };
    await currentConfiguration();
    return {
      config,
      scope,
      selected,
      verification: {
        client: chain.client,
        currentConfiguration,
        now: input.now,
        maxSafeBlockAgeSeconds: chain.maxSafeBlockAgeSeconds,
      },
    };
  }
  async function reselect(draft: LinuxWeb2Draft) {
    await journal.reload();
    const j = journal.value;
    insist(j, "web2_publishing_review_required", 409);
    const c = await context(draft, j.selection.scope.ownerWallet);
    const selected = configuredGrantSelection(
      await input.publishing!.grants.prepare(structuredClone(c.scope)),
      c.scope,
    );
    insist(
      canonical(selected) === canonical(j.selection) &&
        j.custodyBindingDigest === c.selected.custodyBindingDigest,
      "web2_configured_grant_changed",
      409,
    );
    insist(
      j.authorization.schema === "pirate.owner-publishing-authorization/2" &&
        j.authorization.communityId === j.selection.grant.communityId &&
        j.authorization.ownerWallet === j.selection.grant.ownerWallet &&
        canonical(j.authorization.policy) ===
          canonical(j.selection.grant.policy) &&
        j.authorization.validFrom === j.selection.grant.validFrom &&
        j.authorization.expiresAt === j.selection.grant.expiresAt,
      "web2_original_authorization_changed",
      409,
    );
    await c.verification.currentConfiguration();
    return { j, c };
  }
  async function act(
    action: string,
    body: Record<string, unknown>,
    draft: LinuxWeb2Draft,
  ) {
    await journal.reload();
    if (action === "publishing-prepare") {
      exact(body, ["ownerWallet", "rolesReviewed"]);
      insist(body.rolesReviewed === true, "web2_roles_review_required", 409);
      const ownerWallet = address(body.ownerWallet);
      const previous = journal.value;
      if (previous) {
        insist(
          previous.selection.scope.ownerWallet === ownerWallet,
          "web2_original_owner_nomination_changed",
          409,
        );
        await reselect(draft);
        return;
      }
      const c = await context(draft, ownerWallet),
        selection = configuredGrantSelection(
          await input.publishing!.grants.prepare(structuredClone(c.scope)),
          c.scope,
        ),
        grant = selection.grant;
      await c.verification.currentConfiguration();
      insist(
        canonical(await input.publisher!.selected()) === canonical(c.selected),
        "publisher_custody_binding_changed",
        409,
      );
      insist(
        input.now() >= grant.validFrom && input.now() < grant.expiresAt,
        "owner_grant_outside_window",
        403,
      );
      await journal.save({
        schema: "pirate.web2-signing-sidecar/1",
        selection,
        custodyBindingDigest: c.selected.custodyBindingDigest,
        authorization: {
          schema: "pirate.owner-publishing-authorization/2",
          communityId: grant.communityId,
          ownerWallet: grant.ownerWallet,
          policy: grant.policy,
          validFrom: grant.validFrom,
          expiresAt: grant.expiresAt,
        },
        accepted: null,
        attachmentPending: false,
        attachment: null,
      });
      return;
    }
    // Reject replacement bytes before any provider interaction.
    const saved = journal.value;
    insist(saved, "web2_publishing_review_required", 409);
    if (action === "publishing-authorize") {
      exact(body, ["signature", "requestDigest", "reviewed"]);
      insist(
        body.reviewed === true &&
          body.requestDigest === snapshot()!.requestDigest,
        "web2_owner_review_changed",
        409,
      );
      if (saved.accepted)
        insist(
          body.signature === saved.accepted.signature,
          "web2_original_authorization_changed",
          409,
        );
    } else exact(body, []);
    const { j, c } = await reselect(draft);
    if (action === "publishing-authorize") {
      if (j.accepted) return;
      const accepted=ownerAuthorizationRecord({authorization:j.authorization,signature:body.signature});
      await requireAuthorizedOwner(accepted,c.config,j.authorization.ownerWallet,undefined,c.verification);
      await journal.save({ ...j, accepted });
      return;
    }
    insist(
      action === "publishing-attach" || action === "publishing-reconcile",
      "unknown_web2_action",
      404,
    );
    const port = input.publishing!.grants;
    if (!j.accepted) {
      await port.reconcile(j.selection.selectionDigest);
      return;
    }
    await validateOwnerAuthorization(j.accepted, c.config, c.verification);
    // Retain before attach. After an unknown reply, reconcile the original
    // before any retry. The configured service owns its idempotency/admission.
    let observation = requireGrantObservation(
      await port.reconcile(j.selection.selectionDigest),
      j.selection,
    );
    if (action === "publishing-attach" && observation.state === "absent") {
      await requireAuthorizedOwner(j.accepted,c.config,j.authorization.ownerWallet,undefined,c.verification);
      await journal.save({ ...j, attachmentPending: true });
      insist(
        input.now() >= j.authorization.validFrom &&
          input.now() < j.authorization.expiresAt,
        "owner_authorization_outside_window",
        403,
      );
      try {
        observation = requireGrantObservation(
          await port.attach(j.selection.selectionDigest),
          j.selection,
        );
      } catch (error) {
        if (error instanceof CommunityError) throw error;
        throw new CommunityError(
          "web2_managed_grant_admission_unavailable",
          503,
        );
      }
    }
    if(observation.state === "absent") {
      // Authenticated absence releases only the pending-attempt hold. It never
      // replaces the selected grant, accepted bytes or signed window.
      await journal.save({...j,attachmentPending:false});
      return;
    }
    insist(
      observation.state === "attached",
      "web2_managed_grant_admission_unavailable",
      503,
    );
    await validateOwnerAuthorization(j.accepted, c.config, c.verification);
    const original = {
      schema: "pirate.web2-publishing-attachment/1" as const,
      selection: j.selection,
      authorization: j.accepted,
      custodyBindingDigest: j.custodyBindingDigest,
    };
    const attachment = publishingAttachment({
      ...original,
      digest: hashJson(original),
    });
    await journal.save({ ...j, attachmentPending: false, attachment });
  }
  return {
    snapshot,
    act,
    async attachment(draft: LinuxWeb2Draft): Promise<Web2PublishingAttachment> {
      const { j, c } = await reselect(draft);
      insist(
        j.attachment && j.accepted,
        "web2_publishing_attachment_required",
        409,
      );
      const observation = requireGrantObservation(
        await input.publishing!.grants.reconcile(j.selection.selectionDigest),
        j.selection,
      );
      insist(
        observation.state === "attached",
        "web2_managed_grant_admission_unavailable",
        503,
      );
      await requireAuthorizedOwner(j.accepted,c.config,j.authorization.ownerWallet,undefined,c.verification);
      return publishingAttachment(j.attachment);
    },
    /** Post-registration recheck for the already-bound native owner grant.
     * It is deliberately separate from browser prepare and attach. */
    async retainedExpandedAttachment(draft: LinuxWeb2Draft, original: Web2PublishingAttachment,
      readCurrent: () => Promise<Web2CommunityConfig>) {
      insist(chain && input.publishing && input.publisher, "web2_publishing_authority_unavailable", 503);
      await journal.reload();
      const j = journal.value, captured = publishingAttachment(original);
      insist(j?.attachment && j.accepted && !j.attachmentPending && canonical(j.attachment) === canonical(captured) &&
        canonical(j.selection) === canonical(captured.selection) && canonical(j.accepted) === canonical(captured.authorization) &&
        canonical(j.authorization) === canonical(captured.authorization.authorization) &&
        j.selection.scope.communityId === draft.configuration.communityId &&
        j.selection.scope.installationId === draft.configuration.installationId,
        "web2_publishing_attachment_changed", 409);
      const currentConfiguration = async () => {
        const config = await readCurrent();
        insist(config.configurationRevision === 2 && config.learningRecords !== draft.configuration.learningRecords &&
          canonical({ ...config, configurationRevision: 1, learningRecords: draft.configuration.learningRecords }) ===
            canonical(draft.configuration), "web2_expanded_publishing_scope_changed", 409);
        return config;
      };
      const assertCustody = async () => {
        const selected = await input.publisher!.selected();
        insist(selected.address === draft.configuration.publisher &&
          selected.custodyBindingDigest === captured.custodyBindingDigest, "publisher_custody_binding_changed", 409);
      };
      await assertCustody();
      const observed = requireGrantObservation(
        await input.publishing.grants.reconcile(captured.selection.selectionDigest), captured.selection);
      insist(observed.state === "attached", "web2_managed_grant_admission_unavailable", 503);
      const config = await currentConfiguration();
      const authorization = await requireAuthorizedOwner(j.accepted, config, j.authorization.ownerWallet, undefined, {
        client: chain.client, currentConfiguration, now: input.now, maxSafeBlockAgeSeconds: chain.maxSafeBlockAgeSeconds,
      });
      await assertCustody();
      await journal.reload();
      insist(canonical(journal.value) === canonical(j), "web2_publishing_attachment_changed", 409);
      await currentConfiguration();
      const now = input.now();
      insist(now >= authorization.validFrom && now < authorization.expiresAt, "owner_authorization_outside_window", 403);
      return captured;
    },
  };
}

/** Revision 1 is the approved first-song policy. The registrar publishes it
 * during registration; no controller configuration transaction is invented. */
export async function prepareWeb2WizardRegistration(
  policy: HostedPolicy,
  configuration: Web2SetupInputs["configuration"],
  template: Web2SetupInputs["deployment"],
  selected: SelectionInput,
) {
  const communityKey = publicId(),
    installationId = publicId();
  const profile = parseProfile({
    ...policy.deployment,
    deploymentBlock: String(policy.deployment.deploymentBlock),
    communityKey,
    installationId,
    communityId: directoryInstanceId(policy.deployment.chainId, communityKey),
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
      app: { label: selected.name, origin: selected.origin },
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
    name: selected.name,
    origin: selected.origin,
    planId: plan.commitment.slice(2),
    directoryProfile: web2ProfileDocument(profile),
  });
  insist(isWeb2Deployment(deployment), "web2_deployment_required");
  return { plan, deployment };
}
