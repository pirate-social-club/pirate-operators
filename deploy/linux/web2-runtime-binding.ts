import { canonical, hashJson } from "../../packages/community/common.ts";
import { ownerOnly } from "../../packages/community/owner-policy.ts";
import { createWeb2PublishingSetup } from "../../apps/community-wizard/server/web2-publishing-setup.ts";
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
  type Web2ChainAuthority,
  type Web2HostAdmission,
  type Web2InstallPlan,
} from "./web2-profile-authority.ts";
import type { NativeGraph } from "./full-native-config.ts";
import type { Web2InstallationHostInputs } from "./web2-local-installation.ts";
import {
  web2ApplicationReleaseBody,
  type Web2NativeOriginal,
} from "../../packages/community/web2-native-business-binding.ts";

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
export const web2TargetDigest = (
  target: InstalledTarget,
  ingress: PublicIngress,
  nativeRuntimeDirectory: string,
) => canonicalDigest({ target, ingress, nativeRuntimeDirectory });

export async function createWeb2RuntimeBinder(input: Web2RuntimeBindingInputs) {
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
  const publishing = input.publishing ? await createWeb2PublishingSetup(input.publishing.directory, {
    hostInstallationId:policy.installationId,publisher:input.publishing.publisher,
    publishing:{chain,grants:input.publishing.grants},now:()=>Math.floor(now()/1000),
  }) : null;
  const ingress = publicIngressFrom(policy.ingress);
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
  async function authenticate(draft: LinuxWeb2Draft) {
    live();
    await lease.assertHeld();
    await verifyWeb2BootstrapRelease(captured.bootstrap, captured.trust);
    assert(draft.origin === policy.origin, "web2_binding_origin_changed");
    await authenticateWeb2Enrollment(chain, draft);
    const controller = await createLocalController(policy.target, lease);
    try {
      const host = await controller.inspectHost(AbortSignal.timeout(45000));
      assert(
        host.supported && host.fingerprint === policy.hostFingerprint,
        "web2_binding_host_changed",
      );
    } finally {
      await controller.dispose();
    }
    live();
    await lease.assertHeld();
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
    if (ownerOnly(draft.configuration.policies.admission)) assert(attachment,"web2_publishing_attachment_required");
    if (attachment) {
      const a = publishingAttachment(attachment), scope = a.selection.scope, c = draft.configuration;
      assert(scope.enrollmentId === draft.enrollment.enrollmentId && scope.hostInstallationId === policy.installationId &&
        scope.installationId === c.installationId && scope.communityId === c.communityId && scope.origin === draft.origin &&
        scope.controller === c.controller && scope.publisher === c.publisher && scope.postsContract === c.postsContract &&
        scope.deploymentDigest === hashJson(draft.deployment),"web2_publishing_attachment_scope_changed");
    }
    return {
      ...structuredClone(policy.graph),
      directoryRuntimeBinding: JSON.stringify(draft.deployment),
      applicationBindings: [
        ...structuredClone(policy.graph.applicationBindings),
        { name: "COMMUNITY_NAME", text: draft.name },
        { name: "PLAN_ID", text: draft.deployment.planId },
        ...(attachment ? [
          {name:"OWNER_GRANT_JSON",text:JSON.stringify(attachment.selection.grant)},
          {name:"OWNER_AUTHORIZATION_JSON",text:JSON.stringify(attachment.authorization)},
          {name:"WEB2_PUBLISHING_ATTACHMENT_SHA256",text:attachment.digest},
          {name:"WEB2_PUBLISHING_ATTACHMENT_JSON",text:JSON.stringify(attachment)},
          {name:"WEB2_PUBLISHING_SELECTION_SHA256",text:attachment.selection.selectionDigest},
          {name:"OWNER_GRANT_ADMISSION_REFERENCE",text:attachment.selection.admissionReference},
        ] : []),
      ],
    };
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
  async function hostInputs(
    bound: BoundRuntime,
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
    await authenticate(draft);
    if (bound.intent.publishingAttachment) {
      assert(publishing,"web2_publishing_authority_unavailable");
      assert(canonical(await publishing.attachment(draft)) === canonical(bound.intent.publishingAttachment),"web2_publishing_attachment_changed");
    }
    await retainWeb2Record(
      policy.bindingDirectory,
      "web2-binding-intent",
      bound.intent,
    );
    await retainWeb2Record(
      policy.bindingDirectory,
      "web2-bound-runtime",
      bound,
    );
    // A crash between the combined result and admission persistence completes
    // the same bytes. A newer valid admission is never overwritten on restart.
    const admission =
      (await optionalWeb2Record<SignedRecord<Web2HostAdmission>>(
        policy.currentAdmissionFile,
      )) ?? bound.admission;
    assert(
      basename(policy.currentAdmissionFile) === "web2-host-admission.json",
      "owned_admission_filename_required",
    );
    // Re-sync the exact current envelope, including a newer signed refresh.
    // Never replace it with the earlier admission embedded in the bound result.
    await retainWeb2Record(
      dirname(policy.currentAdmissionFile),
      "web2-host-admission",
      admission,
    );
    await readWeb2HostAdmission({
      path: policy.currentAdmissionFile,
      trust: captured.trust,
      now,
      installationId: policy.installationId,
      draft,
      releaseArtifactDigest: bootstrap.artifactDigest,
      targetDigest,
      hostFingerprint: policy.hostFingerprint,
      minimumGeneration: policy.generation,
    });
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
      signProfile: async (body,generation) => {
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
    trust: captured.trust,
    lease,
    async retained() {
      const bound = await optionalWeb2Record<BoundRuntime>(boundPath);
      return bound ? hostInputs(bound) : null;
    },
    async bind(value: unknown) {
      assert(!busy, "web2_binding_in_progress");
      busy = true;
      try {
        const draft = linuxWeb2DraftFrom(value);
        await authenticate(draft);
        const bound = await optionalWeb2Record<BoundRuntime>(boundPath);
        if (bound) {
          validateIntent(bound.intent, draft);
          return hostInputs(bound);
        }
        let intent = await optionalWeb2Record<BindingIntent>(intentPath);
        if (intent) validateIntent(intent, draft);
        else {
          const attachment = ownerOnly(draft.configuration.policies.admission)
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
