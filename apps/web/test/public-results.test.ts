import test from "node:test";
import assert from "node:assert/strict";
import {
  publicResultsAction,
  turnOffPublicResults,
  turnOnPublicResults,
} from "../src/live/public-results.ts";
import type { KaraokeConsentRequest } from "../src/live/learning-consent.ts";

const contract = `0x${"4".repeat(40)}`;
const revocation: KaraokeConsentRequest = {
  target: { chainId: 6343, version: 4, contract },
  domain: {
    name: "Pirate Learning Results",
    version: "4",
    chainId: 6343,
    verifyingContract: contract,
  },
  types: {},
  primaryType: "Revocation",
  message: { learner: `0x${"a".repeat(40)}`, nonce: "0" },
};

test("settings offer the V4 action for the session's public results, V3 keeps enrollment", () => {
  assert.equal(publicResultsAction("on"), "off");
  assert.equal(publicResultsAction("pending"), "off");
  assert.equal(publicResultsAction("off"), "on");
  assert.equal(publicResultsAction("unavailable"), "enrollment");
  assert.equal(publicResultsAction(undefined), "enrollment");
});

test("turning off signs the V4 revocation once and relays it", async () => {
  const signed: KaraokeConsentRequest[] = [],
    submitted: string[] = [];
  const message = await turnOffPublicResults({
    request: async () => revocation,
    submit: async (_request, signature) => {
      submitted.push(signature);
      return { state: "pending" };
    },
    wallet: {
      async signConsent(request) {
        signed.push(request);
        return "0xsigned";
      },
    },
    status: () => {},
  });
  assert.match(message, /Public results are off/);
  assert.deepEqual(signed, [revocation]);
  assert.deepEqual(submitted, ["0xsigned"]);
  // Anything but a V4 Revocation for its own contract is never signed.
  for (const changed of [
    { ...revocation, primaryType: "Enrollment" as const },
    { ...revocation, target: { ...revocation.target!, version: 3 as const } },
    {
      ...revocation,
      domain: { ...revocation.domain, verifyingContract: `0x${"5".repeat(40)}` },
    },
    { ...revocation, domain: { ...revocation.domain, version: "3" } },
    { ...revocation, domain: { ...revocation.domain, chainId: 1 } },
  ])
    await assert.rejects(
      turnOffPublicResults({
        request: async () => changed,
        submit: async () => assert.fail("submitted"),
        wallet: { signConsent: async () => assert.fail("signed") },
        status: () => {},
      }),
      /Public results changed/,
    );
  await assert.rejects(
    turnOffPublicResults({
      request: async () => revocation,
      submit: async () => ({ state: "reverted" }),
      wallet: { signConsent: async () => "0xsigned" },
      status: () => {},
    }),
    /could not be turned off/,
  );
});

test("turning on clears the withdrawal before the normal sign-in", async () => {
  const steps: string[] = [];
  await turnOnPublicResults({
    enable: async () => steps.push("enable"),
    signIn: async () => {
      steps.push("sign-in");
    },
    status: () => {},
  });
  assert.deepEqual(steps, ["enable", "sign-in"]);
  // A refused turn-on never asks for a sign-in.
  steps.length = 0;
  await assert.rejects(
    turnOnPublicResults({
      enable: async () => {
        throw new Error("refused");
      },
      signIn: async () => {
        steps.push("sign-in");
      },
      status: () => {},
    }),
  );
  assert.deepEqual(steps, []);
});
