import assert from "node:assert/strict";
import { join } from "node:path";
import { hashJson } from "../../packages/community/common.ts";
import { maxWeb2DanceRewardBytes, readWeb2InstalledDanceRewards } from "../../packages/community/web2-dance-reward-attachment.ts";
import {
  requestWeb2DanceBindPrepare, retainWeb2DanceBindPrepare, type Web2DanceBindPrepareOwner,
} from "./web2-dance-bind-prepare.ts";
import { nativeDigest } from "../../packages/community/native-business-binding.ts";
import { assertStartAllowed } from "./maintenance-guard.ts";
import { assertWeb2IngressUncreated, createWeb2ExpansionPreparation } from "./web2-expansion-preparation.ts";
import { publishingAttachment } from "./web2-publishing-attachment.ts";
import { setTimeout as delay } from "node:timers/promises";
import {
  retainWeb2Record as retain,
  optionalWeb2Record as optionalRecord,
  web2TargetDigest,
} from "./web2-runtime-binding.ts";
import {
  linuxWeb2DraftFrom,
  type LinuxWeb2Draft,
  type LinuxWeb2Installation,
  type LinuxWeb2Observation,
  type LinuxWeb2PlanSelection,
  type LinuxWeb2PlanSummary,
} from "../../packages/community-setup/linux-web2-profile.ts";
import {
  verifyInstalledRelease,
  installedExecutionPaths,
  type FullRelease,
} from "./installed-release.ts";
import {
  canonicalDigest,
  readPrivateJSON,
  verifyRecord,
  type SignedRecord,
  type TrustAnchor,
} from "./installed-records.ts";
import {
  privateDirectory,
  processIdentity,
  sameProcess,
  type OperationLease,
} from "./backend-state.ts";
import {
  createLocalController,
  type InstalledTarget,
} from "./local-target-controller.ts";
import {
  authenticateWeb2Enrollment,
  ownWeb2ChainAuthority,
  readWeb2HostAdmission,
  type Web2ChainAuthority,
  type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import {
  IngressStartupFailure,
  inspectCommunityIngress,
  inspectTrustedPublicationIngress,
  inspectTrustedRevisionOneIngress,
  publicIngressFrom,
  retainPublicIngress,
  startPublicIngress,
  waitForCommunityIngress,
  type PublicIngress,
} from "./public-ingress.ts";
import {
  web2ApplicationReleaseBody,
  type Web2NativeOriginal,
} from "../../packages/community/web2-native-business-binding.ts";
import { stageNativePublication, type Web2PublicationActivation, type Web2PublicationInstallationInputs } from "./web2-publication-installation.ts";
import { expandedPublicationApprovalExists, readApprovedExpandedPublication, readApprovedWeb2Transition } from "./web2-expanded-publication.ts";
import {
  assertTrustedRevisionTwoTarget, readTrustedRevisionTwoPolicy, requireTrustedRevisionTwoResources, trustedRevisionTwo, web2OriginalStartIntent,
} from "./web2-trusted-revision-two.ts";
import { retainTrustedRevisionOneServingWitness, trustedRevisionOneResourceDigest } from "./web2-trusted-revision-two-producer.ts";
import { readTrustedNativePublication } from "./web2-trusted-publication.ts";
import { nativePublicationPaths } from "./web2-publication-selection.ts";
import { danceActivationPaths } from "./web2-dance-retained-files.ts";
import {
  readDanceActivationArtifact, readDanceActivationPublicationMount, stageWeb2DanceActivation, type Web2DanceActivationOwner,
} from "./web2-dance-retained-activation.ts";
import { postsSelectorPath, stagePostsSelector, type Web2PostsInstallationInputs } from "./web2-posts-selector-installation.ts";

/** Installed host-only inputs. No request can replace these with browser fields. */
export interface Web2InstallationHostInputs {
  release: SignedRecord<FullRelease>;
  applicationRelease: Web2NativeOriginal["release"];
  trust: TrustAnchor;
  lease: OperationLease;
  target: InstalledTarget;
  ingress: PublicIngress;
  chain: Web2ChainAuthority;
  currentAdmissionFile: string;
  minimumGeneration: number;
  planDirectory: string;
  hostFingerprint: string;
  nativeRuntimeDirectory: string;
  now: () => number;
  publication?: Web2PublicationInstallationInputs;
  activateTrustedPublication?(input: Web2PublicationActivation): Promise<void>;
  posts?: Web2PostsInstallationInputs;
  recheckTrustedPublishing?(readCurrent: () => Promise<LinuxWeb2Draft["configuration"]>): Promise<void>;
  signProfile(
    body: Web2InstallPlan,
    generation: number,
  ): Promise<SignedRecord<Web2InstallPlan>>;
}
export interface Web2InstalledService extends LinuxWeb2Installation {
  resumeOriginal(): Promise<LinuxWeb2Observation | null>;
  stageRetainedDance(owner: Web2DanceActivationOwner, assertRetained: () => Promise<void>): Promise<string>;
  prepareRetainedDanceBindings(owner: Web2DanceBindPrepareOwner, assertRetained: () => Promise<void>):
    ReturnType<typeof retainWeb2DanceBindPrepare>;
  shutdownService(): Promise<void>;
}
export async function createWeb2Installation(
  input: Web2InstallationHostInputs,
  signal?: AbortSignal,
  assertRetainedBeforeController?: () => Promise<void>,
): Promise<Web2InstalledService> {
  const { lease, signProfile, now } = input;
  const selected = structuredClone({
    release: input.release,
    applicationRelease: input.applicationRelease,
    trust: input.trust,
    target: input.target,
    currentAdmissionFile: input.currentAdmissionFile,
    minimumGeneration: input.minimumGeneration,
    planDirectory: input.planDirectory,
    hostFingerprint: input.hostFingerprint,
    nativeRuntimeDirectory: input.nativeRuntimeDirectory,
  });
  const chain = ownWeb2ChainAuthority(input.chain),
    ingress = publicIngressFrom(input.ingress);
  const release = await verifyInstalledRelease(
    selected.release,
    selected.trust,
  );
  const graph = release.graph;
  assertTrustedRevisionTwoTarget(graph, ingress);
  const trusted = graph.publicationExpansion === trustedRevisionTwo;
  const recheckTrustedPublishing = input.recheckTrustedPublishing?.bind(input);
  assert(!trusted || recheckTrustedPublishing, "trusted_revision_two_owner_publishing_required");
  const publication = input.publication, activateTrustedPublication = input.activateTrustedPublication?.bind(input);
  const trustedConsent = trusted && Boolean(graph.nativePublication);
  assert(Boolean(activateTrustedPublication) === trustedConsent &&
    Boolean(publication) === (!trustedConsent && Boolean(graph.nativePublication)),
    "native_publication_owner_unavailable");
  const prepareExpansion = publication?.prepareExpansion?.bind(publication);
  assert(!prepareExpansion || (release.graph.publicationExpansion === "registry-revision-two/1" && release.graph.fixtureTransport &&
    ingress.tls.kind === "local-fixture-ca" && publication?.activateAfterStaging), "native_expansion_bootstrap_unadmitted");
  const prepareOnce = createWeb2ExpansionPreparation(selected.planDirectory, lease);
  const posts = input.posts;
  assert(Boolean(postsSelectorPath(release.graph, selected.target)) === Boolean(posts),
    "native_posts_install_owner_unavailable");
  assert(
    release.schema === "pirate.complete-linux-web2-release/1",
    "explicit_web2_release_required",
  );
  assert(
    canonicalDigest(
      verifyRecord(selected.applicationRelease, selected.trust),
    ) === canonicalDigest(web2ApplicationReleaseBody(release)),
    "application_release_identity_changed",
  );
  assert(
    lease.installationId === release.graph.installationId &&
      selected.target.installationId === lease.installationId,
  );
  assert(
    Number.isSafeInteger(selected.minimumGeneration) &&
      selected.minimumGeneration > 0 &&
      typeof now === "function",
  );
  assert(
    selected.planDirectory === release.graph.stateRoots.configuration,
    "owned_install_configuration_root_required",
  );
  assert(
    selected.target.containers.every((c) =>
      c.ports.every((p) => p.ip === "127.0.0.1"),
    ),
    "private_application_ports_required",
  );
  assert(
    selected.target.containers.some(
      (c) =>
        c.imageId === release.imageId &&
        c.ports.some((p) => p.host === Number(new URL(ingress.upstream).port)),
    ),
    "actual_private_application_upstream_required",
  );
  await privateDirectory(selected.nativeRuntimeDirectory);
  assert(
    selected.target.allowedWritableRoots.some(
      (root) =>
        selected.nativeRuntimeDirectory === root ||
        selected.nativeRuntimeDirectory.startsWith(root + "/"),
    ),
    "owned_native_runtime_directory_required",
  );
  const nativeLaunchFile = join(selected.planDirectory, "web2-launch.json"),
    execution = installedExecutionPaths(release);
  assert(
    selected.target.containers.some(
      (c) =>
        c.imageId === release.imageId &&
        canonicalDigest(c.argv) ===
          canonicalDigest([
            execution.node,
            join(release.root, "full-launch.mjs"),
            nativeLaunchFile,
          ]),
    ),
    "exact_web2_native_launch_required",
  );
  const targetDigest = web2TargetDigest(
      selected.target,
      ingress,
      selected.nativeRuntimeDirectory,
    ),
    originalPath = join(selected.planDirectory, "web2-original.json");
  await assertRetainedBeforeController?.();
  const controller = await createLocalController(selected.target, lease);
  let closed = false,
    busy = false,
    edge: Awaited<ReturnType<typeof startPublicIngress>> | undefined;
  let ingressFailure: IngressStartupFailure | undefined;
  let idle = Promise.resolve(),
    finish: () => void = () => {};
  const open = async () => {
    assert(!closed && !signal?.aborted, "web2_installer_closed_or_cancelled");
    await lease.assertHeld();
  };
  const exclusive = async <T>(action: () => Promise<T>) => {
    assert(!busy, "web2_installation_operation_in_progress");
    busy = true;
    idle = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      return await action();
    } finally {
      busy = false;
      finish();
    }
  };
  function nativeOriginal(record: SignedRecord<Web2InstallPlan>): Web2NativeOriginal {
    return { schema: "pirate.web2-native-application-original/1", record,
      release: selected.applicationRelease, trust: selected.trust, durableScope: release.graph.durableScope };
  }
  const currentHostAdmission = (draft: LinuxWeb2Draft, planId: string | undefined, retainedGeneration: number) =>
    readWeb2HostAdmission({
      path: selected.currentAdmissionFile,
      trust: selected.trust,
      now,
      installationId: lease.installationId,
      draft,
      releaseArtifactDigest: release.artifactDigest,
      targetDigest,
      hostFingerprint: selected.hostFingerprint,
      minimumGeneration: Math.max(
        selected.minimumGeneration,
        retainedGeneration,
      ),
      ...(planId ? { planId } : {}),
    });
  async function authorize(
    draft: LinuxWeb2Draft,
    planId?: string,
    retainedGeneration = selected.minimumGeneration,
    retained?: { record: SignedRecord<Web2InstallPlan>; starting: boolean },
  ) {
    await open();
    assert(
      draft.origin === ingress.origin &&
        canonicalDigest(draft.deployment) ===
          canonicalDigest(JSON.parse(release.graph.directoryRuntimeBinding)),
      "installed_web2_deployment_changed",
    );
    await verifyInstalledRelease(selected.release, selected.trust);
    const host = () => currentHostAdmission(draft, planId, retainedGeneration);
    await host();
    const useExpansion = retained && graph.publicationExpansion &&
      ((!trusted && retained.starting) || await expandedPublicationApprovalExists(graph));
    let approvalSha256: string | undefined;
    const read = async () => {
      assert(retained, "trusted_revision_two_original_required");
      const approved = await readApprovedWeb2Transition({ graph, original: nativeOriginal(retained.record), chain, now });
      if (trusted) {
        approvalSha256 ??= approved.approvalSha256;
        assert(approved.approvalSha256 === approvalSha256, "trusted_revision_two_approval_changed");
      }
      return approved;
    };
    const expanded = useExpansion ? await read() : undefined;
    const evidence = expanded?.authority ?? await authenticateWeb2Enrollment(chain, draft);
    let admission = await host();
    const actual = await controller.inspectHost(AbortSignal.timeout(45000));
    assert(
      actual.supported && actual.fingerprint === selected.hostFingerprint,
      "web2_installed_host_changed",
    );
    await host();
    await open();
    if (expanded) {
      if (trusted) {
        requireTrustedRevisionTwoResources(selected.target.containers.length, actual.resources);
        await recheckTrustedPublishing!(async () => (await read()).configuration);
      }
      const current = await read();
      assert(current.selectionSha256 === expanded.selectionSha256 &&
        (!trusted || current.approvalSha256 === expanded.approvalSha256),
        "native_expanded_publication_selection_changed");
    } else if (trusted) {
      assert(!await expandedPublicationApprovalExists(graph), "trusted_revision_two_approval_changed");
      await authenticateWeb2Enrollment(chain, draft);
    }
    let trustedPublication: Awaited<ReturnType<typeof readTrustedNativePublication>> = undefined;
    if (trustedConsent && expanded) {
      assert(retained && "approval" in expanded, "trusted_web2_publication_approval_required");
      trustedPublication = await readTrustedNativePublication({ graph, original: nativeOriginal(retained.record), approval: expanded });
      assert(trustedPublication, "trusted_web2_publication_attachment_required");
      assert((await read()).approvalSha256 === expanded.approvalSha256, "trusted_revision_two_approval_changed");
    }
    if (trusted) {
      admission = await host();
      await open();
      if (trustedPublication && retained && expanded && "approval" in expanded) {
        assert((await readTrustedNativePublication({ graph, original: nativeOriginal(retained.record), approval: expanded }))?.raw === trustedPublication.raw,
          "trusted_web2_publication_attachment_changed");
      }
    }
    return { evidence, admission, expanded, trustedPublication };
  }
  async function load(selection: LinuxWeb2PlanSelection) {
    await open();
    assert(Object.keys(selection).sort().join(",") === "planDigest,planId");
    const record =
        await readPrivateJSON<SignedRecord<Web2InstallPlan>>(originalPath),
      body = verifyRecord(record, selected.trust);
    assert.deepEqual(Object.keys(body).sort(), ["schema","planId","installationId","durableScope","generation","draft","releaseArtifactDigest","releaseSourceDigest","targetDigest","hostFingerprint","enrollment","registrationAuthority",...(Object.hasOwn(body,"publishingAttachmentDigest") ? ["publishingAttachmentDigest"] : []),
      ...(Object.hasOwn(body, "danceRewardIntentSha256") ? ["danceRewardIntentSha256"] : [])].sort(),"original_web2_installation_fields_changed");
    assert(
      body.schema === "pirate.linux-web2-install-plan/1" &&
        body.planId === selection.planId &&
        canonicalDigest(body) === selection.planDigest &&
        body.installationId === lease.installationId &&
        body.durableScope === release.graph.durableScope &&
        body.releaseArtifactDigest === release.artifactDigest &&
        body.releaseSourceDigest === release.sourceDigest &&
        body.publishingAttachmentDigest === selected.applicationRelease.body.publishingAttachmentDigest &&
        body.danceRewardIntentSha256 === selected.applicationRelease.body.danceRewardIntentSha256 &&
        body.targetDigest === targetDigest &&
        body.hostFingerprint === selected.hostFingerprint,
      "original_web2_installation_changed",
    );
    assert(
      Number.isSafeInteger(body.generation) &&
        body.generation >= selected.minimumGeneration,
      "original_web2_generation_invalid",
    );
    assert(
      canonicalDigest(linuxWeb2DraftFrom(body.draft)) ===
        canonicalDigest(body.draft),
    );
    return { record, body };
  }
  const selectionFor = (p: Web2InstallPlan) => ({
    planId: p.planId,
    planDigest: canonicalDigest(p),
  });
  function summary(p: Web2InstallPlan): LinuxWeb2PlanSummary {
    return {
      ...selectionFor(p),
      installationId: p.installationId,
      summary: {
        name: p.draft.name,
        origin: p.draft.origin,
        communityId: p.draft.enrollment.communityId,
        controller: p.draft.configuration.controller,
        publisher: p.draft.configuration.publisher,
        registrationTransaction: p.enrollment.transactionHash,
        verifiedListing: false,
        namesEnabled: false,
        learningEnabled: Boolean(p.draft.privatePractice),
        danceEnabled: Boolean(p.draft.privatePractice?.includes("dance")),
      },
    };
  }
  function inspectTrustedSelection(selectedPublication: NonNullable<Awaited<ReturnType<typeof readTrustedNativePublication>>>) {
    const { selector, selection } = selectedPublication.initialization;
    assert(selection.active, "trusted_web2_publication_active_release_required");
    return inspectTrustedPublicationIngress(ingress, graph.readbackKeyFile, { mount: selector.body.mount, active: selection.active });
  }
  async function observation(
    selection: LinuxWeb2PlanSelection,
  ): Promise<LinuxWeb2Observation> {
    const { body, record } = await load(structuredClone(selection));
    const base = { ...selectionFor(body), installationId: body.installationId };
    try {
      const intent = await optionalRecord(
        join(selected.planDirectory, "web2-start-intent.json"),
      );
      const before = await authorize(body.draft, body.planId, body.generation, { record, starting: intent !== null });
      const state = await controller.inspect(AbortSignal.timeout(45000));
      if (!intent) {
        assert(
          state.resources.every((r) => r.actual === null),
          "unrecorded_installation_effect",
        );
        return { ...base, state: "prepared" };
      }
      if (!state.resources.every((r) => r.actual?.State.Running))
        return {
          ...base,
          state: "unavailable",
          reason: "original_resources_not_running",
        };
      assert(
        edge &&
          sameProcess(
            edge.identity,
            await processIdentity(edge.identity.hostPid),
          ),
        "original_ingress_not_running",
      );
      await inspectCommunityIngress(
        ingress,
        body.draft.enrollment.communityId,
        true,
      );
      const after = await authorize(body.draft, body.planId, body.generation, { record, starting: true });
      const identity = edge.identity;
      const assertIngress = async () => {
        assert(sameProcess(identity, await processIdentity(identity.hostPid)), "original_ingress_not_running");
      };
      await assertIngress();
      if (trustedConsent) {
        assert(before.trustedPublication?.raw === after.trustedPublication?.raw, "trusted_web2_publication_attachment_changed");
        if (after.trustedPublication) {
          await inspectTrustedSelection(after.trustedPublication);
          const latest = await authorize(body.draft, body.planId, body.generation, { record, starting: true });
          assert(latest.trustedPublication?.raw === after.trustedPublication.raw, "trusted_web2_publication_attachment_changed");
          await assertIngress();
        }
      }
      if (trusted && !before.expanded && !after.expanded) {
        const original = nativeOriginal(record);
        const policy = await readTrustedRevisionTwoPolicy({
          graph, original, now, currentAdmissionFile: selected.currentAdmissionFile,
        });
        const resourcesSha256 = trustedRevisionOneResourceDigest(selected.target.containers.length, state.resources);
        await retainTrustedRevisionOneServingWitness({
          graph, original, policy, resourcesSha256,
          async assertCurrent() {
            await assertIngress();
            await inspectTrustedRevisionOneIngress(ingress, body.draft.configuration);
            const current = await controller.inspect(AbortSignal.timeout(45000));
            assert(current.fingerprint === selected.hostFingerprint &&
              current.resources.every(r => r.actual?.State.Running) &&
              trustedRevisionOneResourceDigest(selected.target.containers.length, current.resources) === resourcesSha256,
              "trusted_revision_two_original_serving_resources_changed");
            const same = await load(selection);
            assert(canonicalDigest(same.record) === canonicalDigest(record), "trusted_revision_two_original_changed");
            const confirmed = await authorize(body.draft, body.planId, body.generation, { record, starting: true });
            assert(!confirmed.expanded && confirmed.evidence.configurationRevision === 1,
              "trusted_revision_two_original_serving_authority_changed");
            assert(canonicalDigest(await readTrustedRevisionTwoPolicy({
              graph, original, now, currentAdmissionFile: selected.currentAdmissionFile,
            })) === canonicalDigest(policy), "trusted_revision_two_binding_policy_changed");
            await assertIngress();
            await open();
            return confirmed.evidence;
          },
        });
      }
      return { ...base, state: "running" };
    } catch {
      return {
        ...base,
        state: "unavailable",
        reason: "installation_authority_or_readback_unavailable",
      };
    }
  }
  async function retainedDanceContext(assertRetained: () => Promise<void>) {
    const paths = danceActivationPaths(graph), transport = graph.nativePublication;
    assert(paths && transport, "web2_dance_activation_unselected");
    await assertRetained();
    await open();
    const retained = await readPrivateJSON<SignedRecord<Web2InstallPlan>>(originalPath);
    const selection = selectionFor(verifyRecord(retained, selected.trust));
    const { body, record } = await load(selection);
    const original = nativeOriginal(record);
    const readStart = async () => {
      const actual = await readPrivateJSON(join(selected.planDirectory, "web2-start-intent.json"));
      assert(canonicalDigest(actual) === canonicalDigest(web2OriginalStartIntent(body)), "original_start_intent_changed");
    };
    await readStart();
    const mountPath = nativePublicationPaths(transport.directory).selector;
    const publicationMount = await readDanceActivationPublicationMount(mountPath);
    const approval = await readApprovedExpandedPublication({ graph, original, chain });
    await assertRetained();
    const resources = await controller.inspect(AbortSignal.timeout(45000));
    function runningIdentity(state: typeof resources) {
      assert(state.fingerprint === selected.hostFingerprint && state.resources.length === selected.target.containers.length &&
        state.resources.every(r => r.actual?.State.Running), "web2_dance_activation_running_original_required");
      return canonicalDigest(state.resources.map(r => ({ key: r.spec.key, id: r.actual.Id })));
    }
    const resourceDigest = runningIdentity(resources);
    const assertCurrent = async () => {
      await assertRetained();
      await open();
      await assertStartAllowed(selected.target.maintenanceDirectory);
      await readStart();
      const latest = await load(selection);
      assert(canonicalDigest(latest.record) === canonicalDigest(record), "web2_dance_activation_original_changed");
      const permitted = await authorize(body.draft, body.planId, body.generation, { record, starting: true });
      assert(permitted.expanded && permitted.expanded.approvalSha256 === approval.approvalSha256 &&
        permitted.expanded.selectionSha256 === approval.selectionSha256 &&
        await readDanceActivationPublicationMount(mountPath) === publicationMount,
        "web2_dance_activation_publication_changed");
      assert(runningIdentity(await controller.inspect(AbortSignal.timeout(45000))) === resourceDigest,
        "web2_dance_activation_running_original_changed");
      await currentHostAdmission(body.draft, body.planId, body.generation);
      await assertRetained();
      await open();
    };
    return { graph, original, chain, approval, publicationMount, paths, transport, assertCurrent };
  }
  const service: Web2InstalledService = {
    verifyExpandedPublishing: (selection, draft) =>
      exclusive(async () => {
        if (release.graph.publicationExpansion === undefined) return undefined;
        const { body, record } = await load(structuredClone(selection));
        assert(canonicalDigest(body.draft) === canonicalDigest(linuxWeb2DraftFrom(draft)), "original_web2_draft_changed");
        if (!await expandedPublicationApprovalExists(release.graph)) return undefined;
        const admitted = await authorize(body.draft, body.planId, body.generation, { record, starting: true });
        assert(admitted.expanded, "native_expanded_publication_activation_unadmitted");
        return "expanded";
      }),
    prepare: (value) =>
      exclusive(async () => {
        const draft = linuxWeb2DraftFrom(value),
          planId = "web2-" + draft.enrollment.enrollmentId.slice(2);
        const old =
          await optionalRecord<SignedRecord<Web2InstallPlan>>(originalPath);
        if (old) {
          const prior = verifyRecord(old, selected.trust);
          assert(
            canonicalDigest(prior.draft) === canonicalDigest(draft),
            "original_web2_draft_changed",
          );
          await load(selectionFor(prior));
          await authorize(draft, prior.planId, prior.generation, { record: old, starting: false });
          await retain(selected.planDirectory, "web2-original", old);
          return summary(prior);
        }
        const current = await authorize(draft, planId);
        const plan: Web2InstallPlan = {
          schema: "pirate.linux-web2-install-plan/1",
          planId,
          installationId: lease.installationId,
          durableScope: release.graph.durableScope,
          generation: current.admission.generation,
          draft,
          releaseArtifactDigest: release.artifactDigest,
          releaseSourceDigest: release.sourceDigest,
          ...(selected.applicationRelease.body.publishingAttachmentDigest ? {publishingAttachmentDigest:selected.applicationRelease.body.publishingAttachmentDigest} : {}),
          ...(selected.applicationRelease.body.danceRewardIntentSha256
            ? { danceRewardIntentSha256: selected.applicationRelease.body.danceRewardIntentSha256 } : {}),
          targetDigest,
          hostFingerprint: selected.hostFingerprint,
          enrollment: current.evidence,
          registrationAuthority: {
            registrar: chain.registrar,
            registrarRevision: String(chain.registrarRevision),
            maxSafeBlockAgeSeconds: String(chain.maxSafeBlockAgeSeconds),
          },
        };
        const signed = await signProfile(
          structuredClone(plan),
          plan.generation,
        );
        assert(
          canonicalDigest(verifyRecord(signed, selected.trust)) ===
            canonicalDigest(plan),
          "web2_profile_signer_changed_body",
        );
        await authorize(draft, planId, plan.generation);
        await retain(selected.planDirectory, "web2-original", signed);
        await lease.record("web2-original-profile-retained", summary(plan));
        return summary(plan);
      }),
    apply: (selection) =>
      exclusive(async () => {
        const owned = structuredClone(selection),
          { body, record } = await load(owned);
        assert(!ingressFailure, "original_ingress_custody_unresolved");
        const original = nativeOriginal(record);
        if (prepareExpansion) {
          const fields = release.graph.applicationBindings.filter(item => item.name === "WEB2_PUBLISHING_ATTACHMENT_JSON");
          const text = fields[0]?.text;
          assert(fields.length === 1 && text, "native_expansion_attachment_required");
          const attachment = publishingAttachment(JSON.parse(text));
          assert(attachment.digest === body.publishingAttachmentDigest, "native_expansion_attachment_changed");
          async function assertLifetimeHeld() {
            signal?.throwIfAborted();
            await lease.assertHeld();
            assert(canonicalDigest(await readPrivateJSON(originalPath)) === canonicalDigest(record), "native_expansion_original_changed");
            await currentHostAdmission(body.draft, body.planId, body.generation);
            await lease.assertHeld();
            signal?.throwIfAborted();
          }
          async function assertCurrent() {
            await open();
            await assertStartAllowed(selected.target.maintenanceDirectory);
            assert(!edge && !ingressFailure && !await optionalRecord(join(selected.planDirectory, "web2-start-intent.json")),
              "native_expansion_installation_already_started");
            const host = await controller.inspect(AbortSignal.timeout(45000));
            assert(host.fingerprint === selected.hostFingerprint && host.resources.length === selected.target.containers.length &&
              host.resources.every(resource => resource.actual === null), "native_expansion_application_already_created");
            await assertWeb2IngressUncreated(ingress);
            await assertLifetimeHeld();
            await open();
          }
          await prepareOnce({
            intent: { schema: "pirate.web2-expansion-bootstrap/1", installationId: body.installationId,
              operationId: lease.operationId, nativeOriginalSha256: nativeDigest(original),
              graphSha256: canonicalDigest(release.graph), attachmentSha256: attachment.digest },
            async authorize() {
              assert(!await expandedPublicationApprovalExists(release.graph), "native_expansion_bootstrap_requires_reconciliation");
              await authorize(body.draft, body.planId, body.generation);
            },
            assertCurrent,
            execute: () => prepareExpansion({ original: structuredClone(original), graph: structuredClone(release.graph),
              attachment: structuredClone(attachment), assertCurrent, assertLifetimeHeld }),
          });
        }
        const retained = { record, starting: true };
        const admitted = await authorize(body.draft, body.planId, body.generation, retained);
        const current = async () => {
          const observed = await authorize(body.draft, body.planId, body.generation, retained);
          assert(observed.expanded?.selectionSha256 === admitted.expanded?.selectionSha256 &&
            (!trusted || observed.expanded?.approvalSha256 === admitted.expanded?.approvalSha256) &&
            observed.trustedPublication?.raw === admitted.trustedPublication?.raw,
            "native_expanded_publication_selection_changed");
        };
        const intent = web2OriginalStartIntent(body);
        const prior = await optionalRecord(
          join(selected.planDirectory, "web2-start-intent.json"),
        );
        if (trusted && admitted.expanded)
          assert(prior, "trusted_revision_two_original_start_required");
        if (prior) {
          assert(canonicalDigest(prior) === canonicalDigest(intent), "original_start_intent_changed");
        }
        if (trusted && admitted.expanded) await current();
        if (posts) {
          await stagePostsSelector({original, graph: release.graph, target: selected.target,
            owner: posts, startRetained: prior !== null, assertCurrent: current});
        }
        if (admitted.trustedPublication) {
          assert(prior && activateTrustedPublication, "trusted_web2_publication_original_start_required");
          const { selector, selection } = admitted.trustedPublication.initialization;
          await current();
          const actual = await controller.inspect(AbortSignal.timeout(45000));
          const application = actual.resources.find(row => row.spec.key === "application");
          assert(application?.actual, "trusted_web2_publication_original_resource_required");
          if (application.actual.State.Running) {
            try {
              await inspectTrustedSelection(admitted.trustedPublication);
            } catch (cause) {
              throw new Error("trusted_web2_publication_supervised_restart_required", { cause });
            }
          }
          await current();
          await activateTrustedPublication({
            original, selection, selectionSha256: selector.body.mount.selectionSha256, assertCurrent: current,
          });
          await current();
        }
        if (publication && release.graph.nativePublication) {
          const staged = await stageNativePublication({
            original,
            transport: release.graph.nativePublication,
            ports: publication,
            startRetained: prior !== null,
            ...(admitted.expanded?.selectionSha256 ? { expectedSelectionSha256: admitted.expanded.selectionSha256 } : {}),
            assertCurrent: current,
          });
          if (publication.activateAfterStaging) {
            assert(admitted.expanded?.selectionSha256, "native_expanded_publication_activation_unadmitted");
            await current();
            await publication.activateAfterStaging({ original, selection: staged.selection,
              selectionSha256: admitted.expanded.selectionSha256, assertCurrent: current });
            await current();
          }
        }
        await retain(selected.planDirectory, "web2-launch", {
          schema: "pirate.linux-web2-launch/1",
          release: selected.release,
          applicationRelease: selected.applicationRelease,
          trust: selected.trust,
          currentAdmissionFile: selected.currentAdmissionFile,
          minimumGeneration: body.generation,
          privateRuntimeDirectory: selected.nativeRuntimeDirectory,
          maintenanceDirectory: selected.target.maintenanceDirectory,
        });
        if (prior) {
          // A lost create reply does not authorize creating/adopting missing resources.
          const state = await controller.inspect(AbortSignal.timeout(45000));
          assert(
            state.resources.every((r) => r.actual !== null),
            "original_start_effect_uncertain",
          );
        } else {
          await retain(selected.planDirectory, "web2-start-intent", intent);
          await current();
          await controller.create(AbortSignal.timeout(180000), current);
        }
        await retainPublicIngress(ingress, lease);
        await current();
        await controller.start(AbortSignal.timeout(120000), current);
        await waitForCommunityIngress(
          ingress,
          body.draft.enrollment.communityId,
          current,
        );
        await current();
        if (admitted.trustedPublication) {
          await inspectTrustedSelection(admitted.trustedPublication);
          await current();
        }
        if (edge) {
          const actual = await processIdentity(edge.identity.hostPid);
          if (actual === null) edge = undefined;
          else
            assert(
              sameProcess(edge.identity, actual),
              "original_ingress_identity_unavailable",
            );
        }
        if (!edge) {
          try {
            edge = await startPublicIngress(ingress, lease, current);
          } catch (error) {
            if (error instanceof IngressStartupFailure) ingressFailure = error;
            throw error;
          }
        }
        return observation(owned);
      }),
    status: (selection) => trusted
      ? exclusive(() => observation(structuredClone(selection)))
      : observation(structuredClone(selection)),
    stageRetainedDance: (owner, assertRetained) =>
      exclusive(async () => {
        const context = await retainedDanceContext(assertRetained);
        return stageWeb2DanceActivation({ ...context, owner });
      }),
    prepareRetainedDanceBindings: (owner, assertRetained) =>
      exclusive(async () => {
        const context = await retainedDanceContext(assertRetained);
        const { original, approval, paths, transport, publicationMount } = context;
        const attachmentJson = await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes);
        const rewards = await readWeb2InstalledDanceRewards({ original, attachmentJson, publicationMountJson: publicationMount });
        const configurationSha256 = hashJson(approval.configuration);
        assert(rewards && approval.selection.active && rewards.attachment.approvalSha256 === approval.approvalSha256 &&
          rewards.attachment.selectionSha256 === approval.selectionSha256 &&
          rewards.attachment.configurationHash === configurationSha256,
          "web2_dance_bind_prepare_rewards_changed");
        const assertCurrent = async () => {
          await context.assertCurrent();
          assert(await readDanceActivationArtifact(paths.reward, maxWeb2DanceRewardBytes) === attachmentJson,
            "web2_dance_bind_prepare_rewards_changed");
          await assertRetained();
          await open();
        };
        return retainWeb2DanceBindPrepare({
          original, directory: paths.directory, source: rewards.source, owner, assertCurrent,
          approved: {
            releaseSha256: approval.selection.active, configurationSha256, ownerWallet: approval.ownerWallet,
            publisher: approval.configuration.publisher, configurationRevision: approval.configuration.configurationRevision,
          },
          prepare: raw => requestWeb2DanceBindPrepare({ ingress, transportDirectory: transport.directory, raw, assertCurrent }),
        });
      }),
    async resumeOriginal() {
      await open();
      const retained =
        await optionalRecord<SignedRecord<Web2InstallPlan>>(originalPath);
      if (!retained) return null;
      const original = verifyRecord(retained, selected.trust),
        selection = selectionFor(original);
      await load(selection);
      // Retaining a prepared plan alone is not approval to start installation.
      if (
        !(await optionalRecord(
          join(selected.planDirectory, "web2-start-intent.json"),
        ))
      )
        return observation(selection);
      return service.apply(selection);
    },
    async close() {
      assert(!busy, "installation_operation_not_quiescent");
      closed = true;
      // Setup lifetime ends; the explicit installed host service still owns
      // Caddy and keeps the community running. No resource or lease is released.
    },
    async shutdownService() {
      closed = true;
      await Promise.race([
        idle,
        delay(200000, undefined, { ref: false }).then(() => {
          throw Error("web2_service_operation_not_quiescent");
        }),
      ]);
      if (ingressFailure) {
        const terminal = await ingressFailure.custody.stop(),
          pid = ingressFailure.custody.pid;
        assert(
          !pid || (await processIdentity(pid)) === null,
          "ingress_failure_lifetime_remains",
        );
        if (terminal.code !== 0 || terminal.signal !== null)
          process.exitCode = 1;
        ingressFailure = undefined;
      }
      const terminal = await edge?.stop();
      if (terminal && (terminal.code !== 0 || terminal.signal !== null))
        process.exitCode = 1;
      edge = undefined;
      await controller.dispose();
    },
  };
  return service;
}
