import type { PublicClient } from "viem";
import {
  canonical,
  hashJson,
  insist,
  object,
  bytes32,
} from "../packages/community/common.ts";
import { address } from "../packages/community/manifest-core.ts";
import {
  observeRootRegistration,
  type RootRegistrationInput,
} from "../packages/community/registration-chain.ts";
import { validateRegistration } from "../packages/community/post-manifest.ts";
import { publishedStateHash } from "./published-state.ts";

/** Read-only proof of the completed mint. No gas estimate or broadcast. */
export async function qualifyPublishedRegistration(
  client: PublicClient,
  state: unknown,
  operator: string,
) {
  insist(
    hashJson(state) === publishedStateHash,
    "published_registration_profile_changed",
    409,
  );
  const captured = object(object(state).registration),
    expected = validateRegistration(captured.receipt),
    receipt = await observeRootRegistration(
      client,
      bytes32(expected.transactionHash),
      address(operator),
      captured.input as RootRegistrationInput,
    );
  insist(
    receipt && canonical(receipt) === canonical(expected),
    "published_registration_receipt_changed",
    409,
  );
  return { mode: "read_only_completed_mint", receipt, transactionsSent: 0 };
}
