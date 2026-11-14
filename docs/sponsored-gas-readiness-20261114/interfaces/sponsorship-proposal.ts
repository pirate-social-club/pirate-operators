/**
 * REVIEW-ONLY schema sketch; NOT an executable validator or deployed API.
 * No imports, implementation, key material, live addresses or numeric caps.
 * Runtime decoders must reject extra keys, malformed values and mutable aliases.
 * Decimal is canonical unsigned base-10; Address/Hash require exact byte lengths.
 */
export type Decimal = string;
export type Address = `0x${string}`;
export type Hash = `0x${string}`;

export interface SourceBinding {
  readonly chainId: 6343;
  readonly sourceCommit: string;
  readonly abiSha256: string;
  readonly contract: Address;
  readonly runtimeCodeHash: Hash;
  readonly deploymentTransaction: Hash;
  readonly deploymentBlockHash: Hash;
}
export interface CommunityBinding {
  readonly communityKey: Hash;
  readonly communityId: Hash;
  readonly directory: SourceBinding;
  readonly installationId: Hash;
  readonly canonicalOrigin: string;
  readonly namespaceId: Hash;
  readonly registry: SourceBinding;
  readonly admissionRevision: Decimal;
  readonly configurationRevision: Decimal;
  readonly authorityRevision: Decimal;
  readonly scopeRevision: Decimal;
}
export interface ExactCall {
  readonly target: Address;
  readonly runtimeCodeHash: Hash;
  readonly selector: `0x${string}`;
  readonly calldata: `0x${string}`;
  readonly nativeValueWei: Decimal;
  readonly semanticArgumentsDigest: Hash;
}
export interface PilotAdmission {
  readonly reference: string;
  readonly revision: Decimal;
  readonly principal: string;
  readonly communityId: Hash;
  readonly installationId: Hash;
  readonly namespaceId: Hash;
  readonly operationKind: Operation["operationKind"];
  readonly constraintsDigest: Hash;
  readonly expiresAt: Decimal;
}
export interface ActionAuthority {
  readonly kind:
    | "issuer-grant-and-recipient-consent"
    | "name-holder" | "name-manager" | "name-approved-operator"
    | "learner-publication-consent" | "first-learner-consent"
    | "directory-controller" | "authorized-service-producer";
  readonly evidenceDigest: Hash;
  readonly source: SourceBinding;
  readonly safeBlockNumber: Decimal;
  readonly safeBlockHash: Hash;
  readonly exactScopeAndRevisionDigest: Hash;
  readonly validUntil: Decimal;
}
export interface ActorProof {
  readonly kind: "wallet" | "service";
  readonly principal: string;
  readonly wallet: Address | null;
  readonly role: string;
  readonly proofDigest: Hash;
  readonly challengeNonce: Hash;
  readonly expiresAt: Decimal;
  readonly pilotAdmission: PilotAdmission;
  readonly actionAuthority: ActionAuthority;
}
// These references need independent verification. They are not member records
// or permission to trust a community Worker. First claim/consent can bootstrap.
export interface SafeSimulation {
  readonly callDigest: Hash;
  readonly authorityEvidenceDigest: Hash;
  readonly safeBlockNumber: Decimal;
  readonly safeBlockHash: Hash;
  readonly result: "success";
  readonly evidenceReference: string;
  readonly validUntil: Decimal;
}
export interface Operation {
  readonly schema: "pirate.sponsor-operation-proposal/2";
  readonly community: CommunityBinding;
  readonly logicalOperationId: Hash;
  readonly operationKind:
    | "free-name-claim" | "name-record" | "name-transfer" | "name-renewal"
    | "directory-enrollment" | "directory-configuration" | "community-post"
    | "learning-authorization" | "learning-result";
  readonly actor: ActorProof;
  readonly simulation: SafeSimulation;
  readonly calls: readonly ExactCall[];
  readonly canonicalBytesDigest: Hash;
  readonly policyEpoch: string;
  readonly policyRevision: Decimal;
  readonly expiresAt: Decimal;
}
export interface FeeBound {
  readonly asset: "native-TESTETH";
  readonly exactPayer: Address;
  readonly gasLimit: Decimal;
  readonly maxUnitFeeWei: Decimal;
  readonly additionalFeeUpperBoundWei: Decimal;
  readonly totalLiabilityUpperBoundWei: Decimal;
  readonly nativeValueUpperBoundWei: Decimal;
  readonly accountingSemanticsReference: string;
  readonly estimateBlockHash: Hash;
  readonly pricingPolicyReference: string;
  readonly observedUnitFeeWei: Decimal;
  readonly observedAt: string;
  readonly multiplierNumerator: Decimal;
  readonly multiplierDenominator: Decimal;
  readonly absoluteOperationCeilingWei: Decimal;
  readonly expiresAt: Decimal;
}
export interface BackendOriginal {
  readonly route: "backend";
  readonly source: SourceBinding;
  readonly sender: Address;
  readonly nonce: Decimal;
  readonly unsignedPayloadDigest: Hash;
  readonly exactSignedRaw: `0x${string}`;
  readonly exactTransactionHash: Hash;
}
export interface MossOriginal {
  readonly route: "moss";
  readonly source: SourceBinding;
  readonly account: Address;
  readonly payer: Address;
  readonly accountNonce: Decimal;
  readonly accountImplementation: Address;
  readonly accountImplementationCodeHash: Hash;
  readonly intentDomain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: 6343;
    readonly verifyingContract: Address;
  };
  readonly exactFinalIntentBytes: `0x${string}`;
  readonly finalIntentDigest: Hash;
  readonly paymentAuthorizationDigest: Hash;
  readonly expiry: Decimal;
}
// Backend raw hashes and MOSS intent digests are not interchangeable identities.
export type Original = BackendOriginal | MossOriginal;

