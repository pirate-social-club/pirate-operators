import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import { chain } from "../harness/chain.ts";
import { accounts, roles, workers } from "../harness/runtime.ts";
import { fixtureLyrics, fixtureManifest, sungWords } from "../harness/karaoke-fixture.ts";
import { openAttempt, post, requestPurchase, type Attempt } from "../harness/karaoke-client.ts";
import type { Signed, Song, Ticket } from "../packages/protocol/index.ts";

export type Chain = Awaited<ReturnType<typeof chain>>;
/** Each test file runs its own anvil; files run in parallel, so each needs its own port. */
export const startChain = (port = 18645) => chain(port);
export const stopChain = async (evm: Chain) => {
  evm.child.kill();
  await new Promise<void>((resolve) => {
    if (evm.child.exitCode !== null) resolve();
    else evm.child.once("exit", () => resolve());
  });
};
export const chainTime = async (evm: Chain) =>
  Number((await evm.publicClient.getBlock()).timestamp);

let songs = 0;
/** One community, one participant and one song per test, on the shared chain. */
export async function community(evm: Chain, label: string) {
  const start = (await chainTime(evm)) + 1;
  const runtime = await workers(undefined, {
    rpcUrl: evm.rpcUrl,
    paymentToken: evm.paymentToken,
    paymentsContract: evm.paymentsContract,
    recordsContract: evm.recordsContract,
    now: start,
    cutoff: start + 100000,
  });
  let now = start;
  /** Moves every service clock, and the chain if it is behind. */
  const at = async (t: number) => {
    now = t;
    if (t > (await chainTime(evm))) {
      await evm.rpc("evm_setNextBlockTimestamp", [t]);
      await evm.rpc("evm_mine", []);
    }
    for (const role of roles) {
      const r = await post(runtime.mf, role, "/__clock", { now: t });
      assert.equal(r.status, 200, JSON.stringify(r.value));
    }
  };
  const signIn = async (index = 5) => {
    const wallet = accounts[index];
    const challenge = await post<{ nonce: string; message: string }>(runtime.mf, "community", "/challenge", {
      wallet: wallet.address,
    });
    const signature = await wallet.signMessage({ message: challenge.value.message });
    const session = await post<{ token: string }>(runtime.mf, "community", "/session", {
      nonce: challenge.value.nonce,
      signature,
    });
    return session.value.token;
  };
  const publish = async (session: string, title = `${label} ${++songs}`) => {
    const song: Song = {
      communityId: "fixture-community",
      audio: `0x${readFileSync("fixtures/original-tone.mp3").toString("hex")}`,
      title,
      lyrics: fixtureLyrics,
      artwork: "original-cover-fixture-v1",
      original: true,
    };
    const manifest = fixtureManifest(song);
    const posted = await post<{ songHash: Hex; status: string; error?: string }>(
      runtime.mf,
      "community",
      "/songs",
      { song, manifest },
      session,
    );
    assert.equal(posted.status, 200, JSON.stringify(posted.value));
    return { song, manifest, songHash: posted.value.songHash };
  };
  const ticket = async (session: string, songHash: Hex, index = 5) => {
    const issued = await post<Signed<Ticket> & { error?: string }>(
      runtime.mf,
      "community",
      "/tickets",
      { songHash, sessionKey: accounts[index].address },
      session,
    );
    return issued;
  };
  /** Signs in, publishes, issues a ticket and opens its attempt. */
  const attempt = async (index = 5) => {
    const session = await signIn(index);
    const { manifest, songHash } = await publish(session);
    const issued = await ticket(session, songHash, index);
    assert.equal(issued.status, 200, JSON.stringify(issued.value));
    const opened = (await openAttempt(runtime.mf, issued.value.body.ticketId, accounts[index])) as Attempt;
    const start = opened.ready.attemptStart!;
    return { session, manifest, songHash, ticket: issued.value, socket: opened, start };
  };
  const purchase = (session: string, ticketId: string, segmentId: string, start?: Parameters<typeof requestPurchase>[4]) =>
    requestPurchase(runtime.mf, session, ticketId, segmentId, start);
  const result = (ticketId: string) =>
    post<{ body: import("../packages/protocol/payments.ts").KaraokeResultBody; error?: string }>(
      runtime.mf,
      "operator",
      "/result",
      { ticketId },
    );
  const fault = (role: string, key: string, value: unknown) =>
    post(runtime.mf, role, "/__fault", { key, value });
  const state = async (role: string, prefix: string) => {
    const all = await post<{ key: string; value: unknown }[]>(runtime.mf, role, "/__state", {});
    return all.value.filter((r) => r.key.startsWith(prefix));
  };
  const operatorBalance = async () =>
    (await evm.read(evm.paymentToken, "TestPaymentToken", "balanceOf", [accounts[2].address])) as bigint;
  return {
    runtime,
    at,
    now: () => now,
    signIn,
    publish,
    ticket,
    attempt,
    purchase,
    result,
    fault,
    state,
    operatorBalance,
    sung: sungWords,
    dispose: () => runtime.mf.dispose(),
  };
}
