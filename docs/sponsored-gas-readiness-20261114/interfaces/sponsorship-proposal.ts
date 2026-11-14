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
export interface ActorProof {
  readonly kind: "wallet" | "service";
  readonly principal: string;
  readonly wallet: Address | null;
  readonly role: string;
  readonly proofDigest: Hash;
  readonly challengeNonce: Hash;
  readonly expiresAt: Decimal;
  readonly pirateMembershipReference: string;
  readonly membershipRevision: Decimal;
}
export interface Operation {
  readonly schema: "pirate.sponsor-operation-proposal/1";
  readonly community: CommunityBinding;
  readonly logicalOperationId: Hash;
  readonly operationKind:
    | "free-name-claim" | "name-record" | "name-transfer" | "name-renewal"
    | "directory-enrollment" | "directory-configuration" | "community-post"
    | "learning-result";
  readonly actor: ActorProof;
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
  readonly schema: "pirate.sponsor-reservation-proposal/1";
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
export type Recovery =
  | { readonly state: "unknown"; readonly original: Original; readonly reservedWei: Decimal; readonly reason: string }
  | { readonly state: "safe-consumed" | "safe-reverted"; readonly original: Original; readonly receipt: SafeReceipt; readonly outstandingWei: Decimal }
  | { readonly state: "expired-unconsumed"; readonly original: Original; readonly proofReference: string; readonly outstandingWei: Decimal };
// A settled transaction may still have unknown fee accounting; outstandingWei
// must retain the unresolved upper bound. Current owner/eligibility is separate.

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
