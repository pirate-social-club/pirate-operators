import { canonical, hashJson } from "../../packages/community/common.ts";
import { ownerOnly } from "../../packages/community/owner-policy.ts";
import {
  createWeb2PublishingSetup,
  createWeb2RetainedPublishingReconciler,
} from "../../apps/community-wizard/server/web2-publishing-setup.ts";
import { publishingAttachment } from "./web2-publishing-attachment.ts";
import type { ManagedOwnerGrantPort, PublisherProofSigner, Web2PublishingAttachment } from "./web2-operator-inputs.ts";
/** One-time host binding AFTER the Wizard retains its genuine enrollment.
 * Bootstrap bytes carry no community ID. No request chooses paths or issuers. */
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  linuxWeb2DraftFrom,
  type LinuxWeb2Draft,
} from "../../packages/community-setup/linux-web2-profile.ts";
import {
  canonicalDigest,
  readPrivateJSON,
  verifyRecord,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";
import {
  verifyInstalledRelease,
  verifyWeb2BootstrapRelease,
  type FullRelease,
  type Web2BootstrapRelease,
} from "./installed-release.ts";
import {
  privateDirectory,
  privateFile,
  syncDirectory,
  type OperationLease,
} from "./backend-state.ts";
import {
  createLocalController,
  type InstalledTarget,
} from "./local-target-controller.ts";
import { publicIngressFrom, type PublicIngress } from "./public-ingress.ts";
import {
  authenticateWeb2Enrollment,
  ownWeb2ChainAuthority,
  readWeb2HostAdmission,
  web2TargetDigest,
  type Web2ChainAuthority,
  type Web2HostAdmission,
  type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import type { NativeGraph } from "./full-native-config.ts";
import { nativePublicationBindingNames } from "./web2-publication-selection.ts";
import { expandedPublicationApprovalExists, readApprovedWeb2Transition } from "./web2-expanded-publication.ts";
import {
  assertTrustedRevisionTwoTarget, requireTrustedRevisionTwoResources, trustedRevisionTwo, trustedRevisionTwoPolicyName, web2OriginalStartIntent,
} from "./web2-trusted-revision-two.ts";
import type { Web2PublicationActivation, Web2PublicationInstallationInputs } from "./web2-publication-installation.ts";
import { postsSelectorPath, type Web2PostsInstallationInputs } from "./web2-posts-selector-installation.ts";
import {
  assertNoBootstrapPractice, assertWeb2LocalStudyInputs,
  validateWeb2LocalStudyPolicy, withWeb2LocalStudy,
  type Web2LocalStudyPolicy,
} from "./web2-local-study.ts";
import type { Web2InstallationHostInputs } from "./web2-local-installation.ts";
import type { Web2PublicDanceServeCustody } from "./web2-public-dance-custody.ts";
import { web2DanceRewardBinding } from "../../packages/community/web2-dance-reward-attachment.ts";
import { web2DanceRewardMount } from "./web2-dance-reward-installation.ts";
import { readTrustedNativePublication } from "./web2-trusted-publication.ts";
import { danceActivationPaths } from "./web2-dance-retained-files.ts";
import { assertStartAllowed } from "./maintenance-guard.ts";
import {
  web2ApplicationReleaseBody,
  web2NativeOriginal,
  type Web2NativeOriginal,
} from "../../packages/community/web2-native-business-binding.ts";

import { assertNoBootstrapNativeActivities, composeNativeActivities, offeredPractice,
  validateNativeActivityPolicy, type Web2NativeActivityPolicy } from "./web2-native-activities.ts";

export interface Web2RuntimeBindingPolicy {
  schema: "pirate.web2-runtime-binding-policy/1";
  bootstrapArtifactDigest: string;
  bootstrapSourceDigest: string;
  installationId: string;
  generation: number;
  issuedAt: number;
  expiresAt: number;
  origin: string;
  hostFingerprint: string;
  graph: Omit<NativeGraph, "directoryRuntimeBinding">;
  privateStudy?: Web2LocalStudyPolicy;
  nativeActivities?: Web2NativeActivityPolicy;
  target: InstalledTarget;
  ingress: PublicIngress;
  currentAdmissionFile: string;
  bindingDirectory: string;
  nativeRuntimeDirectory: string;
}
export interface Web2RuntimeBindingInputs {
  bootstrap: SignedRecord<Web2BootstrapRelease>;
  trust: TrustAnchor;
  policy: SignedRecord<Web2RuntimeBindingPolicy>;
  lease: OperationLease;
  chain: Web2ChainAuthority;
  /** Unix epoch milliseconds for the host binding policy and its validity window. */
  now: () => number;
  /** Private sidecar belongs to the paired Wizard. No request supplies its path. */
  publishing?: { directory: string; grants: ManagedOwnerGrantPort; publisher: PublisherProofSigner };
  /** Retained Dance checks the original Wizard journal on its action lease. */
  retainedPublishing?: {
    directory: string;
    grants: Pick<ManagedOwnerGrantPort, "reconcile">;
    publisher: Pick<PublisherProofSigner, "selected">;
  };
  publication?: Web2PublicationInstallationInputs;
  activateTrustedPublication?(input: Web2PublicationActivation, custody?: Web2PublicDanceServeCustody): Promise<void>;
  posts?: Web2PostsInstallationInputs;
  signRelease(body: FullRelease): Promise<SignedRecord<FullRelease>>;
  signApplicationRelease(
    body: Web2NativeOriginal["release"]["body"],
  ): Promise<Web2NativeOriginal["release"]>;
  signAdmission(
    body: Web2HostAdmission,
  ): Promise<SignedRecord<Web2HostAdmission>>;
  signProfile(
    body: Web2InstallPlan,
    generation: number,
  ): Promise<SignedRecord<Web2InstallPlan>>;
}
interface BindingIntent {
  schema: "pirate.web2-runtime-binding-intent/1";
  bootstrapDigest: string;
  policyDigest: string;
  draft: LinuxWeb2Draft;
  publishingAttachment?: Web2PublishingAttachment;
  release: FullRelease;
  admission: Web2HostAdmission;
}
interface BoundRuntime {
  schema: "pirate.web2-bound-runtime/1";
  intent: BindingIntent;
  release: SignedRecord<FullRelease>;
  applicationRelease: Web2NativeOriginal["release"];
  admission: SignedRecord<Web2HostAdmission>;
}

/** Existing output means compare and re-sync the exact original, never success
 * from EEXIST alone. A failed directory sync prevents subsequent effects. */
export async function retainWeb2Record(
  directory: string,
  name: string,
  value: unknown,
) {
  await privateDirectory(directory);
  assert(/^[a-z0-9-]{1,120}(?![\s\S])/.test(name));
  const path = join(directory, name + ".json"),
    bytes = Buffer.from(JSON.stringify(value) + "\n");
  assert(bytes.length <= 16 * 1024 ** 2, "web2_control_record_too_large");
  let file;
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await privateFile(path, 16 * 1024 ** 2);
    try {
      assert(
        (await existing.readFile()).equals(bytes),
        "original_install_record_changed",
      );
      await existing.sync();
    } finally {
      await existing.close();
    }
    await syncDirectory(directory);
    return;
  }
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}
export async function optionalWeb2Record<T>(path: string): Promise<T | null> {
  try {
    return await readPrivateJSON<T>(path, 16 * 1024 ** 2);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
interface BoundControlRecords {
  directory: string;
  bound: BoundRuntime;
  admission: Parameters<typeof readWeb2HostAdmission>[0];
}

/** The normal binder can reconcile its own interrupted bind. After
 * authentication it retains exact bound bytes and the existing admission,
 * or completes a missing admission from that same original. */
export async function recoverWeb2BindingControlRecords({ directory, bound, admission }: BoundControlRecords) {
  await retainWeb2Record(directory, "web2-binding-intent", bound.intent);
  await retainWeb2Record(directory, "web2-bound-runtime", bound);
  const current = await optionalWeb2Record<SignedRecord<Web2HostAdmission>>(admission.path) ?? bound.admission;
  assert(basename(admission.path) === "web2-host-admission.json", "owned_admission_filename_required");
  await retainWeb2Record(dirname(admission.path), "web2-host-admission", current);
  return readWeb2HostAdmission(admission);
}

/** Dance owner commands can only read an already started, selected original.
 * Every required record has to exist. No retained recovery or sync path is
 * reachable from this reader, including for a missing current admission. */
export async function readRetainedWeb2DanceControl(input: BoundControlRecords & {
  nativeRuntimeDirectory: string;
  maintenanceDirectory: string;
  registrationAuthority: Web2InstallPlan["registrationAuthority"];
  lease: Pick<OperationLease, "assertHeld">;
  live(): void;
}) {
  const { directory, bound, admission, lease, live } = input;
  live();
  await lease.assertHeld();
  await privateDirectory(directory);
  assert(bound.schema === "pirate.web2-bound-runtime/1" && bound.intent.schema === "pirate.web2-runtime-binding-intent/1" &&
    basename(admission.path) === "web2-host-admission.json", "web2_stage_binding_scope_changed");
  const release = verifyRecord(bound.release, admission.trust), graph = release.graph;
  assert(canonicalDigest(release) === canonicalDigest(bound.intent.release) &&
    canonicalDigest(verifyRecord(bound.admission, admission.trust)) === canonicalDigest(bound.intent.admission) &&
    canonicalDigest(verifyRecord(bound.applicationRelease, admission.trust)) ===
      canonicalDigest(web2ApplicationReleaseBody(release)),
    "runtime_issuer_changed_body");
  assert(graph.stateRoots.configuration === directory && danceActivationPaths(graph), "web2_dance_activation_unselected");

  const read = <T>(name: string) => readPrivateJSON<T>(join(directory, name + ".json"), 16 * 1024 ** 2);
  const original = await read<SignedRecord<Web2InstallPlan>>("web2-original");
  const plan = verifyRecord(original, admission.trust);
  await web2NativeOriginal(JSON.stringify({
    schema: "pirate.web2-native-application-original/1", record: original,
    release: bound.applicationRelease, trust: admission.trust, durableScope: graph.durableScope,
  } satisfies Web2NativeOriginal));
  assert(plan.installationId === admission.installationId && plan.hostFingerprint === admission.hostFingerprint &&
    plan.targetDigest === admission.targetDigest && plan.generation >= admission.minimumGeneration &&
    plan.releaseArtifactDigest === admission.releaseArtifactDigest &&
    canonicalDigest(plan.draft) === canonicalDigest(admission.draft) &&
    canonicalDigest(plan.draft) === canonicalDigest(bound.intent.draft) &&
    canonicalDigest(plan.registrationAuthority) === canonicalDigest(input.registrationAuthority),
    "web2_stage_original_changed");
  const expectedLaunch = {
    schema: "pirate.linux-web2-launch/1", release: bound.release,
    applicationRelease: bound.applicationRelease, trust: admission.trust,
    currentAdmissionFile: admission.path, minimumGeneration: plan.generation,
    privateRuntimeDirectory: input.nativeRuntimeDirectory, maintenanceDirectory: input.maintenanceDirectory,
  };
  const originals = ([
    ["web2-binding-intent", bound.intent], ["web2-bound-runtime", bound], ["web2-original", original],
    ["web2-launch", expectedLaunch], ["web2-start-intent", web2OriginalStartIntent(plan)],
  ] as const).map(([name, value]) => [name, canonicalDigest(value)] as const);
  const assertRetained = async () => {
    live();
    await lease.assertHeld();
    await assertStartAllowed(input.maintenanceDirectory);
    for (const [name, digest] of originals)
      assert(canonicalDigest(await read(name)) === digest, "web2_stage_original_changed");
    await readWeb2HostAdmission({ ...admission, minimumGeneration: plan.generation, planId: plan.planId });
    live();
    await lease.assertHeld();
  };
  await assertRetained();
  return assertRetained;
}
export { web2TargetDigest };

export async function createWeb2RuntimeBinder(
  input: Web2RuntimeBindingInputs,
  mode: "setup" | "retained-dance-owner" = "setup",
) {
  const retainedOwner = mode === "retained-dance-owner";
  assert(!input.retainedPublishing || retainedOwner && !input.publishing,
    "web2_retained_publishing_selection_changed");
  const retainedPublishing = retainedOwner ? input.retainedPublishing ?? input.publishing : undefined;
  const {
    lease,
    now,
    signRelease,
    signApplicationRelease,
    signAdmission,
    signProfile,
  } = input;
  const captured = structuredClone({
    bootstrap: input.bootstrap,
    trust: input.trust,
    policy: input.policy,
  });
  const chain = ownWeb2ChainAuthority(input.chain),
    policy = verifyRecord(captured.policy, captured.trust);
  const bootstrap = await verifyWeb2BootstrapRelease(
    captured.bootstrap,
    captured.trust,
  );
  assert(
    policy.schema === "pirate.web2-runtime-binding-policy/1" &&
      policy.bootstrapArtifactDigest === bootstrap.artifactDigest &&
      policy.bootstrapSourceDigest === bootstrap.sourceDigest &&
      policy.installationId === lease.installationId &&
      policy.target.installationId === lease.installationId &&
      policy.graph.installationId === lease.installationId &&
      policy.graph.releaseRoot === bootstrap.root &&
      policy.graph.stateRoots.configuration === policy.bindingDirectory,
    "web2_binding_policy_changed",
  );
  assertNoBootstrapPractice(policy.graph);
  assertNoBootstrapNativeActivities(policy.graph);
  const publicationNames = new Set<string>(nativePublicationBindingNames);
  assert(![...policy.graph.applicationBindings, ...policy.graph.secretBindings,
    ...policy.graph.actors.flatMap(actor => actor.bindings)].some(binding => publicationNames.has(binding.name)),
    "prebound_native_publication_refused");
  const publication = input.publication, activateTrustedPublication = input.activateTrustedPublication?.bind(input);
  const trustedConsent = policy.graph.publicationExpansion === trustedRevisionTwo && Boolean(policy.graph.nativePublication);
  assert(Boolean(activateTrustedPublication) === (trustedConsent && !retainedOwner) &&
    Boolean(publication) === (!trustedConsent && Boolean(policy.graph.nativePublication)),
    "native_publication_owner_unavailable");
  assert(policy.graph.publicationExpansion === undefined ||
    policy.graph.publicationExpansion === trustedRevisionTwo ||
    policy.graph.publicationExpansion === "registry-revision-two/1" && policy.graph.nativePublication &&
    policy.graph.fixtureTransport && policy.ingress.tls.kind === "local-fixture-ca",
    "native_expanded_fixture_selection_required");
  const ingress = publicIngressFrom(policy.ingress);
  assertTrustedRevisionTwoTarget(policy.graph, ingress);
  assert(policy.graph.publicationExpansion !== trustedRevisionTwo || (retainedOwner ? retainedPublishing : input.publishing),
    "trusted_revision_two_owner_publishing_required");
  const rewardFile = trustedConsent ? web2DanceRewardMount(policy.graph, policy.target, false) : undefined;
  const posts = input.posts;
  assert(Boolean(postsSelectorPath(policy.graph, policy.target)) === Boolean(posts),
    "native_posts_install_owner_unavailable");
  const privatePracticeSelection = offeredPractice(policy.privateStudy, policy.nativeActivities);
  const checkNative = async () => {
    if (!policy.nativeActivities) return;
    assert(policy.privateStudy, "native_activities_require_private_study_policy");
    await validateNativeActivityPolicy({policy: policy.nativeActivities, study: policy.privateStudy,
      graph: policy.graph, target: policy.target, release: bootstrap, expiresAt: policy.expiresAt});
  };
  if (policy.privateStudy) {
    validateWeb2LocalStudyPolicy(policy.privateStudy, policy.graph, bootstrap, policy.target, policy.nativeActivities?.socket);
    await assertWeb2LocalStudyInputs(policy.privateStudy, policy.graph);
  }
  await checkNative();
  const publishing = !retainedOwner && input.publishing ? await createWeb2PublishingSetup(input.publishing.directory, {
    hostInstallationId:policy.installationId,publisher:input.publishing.publisher,
    publishing:{chain,grants:input.publishing.grants},now:()=>Math.floor(now()/1000),
  }) : null;
  const reconcileExpandedAttachment = retainedPublishing
    ? await createWeb2RetainedPublishingReconciler(retainedPublishing.directory, {
      chain, publisher: retainedPublishing.publisher, grants: retainedPublishing.grants,
      now: () => Math.floor(now() / 1000),
    })
    : publishing?.retainedExpandedAttachment;
  assert(
    ingress.origin === policy.origin &&
      !Object.hasOwn(policy.graph, "directoryRuntimeBinding"),
    "bootstrap_prebinding_refused",
  );
  const ownerBindingNames=["OWNER_GRANT_JSON","OWNER_AUTHORIZATION_JSON","WEB2_PUBLISHING_ATTACHMENT_SHA256","WEB2_PUBLISHING_ATTACHMENT_JSON","WEB2_PUBLISHING_SELECTION_SHA256","OWNER_GRANT_ADMISSION_REFERENCE"];
  assert(
    !policy.graph.applicationBindings.some((x) =>
      ["COMMUNITY_NAME", "PLAN_ID", ...ownerBindingNames].includes(x.name),
    ),
    "bootstrap_application_identity_refused",
  );
  assert(
    Number.isSafeInteger(policy.generation) &&
      policy.generation > 0 &&
      Number.isSafeInteger(policy.issuedAt) &&
      Number.isSafeInteger(policy.expiresAt) &&
      policy.issuedAt < policy.expiresAt,
    "finite_binding_policy_required",
  );
  assert(!policy.graph.secretBindings.some(x=>ownerBindingNames.includes(x.name)) &&
    !policy.graph.actors.some(actor=>actor.bindings.some(x=>ownerBindingNames.includes(x.name))),"bootstrap_owner_binding_refused");
  await privateDirectory(policy.bindingDirectory);
  const intentPath = join(policy.bindingDirectory, "web2-binding-intent.json"),
    boundPath = join(policy.bindingDirectory, "web2-bound-runtime.json");
  const targetDigest = web2TargetDigest(
    policy.target,
    ingress,
    policy.nativeRuntimeDirectory,
  );
  const policyDigest = canonicalDigest(captured.policy),
    bootstrapDigest = canonicalDigest(captured.bootstrap);
  function live() {
    assert(
      Number.isSafeInteger(now()) &&
        policy.issuedAt <= now() &&
        now() < policy.expiresAt,
      "web2_binding_policy_expired",
    );
  }
  type ExpansionRead = () => ReturnType<typeof readApprovedWeb2Transition>;
  async function authenticate(draft: LinuxWeb2Draft, expanded?: ExpansionRead, assertRetained?: () => Promise<void>) {
    live();
    await lease.assertHeld();
    await verifyWeb2BootstrapRelease(captured.bootstrap, captured.trust);
    assert(draft.origin === policy.origin, "web2_binding_origin_changed");
    if (expanded) await expanded();
    else await authenticateWeb2Enrollment(chain, draft);
    await assertRetained?.();
    const controller = await createLocalController(policy.target, lease);
    try {
      const host = await controller.inspectHost(AbortSignal.timeout(45000));
      assert(
        host.supported && host.fingerprint === policy.hostFingerprint,
        "web2_binding_host_changed",
      );
      if (expanded && policy.graph.publicationExpansion === trustedRevisionTwo)
        requireTrustedRevisionTwoResources(policy.target.containers.length, host.resources);
    } finally {
      await controller.dispose();
    }
    if (draft.privatePractice) {
      assert(policy.privateStudy && draft.privatePractice === privatePracticeSelection,
        "web2_private_study_unavailable");
      await checkNative();
      await assertWeb2LocalStudyInputs(policy.privateStudy, policy.graph);
    }
    live();
    await lease.assertHeld();
    if (expanded) await expanded();
  }
  function validateIntent(intent: BindingIntent, draft?: LinuxWeb2Draft) {
    assert(
      intent.schema === "pirate.web2-runtime-binding-intent/1" &&
        intent.policyDigest === policyDigest &&
        intent.bootstrapDigest === bootstrapDigest,
      "original_runtime_binding_changed",
    );
    const owned = linuxWeb2DraftFrom(intent.draft);
    if (draft)
      assert(
        canonicalDigest(owned) === canonicalDigest(draft),
        "original_web2_draft_changed",
      );
    const graph = graphFor(owned, intent.publishingAttachment);
    assert(
      canonicalDigest(intent.release) ===
        canonicalDigest({
          ...bootstrap,
          schema: "pirate.complete-linux-web2-release/1",
          graph,
          requiredRoles: graph.requiredRoles,
        }),
      "bound_runtime_graph_or_artifacts_changed",
    );
    assert(
      Number.isSafeInteger(intent.admission.issuedAt) &&
        policy.issuedAt <= intent.admission.issuedAt &&
        intent.admission.issuedAt <= now(),
      "bound_runtime_admission_time_changed",
    );
    assert(
      canonicalDigest(intent.admission) ===
        canonicalDigest(admissionFor(owned, intent.admission.issuedAt)),
      "bound_runtime_admission_changed",
    );
    return owned;
  }
  function graphFor(draft: LinuxWeb2Draft, attachment?: Web2PublishingAttachment): NativeGraph {
    if (ownerOnly(draft.configuration.policies.admission) || policy.graph.publicationExpansion === trustedRevisionTwo)
      assert(attachment,"web2_publishing_attachment_required");
    if (attachment) {
      const a = publishingAttachment(attachment), scope = a.selection.scope, c = draft.configuration;
      assert(scope.enrollmentId === draft.enrollment.enrollmentId && scope.hostInstallationId === policy.installationId &&
        scope.installationId === c.installationId && scope.communityId === c.communityId && scope.origin === draft.origin &&
        scope.controller === c.controller && scope.publisher === c.publisher && scope.postsContract === c.postsContract &&
        scope.deploymentDigest === hashJson(draft.deployment),"web2_publishing_attachment_scope_changed");
    }
    const graph = composeNativeActivities(withWeb2LocalStudy({
      ...structuredClone(policy.graph),
      directoryRuntimeBinding: JSON.stringify(draft.deployment),
      applicationBindings: [
        ...structuredClone(policy.graph.applicationBindings),
        { name: "COMMUNITY_NAME", text: draft.name },
        { name: "PLAN_ID", text: draft.deployment.planId },
        ...(rewardFile ? [{ name: web2DanceRewardBinding, file: rewardFile }] : []),
        ...(attachment ? [
          {name:"OWNER_GRANT_JSON",text:JSON.stringify(attachment.selection.grant)},
          {name:"OWNER_AUTHORIZATION_JSON",text:JSON.stringify(attachment.authorization)},
          {name:"WEB2_PUBLISHING_ATTACHMENT_SHA256",text:attachment.digest},
          {name:"WEB2_PUBLISHING_ATTACHMENT_JSON",text:JSON.stringify(attachment)},
          {name:"WEB2_PUBLISHING_SELECTION_SHA256",text:attachment.selection.selectionDigest},
          {name:"OWNER_GRANT_ADMISSION_REFERENCE",text:attachment.selection.admissionReference},
        ] : []),
      ],
    }, draft, bootstrap, policy.privateStudy, policy.nativeActivities?.socket),
      draft, policy.privateStudy, policy.nativeActivities);
    if (graph.nativePublication) {
      assert(draft.privatePractice && policy.nativeActivities &&
        graph.localActivitySocket === policy.nativeActivities.socket,
        "native_publication_requires_selected_activity_socket");
    }
    if (trustedConsent) danceActivationPaths(graph);
    return graph;
  }
  function admissionFor(
    draft: LinuxWeb2Draft,
    issuedAt: number,
  ): Web2HostAdmission {
    return {
      schema: "pirate.linux-web2-host-admission/1",
      installationId: policy.installationId,
      directoryInstallationId: draft.enrollment.installationId,
      communityId: draft.enrollment.communityId,
      generation: policy.generation,
      issuedAt,
      expiresAt: policy.expiresAt,
      hostFingerprint: policy.hostFingerprint,
      releaseArtifactDigest: bootstrap.artifactDigest,
      targetDigest,
      draftDigest: canonicalDigest(draft),
      revokedPlanIds: [],
    };
  }
  const hostAdmissionScope = (draft: LinuxWeb2Draft): Parameters<typeof readWeb2HostAdmission>[0] => ({
    path: policy.currentAdmissionFile, trust: captured.trust, now,
    installationId: policy.installationId, draft, releaseArtifactDigest: bootstrap.artifactDigest,
    targetDigest, hostFingerprint: policy.hostFingerprint, minimumGeneration: policy.generation,
  });
  async function hostInputs(
    bound: BoundRuntime,
    stageCurrent?: () => Promise<void>,
  ): Promise<Web2InstallationHostInputs> {
    assert(bound.schema === "pirate.web2-bound-runtime/1");
    const draft = validateIntent(bound.intent);
    assert(
      canonicalDigest(verifyRecord(bound.release, captured.trust)) ===
        canonicalDigest(bound.intent.release) &&
        canonicalDigest(verifyRecord(bound.admission, captured.trust)) ===
          canonicalDigest(bound.intent.admission),
      "runtime_issuer_changed_body",
    );
    await verifyInstalledRelease(bound.release, captured.trust);
    assert(
      canonicalDigest(
        verifyRecord(bound.applicationRelease, captured.trust),
      ) === canonicalDigest(web2ApplicationReleaseBody(bound.intent.release)),
      "application_release_identity_changed",
    );
    let expanded: ExpansionRead | undefined;
    const graph = bound.intent.release.graph;
    const trusted = graph.publicationExpansion === trustedRevisionTwo;
    const hasApproval = await expandedPublicationApprovalExists(graph);
    assert(!stageCurrent || hasApproval, "web2_stage_publication_approval_required");
    if (hasApproval) {
      const record = await readPrivateJSON<SignedRecord<Web2InstallPlan>>(join(policy.bindingDirectory, "web2-original.json"));
      assert(canonicalDigest(record.body.draft) === canonicalDigest(draft), "native_expanded_bound_draft_changed");
      const original: Web2NativeOriginal = { schema: "pirate.web2-native-application-original/1", record,
        release: bound.applicationRelease, trust: captured.trust, durableScope: graph.durableScope };
      let approvalSha256: string | undefined, companionRaw: string | undefined;
      expanded = async () => {
        const approved = await readApprovedWeb2Transition({ graph, original, chain, now });
        if (trusted) {
          approvalSha256 ??= approved.approvalSha256;
          assert(approved.approvalSha256 === approvalSha256, "trusted_revision_two_approval_changed");
          if (stageCurrent) {
            assert("approval" in approved, "web2_public_dance_approval_changed");
            const attachment = await readTrustedNativePublication({ graph, original, approval: approved });
            assert(attachment, "trusted_web2_publication_attachment_required");
            companionRaw ??= attachment.raw;
            assert(companionRaw === attachment.raw, "web2_public_dance_approval_changed");
            await stageCurrent();
          }
        }
        return approved;
      };
    }
    await stageCurrent?.();
    await authenticate(draft, expanded, stageCurrent);
    async function recheckExpandedAttachment(readCurrent: () => Promise<LinuxWeb2Draft["configuration"]>) {
      if (trusted) live();
      const attachment = bound.intent.publishingAttachment;
      assert(reconcileExpandedAttachment && attachment, "web2_publishing_authority_unavailable");
      const retained = await reconcileExpandedAttachment(draft, attachment, readCurrent);
      assert(canonical(retained) === canonical(attachment), "web2_publishing_attachment_changed");
      if (trusted) live();
    }
    if (expanded) {
      const read = expanded;
      await recheckExpandedAttachment(async () => (await read()).configuration);
    } else if (bound.intent.publishingAttachment) {
      assert(publishing, "web2_publishing_authority_unavailable");
      const retained = await publishing.attachment(draft);
      assert(canonical(retained) === canonical(bound.intent.publishingAttachment), "web2_publishing_attachment_changed");
    }
    if (draft.privatePractice) await authenticate(draft, expanded, stageCurrent);
    if (stageCurrent) await stageCurrent();
    else {
      await recoverWeb2BindingControlRecords({
        directory: policy.bindingDirectory, bound, admission: hostAdmissionScope(draft),
      });
      if (trusted) {
        assert(hasApproval === await expandedPublicationApprovalExists(graph), "trusted_revision_two_approval_changed");
        await authenticate(draft, expanded);
        if (!hasApproval)
          await retainWeb2Record(policy.bindingDirectory, trustedRevisionTwoPolicyName, captured.policy);
      }
    }
    return {
      release: bound.release,
      applicationRelease: bound.applicationRelease,
      trust: captured.trust,
      lease,
      target: structuredClone(policy.target),
      ingress,
      chain,
      currentAdmissionFile: policy.currentAdmissionFile,
      minimumGeneration: policy.generation,
      planDirectory: policy.bindingDirectory,
      hostFingerprint: policy.hostFingerprint,
      nativeRuntimeDirectory: policy.nativeRuntimeDirectory,
      now,
      ...(publication ? { publication } : {}),
      ...(activateTrustedPublication ? { activateTrustedPublication } : {}),
      ...(posts ? { posts } : {}),
      ...(trusted ? { recheckTrustedPublishing: recheckExpandedAttachment } : {}),
      signProfile: async (body,generation) => {
        assert(!stageCurrent, "web2_stage_signing_refused");
        assert(!expanded, "native_expanded_signed_plan_replacement_refused");
        if (bound.intent.publishingAttachment) {
          assert(publishing,"web2_publishing_authority_unavailable");
          assert(canonical(await publishing.attachment(draft)) === canonical(bound.intent.publishingAttachment),"web2_publishing_attachment_changed");
        }
        return signProfile(body,generation);
      },
    };
  }
  let busy = false;
  return {
    bootstrap: captured.bootstrap,
    privateStudyAvailable: Boolean(policy.privateStudy),
    privatePracticeSelection,
    trust: captured.trust,
    lease,
    async retained() {
      assert(!retainedOwner, "web2_dance_owner_setup_refused");
      const bound = await optionalWeb2Record<BoundRuntime>(boundPath);
      return bound ? hostInputs(bound) : null;
    },
    async retainedForDanceOwnerAction() {
      assert(retainedOwner, "web2_dance_owner_mode_required");
      const bound = await readPrivateJSON<BoundRuntime>(boundPath, 16 * 1024 ** 2);
      assert(bound.schema === "pirate.web2-bound-runtime/1", "original_runtime_binding_changed");
      const draft = validateIntent(bound.intent);
      const assertRetained = await readRetainedWeb2DanceControl({
        directory: policy.bindingDirectory, bound, admission: hostAdmissionScope(draft),
        nativeRuntimeDirectory: policy.nativeRuntimeDirectory,
        maintenanceDirectory: policy.target.maintenanceDirectory,
        registrationAuthority: {
          registrar: chain.registrar, registrarRevision: String(chain.registrarRevision),
          maxSafeBlockAgeSeconds: String(chain.maxSafeBlockAgeSeconds),
        },
        lease, live,
      });
      const host = await hostInputs(bound, assertRetained);
      return { host, assertRetained };
    },
    async bind(value: unknown) {
      assert(!retainedOwner, "web2_dance_owner_setup_refused");
      assert(!busy, "web2_binding_in_progress");
      busy = true;
      try {
        const draft = linuxWeb2DraftFrom(value);
        const bound = await optionalWeb2Record<BoundRuntime>(boundPath);
        if (bound) {
          validateIntent(bound.intent, draft);
          return hostInputs(bound);
        }
        await authenticate(draft);
        let intent = await optionalWeb2Record<BindingIntent>(intentPath);
        if (intent) validateIntent(intent, draft);
        else {
          const attachment = (ownerOnly(draft.configuration.policies.admission) ||
            policy.graph.publicationExpansion === trustedRevisionTwo)
            ? (assert(publishing,"web2_publishing_authority_unavailable"), await publishing.attachment(draft)) : undefined;
          const graph = graphFor(draft, attachment);
          intent = {
            schema: "pirate.web2-runtime-binding-intent/1",
            bootstrapDigest,
            policyDigest,
            draft,
            ...(attachment ? {publishingAttachment:attachment} : {}),
            release: {
              ...structuredClone(bootstrap),
              schema: "pirate.complete-linux-web2-release/1",
              graph,
              requiredRoles: graph.requiredRoles,
            },
            admission: admissionFor(draft, now()),
          };
        }
        await retainWeb2Record(
          policy.bindingDirectory,
          "web2-binding-intent",
          intent,
        );
        await authenticate(draft);
        const release = await signRelease(structuredClone(intent.release)),
          applicationRelease = await signApplicationRelease(
            web2ApplicationReleaseBody(intent.release),
          ),
          admission = await signAdmission(structuredClone(intent.admission));
        assert(
          canonicalDigest(verifyRecord(release, captured.trust)) ===
            canonicalDigest(intent.release) &&
            canonicalDigest(verifyRecord(admission, captured.trust)) ===
              canonicalDigest(intent.admission) &&
            canonicalDigest(
              verifyRecord(applicationRelease, captured.trust),
            ) === canonicalDigest(web2ApplicationReleaseBody(intent.release)),
          "runtime_issuer_changed_body",
        );
        await authenticate(draft);
        await verifyInstalledRelease(release, captured.trust);
        const result: BoundRuntime = {
          schema: "pirate.web2-bound-runtime/1",
          intent,
          release,
          applicationRelease,
          admission,
        };
        await retainWeb2Record(
          policy.bindingDirectory,
          "web2-bound-runtime",
          result,
        );
        return hostInputs(result);
      } finally {
        busy = false;
      }
    },
  };
}