export interface ReservedAuthority {
  readonly schema: "pirate.sponsor-reservation-proposal/2";
  readonly reservationId: Hash;
  readonly logicalOperationId: Hash;
  readonly operationDigest: Hash;
  readonly finalAuthorizationDigest: Hash;
  readonly expectedLedgerRevision: Decimal;
  readonly committedLedgerRevision: Decimal;
  readonly journalSequence: Decimal;
  readonly signerFenceEpoch: string;
  readonly communityId: Hash;
  readonly policyEpoch: string;
  readonly fee: FeeBound;
  readonly durableBeforeSigning: true;
}
export interface SafeReceipt {
  readonly transactionHash: Hash;
  readonly blockNumber: Decimal;
  readonly blockHash: Hash;
  readonly safeBlockNumber: Decimal;
  readonly safeBlockHash: Hash;
  readonly status: "success" | "reverted";
  readonly intendedExecutionProven: boolean;
  readonly actualPayer: Address;
  readonly payerProofReference: string;
  readonly gasUsed: Decimal;
  readonly effectiveGasPriceWei: Decimal;
  readonly rawL1FeeWei: Decimal | null;
  readonly rawL1GasUsed: Decimal | null;
  readonly rawL1GasPriceWei: Decimal | null;
  readonly extraFeeSemantics: "verified-additive" | "verified-included" | "unknown";
  readonly measuredSponsorDebitWei: Decimal | null;
  readonly reconciliationReference: string;
}
export type ExactOriginalRecovery =
  | { readonly state: "unknown"; readonly original: Original; readonly reservedWei: Decimal; readonly reason: string }
  | { readonly state: "safe-consumed"; readonly original: Original; readonly receipt: SafeReceipt & { readonly status: "success"; readonly intendedExecutionProven: true }; readonly outstandingWei: Decimal }
  | { readonly state: "safe-reverted"; readonly original: Original; readonly receipt: SafeReceipt & { readonly status: "reverted" }; readonly outstandingWei: Decimal }
  | { readonly state: "expired-unconsumed"; readonly original: Original; readonly proofReference: string; readonly outstandingWei: Decimal };
// A settled transaction may still have unknown fee accounting; outstandingWei
// must retain the unresolved upper bound. Current owner/eligibility is separate.

