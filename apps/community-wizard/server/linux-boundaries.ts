import {operatorPolicyFrom} from "../../../packages/community-setup/shared-operator-policy.ts";
import {preparedSharedTargetFrom} from "./shared-target.ts";
import {
  storageProfileFrom,
  type ObjectStorageProfileV1,
} from "../../../packages/community-setup/storage.ts";
import {
  fields,
  record,
  reference,
  text,
  hash,
  natural,
  requireLinux,
  linuxProfileFrom,
  targetFrom,
  type LinuxDraftV2,
} from "../../../packages/community-setup/shared-linux-profile.ts";
import { backendPlanFrom, sha256From } from "./linux-operator-boundary.ts";
import { canonical, digestJson, sameIdentity } from "./linux-journal.ts";
import type {
  CredentialRequirement,
  LinuxCapabilities,
  LinuxPlan,
  NamespaceProof,
  NamespaceAuthorityResult,
  RestoreInspection,
  TargetInspection,
} from "./linux-contracts.ts";
export function requirementsFrom(value: unknown): CredentialRequirement[] {
  requireLinux(
    Array.isArray(value) && value.length <= 30,
    "invalid_requirements",
    "The backend returned unsupported credential requirements.",
  );
  const result = value.map((v) => {
    const r = fields(v, [
      "id",
      "label",
      "role",
      "scope",
      "state",
      "correction",
    ]);
    requireLinux(
      ["ssh", "speech", "publication", "public-media", "backup"].includes(
        String(r.role),
      ) && ["missing", "saved", "verified"].includes(String(r.state)),
      "invalid_requirements",
      "Use a compatible managed-credential adapter.",
    );
    const id = reference(r.id);
    requireLinux(
      !/PRIVATE_KEY|OIDC|PLATFORM_LOGIN|ACRCLOUD|CATALOG|RECOGNITION_PROVIDER/i.test(id),
      "managed_signer_required",
      "Signer and platform login credentials must stay in their distinct managed backend scopes.",
    );
    return {
      id,
      label: text(r.label),
      role: r.role,
      scope: text(r.scope),
      state: r.state,
      correction:
        typeof r.correction === "string" ? r.correction.slice(0, 240) : "",
    } as CredentialRequirement;
  });
  requireLinux(
    new Set(result.map((v) => v.id)).size === result.length,
    "invalid_requirements",
    "Credential requirement identities must be distinct.",
  );
  return result;
}
export function capabilitiesFrom(value: unknown): LinuxCapabilities {
  const c = fields(value, [
    "version",
    "adapterId",
    "sourceDigest",
    "targets",
    "operations",
    "features",
    "backup",
    "publicationProfiles", "publicationSelection",
    "learningProfiles",
    "sshConnections",
    "backupProfiles",
    "limitations", "policy",
  ]);
  requireLinux(
    c.version === 2,
    "adapter_version",
    "Install a compatible Linux deployment adapter.",
  );
  const list = (v: unknown, allowed: string[]) => {
    requireLinux(
      Array.isArray(v) &&
        v.length <= allowed.length &&
        v.every((item) => typeof item === "string" && allowed.includes(item)) &&
        new Set(v).size === v.length,
      "adapter_capabilities",
      "The Linux adapter returned incompatible capabilities.",
    );
    return v as string[];
  };
  const profiles = (v: unknown) => {
    requireLinux(
      Array.isArray(v) && v.length <= 100,
      "adapter_profiles",
      "Use the supported backend profile catalog.",
    );
    return v.map((item) => {
      const r = fields(item, ["id", "label", "verified"]);
      requireLinux(
        typeof r.verified === "boolean",
        "adapter_profiles",
        "Profile verification is unavailable.",
      );
      return {
        id: reference(r.id),
        label: text(r.label),
        verified: r.verified,
      };
    });
  };
  requireLinux(
    Array.isArray(c.backupProfiles) && c.backupProfiles.length <= 100,
    "backup_profiles",
    "Discover a supported encrypted-backup destination on this runner.",
  );
  const backupProfiles = c.backupProfiles.map((v) => {
    const r = fields(v, ["id", "label", "profile"]),
      profile = storageProfileFrom(r.profile);
    requireLinux(
      profile.role === "backup",
      "backup_profiles",
      "Select a backup transport, separate from public media.",
    );
    return {
      id: reference(r.id),
      label: text(r.label),
      profile: profile as ObjectStorageProfileV1,
    };
  });
  const b = fields(c.backup, ["formats", "maxBytes", "sessionPolicies"]);
  requireLinux(
    Array.isArray(b.formats) &&
      b.formats.length <= 10 &&
      b.formats.every((v) => typeof v === "string" && v.length < 100),
    "backup_capabilities",
    "No compatible encrypted backup format is installed.",
  );
  requireLinux(
    Array.isArray(c.sshConnections) &&
      c.sshConnections.length <= 100 &&
      Array.isArray(c.limitations) &&
      c.limitations.length <= 50 &&
      c.limitations.every((v) => typeof v === "string" && v.length <= 240),
    "adapter_capabilities",
    "Refresh the backend capability catalog.",
  );
  return {
    version: 2,
    adapterId: reference(c.adapterId),
    sourceDigest: hash(c.sourceDigest),
    targets: list(c.targets, [
      "local-linux",
      "ssh-linux",
    ]) as LinuxCapabilities["targets"],
    operations: list(c.operations, [
      "create",
      "import",
      "restore",
      "upgrade",
    ]) as LinuxCapabilities["operations"],
    features: list(c.features, [
      "learning",
      "karaoke",
      "media",
      "dance",
      "telegram",
    ]) as LinuxCapabilities["features"],
    backup: {
      formats: b.formats as string[],
      maxBytes: natural(b.maxBytes, 1024 ** 4),
      sessionPolicies: list(b.sessionPolicies, [
        "revoke-existing",
        "preserve-existing",
      ]) as LinuxCapabilities["backup"]["sessionPolicies"],
    },
    publicationSelection: c.publicationSelection===null?null:reference(c.publicationSelection),
    publicationProfiles: profiles(c.publicationProfiles),
    learningProfiles: profiles(c.learningProfiles),
    sshConnections: c.sshConnections.map((v) => {
      const r = fields(v, ["id", "label"]);
      return { id: reference(r.id), label: text(r.label) };
    }),
    backupProfiles,
    limitations: c.limitations as string[],
    policy: operatorPolicyFrom(c.policy),
  };
}
export function targetInspectionFrom(
  value: unknown,
  draft: Pick<LinuxDraftV2, "target">,
): TargetInspection {
  const t = fields(value, [
    "id",
    "target",
    "fingerprint",
    "supported",
    "description",
    "corrections",
    "existing", "prepared",
  ]);
  requireLinux(
    canonical(targetFrom(t.target)) === canonical(draft.target) &&
      typeof t.supported === "boolean" &&
      Array.isArray(t.existing) &&
      t.existing.length <= 50 &&
      Array.isArray(t.corrections) &&
      t.corrections.length <= 20 &&
      t.corrections.every((v) => typeof v === "string" && v.length <= 240),
    "target_changed",
    "Inspect the selected host again; it no longer matches this setup.",
  );
  return {
    id: reference(t.id),
    target: targetFrom(t.target),
    fingerprint: text(t.fingerprint),
    supported: t.supported,
    description: text(t.description),
    corrections: t.corrections as string[],
    existing: t.existing.map(linuxProfileFrom),
    prepared: preparedSharedTargetFrom(t.prepared, draft),
  };
}
export {namespaceResultFrom as namespaceProofFrom} from "./shared-namespace-port.ts";
export function restoreInspectionFrom(
  value: unknown,
  backupId: string,
  ciphertextDigest: string,
  formats: string[],
): RestoreInspection {
  const r = fields(value, [
    "id",
    "backupId",
    "ciphertextDigest",
    "manifestDigest",
    "format",
    "authenticated",
    "compatible",
    "profile",
    "sessionPolicies",
    "corrections",
  ]);
  requireLinux(
    r.backupId === backupId &&
      r.ciphertextDigest === ciphertextDigest &&
      typeof r.format === "string" &&
      formats.includes(r.format) &&
      r.authenticated === true &&
      r.compatible === true &&
      Array.isArray(r.sessionPolicies) &&
      r.sessionPolicies.every((v) =>
        ["revoke-existing", "preserve-existing"].includes(String(v)),
      ) &&
      Array.isArray(r.corrections) &&
      r.corrections.length <= 20 &&
      r.corrections.every((v) => typeof v === "string" && v.length <= 240),
    "restore_incompatible",
    "This backup could not be authenticated or restored by this backend. Check the separate recovery key, format and required backend capabilities.",
  );
  return {
    id: reference(r.id),
    backupId,
    ciphertextDigest: hash(r.ciphertextDigest),
    manifestDigest: hash(r.manifestDigest),
    format: r.format,
    authenticated: true,
    compatible: true,
    profile: linuxProfileFrom(r.profile),
    sessionPolicies: r.sessionPolicies as RestoreInspection["sessionPolicies"],
    corrections: r.corrections as string[],
  };
}
export function planFrom(value: unknown): LinuxPlan {
  const p = fields(value, [
    "id",
    "digest",
    "profileDigest",
    "expiresAt",
    "backend",
    "profile", "operatorPolicy",
    "targetInspectionId",
    "targetFingerprint",
    "namespaceProofId",
    "action",
    "changes",
    "warnings",
    "requirements",
    "restoreInspectionId",
    "restoreManifestDigest",
    "restoreCiphertextDigest",
    "predecessorOperationId",
    "sessionPolicy",
  ]);
  requireLinux(
    ["create", "adopt", "restore", "upgrade"].includes(String(p.action)) &&
      ["revoke-existing", "preserve-existing"].includes(
        String(p.sessionPolicy),
      ),
    "invalid_plan",
    "Prepare a supported whole-application plan.",
  );
  for (const key of ["changes", "warnings"])
    requireLinux(
      Array.isArray(p[key]) &&
        (p[key] as unknown[]).length <= 100 &&
        (p[key] as unknown[]).every(
          (v) => typeof v === "string" && v.length <= 240,
        ),
      "invalid_plan",
      "The reviewed plan must contain bounded, safe changes and warnings.",
    );
  const result: LinuxPlan = {
    id: reference(p.id),
    digest: sha256From(p.digest),
    profileDigest: sha256From(p.profileDigest),
    expiresAt: natural(p.expiresAt),
    backend: backendPlanFrom(p.backend),
    profile: linuxProfileFrom(p.profile),
    operatorPolicy: operatorPolicyFrom(p.operatorPolicy),
    targetInspectionId: reference(p.targetInspectionId),
    targetFingerprint: text(p.targetFingerprint),
    namespaceProofId: reference(p.namespaceProofId),
    action: p.action as LinuxPlan["action"],
    changes: p.changes as string[],
    warnings: p.warnings as string[],
    requirements: requirementsFrom(p.requirements),
    restoreInspectionId:
      p.restoreInspectionId === null ? null : reference(p.restoreInspectionId),
    restoreManifestDigest:
      p.restoreManifestDigest === null ? null : hash(p.restoreManifestDigest),
    restoreCiphertextDigest:
      p.restoreCiphertextDigest === null
        ? null
        : hash(p.restoreCiphertextDigest),
    predecessorOperationId:
      p.predecessorOperationId === null
        ? null
        : reference(p.predecessorOperationId),
    sessionPolicy: p.sessionPolicy as LinuxPlan["sessionPolicy"],
  };
  const { digest, ...preimage } = result;
  requireLinux(
    digest === digestJson(preimage) &&
      result.profileDigest === digestJson(result.profile),
    "plan_digest",
    "The backend plan or full profile changed. Review a fresh plan.",
  );
  return result;
}
export function requirePlanIdentity(
  plan: LinuxPlan,
  retained: LinuxPlan["profile"]["identity"] | null,
) {
  requireLinux(
    !retained || sameIdentity(retained, plan.profile.identity),
    "identity_changed",
    "Reconcile the original deployment before changing its retained resource identity.",
  );
}
