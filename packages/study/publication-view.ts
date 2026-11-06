/** Browser-safe HTTP receipt. No chain client, private lesson or provider types. */
export interface StudyPublicationReceipt {
  state: "pending" | "published" | "private" | "failed";
  sessionId: `0x${string}`;
  chainId: 31337 | 6343;
  contract: `0x${string}`;
  commitment: `0x${string}`;
  transactionHash: `0x${string}` | null;
  confirmed: boolean;
  checkedAt: number;
  reason?: string;
}
