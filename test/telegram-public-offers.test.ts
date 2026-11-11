import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramPublicOffers } from "../services/telegram-catalog.ts";
import { publicOfferText } from "../packages/telegram/presentation.ts";

test("public offer projection strips wallet/credit/claim fields and preserves exact window and mode", () => {
  const now = 1794355200000;
  const projected = telegramPublicOffers(
    {
      state: "ready",
      readAt: now,
      validUntil: now + 1000,
      wallet: "private",
      credit: "private",
      offers: [
        {
          id: "offer",
          mode: "testnet",
          opensAt: now,
          cutoffAt: now + 10000,
          tickets: 6,
          activities: ["study"],
          rules: "Qualifying learners share any winnings.",
          claimId: "private",
        },
      ],
    } as never,
    now,
  );
  assert.equal(JSON.stringify(projected).includes("private"), false);
  assert.match(publicOfferText(projected, now), /Open until/);
  assert.match(publicOfferText(projected, now), /testnet/);
  assert.match(publicOfferText(projected, now + 2000), /unavailable/);
});
test("no offer, unavailable read, upcoming and closed are distinct; a malformed window is refused", () => {
  const now = 1794355200000;
  assert.equal(
    publicOfferText(
      { state: "ready", readAt: now, validUntil: now + 1000, offers: [] },
      now,
    ),
    "No active reward offer.",
  );
  assert.equal(
    publicOfferText({ state: "unavailable" }, now),
    "Reward information is unavailable.",
  );
  const offer = {
    id: "offer",
    mode: "practice" as const,
    opensAt: now + 100,
    cutoffAt: now + 200,
    tickets: 1,
    activities: ["study" as const],
    rules: "Practice only.",
  };
  assert.match(
    publicOfferText(
      { state: "ready", readAt: now, validUntil: now + 1000, offers: [offer] },
      now,
    ),
    /Opens/,
  );
  assert.match(
    publicOfferText(
      { state: "ready", readAt: now, validUntil: now + 1000, offers: [offer] },
      now + 201,
    ),
    /Closed/,
  );
  assert.throws(
    () =>
      telegramPublicOffers(
        {
          state: "ready",
          readAt: now,
          validUntil: now + 1000,
          offers: [{ ...offer, cutoffAt: now }],
        },
        now,
      ),
    /projection_invalid/,
  );
});
