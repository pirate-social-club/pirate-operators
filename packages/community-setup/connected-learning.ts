import { check } from "../protocol/index.ts";
/** Telegram owns verification/storage. Lane 6 consumes only current links. */
export interface ConnectedLearningLinkV1 {
  version: 1;
  communityId: string;
  botId: string;
  generation: number;
  accountId: string;
  wallet: string;
  linkedAtMs: number;
  revokedAtMs: number | null;
}
export interface ConnectedLearningContextV1 {
  communityId: string;
  botId: string;
  generation: number;
  startedAtMs: number;
}
export function assertConnectedLearningLink(
  link: ConnectedLearningLinkV1 | null,
  context: ConnectedLearningContextV1,
): asserts link is ConnectedLearningLinkV1 {
  check(
    /^0x[0-9a-f]{64}$/.test(context.communityId) &&
      /^[1-9][0-9]{0,19}$/.test(context.botId) &&
      link?.version === 1 &&
      link.communityId === context.communityId &&
      link.botId === context.botId &&
      link.generation === context.generation &&
      Number.isSafeInteger(context.generation) &&
      context.generation > 0 &&
      typeof link.accountId === "string" &&
      link.accountId.length > 0 &&
      /^0x[0-9a-f]{40}$/.test(link.wallet) &&
      !/^0x0+$/.test(link.wallet) &&
      link.revokedAtMs === null,
    "connected_learning_link_required",
  );
  check(
    Number.isSafeInteger(context.startedAtMs) &&
      Number.isSafeInteger(link.linkedAtMs) &&
      link.linkedAtMs >= 0 &&
      context.startedAtMs >= link.linkedAtMs,
    "connected_learning_not_prospective",
  );
}