export interface NonceGroupReservation {
  readonly schema: "pirate.sponsor-nonce-group-proposal/1";
  readonly chainId: 6343;
  readonly sender: Address;
  readonly nonce: Decimal;
  readonly originalOperationDigest: Hash;
  readonly originalReservationId: Hash;
  readonly expectedGroupRevision: Decimal;
  readonly committedGroupRevision: Decimal;
  readonly retainedAttemptSetDigest: Hash;
  readonly originalCommunityBoundWei: Decimal; // B
  readonly maxOperationAttemptBoundWei: Decimal; // F >= B
  readonly maxCancellationBoundWei: Decimal; // C
  readonly globalOutstandingWei: Decimal; // max(F,C), counted once
  readonly communityAndOrdinaryOutstandingWei: Decimal; // B
  readonly recoveryOutstandingWei: Decimal; // max(F-B,C)
  readonly recoveryPolicyReference: string;
  readonly senderFloatEvidenceReference: string;
  readonly journalSequence: Decimal;
  readonly durableBeforeSigning: true;
}
// Category exposures are alternative allocations, not additive global costs.
// Only qualified same-chain/sender/nonce backend inclusion fees may be grouped.
// Independent fees, other nonces and MOSS intents need separate liabilities.
export interface ManualBackendAttempt {
  readonly schema: "pirate.sponsor-backend-attempt-proposal/2";
  readonly original: BackendOriginal;
  readonly logicalOperationId: Hash;
  readonly attemptId: Hash;
  readonly purpose: "fee-bump" | "cancel";
  readonly approvalDigest: Hash;
  readonly approvalExpiresAt: Decimal;
  readonly priorJournalSequence: Decimal;
  readonly exactAttempt: BackendOriginal;
  readonly exactAttemptFeeBound: FeeBound;
  readonly nonceGroupReservation: NonceGroupReservation;
  readonly preservedOriginalReservationId: Hash;
}
// Runtime rules must enforce identical original/attempt sender, nonce and chain.
// Fee bump also preserves type/to/data/value/access list; cancellation is not
// intended operation success. This interface is not a validator or SDK update.
export interface SafeNonceConsumption {
  readonly source: SourceBinding;
  readonly sender: Address;
  readonly nonce: Decimal;
  readonly consumingRawTransaction: `0x${string}`;
  readonly consumingTransactionHash: Hash;
  readonly receipt: SafeReceipt;
  readonly canonicalAncestryEvidence: string;
}
export type BackendAttemptRecovery =
  | { readonly state: "replacement-executed"; readonly original: BackendOriginal; readonly attempt: ManualBackendAttempt; readonly proof: SafeNonceConsumption; readonly intendedExecutionEvidence: string; readonly outstandingWei: Decimal }
  | { readonly state: "nonce-consumed-without-original-success"; readonly original: BackendOriginal; readonly attempt: ManualBackendAttempt | null; readonly proof: SafeNonceConsumption; readonly cause: "cancelled" | "replacement-reverted" | "unrecognized"; readonly outstandingWei: Decimal; readonly custodyPaused: boolean };
// A different transaction is never returned as exact-original success.
// The consuming proof must match the recorded attempt or trigger custody pause.
export type Recovery = ExactOriginalRecovery | BackendAttemptRecovery;

// Expired application intent does not expire an ordinary signed EOA transaction;
// it can still be mined and revert. Keep its gas liability until excluded by
// canonical nonce consumption or another actually enforced protocol condition.
// MOSS expiry/nonce behavior requires its own proof; no backend assumption.
export interface CostObservation {
  readonly schema: "pirate.sponsor-cost-observation-proposal/1";
  readonly logicalOperationId: Hash;
  readonly communityId: Hash | null;
  readonly source: SourceBinding;
  readonly observedAt: string;
  readonly estimateGas: Decimal | null;
  readonly selectedFeeBound: FeeBound;
  readonly receipt: SafeReceipt | null;
  readonly feeStatus: "estimated" | "pending" | "reconciled" | "unknown";
  readonly canonicalReceiptReference: string | null;
  readonly calldataBytes: Decimal;
  readonly outcome: string;
  readonly oneOffOrRecurring: "setup" | "operation" | "attestation";
}
