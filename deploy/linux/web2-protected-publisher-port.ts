import type { Address, Hex, TransactionSerializedLegacy } from "viem";
import type { NativeDanceRetainedReference } from "../../services/native-dance-retained-reference.ts";
import type { PublisherProofSigner } from "./web2-operator-inputs.ts";

type StagePublisherLegacyTransaction = Readonly<{
  type: "legacy";
  chainId: 6343;
  nonce: number;
  to: Address;
  data: Hex;
  value: 0n;
  gas: bigint;
  gasPrice: bigint;
}>;

type StagePublisherOriginal =
  | Readonly<{ family: "v5"; commandId: Hex; bodyHash: Hex; acceptedSessionHash: Hex }>
  | Readonly<{ family: "bind"; commandId: Hex; commandHash: Hex; approvalSha256: Hex }>
  | Readonly<{ family: "dance"; reference: NativeDanceRetainedReference }>;

/** A private call inside the owner of the selected Store, lease and key.
 * The owner checks the exact original against its own journals and mounted
 * proofs, then consumes the held sign permit at actual key invocation.
 * The returned raw transaction stays within the protected sender. */
export interface HeldStagePublisherLegacySigner {
  signHeldLegacy(input: Readonly<{
    original: StagePublisherOriginal;
    transaction: StagePublisherLegacyTransaction;
  }>): Promise<TransactionSerializedLegacy>;
}

/** Enrolls the same EOA with the existing retained proof API. The two signing
 * methods reconstruct their respective purpose from authoritative state. */
export interface ProtectedStagePublisher
  extends PublisherProofSigner, HeldStagePublisherLegacySigner {
  readonly publisher: Address;
  readonly keyReference: string;
  readonly generation: number;
  assertOnlyPublisherOwnerSync(): true;
  expiresAtMs(): number;
  close(): Promise<void>;
}
