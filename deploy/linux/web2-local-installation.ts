import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Hex } from "viem";
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
  authenticateWeb2InstallationAuthorization,
  ownWeb2ChainAuthority,
  readWeb2HostAdmission,
  type Web2ChainAuthority,
  type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import {
  IngressStartupFailure,
  inspectCommunityIngress,
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
  signProfile(
    body: Web2InstallPlan,
    generation: number,
  ): Promise<SignedRecord<Web2InstallPlan>>;
}
export interface Web2InstalledService extends LinuxWeb2Installation {
  resumeOriginal(): Promise<LinuxWeb2Observation | null>;
  shutdownService(): Promise<void>;
}
export async function createWeb2Installation(
  input: Web2InstallationHostInputs,
  signal?: AbortSignal,
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
  async function authorize(
    draft: LinuxWeb2Draft,
    planId?: string,
    retainedGeneration = selected.minimumGeneration,
  ) {
    await open();
    assert(
      draft.origin === ingress.origin &&
        canonicalDigest(draft.deployment) ===
          canonicalDigest(JSON.parse(release.graph.directoryRuntimeBinding)),
      "installed_web2_deployment_changed",
    );
    await verifyInstalledRelease(selected.release, selected.trust);
    const host = () =>
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
    await host();
    const original = draft.enrollment.operations.find(
      (op) => op.kind === "registration",
    );
    const evidence =
      original &&
      original.state === "consumed" &&
      original.transactionHash &&
      original.receipt !== null
        ? await authenticateWeb2Enrollment(chain, draft)
        : await authenticateWeb2InstallationAuthorization(chain, draft);
    const admission = await host();
    const actual = await controller.inspectHost(AbortSignal.timeout(45000));
    assert(
      actual.supported && actual.fingerprint === selected.hostFingerprint,
      "web2_installed_host_changed",
    );
    await host();
    await open();
    return { evidence, admission };
  }
  async function load(selection: LinuxWeb2PlanSelection) {
    await open();
    assert(Object.keys(selection).sort().join(",") === "planDigest,planId");
    const record =
        await readPrivateJSON<SignedRecord<Web2InstallPlan>>(originalPath),
      body = verifyRecord(record, selected.trust);
    assert.deepEqual(Object.keys(body).sort(), ["schema","planId","installationId","durableScope","generation","draft","releaseArtifactDigest","releaseSourceDigest","targetDigest","hostFingerprint","enrollment","registrationAuthority",...(Object.hasOwn(body,"publishingAttachmentDigest") ? ["publishingAttachmentDigest"] : [])].sort(),"original_web2_installation_fields_changed");
    assert(
      body.schema === "pirate.linux-web2-install-plan/1" &&
        body.planId === selection.planId &&
        canonicalDigest(body) === selection.planDigest &&
        body.installationId === lease.installationId &&
        body.durableScope === release.graph.durableScope &&
        body.releaseArtifactDigest === release.artifactDigest &&
        body.releaseSourceDigest === release.sourceDigest &&
        body.publishingAttachmentDigest === selected.applicationRelease.body.publishingAttachmentDigest &&
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
      binding: {
        generation: p.generation,
        planId: p.planId,
        durableScope: p.durableScope,
        releaseArtifactDigest: p.releaseArtifactDigest as Hex,
        releaseSourceDigest: p.releaseSourceDigest as Hex,
        targetDigest: p.targetDigest,
        hostFingerprint: p.hostFingerprint,
      },
      summary: {
        name: p.draft.name,
        origin: p.draft.origin,
        communityId: p.draft.enrollment.communityId,
        controller: p.draft.configuration.controller,
        publisher: p.draft.configuration.publisher,
        registrationTransaction:
          p.enrollment.schema === "pirate.linux-web2-enrollment-evidence/1"
            ? p.enrollment.transactionHash
            : null,
        verifiedListing: false,
        namesEnabled: false,
        learningEnabled: false,
        danceEnabled: false,
      },
    };
  }
  function installationProbe(body: Web2InstallPlan) {
    return body.enrollment.schema ===
      "pirate.linux-web2-installation-authorization/1"
      ? {
          enrollmentId: body.enrollment.enrollmentId,
          configuration: body.draft.configuration,
          generation: body.generation,
          planId: body.planId,
          durableScope: body.durableScope,
          releaseArtifactDigest: body.releaseArtifactDigest as Hex,
          releaseSourceDigest: body.releaseSourceDigest as Hex,
          targetDigest: body.targetDigest,
          hostFingerprint: body.hostFingerprint,
        }
      : undefined;
  }
  async function observation(
    selection: LinuxWeb2PlanSelection,
  ): Promise<LinuxWeb2Observation> {
    const { body } = await load(structuredClone(selection));
    const base = { ...selectionFor(body), installationId: body.installationId };
    try {
      await authorize(body.draft, body.planId, body.generation);
      const state = await controller.inspect(AbortSignal.timeout(45000));
      const intent = await optionalRecord(
        join(selected.planDirectory, "web2-start-intent.json"),
      );
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
        undefined,
        installationProbe(body),
      );
      await authorize(body.draft, body.planId, body.generation);
      assert(
        sameProcess(
          edge.identity,
          await processIdentity(edge.identity.hostPid),
        ),
        "original_ingress_not_running",
      );
      return { ...base, state: "running" };
    } catch {
      return {
        ...base,
        state: "unavailable",
        reason: "installation_authority_or_readback_unavailable",
      };
    }
  }
  const service: Web2InstalledService = {
    prepare: (value) =>
      exclusive(async () => {
        const draft = linuxWeb2DraftFrom(value),
          planId = "web2-" + draft.enrollment.enrollmentId.slice(2);
        const current = await authorize(draft, planId);
        const old =
          await optionalRecord<SignedRecord<Web2InstallPlan>>(originalPath);
        if (old) {
          const prior = verifyRecord(old, selected.trust);
          assert(
            canonicalDigest(prior.draft) === canonicalDigest(draft),
            "original_web2_draft_changed",
          );
          await load(selectionFor(prior));
          await authorize(draft, prior.planId, prior.generation);
          await retain(selected.planDirectory, "web2-original", old);
          return summary(prior);
        }
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
          { body } = await load(owned);
        assert(!ingressFailure, "original_ingress_custody_unresolved");
        const current = async () => {
          await authorize(body.draft, body.planId, body.generation);
        };
        await current();
        const intent = {
          ...selectionFor(body),
          targetDigest,
          installationId: body.installationId,
        };
        const prior = await optionalRecord(
          join(selected.planDirectory, "web2-start-intent.json"),
        );
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
          assert(
            canonicalDigest(prior) === canonicalDigest(intent),
            "original_start_intent_changed",
          );
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
          installationProbe(body),
        );
        await current();
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
    status: (selection) => observation(structuredClone(selection)),
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
