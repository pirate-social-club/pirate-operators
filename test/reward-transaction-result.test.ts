import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseRewardTransactionResult as parse } from "../packages/rewards/transaction-result.ts";
const context = { network: "testnet", expectedAccountVerified: true };
const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/reward-moss-result-modeled.json", import.meta.url),
    "utf8",
  ),
);
const hash = fixture.result.receipt.transactionHash;
const other = "0x" + "12".repeat(32);
const candidate = (value: unknown) => parse(value, context);

test("MODELED canonical transaction: missing chainId remains an approved hash candidate, never a payment confirmation", () => {
  assert.match(fixture.label, /MODELED.*NOT a captured browser/);
  assert.deepEqual(candidate(fixture.result), {
    outcome: "approved",
    disposition: "candidate",
    reason: "unique_hash",
    hash,
    chainEvidence: "verified_testnet_context",
  });
});
test("a single array receipt and mirrored hash aliases normalize to one candidate", () => {
  const upper = hash.toUpperCase().replace("0X", "0x");
  const result = candidate({
    status: "approved",
    receipts: [{ hash: upper, transactionHash: hash, chainId: "0x18c7" }],
  });
  assert.equal(result.hash, hash);
  assert.equal(result.chainEvidence, "explicit_testnet");
  assert.equal(result.disposition, "candidate");
});
for (const chainId of [6343, "6343", "0x18c7", "0X18C7", 6343n]) {
  test(`normalizes explicit testnet chain representation ${typeof chainId}:${String(chainId)}`, () => {
    assert.equal(
      candidate({
        status: "approved",
        receipt: { transactionHash: hash, chainId },
      }).hash,
      hash,
    );
  });
}
for (const chainId of [4326, "8453", "0x2105", 1n, 0]) {
  test(`rejects explicit other chain ${typeof chainId}:${String(chainId)}`, () => {
    assert.deepEqual(
      candidate({
        status: "approved",
        receipt: { transactionHash: hash, chainId },
      }),
      { outcome: "unknown", disposition: "rejected", reason: "wrong_chain" },
    );
  });
}
for (const chainId of [
  null,
  {},
  [],
  true,
  NaN,
  Infinity,
  6343.5,
  " 6343",
  "6343 ",
  "6.343e3",
  "0x",
  "06343",
  -1,
  -1n,
]) {
  test(`rejects malformed chain representation ${typeof chainId}:${String(chainId)}`, () => {
    const result = candidate({
      status: "approved",
      receipt: { transactionHash: hash, chainId },
    });
    assert.equal(result.reason, "malformed_chain");
    assert.equal(result.hash, undefined);
  });
}
test("an explicit top-level chain cannot contradict verified testnet context", () => {
  for (const chainId of [4326, "garbage", null]) {
    const result = candidate({ ...fixture.result, chainId });
    assert.equal(result.disposition, "rejected");
    assert.equal(result.hash, undefined);
  }
});
test("wrong-chain metadata in any receipt poisons a matching singular candidate", () => {
  const result = candidate({
    status: "approved",
    receipt: { hash },
    receipts: [{ chainId: 4326 }],
  });
  assert.equal(result.reason, "wrong_chain");
  assert.equal(result.hash, undefined);
});
test("rejects disagreeing aliases and multiple unique receipts without selecting the first", () => {
  for (const result of [
    { status: "approved", receipt: { transactionHash: hash, hash: other } },
    { status: "approved", receipt: { hash }, receipts: [{ hash: other }] },
  ]) {
    assert.equal(candidate(result).reason, "conflicting_hashes");
    assert.equal(candidate(result).hash, undefined);
  }
});
test("a malformed hash alias cannot be hidden by a valid transactionHash", () => {
  assert.equal(
    candidate({
      status: "approved",
      receipt: { transactionHash: hash, hash: "bad" },
    }).reason,
    "malformed_hash",
  );
});
test("chain omission is disallowed without both verified testnet and expected account context", () => {
  for (const bad of [
    { network: "mainnet", expectedAccountVerified: true },
    { network: "testnet", expectedAccountVerified: false },
  ]) {
    assert.equal(parse(fixture.result, bad).reason, "testnet_context_required");
  }
});
test("approved without a hash stays unknown, while declined/error statuses remain distinct", () => {
  for (const status of ["approved", "cancelled", "error", "unexpected"]) {
    const result = candidate({ status });
    assert.equal(
      result.outcome,
      status === "cancelled" || status === "error" ? status : "unknown",
    );
    assert.equal(result.disposition, "no_candidate");
  }
});
test("hashes survive error/cancelled/unknown SDK status as candidates for canonical review", () => {
  for (const status of ["cancelled", "error", "unexpected"]) {
    const result = candidate({ status, receipts: [{ hash }] });
    assert.equal(result.hash, hash);
    assert.equal(result.outcome, status === "unexpected" ? "unknown" : status);
  }
});
test("malformed containers, accessors and hostile proxies fail closed without calling a getter", () => {
  for (const value of [
    null,
    [],
    "approved",
    { receipt: null },
    { receipts: {} },
    { receipts: [null] },
    { receipts: new Array(33).fill({ hash }) },
  ]) {
    assert.equal(candidate(value).disposition, "rejected");
  }
  let invoked = false;
  const receipt = {
    get transactionHash() {
      invoked = true;
      throw Error("private error");
    },
  };
  assert.equal(candidate({ receipt }).disposition, "rejected");
  assert.equal(invoked, false);
  assert.equal(
    candidate(
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor() {
            throw Error("private error");
          },
        },
      ),
    ).disposition,
    "rejected",
  );
});
test("input is unchanged and SDK credential/error strings are not returned", () => {
  const value = structuredClone(fixture.result);
  value.jwt = "private-token";
  value.error = "private-provider-error";
  const before = structuredClone(value);
  const parsed = candidate(value);
  assert.deepEqual(value, before);
  assert.equal(JSON.stringify(parsed).includes("private"), false);
});
