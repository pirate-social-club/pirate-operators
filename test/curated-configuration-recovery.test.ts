import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256 } from "viem";
import {
  curatedConfigurationIntent,
  curatedConfigurationNonce,
  guardedConfigurationPin,
} from "../harness/megaeth/curated-configuration-recovery.ts";
import { curatedConfigurationPlan } from "../harness/megaeth/curated-configuration-plan.ts";
import { deploymentJournalProfileHash } from "../harness/megaeth/deployment-journal.ts";
import { hashJson } from "../packages/community/common.ts";

test("pending and newly mined captured configuration transactions can reconcile; unrelated nonce drift cannot allocate a replacement", () => {
  assert.doesNotThrow(() => curatedConfigurationNonce(18, 18, 18, false));
  for (const [latest, pending] of [
    [18, 19],
    [19, 19],
  ]) {
    assert.throws(() =>
      curatedConfigurationNonce(latest!, pending!, 18, false),
    );
    assert.doesNotThrow(() =>
      curatedConfigurationNonce(latest!, pending!, 18, true),
    );
  }
  for (const [latest, pending] of [
    [17, 18],
    [18, 20],
    [19, 20],
    [20, 20],
  ])
    assert.throws(() => curatedConfigurationNonce(latest!, pending!, 18, true));
});
test("a paused configuration invocation cannot start a pin after its deadline; read reconciliation remains available", async () => {
  let now = 100,
    sends = 0;
  const send = guardedConfigurationPin(
    200,
    async () => {
      sends++;
      return new Response("fixture");
    },
    () => now,
  );
  now = 201;
  await assert.rejects(
    send(
      new Request("https://rpc.filebase.io/api/v0/add?cid-version=1", {
        method: "POST",
      }),
    ),
    /pin_deadline_reached/,
  );
  assert.equal(sends, 0);
  await send(
    new Request("https://rpc.filebase.io/api/v0/pin/ls?arg=fixture", {
      method: "POST",
    }),
  );
  assert.equal(sends, 1);
});
test("recovery admits only the exact wrapped profile, controller-signed bytes, sole intent and captured nonce", async () => {
  const planned = await curatedConfigurationPlan(),
    signer = privateKeyToAccount(`0x${"66".repeat(32)}`);
  planned.profile.manifest.controller =
    signer.address.toLowerCase() as `0x${string}`;
  const raw = await signer.signTransaction({
      type: "legacy",
      chainId: 6343,
      nonce: 18,
      to: planned.call.to,
      data: planned.call.data,
      value: 0n,
      gas: planned.call.gas,
      gasPrice: 1000000n,
    }),
    item = {
      intentHash: hashJson({
        to: planned.call.to,
        data: planned.call.data,
        gas: planned.call.gas.toString(),
      }),
      nonce: 18,
      raw,
      hash: keccak256(raw),
      maximumFee: (planned.call.gas * 1000000n).toString(),
    },
    state = {
      schema: "pirate.testnet-deployment-journal/1",
      profileHash: deploymentJournalProfileHash(
        planned.profile,
        planned.limits,
      ),
      chainId: 6343,
      signer: signer.address,
      transactions: { configure_owner_curated: item },
    };
  assert.equal(
    (await curatedConfigurationIntent(state, planned))!.hash,
    item.hash,
  );
  await assert.rejects(
    curatedConfigurationIntent(
      { ...state, profileHash: hashJson({ wrong: true }) },
      planned,
    ),
    /journal_changed/,
  );
  await assert.rejects(
    curatedConfigurationIntent(
      { ...state, transactions: { ...state.transactions, unrelated: item } },
      planned,
    ),
    /journal_changed/,
  );
  await assert.rejects(
    curatedConfigurationIntent(
      {
        ...state,
        transactions: { configure_owner_curated: { ...item, nonce: 19 } },
      },
      planned,
    ),
    /signed_intent_changed/,
  );
});
