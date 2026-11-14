import type {OperatorPolicyView} from "../../../packages/community-setup/shared-operator-policy.ts";
import type {NamespaceAuthorityProof as SharedNamespaceProof, NamespaceChallenge} from "../../../packages/community-names/namespace-import.ts";
import type {SharedInfrastructure} from "../../../packages/community-setup/shared-linux-infrastructure.ts";
// Required structural ports to the owning Linux/naming adapters. No adapter,
// provider client, capability marker or successful fallback is implemented here.
import type {
  LinuxOperatorAdapter,
  LinuxDeploymentIntent,
  LinuxRestoreIntent,
  LinuxReconciliationRequest,
  LinuxOperationResult,
  LinuxTargetRef,
  CompleteReleaseRef,
} from "../../../deploy/linux/operator-adapter-contract.ts";
export type {
  LinuxOperatorAdapter,
  LinuxDeploymentIntent,
  LinuxRestoreIntent,
  LinuxReconciliationRequest,
  LinuxOperationResult,
  LinuxTargetRef,
  CompleteReleaseRef,
};
export type BoundLinuxIntent =
  | { kind: "deploy"; intent: LinuxDeploymentIntent }
  | { kind: "restore"; intent: LinuxRestoreIntent };
import type { ObjectStorageProfileV1 } from "../../../packages/community-setup/storage.ts";
import type {
  DeploymentIdentity,
  LinuxCommunityProfileV2,
  LinuxDraftV2,
  LinuxTarget,
  SessionPolicy,
} from "../../../packages/community-setup/shared-linux-profile.ts";
export interface CredentialRequirement {
  id: string;
  label: string;
  role: "ssh" | "speech" | "publication" | "public-media" | "backup";
  scope: string;
  state: "missing" | "saved" | "verified";
  correction: string;
}
export interface LinuxCapabilities {
  version: 2;
  adapterId: string;
  sourceDigest: string;
  targets: Array<"local-linux" | "ssh-linux">;
  operations: Array<"create" | "import" | "restore" | "upgrade">;
  features: Array<keyof LinuxDraftV2["features"]>;
  backup: {
    formats: string[];
    maxBytes: number;
    sessionPolicies: SessionPolicy[];
  };
  publicationSelection: string | null;
  publicationProfiles: Array<{ id: string; label: string; verified: boolean }>;
  learningProfiles: Array<{ id: string; label: string; verified: boolean }>;
  sshConnections: Array<{ id: string; label: string }>;
  backupProfiles: Array<{
    id: string;
    label: string;
    profile: ObjectStorageProfileV1;
  }>;
  limitations: string[];
  policy: OperatorPolicyView | null;
}
export interface TargetInspection {
  id: string;
  target: LinuxTarget;
  fingerprint: string;
  supported: boolean;
  description: string;
  corrections: string[];
  existing: LinuxCommunityProfileV2[];
  prepared: {identity:DeploymentIdentity;infrastructure:SharedInfrastructure;settings:LinuxDraftV2} | null;
}
export interface NamespaceProof extends SharedNamespaceProof {
  status: "verified"; tld: string; correction: string;
}
export type NamespaceAuthorityResult = NamespaceProof | {tld:string;status:"pending"|"unavailable";correction:string};
export type {NamespaceChallenge};
// Root verifies the complete original authenticated Linux identity/resource set
// against its retained mapping ledger. This port never creates/replaces IDs.
export interface OriginalInstallationPort {
  requireOriginal(input:{identity:DeploymentIdentity;binding:SharedNamespaceProof["binding"]}):Promise<SharedInfrastructure["mapping"]>;
}
export interface NamespaceRequestRecoveryPort {
  begin(requestId:string, run:()=>Promise<NamespaceChallenge>):Promise<NamespaceChallenge>;
  complete(requestId:string, run:()=>Promise<NamespaceProof>):Promise<NamespaceProof>;
  recover(requestId:string):Promise<
    {state:"pending"} | {state:"not-started";evidenceRef:string} |
    {state:"completed";result:NamespaceChallenge | NamespaceProof}>;
}
export interface RestoreInspection {
  id: string;
  backupId: string;
  ciphertextDigest: string;
  manifestDigest: string;
  format: string;
  authenticated: boolean;
  compatible: boolean;
  profile: LinuxCommunityProfileV2;
  sessionPolicies: SessionPolicy[];
  corrections: string[];
}
export interface LinuxPlan {
  id: string;
  digest: string;
  profileDigest: string;
  expiresAt: number;
  backend: { target: LinuxTargetRef; release: CompleteReleaseRef };
  profile: LinuxCommunityProfileV2;
  operatorPolicy: OperatorPolicyView | null;
  targetInspectionId: string;
  targetFingerprint: string;
  namespaceProofId: string;
  action: "create" | "adopt" | "restore" | "upgrade";
  changes: string[];
  warnings: string[];
  requirements: CredentialRequirement[];
  restoreInspectionId: string | null;
  restoreManifestDigest: string | null;
  restoreCiphertextDigest: string | null;
  predecessorOperationId: string | null;
  sessionPolicy: SessionPolicy;
}
export interface LinuxOperation {
  id: string;
  kind: LinuxDraftV2["mode"];
  draftRevision: number;
  plan: LinuxPlan;
  startedAt: number;
}
export type LinuxObservation = {
  revision: number;
  custody: "held" | "cleared";
} & (
  | { state: "pending" | "unknown"; receiptRef: string; correction: string }
  | {
      state: "failed";
      receiptRef: string;
      effects: "none" | "retained";
      identity: DeploymentIdentity;
      correction: string;
    }
  | {
      state: "succeeded";
      receiptRef: string;
      identity: DeploymentIdentity;
      profileDigest: string;
      recovery: null | {
        inspectionId: string;
        manifestDigest: string;
        sessionPolicy: SessionPolicy;
      };
      sharedConfiguration: {
        directory: import("../../../packages/community-setup/shared-linux-infrastructure.ts").SharedInfrastructure["directory"];
        configuration: import("../../../packages/community-setup/shared-linux-infrastructure.ts").SharedInfrastructure["configuration"];
        evidenceRef:string; blockNumber:string; blockHash:string;
      };
      health: {
        origin: string;
        application: boolean;
        login: boolean;
        media: boolean;
        learning: boolean;
        checkedAt: number;
      };
    }
);
// Mandatory source-pinned producer contract, separate from authority/readiness.
// terminal is READ ONLY over the original retained operation: pending returns
// no new result, and result returns only its closed original native evidence.
// No new transaction, new deployment, resend or rewritten receipt is permitted.
export interface LinuxJournalRecoveryPort {
  readonly policy:"pirate.linux-journal-capacity/1";
  readonly sourceDigest:string;
  readonly resultMaxBytes:524288;
  readonly intentMaxBytes:262144;
  terminal(input:{operation:LinuxOperation;retainedIntent:BoundLinuxIntent|null}):Promise<
    {state:"pending";operationId:string} | {state:"result";result:LinuxOperationResult}>;
}
export interface LinuxDeploymentPort {
  readonly journalRecovery:LinuxJournalRecoveryPort;
  readonly version: 2;
  readonly operator: LinuxOperatorAdapter;
  capabilities(): Promise<LinuxCapabilities>;
  inspectTarget(input: {
    requestId: string;
    target: LinuxTarget;
  }): Promise<TargetInspection>;
  credentialRequirements(input: {
    draft: LinuxDraftV2;
    target: TargetInspection;
  }): Promise<CredentialRequirement[]>;
  verifyCredentials(input: {
    requestId: string;
    draft: LinuxDraftV2;
    target: TargetInspection;
  }): Promise<CredentialRequirement[]>;
  reconcileCredentials(input: {
    requestId: string;
    draft: LinuxDraftV2;
  }): Promise<{
    state: "pending" | "saved" | "not-saved";
    requirements: CredentialRequirement[];
  }>;
  saveCredentials(input: {
    requestId: string;
    draft: LinuxDraftV2;
    values: Record<string, string>;
  }): Promise<void>;
  // Stage immutable ciphertext only; keep its opaque id recoverable after a lost reply.
  stageBackup(input: {
    requestId: string;
    bytes: AsyncIterable<Uint8Array>;
    byteLength: number;
  }): Promise<{ backupId: string; ciphertextDigest: string }>;
  // No key or plaintext is returned to the wizard journal. Authentication and
  // compatibility must be implemented by the real backup owner before a plan.
  inspectBackup(input: {
    backupId: string;
    recoveryKey: string;
  }): Promise<RestoreInspection>;
  prepare(input: {
    requestId: string;
    draft: LinuxDraftV2;
    target: TargetInspection;
    namespace: NamespaceProof;
    retainedIdentity: DeploymentIdentity | null;
    previousOperation: LinuxOperation | null;
    imported: LinuxCommunityProfileV2 | null;
    restore: RestoreInspection | null;
  }): Promise<LinuxPlan>;
  // Server-owned binding, never browser-supplied effect/admission evidence.
  // Materialize and verify actual sealed refs, target identity, secret generations,
  // backend journal CAS and fresh complete-profile/authority admission.
  bindOperation(operation: LinuxOperation): Promise<BoundLinuxIntent>;
  bindReconciliation(input: {
    operation: LinuxOperation;
    retainedIntent: BoundLinuxIntent | null;
  }): Promise<LinuxReconciliationRequest>;
  // Read and validate the real restricted receipt, postguard and cleanup plus
  // complete-profile health/recovery facts. Never infer custody from an empty
  // process list, timeout, denied access or outcome text alone.
  observeResult(input: {
    operation: LinuxOperation;
    result: LinuxOperationResult;
  }): Promise<LinuxObservation>;
}
export interface NamespaceAuthorityPort {
  readonly version: 3;
  assertWritable():void;
  begin(requestId:string): Promise<NamespaceChallenge>;
  complete(input:{requestId:string;challengeId:string;proof:unknown}):Promise<NamespaceProof>;
  recover(requestId:string): ReturnType<NamespaceRequestRecoveryPort["recover"]>;
  inspect(input: {
    requestId: string;
    tld: string;
    hostingOrigin: string;
    identity: DeploymentIdentity | null;
  }): Promise<NamespaceAuthorityResult>;
  // A snapshot is not admission authority. The owner must revalidate current
  // original-target/TLD/SLD rights, including final backend effect fences.
  revalidate(input: {
    proof: NamespaceProof;
    profile: LinuxCommunityProfileV2;
  }): Promise<NamespaceAuthorityResult>;
}
