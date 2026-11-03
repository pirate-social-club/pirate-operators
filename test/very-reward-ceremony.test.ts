import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { RewardCeremony } from "../harness/very/reward-ceremony.ts";
import {
  configurationHash,
  context,
  type AttesterConfig,
  type Challenge,
  type Permit,
} from "../services/very-attester/policy.ts";
import { deferred } from "./very-fixture.ts";

const key = `0x${"6".padStart(64, "0")}` as Hex;
const claimant = privateKeyToAccount(key);
const config: AttesterConfig = {
  chainId: 31337,
  pool: "0x1111111111111111111111111111111111111111",
  drawingId: "1",
  poolCodeHash: `0x${"11".repeat(32)}`,
  attester: claimant.address,
  appId: "11111111-1111-4111-8111-111111111111",
};
function fixture() {
  let now = 1800000000000,
    onChain = false,
    submits = 0,
    opens = 0;
  let submit = async (_permit: Permit) => {
    onChain = true;
  };
  let issue = async () => ({
    nullifier: `0x${"ab".repeat(32)}`,
    expiresAt: "1800000300",
    signature: `0x${"cd".repeat(65)}`,
  });
  const requests: {
    app: string;
    scope: string;
    binding: string;
    key: Buffer;
  }[] = [];
  const challenge: Challenge = {
    id: `0x${"12".repeat(32)}`,
    claimant: claimant.address,
    binding: "17",
    expiresAt: 1800000300,
    scope: context(config).scope,
    configHash: configurationHash(config),
  };
  const ceremony = new RewardCeremony({
    config,
    claimant,
    now: () => now,
    provider: {
      open: async (app, scope, binding, key) => {
        opens++;
        requests.push({ app, scope, binding, key });
        return { id: "fixture-session" };
      },
      poll: async () => "fixture-proof-never-log",
    },
    call: async (path, input) => {
      if (path === "/challenge") return challenge;
      assert.equal(path, "/issue");
      assert.equal(
        (input as { proof: string }).proof,
        "fixture-proof-never-log",
      );
      return issue();
    },
    registered: async () => onChain,
    register: async (permit) => {
      submits++;
      await submit(permit);
    },
  });
  return {
    ceremony,
    requests,
    challenge,
    setIssue: (fn: typeof issue) => {
      issue = fn;
    },
    setSubmit: (fn: typeof submit) => {
      submit = fn;
    },
    chainSuccess: () => {
      onChain = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get submits() {
      return submits;
    },
    get opens() {
      return opens;
    },
  };
}
test("ceremony uses the pinned app and derived scope, clears the key and redacts its report", async () => {
  const f = fixture();
  await f.ceremony.start();
  assert.equal(f.requests[0].app, config.appId);
  assert.equal(f.requests[0].scope, context(config).externalNullifier);
  assert.match(f.ceremony.view().launch!, /^veros:\/\/verify/);
  await f.ceremony.poll();
  assert.equal(f.ceremony.view().state, "complete");
  assert.equal(f.ceremony.view().launch, null);
  assert.equal(f.submits, 1);
  assert.ok(f.requests[0].key.every((v) => v === 0));
  const report = JSON.stringify(f.ceremony.view().report);
  for (const value of [
    config.appId,
    "fixture-proof-never-log",
    "fixture-session",
    "abababab",
  ])
    assert.ok(!report.includes(value));
  await f.ceremony.start();
  assert.equal(f.opens, 1);
});
test("unknown registration outcome only reads the chain; it never retries sending", async () => {
  const f = fixture();
  f.setSubmit(async () => {
    throw new Error("response_lost");
  });
  await f.ceremony.start();
  await f.ceremony.poll();
  assert.equal(f.ceremony.view().state, "registration_unknown");
  f.ceremony.reset();
  await f.ceremony.start();
  await f.ceremony.poll();
  assert.equal(f.submits, 1);
  f.chainSuccess();
  await f.ceremony.poll();
  assert.equal(f.ceremony.view().state, "complete");
  assert.equal(f.submits, 1);
});
test("failed verification is stage-specific without exposing provider details", async () => {
  const f = fixture();
  f.setIssue(async () => {
    throw new Error("invalid_proof_binding");
  });
  await f.ceremony.start();
  await f.ceremony.poll();
  assert.equal(f.submits, 0);
  assert.match(
    f.ceremony.view().error!,
    /attester verification \(invalid_proof_binding\)/,
  );
  f.setIssue(async () => {
    throw new Error("private-provider-body");
  });
  await f.ceremony.start();
  await f.ceremony.poll();
  assert.ok(
    !JSON.stringify(f.ceremony.view()).includes("private-provider-body"),
  );
});
test("reset during verification drains the request without submitting registration", async () => {
  const f = fixture();
  const entered = deferred<void>(),
    release = deferred<void>();
  f.setIssue(async () => {
    entered.resolve();
    await release.promise;
    return {
      nullifier: `0x${"ab".repeat(32)}`,
      expiresAt: "1800000300",
      signature: "0x",
    };
  });
  await f.ceremony.start();
  const poll = f.ceremony.poll();
  await entered.promise;
  f.ceremony.reset();
  let drained = false;
  const drain = f.ceremony.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  release.resolve();
  await poll;
  await drain;
  assert.equal(f.submits, 0);
  assert.equal(f.ceremony.view().state, "ready");
});
test("an expired ceremony removes the QR before a refreshed page renders it", async () => {
  const f = fixture();
  await f.ceremony.start();
  f.advance(300000);
  assert.equal(f.ceremony.view().state, "expired");
  assert.equal(f.ceremony.view().launch, null);
  assert.equal(f.submits, 0);
});
