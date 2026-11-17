import type { Address, Hex } from "viem";
import type {
  PublicationGrant,
  PublicationPurpose,
  parsePublicationWithdrawal,
} from "./publication-consent.ts";

type Wire<T> = Readonly<{
  [K in keyof T]: T[K] extends bigint ? string : T[K];
}>;
export type GrantWireV1 = Wire<PublicationGrant>;
export type WithdrawalWireV1 = Wire<
  ReturnType<typeof parsePublicationWithdrawal>
>;

/** Server-retained selection. Types alone do not authenticate a wire value. */
export interface ConsentSourceV1 {
  schema: "pirate.publication-source/1";
  resultsVersion: 5;
  chainId: 31337 | 6343;
  communityId: Hex;
  installationId: string;
  directory: Address;
  directoryRuntimeHash: Hex;
  registry: Address;
  registryRuntimeHash: Hex;
  releaseSelectionSha256: Hex;
}
export interface BoundPublicationGrantV1 {
  schema: "pirate.bound-publication-grant/1";
  source: ConsentSourceV1;
  grantId: Hex;
  grant: GrantWireV1;
  recordedAtS: string;
  boundAtS: string;
  localFenceGeneration: string;
}
export interface ConsentCommandContextV1 {
  schema: "pirate.publication-command/1";
  commandId: Hex;
  requestId: string;
  accountId: string;
  source: ConsentSourceV1;
  digest: Hex;
  preparedAtMs: number;
  localFenceGeneration: string;
}
export type PreparedConsentCommandV1 = ConsentCommandContextV1 &
  (
    | { action: "grant"; message: GrantWireV1 }
    | { action: "withdraw"; message: WithdrawalWireV1 }
  );
export interface CanonicalObservationV1 {
  blockNumber: string;
  blockHash: Hex;
  timestampS: string;
}
export type CurrentGrantStateV1 =
  | {
      state: "allowed";
      binding: BoundPublicationGrantV1;
      observed: CanonicalObservationV1;
    }
  | {
      state: "denied";
      reason:
        | "local_withdrawal"
        | "unknown_grant"
        | "wrong_scope"
        | "inactive_registry"
        | "superseded_descriptor"
        | "changed_target_code"
        | "withdrawn"
        | "not_effective"
        | "expired";
      observed?: CanonicalObservationV1;
    }
  | { state: "unavailable"; reason: string };

/** Browser permission observation. GET does not create an activity start or
 * mint a BoundPublicationGrantV1; producers bind the exact grant at actual start. */
export type PublicationPermissionViewV1 = {
  schema: "pirate.publication-permission/1";
  purpose: PublicationPurpose;
  commandId: Hex | null;
  sourceId: Hex | null;
} & (
  | {
      state: "allowed";
      grantId: Hex;
      source: ConsentSourceV1;
      observed: CanonicalObservationV1;
    }
  | Extract<CurrentGrantStateV1, { state: "denied" | "unavailable" }>
);

/** Historical command consumption, separate from current grant usability. */
export type ConsentCommandReceiptV1 = {
  schema: "pirate.publication-command-receipt/1";
  commandId: Hex;
  digest: Hex;
  action: "grant" | "withdraw";
  purpose: PublicationPurpose;
  source: ConsentSourceV1;
  transactionHash: Hex | null;
} & (
  | { state: "prepared" | "queued" | "pending" | "unknown" }
  | { state: "withheld" | "refused"; reason: string }
  | {
      state: "recorded" | "reverted";
      observed: CanonicalObservationV1;
      transactionIndex: number;
    }
);
