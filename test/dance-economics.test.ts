import test from "node:test";
import assert from "node:assert/strict";
import { singleOfferShares } from "../packages/dance/categorical-source.ts";
import { dh, dw } from "./dance-fixture.ts";
test("combined modeled Study/Karaoke/Dance candidates collapse once per captured account/offer", () => {
  const base = { accountId: "learner", wallet: dw(1), offerId: "offer_1" };
  const entries = [
    { ...base, evidenceHash: dh(3), completedAtMs: 3000 },
    { ...base, evidenceHash: dh(2), completedAtMs: 2000 },
    { ...base, evidenceHash: dh(1), completedAtMs: 2000 },
  ];
  assert.deepEqual(singleOfferShares(entries), [entries[2]]);
  assert.throws(
    () => singleOfferShares([...entries, { ...entries[0], wallet: dw(2) }]),
    /reward_qualifier_wallet_changed/,
  );
  assert.equal(
    singleOfferShares([...entries, { ...entries[0], offerId: "offer_2" }])
      .length,
    2,
  );
});
