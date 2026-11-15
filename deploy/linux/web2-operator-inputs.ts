/** Frozen service/browser boundaries. No credentials or request-selected RPCs. */
import type { Address, Hex, TypedDataDefinition } from "viem";
import type { PreparedHostedEnrollment } from "../../packages/community-setup/hosted-enrollment-client.ts";
import type { OwnerBudgetGrant } from "../../packages/release/owner-grant.ts";
import type { SignedOwnerAuthorization } from "../../packages/community/owner-authorization.ts";

export interface Web2Wallet {
  connect(): Promise<{ address: Address; network: "testnet" }>;
  signTypedData(request: {
    expectedController: Address;
    requestDigest: Hex;
    data: TypedDataDefinition;
  }): Promise<
    | { status: "success"; signature: Hex }
    | { status: "cancelled" }
    | { status: "error"; code: string }
  >;
}
export interface PublisherProofSigner {
  selected(): Promise<{ address: Address; custodyBindingDigest: Hex }>;
  signEnrollment(input: {
    operationId: Hex;
    prepared: PreparedHostedEnrollment;
  }): Promise<{ recipient: Address; signature: Hex }>;
}
export interface OwnerGrantScope {
  schema: "pirate.web2-owner-grant-scope/1";
  enrollmentId: Hex;
  installationId: Hex;
  hostInstallationId: string;
  deploymentDigest: Hex;
  communityId: Hex;
  origin: string;
  controller: Address;
  ownerWallet: Address;
  policy: { version: string; sha256: string };
  chainId: 6343;
  postsContract: Address;
  publisher: Address;
}
export interface ConfiguredGrantSelection {
  schema: "pirate.web2-configured-owner-grant/1";
  scope: OwnerGrantScope;
  grant: OwnerBudgetGrant;
  /** Digest authenticates bytes; authority comes only from the configured port. */
  selectionDigest: Hex;
  admissionReference: string;
}
export interface GrantAttachmentObservation {
  selectionDigest: Hex;
  grantDigest: string;
  admissionReference: string;
  state: "absent" | "attached" | "unknown";
}
/** Provided by authenticated Pirate configuration. Missing port is unavailable;
 * the validator's numeric ceilings never supply a grant or an issuer. */
export interface ManagedOwnerGrantPort {
  prepare(scope: OwnerGrantScope): Promise<ConfiguredGrantSelection>;
  attach(selectionDigest: Hex): Promise<GrantAttachmentObservation>;
  reconcile(selectionDigest: Hex): Promise<GrantAttachmentObservation>;
}
export interface Web2PublishingAttachment {
  schema: "pirate.web2-publishing-attachment/1";
  selection: ConfiguredGrantSelection;
  authorization: SignedOwnerAuthorization;
  custodyBindingDigest: Hex;
  digest: Hex;
}
