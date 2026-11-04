import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  keccak256,
  concat,
  type Hex,
  type Address,
} from "viem";
import { workers, roles } from "./runtime.ts";
import type { PrivateKeyAccount } from "viem/accounts";

import {
  digest,
  registrationTypes,
  type Song,
  type Signed,
  type Ticket,
  type Result,
} from "../packages/protocol/index.ts";
import { rewardPoolScope } from "../packages/protocol/very-reward-scope.ts";
import { PAYMENT_GRACE_S } from "../packages/protocol/payments.ts";
import { fixtureLyrics, fixtureManifest, sungWords } from "./karaoke-fixture.ts";
import { openAttempt, post, requestPurchase, type Attempt } from "./karaoke-client.ts";

export interface PoolChain {
  token: Address;
  jackpot: Address;
  paymentToken?: Address;
  deploy(name: string, args: readonly unknown[]): Promise<Address>;
  write(
    address: Address,
    name: string,
    functionName: string,
    args?: readonly unknown[],
    signer?: number,
  ): Promise<unknown>;
  read(
    address: Address,
    name: string,
    functionName: string,
    args?: readonly unknown[],
  ): Promise<unknown>;
  timestamp(): Promise<number>;
  advanceTo(timestamp: number): Promise<void>;
}
export async function runFlow({
  runtime,
  evm,
  accounts,
  cutoff = 1800000100,
  windowSeconds = 0,
  log,
}: {
  runtime: Awaited<ReturnType<typeof workers>>;
  evm: PoolChain;
  accounts: readonly PrivateKeyAccount[];
  cutoff?: number;
  windowSeconds?: number;
  log: (step: string, state: unknown) => void;
}) {
  const { write, read, deploy, token, jackpot } = evm;
  const fetcher = async (
    role: string,
    path: string,
    input: unknown,
    session?: string,
  ) => {
    const worker = await runtime.mf.getWorker(role);
    const response = await worker.fetch(`http://community.localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session ? { Authorization: `Bearer ${session}` } : {}),
      },
      body: JSON.stringify(input),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const clock = async (now: number) => {
    await evm.advanceTo(now);
    for (const role of roles) await fetcher(role, "/__clock", { now });
    assert.ok((await evm.timestamp()) >= now);
  };
  // Karaoke time moves only the services' clocks: payment receipts do not
  // depend on chain time, and the pool's chain clock advances at the cutoff.
  let serviceNow = 1800000000;
  const serviceClock = async (now: number) => {
    serviceNow = now;
    for (const role of roles) await fetcher(role, "/__clock", { now });
  };
  const song: Song = {
    communityId: "fixture-community",
    audio: `0x${readFileSync("fixtures/original-tone.mp3").toString("hex")}`,
    title: "Sing Together",
    lyrics: fixtureLyrics,
    artwork: "original-cover-fixture-v1",
    original: true,
  };
  const manifest = fixtureManifest(song);
  const sessions: string[] = [];
  const entries: Result[] = [];
  for (const wallet of accounts.slice(5, 8)) {
    const { nonce, message } = (await fetcher("community", "/challenge", {
      wallet: wallet.address,
    })) as { nonce: string; message: string };
    const signature = await wallet.signMessage({ message });
    const { token: session } = (await fetcher("community", "/session", {
      nonce,
      signature,
    })) as { token: string };
    sessions.push(session);
  }
  log("sign_in", {
    participants: sessions.length,
    community: song.communityId,
  });
  const posted = (await fetcher(
    "community",
    "/songs",
    { song, manifest },
    sessions[0],
  )) as {
    songHash: Hex;
    status: string;
  };
  assert.equal(posted.status, "published");
  log("admission", posted);
  for (let i = 0; i < 3; i++) {
    const ticket = (await fetcher(
      "community",
      "/tickets",
      { songHash: posted.songHash, sessionKey: accounts[5 + i].address },
      sessions[i],
    )) as Signed<Ticket>;
    const ticketId = ticket.body.ticketId;
    const attempt = (await openAttempt(
      runtime.mf,
      ticketId,
      accounts[5 + i],
    )) as Attempt;
    const start = attempt.ready.attemptStart!;
    const startedAt = start.body.startedAt;
    // Pay each line inside its window, binding each on the operator's socket.
    for (const segment of manifest.segments) {
      const opensAt = startedAt + Math.max(0, Math.ceil((segment.startMs - 15000) / 1000));
      if (opensAt > serviceNow) await serviceClock(opensAt);
      const signed = await requestPurchase(
        runtime.mf,
        sessions[i],
        ticketId,
        segment.segmentId,
        start,
      );
      assert.equal(signed.status, 200, JSON.stringify(signed.value));
      const bound = await attempt.pay(signed.value);
      assert.equal(bound.type, "paid", JSON.stringify(bound));
    }
    attempt.send({ type: "words", words: sungWords(manifest) });
    attempt.send({ type: "finish" });
    const echo = await post(runtime.mf, "operator", "/result", { ticketId });
    assert.equal((echo.value as { error?: string }).error, "result_not_final");
    // At the deadline the operator closes the ticket on chain, reconciles at
    // the closure block and signs.
    await serviceClock(serviceNow + PAYMENT_GRACE_S);
    attempt.close();
    const result = (await fetcher("operator", "/result", {
      ticketId,
    })) as Signed<Result>;
    assert.equal(result.body.paidCount, manifest.segments.length);
    assert.equal(result.body.unmeasuredCount, 0);
    assert.ok(result.body.lines.every((line) => line.status === "assessed"));
    const qualified = (await fetcher(
      "community",
      "/qualify",
      { result },
      sessions[i],
    )) as { entry: Result };
    entries.push(qualified.entry);
  }
  log(
    "karaoke_and_qualification",
    entries.map((e) => ({
      participant: e.participant,
      rewardScoreBps: e.rewardScoreBps,
      lines: e.lines.map((line) => `${line.lineId}:${line.status}:${line.scoreBps}`),
      paidCount: e.paidCount,
      paidAmount: e.paidAmount,
    })),
  );
  if (evm.paymentToken) {
    const operatorBalance = await read(evm.paymentToken, "TestPaymentToken", "balanceOf", [
      accounts[2].address,
    ]);
    // Three attempts of four lines at 1000 each, plus one admission at 2000.
    assert.equal(operatorBalance, BigInt(3 * manifest.segments.length * 1000 + 2000));
    log("operator_payments", {
      redemptions: 3 * manifest.segments.length + 1,
      operatorUnits: String(operatorBalance),
      contract: "OperatorPayments",
      chain: "local-anvil",
    });
  }
  const pool = await deploy("RewardPool", [
    token,
    jackpot,
    accounts[8].address,
    accounts[1].address,
    accounts[4].address,
    1n,
    BigInt(cutoff),
    BigInt(windowSeconds),
    1n,
    1000000n,
    digest({ policy: "local-fixture/0", minimum: 7000 }),
  ]);
  await write(token, "TestUSDC", "mint", [pool, 1000000n]);
  const leaves = entries.map((e) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: "address" },
          { type: "uint256" },
          { type: "address" },
          { type: "bytes32" },
        ],
        [pool, 1n, e.participant, e.attemptId as Hex],
      ),
    ),
  );
  const pair = (a: Hex, b: Hex) =>
    keccak256(concat([a, b].sort() as [Hex, Hex]));
  const left = pair(leaves[0], leaves[1]);
  const root = pair(left, leaves[2]);
  const proofs = [[leaves[1], leaves[2]], [leaves[0], leaves[2]], [left]];
  await write(
    pool,
    "RewardPool",
    "commitEntries",
    [root, 3n, digest({ policy: "local-fixture/0", minimum: 7000 })],
    1,
  );
  await write(
    pool,
    "RewardPool",
    "purchase",
    [[{ normals: [1, 2, 3, 4, 5], bonusball: 1 }]],
    8,
  );
  assert.equal(await read(pool, "RewardPool", "ticketSpend"), 1000000n);
  log("ticket_purchase", {
    tokenUnits: "1000000",
    owner: "reward_pool",
    executor: "separate",
  });
  log("entry_commitment", { root, entries: 3 });
  await clock(cutoff);
  await write(jackpot, "MockJackpot", "draw", [1n, 10000001n]);
  await write(pool, "RewardPool", "settle");
  assert.equal(await read(pool, "RewardPool", "winnings"), 10000001n);
  const scope = (await read(pool, "RewardPool", "scope")) as Hex;
  assert.equal(
    scope,
    rewardPoolScope({
      chainId: BigInt(runtime.chainId),
      pool,
      drawingId: (await read(pool, "RewardPool", "drawingId")) as bigint,
    }),
  );
  const registrations = [];
  for (let i = 0; i < entries.length; i++) {
    const permit = (await fetcher("very", "/attest", {
      pool,
      scope,
      claimant: entries[i].participant,
      subject: i + 1,
    })) as { nullifier: Hex; expiresAt: string; signature: Hex };
    const registration = {
      scope,
      claimant: entries[i].participant,
      recipient: entries[i].participant,
      attemptId: entries[i].attemptId as Hex,
      nullifier: permit.nullifier,
      expiresAt: BigInt(permit.expiresAt),
    };
    const authorization = await accounts[5 + i].signTypedData({
      domain: {
        name: "Pirate Reward Pool",
        version: "1",
        chainId: runtime.chainId,
        verifyingContract: pool,
      },
      types: registrationTypes,
      primaryType: "Registration",
      message: registration,
    });
    registrations.push({
      ...registration,
      proof: proofs[i],
      attestation: permit.signature,
      authorization,
    });
  }
  await write(pool, "RewardPool", "registerBatch", [registrations], 1);
  assert.equal(await read(pool, "RewardPool", "registeredCount"), 3n);
  log("registration", {
    registered: Number(await read(pool, "RewardPool", "registeredCount")),
    winnings: "10000001",
  });
  await clock(Number(await read(pool, "RewardPool", "deadline")));
  await write(pool, "RewardPool", "finalize");
  assert.equal(await read(pool, "RewardPool", "share"), 3333333n);
  assert.equal(await read(pool, "RewardPool", "sponsorBalance"), 2n);
  await write(
    pool,
    "RewardPool",
    "withdrawBatch",
    [accounts.slice(5, 8).map((a) => a.address)],
    1,
  );
  for (let i = 5; i < 8; i++) {
    assert.equal(
      await read(token, "TestUSDC", "balanceOf", [accounts[i].address]),
      3333333n,
    );
  }
  await write(pool, "RewardPool", "withdrawSponsor", [accounts[0].address]);
  assert.equal(await read(token, "TestUSDC", "balanceOf", [pool]), 0n);
  log("withdrawal", {
    participantUnits: "3333333",
    sponsorDust: "2",
    poolBalance: "0",
  });
  log("acceptance", { status: "passed", scope: "local-skeleton/1" });
}
