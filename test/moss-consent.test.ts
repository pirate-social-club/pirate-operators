// Consent from a learner whose smart account has no code yet
// (docs/learning-records-contract.md section 9), on local anvil. The MOSS
// account is stood in for by contracts/test/MockAccount.sol: an EIP-7702
// delegate with one signing key in place of a passkey, and an initializer that
// can be made to fail.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createWalletClient,
  encodeFunctionData,
  hashTypedData,
  http,
  parseAbi,
  serializeErc8010Signature,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { accounts } from "../harness/runtime.ts";
import { openAttempt, post, type Attempt } from "../harness/karaoke-client.ts";
import type { Signed, Ticket } from "../packages/protocol/index.ts";
import { PAYMENT_GRACE_S, songEndMs, type KaraokeManifest, type KaraokeResultBody } from "../packages/protocol/payments.ts";
import { consentMessage, consentTypes, type Consent } from "../packages/protocol/records.ts";
import { readLearner } from "../packages/records/reader.ts";
import { community, startChain, stopChain, type Chain } from "./payments-fixture.ts";

let evm: Chain;
before(async () => {
  evm = await startChain(18845);
});
after(async () => {
  await stopChain(evm);
});

type C = Awaited<ReturnType<typeof community>>;
const initializerAbi = parseAbi(["function activate(address account, address key)"]);
const manifests = new Map<Hex, KaraokeManifest>();
const setFailing = (value: boolean) => evm.write(evm.mockInitializer, "MockInitializer", "setFailing", [value]);

/** A learner with a fresh account and a separate key standing in for its passkey. */
async function smartLearner(c: C) {
  const learner = privateKeyToAccount(generatePrivateKey());
  const passkey = privateKeyToAccount(generatePrivateKey());
  const { mf } = c.runtime;
  const challenge = await post<{ nonce: string; message: string }>(mf, "community", "/challenge", { wallet: learner.address });
  const session = (
    await post<{ token: string }>(mf, "community", "/session", {
      nonce: challenge.value.nonce,
      signature: await learner.signMessage({ message: challenge.value.message }),
    })
  ).value.token;
  const { manifest, songHash } = await c.publish(session);
  const issued = await post<Signed<Ticket>>(mf, "community", "/tickets", { songHash, sessionKey: learner.address }, session);
  assert.equal(issued.status, 200, JSON.stringify(issued.value));
  manifests.set(issued.value.body.manifestSha256, manifest);
  const socket = (await openAttempt(mf, issued.value.body.ticketId, learner)) as Attempt;
  return { learner, passkey, session, manifest, ticket: issued.value, socket, start: socket.ready.attemptStart! };
}
type L = Awaited<ReturnType<typeof smartLearner>>;

/** The consent as a MOSS account with no code signs it: ERC-8010-wrapped. */
async function wrappedConsent(a: L, options: { signer?: PrivateKeyAccount; delegate?: Address } = {}) {
  const offered = a.socket.ready.consent as { domain: { name: string; version: string; chainId: number; verifyingContract: Hex }; message: Consent };
  const digest = hashTypedData({ domain: offered.domain, types: consentTypes, primaryType: "Consent", message: consentMessage(offered.message) });
  const authorization = await (options.signer ?? a.learner).signAuthorization({
    contractAddress: options.delegate ?? evm.mockAccount,
    chainId: 0,
    nonce: 0,
  });
  return serializeErc8010Signature({
    authorization,
    address: evm.mockInitializer,
    data: encodeFunctionData({ abi: initializerAbi, functionName: "activate", args: [a.learner.address, a.passkey.address] }),
    signature: await a.passkey.sign({ hash: digest }),
  });
}
async function consent(a: L, signature: Hex) {
  a.socket.send({ type: "consent", signature });
  return a.socket.next();
}
async function payAll(c: C, a: L) {
  for (const segment of a.manifest.segments) {
    const opens = a.start.body.startedAt + Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
    if (opens > c.now()) await c.at(opens);
    const signed = await c.purchase(a.session, a.ticket.body.ticketId, segment.segmentId, a.start);
    assert.equal(signed.status, 200, JSON.stringify(signed.value));
    assert.equal((await a.socket.pay(signed.value)).type, "paid");
  }
}
async function finish(c: C, a: L): Promise<KaraokeResultBody> {
  await c.at(a.start.body.startedAt + Math.ceil(songEndMs(a.manifest) / 1000) - 1);
  a.socket.send({ type: "words", words: c.sung(a.manifest) });
  a.socket.send({ type: "finish" });
  await c.at(c.now() + PAYMENT_GRACE_S);
  const result = await c.result(a.ticket.body.ticketId);
  assert.equal(result.status, 200, JSON.stringify(result.value));
  return result.value.body;
}
const publication = async (c: C) =>
  (await c.state("operator", "publication:")).map((r) => r.value as { state: string; reason?: string })[0];
const recordTransactions = async (c: C) =>
  (await c.state("operator", "tx:"))
    .map((r) => r.value as { kind: string; mined: { status: string } | null })
    .filter((t) => t.kind.startsWith("record_"))
    .map((t) => `${t.kind}:${t.mined?.status}`);
