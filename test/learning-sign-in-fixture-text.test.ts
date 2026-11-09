import test from "node:test";
import assert from "node:assert/strict";
import { signInMessageV4 } from "../packages/protocol/learning-results-v4.ts";
import {
  fixtureSignIn,
  fixtureSignInText,
} from "../apps/web/live-e2e/v4-sign-in-text.ts";

// The live V4 browser fixture carries a frozen sign-in text so the web
// client's CI never imports viem. It must stay the shared builder's output.
test("the live V4 fixture's frozen sign-in text is the shared builder's text", () => {
  const f = fixtureSignIn;
  assert.equal(
    signInMessageV4(
      {
        origin: f.origin,
        chainId: f.chainId,
        contract: f.contract,
        communityId: f.communityId,
        publicationPolicy: f.publicationPolicy,
      },
      {
        learner: f.learner,
        nonce: f.nonce,
        issuedAt: BigInt(f.issuedAt),
      },
    ),
    fixtureSignInText,
  );
});
