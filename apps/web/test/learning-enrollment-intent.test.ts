// UNRUN. Calls the actual existing post() and enrollment controller. The full
// communityFetch/D1 fence witness is supplied as a protected test proposal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrollStudyForAccount } from "../src/study/enrollment-intent.ts";
import type { KaraokeConsentRequest } from "../src/live/learning-consent.ts";

function enrollment(): KaraokeConsentRequest {
  const contract = `0x${"1".repeat(40)}`,
    policy = `0x${"2".repeat(64)}`;
  return {
    target: { version: 3, chainId: 6343, contract },
    domain: { version: "3", chainId: 6343, verifyingContract: contract },
    types: {},
    primaryType: "Enrollment",
    message: {
      learner: "fixture-account",
      activities: "2",
      publicityPolicy: policy,
    },
    disclosure: {
      version: 3,
      termsUrl: "/learning/v3/terms",
      privacyUrl: "/learning/v3/privacy",
      publicityPolicy: policy,
    },
  };
}
test("both real V3 enrollment HTTP calls carry the captured account and existing CSRF/credential behavior", async () => {
  const savedFetch = globalThis.fetch,
    sent: RequestInit[] = [];
  let csrf = "csrf-first";
  globalThis.fetch = (async (path, init) => {
    assert.equal(path, "/api/karaoke/enrollment");
    assert.equal(init?.method, "POST");
    assert.equal(init.credentials, "same-origin");
    sent.push(init);
    return Response.json(
      sent.length === 1 ? enrollment() : { state: "success" },
    );
  }) as typeof fetch;
  try {
    await enrollStudyForAccount({
      account: () => "fixture-account",
      csrf: () => csrf,
      active: () => true,
      wallet: {
        signConsent: async (value) => {
          assert.deepEqual(value, enrollment());
          csrf = "csrf-second";
          return "fixture-signature";
        },
      },
    });
    assert.equal(sent.length, 2);
    for (const request of sent)
      assert.equal(
        new Headers(request.headers).get("x-study-account"),
        "fixture-account",
      );
    assert.equal(
      new Headers(sent[0]!.headers).get("x-csrf-token"),
      "csrf-first",
    );
    assert.equal(
      new Headers(sent[1]!.headers).get("x-csrf-token"),
      "csrf-second",
    );
    assert.deepEqual(JSON.parse(String(sent[0]!.body)), { activity: "study" });
    assert.equal(
      JSON.parse(String(sent[1]!.body)).signature,
      "fixture-signature",
    );
  } finally {
    globalThis.fetch = savedFetch;
  }
});
for (const boundary of ["account", "disposed"] as const)
  test(`V3 enrollment stops after ${boundary} changes during MOSS signing`, async () => {
    const savedFetch = globalThis.fetch;
    let account = "fixture-account",
      active = true,
      posts = 0;
    globalThis.fetch = (async () => {
      posts++;
      return Response.json(enrollment());
    }) as typeof fetch;
    try {
      await assert.rejects(
        enrollStudyForAccount({
          account: () => account,
          csrf: () => "fixture-csrf",
          active: () => active,
          wallet: {
            signConsent: async () => {
              if (boundary === "account") account = "different-account";
              else active = false;
              return "fixture-signature";
            },
          },
        }),
        /closed/,
      );
      assert.equal(posts, 1);
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