const codeOf = async (address: Address) => (await evm.publicClient.getCode({ address })) ?? "0x";
const designator = () => `0xef0100${evm.mockAccount.slice(2).toLowerCase()}`;
const read = async (a: L, attemptId: Hex) =>
  (
    await readLearner(
      { rpcUrl: evm.rpcUrl, records: evm.recordsContract, manifest: async (r) => manifests.get(r) },
      a.learner.address,
    )
  ).find((x) => x.attemptId === attemptId);
const lines = (n: number) => Array.from({ length: n }, () => "record_line:success");

test("an ERC-8010 consent activates the learner's account, survives a crash before opening, and publishes", async () => {
  const c = await community(evm, "smart-activation");
  try {
    const a = await smartLearner(c);
    assert.equal(await codeOf(a.learner.address), "0x");
    assert.equal((await consent(a, await wrappedConsent(a))).type, "consented");
    await c.fault("operator", "fault:crash-before-open", true);
    await payAll(c, a);
    const result = await finish(c, a);
    // Activated, then stopped before the attempt was opened.
    assert.equal((await codeOf(a.learner.address)).toLowerCase(), designator());
    assert.equal((await publication(c)).state, "pending");
    await c.at(c.now() + 1);
    assert.equal((await publication(c)).state, "published");
    assert.deepEqual(await recordTransactions(c), [
      "record_activate:success",
      "record_open:success",
      ...lines(4),
      "record_complete:success",
    ]);
    const r = await read(a, result.attemptId);
    assert.ok(r?.verified, JSON.stringify(r?.problems));
    assert.deepEqual(r.grade?.lines.map((l) => l.status), result.lines.map((l) => l.status));
    assert.equal(r.grade?.rewardScoreBps, result.rewardScoreBps);
  } finally {
    await c.dispose();
  }
});

test("a delegated account whose setup reverted is set up again before the attempt opens", async () => {
  const c = await community(evm, "smart-recovery");
  try {
    const a = await smartLearner(c);
    assert.equal((await consent(a, await wrappedConsent(a))).type, "consented");
    await setFailing(true);
    await c.fault("operator", "fault:crash-after-activation", true);
    await payAll(c, a);
    const result = await finish(c, a);
    // The delegation stuck even though the setup call reverted.
    assert.equal((await codeOf(a.learner.address)).toLowerCase(), designator());
    assert.deepEqual(await recordTransactions(c), ["record_activate:reverted"]);
    await setFailing(false);
    await c.at(c.now() + 1);
    assert.equal((await publication(c)).state, "published");
    assert.deepEqual(await recordTransactions(c), [
      "record_activate:reverted",
      "record_initialize:success",
      "record_open:success",
      ...lines(4),
      "record_complete:success",
    ]);
    assert.ok((await read(a, result.attemptId))?.grade);
  } finally {
    await setFailing(false);
    await c.dispose();
  }
});

test("a setup that keeps failing ends the publication without opening the attempt", async () => {
  const c = await community(evm, "smart-failing");
  try {
    const a = await smartLearner(c);
    assert.equal((await consent(a, await wrappedConsent(a))).type, "consented");
    await setFailing(true);
    await payAll(c, a);
    const result = await finish(c, a);
    assert.deepEqual(await publication(c), { revision: 1, ordinals: [1, 2, 3, 4], state: "failed", reason: "account_not_initialized" });
    assert.deepEqual(await recordTransactions(c), ["record_activate:reverted", "record_initialize:reverted"]);
    assert.equal(await read(a, result.attemptId), undefined);
  } finally {
    await setFailing(false);
    await c.dispose();
  }
});

test("an activation that is not the learner's, names another delegate, or has a stale nonce is refused", async () => {
  const c = await community(evm, "smart-refusals");
  try {
    const a = await smartLearner(c);
    const stranger = privateKeyToAccount(generatePrivateKey());
    const notTheirs = await consent(a, await wrappedConsent(a, { signer: stranger }));
    assert.deepEqual([notTheirs.type, notTheirs.code], ["error", "authorization_not_learners"]);
    const otherDelegate = await consent(a, await wrappedConsent(a, { delegate: evm.recordsContract }));
    assert.deepEqual([otherDelegate.type, otherDelegate.code], ["error", "unapproved_delegate"]);

    assert.equal((await consent(a, await wrappedConsent(a))).type, "consented");
    // The learner transacts after consenting, so the signed authorization's nonce is spent.
    await evm.rpc("anvil_setBalance", [a.learner.address, "0xde0b6b3a7640000"]);
    const wallet = createWalletClient({ chain: foundry, transport: http(evm.rpcUrl), account: a.learner });
    await evm.publicClient.waitForTransactionReceipt({
      hash: await wallet.sendTransaction({ to: accounts[0].address, value: 0n }),
    });
    await payAll(c, a);
    await finish(c, a);
    assert.deepEqual(await publication(c), {
      revision: 1,
      ordinals: [1, 2, 3, 4],
      state: "failed",
      reason: "authorization_nonce_stale",
    });
    assert.deepEqual(await recordTransactions(c), []);
    assert.equal(await codeOf(a.learner.address), "0x");
  } finally {
    await c.dispose();
  }
});
