/** Browser-safe HTTP receipt. No chain client, private lesson or provider types. */
export interface StudyPublicationReceipt {
  state: "pending" | "published" | "private" | "failed";
  sessionId: `0x${string}`;
  chainId: 31337 | 6343;
  contract: `0x${string}`;
  commitment: `0x${string}`;
  // The original commitment/transaction above remain immutable recovery evidence.
  canonicalHead?: { number: string; hash: `0x${string}` };
  canonicalRevision?: {
    revision: number;
    status: number;
    commitment: `0x${string}`;
    transactionHash: `0x${string}`;
    blockNumber: string;
    blockHash: `0x${string}`;
  };
  transactionHash: `0x${string}` | null;
  confirmed: boolean;
  checkedAt: number;
  reason?: string;
  neverSubmitted?: boolean;
  privateHistoryErased?: boolean;
}
export const studyRevisionRecovery = (
  receipt?: StudyPublicationReceipt | null,
) =>
  receipt?.state === "failed" &&
  [
    "canonical_result_changed",
    "canonical_revision_unverified",
    "canonical_head_behind",
  ].includes(receipt.reason ?? "");
