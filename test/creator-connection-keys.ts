import { privateKeyToAccount } from "viem/accounts";

// Public unfunded fixtures. Never used by a deployed application or public chain.
export const creatorPublisherFixture = privateKeyToAccount(
  `0x${"11".repeat(32)}`,
);
export const otherCreatorPublisherFixture = privateKeyToAccount(
  `0x${"22".repeat(32)}`,
);
