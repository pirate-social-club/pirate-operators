import type { ChatActor, TelegramGrant, WebAccount } from "./contracts.ts";

export interface PendingConnection {
  actor: ChatActor;
  expiresAt: number;
  consumedBy: string | null;
}
export interface BrokerRequest {
  id: string;
  clientId: string;
  requestDigest: string;
  actor: ChatActor;
  returnUrl: string;
  communityState: string;
  expiresAt: number;
}
export interface BrokerReceipt {
  requestId: string;
  requestDigest: string;
  clientId: string;
  redemptionId: string;
  actor: ChatActor;
  telegramId: string;
  verifiedAt: number;
}
export interface TelegramBrokerPort {
  /** Authenticated server channel; retries bind the same request digest. */
  request(input: BrokerRequest): Promise<{ navigationUrl: string }>;
  /** Same redemptionId reconciles an uncertain response; a different redemption is refused. */
  redeem(input: {
    code: string;
    requestId: string;
    requestDigest: string;
    redemptionId: string;
  }): Promise<BrokerReceipt>;
}
export interface CommunityLinkTransaction {
  id: string;
  pendingHash: string;
  actor: ChatActor;
  account: WebAccount;
  browserHash: string;
  communityState: string;
  requestDigest: string;
  expiresAt: number;
  phase: "created" | "broker_ready" | "redeeming" | "complete";
  navigationUrl: string | null;
  redemptionId: string;
  completionHash: string | null;
  grant: TelegramGrant | null;
}
