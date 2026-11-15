// Source-only interface for the sole wizard writer, routed through integration.
// No implementation or runtime authority follows from these TypeScript types.
// The server decodes and validates persisted records; browser bodies provide
// only optimistic-concurrency references and settings, never effect evidence.

export interface EvidenceRef {
  readonly relativePath: string;
  readonly sha256: string;
}

export interface SecretRef {
  readonly storeId: string;
  readonly keyId: string;
  readonly generation: number;
}

export interface LinuxTargetRef {
  readonly endpointRef: string;
  readonly endpointIdentityDigest: string;
  readonly stateNamespace: string;
  readonly deploymentId: string;
}

export interface CompleteReleaseRef {
  readonly sourceHead: string;
  readonly sourceTree: string;
  readonly manifest: EvidenceRef;
  readonly selectedProfileDigest: string;
  // Required actual services are inventoried in the sealed manifest. A string
  // or browser checkbox cannot promote the partial foundation into this type.
  readonly requiredServices: readonly string[];
}

export interface LinuxDeploymentIntent {
  readonly operationId: string;
  readonly journalRevision: number;
  readonly target: LinuxTargetRef;
  readonly planDigest: string;
  readonly draftRevision: number;
  readonly release: CompleteReleaseRef;
  readonly appOrigin: string;
  // Authority adapter owns validation/freshness and scoped issuance decisions.
  // Hosting origin never grants parent or sibling namespace authority.
  readonly importedAuthorityRefs: readonly EvidenceRef[];
  readonly desiredConfiguration: EvidenceRef;
  readonly serviceSecretRefs: readonly SecretRef[];
  readonly resourceKeys: readonly string[];
  readonly executionBoundSeconds: number;
}

export interface OwnedProcessIdentity {
  readonly hostPid: number;
  readonly hostStartTicks: string;
  readonly hostGroup: number;
  readonly hostSession: number;
  readonly networkNamespace: string;
  readonly pidNamespace: string;
  readonly containerId?: string;
}

export interface ResourceReadback {
  readonly resourceKey: string;
  readonly intentId: string;
  readonly targetIdentityDigest: string;
  readonly disposition: "owned-present" | "confirmed-absent" | "conflict" | "unknown";
  readonly observedConfigurationDigest?: string;
  readonly evidence: EvidenceRef;
}

export interface LinuxOperationResult {
  readonly operationId: string;
  readonly outcome: "completed" | "failed" | "interrupted" | "custody-uncertain";
  readonly lastCompletedPhase: string | null;
  readonly unrunPhases: readonly string[];
  readonly resources: readonly ResourceReadback[];
  readonly ownedProcesses: readonly OwnedProcessIdentity[];
  readonly rawReceipt: EvidenceRef;
  readonly postguard: EvidenceRef;
  readonly cleanup: EvidenceRef;
  // The caller retains its active claim on uncertain custody or failed postguard.
}

export interface LinuxReconciliationRequest {
  readonly operationId: string;
  readonly journalRevision: number;
  readonly target: LinuxTargetRef;
  readonly intents: readonly EvidenceRef[];
  readonly executionBoundSeconds: number;
}

export interface LinuxRestoreIntent {
  readonly operationId: string;
  readonly journalRevision: number;
  readonly freshTarget: LinuxTargetRef;
  readonly encryptedCohortManifest: EvidenceRef;
  readonly transportConfiguration: EvidenceRef;
  readonly transportCredentialRef: SecretRef;
  readonly recoveryKeyRef: SecretRef;
  readonly compatibleRelease: CompleteReleaseRef;
  readonly revocationPolicyDigest: string;
  readonly executionBoundSeconds: number;
}

export interface LinuxOperatorAdapter {
  // Persist/fsync the exact intent under the exclusive journal lock first.
  // Validate fresh authority, host identity and complete-profile admission;
  // refuse unknown/conflicting effects and ambient context/adoption.
  // Stream redacted phase progress to the server's durable operation record.
  deploy(intent: LinuxDeploymentIntent, signal: AbortSignal): Promise<LinuxOperationResult>;

  // Read back actual owned process/resource identities; no deploy, deletion,
  // adoption or replacement. Never infer absence from access denied or timeout.
  reconcile(request: LinuxReconciliationRequest, signal: AbortSignal): Promise<LinuxOperationResult>;

  // Preview/authenticate the entire cohort and policy before mutation; apply
  // only to an explicitly admitted fresh target under a new persisted intent.
  // Rebind live auth/revocation state; preserved bytes alone are not readiness.
  restore(intent: LinuxRestoreIntent, signal: AbortSignal): Promise<LinuxOperationResult>;
}
