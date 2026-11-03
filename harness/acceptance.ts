import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  encodeAbiParameters,
  keccak256,
  concat,
  type Hex,
  type Address,
} from "viem";
import { workers, accounts, roles } from "./runtime.ts";
import { chain } from "./chain.ts";
import {
  digest,
  type Song,
  type Signed,
  type Ticket,
  type Result,
} from "../packages/protocol/index.ts";
import { performance } from "../packages/scoring/fixture-score.ts";

const log = (step: string, state: unknown) =>
  console.log(JSON.stringify({ step, state }));
const runtime = await workers();
let evm: Awaited<ReturnType<typeof chain>> | undefined;
try {
  evm = await chain();
  const { write, read, rpc, deploy, token, jackpot } = evm;
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
    await rpc("evm_setNextBlockTimestamp", [now]);
    await rpc("evm_mine", []);
    for (const role of roles) await fetcher(role, "/__clock", { now });
    assert.equal(Number((await evm!.publicClient.getBlock()).timestamp), now);
  };
  const song: Song = {
    communityId: "fixture-community",
    audio: `0x${readFileSync("fixtures/original-tone.mp3").toString("hex")}`,
    title: "Sing Together",
    lyrics: "sing together",
    artwork: "original-cover-fixture-v1",
    original: true,
  };
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
  const post = (await fetcher("community", "/songs", song, sessions[0])) as {
    songHash: Hex;
    status: string;
  };
  assert.equal(post.status, "published");
  log("admission", post);
  for (let i = 0; i < 3; i++) {
    const ticket = (await fetcher(
      "community",
      "/tickets",
      { songHash: post.songHash, sessionKey: accounts[5 + i].address },
      sessions[i],
    )) as Signed<Ticket>;
    await fetcher("operator", "/prepare", ticket);
    const proof = await accounts[5 + i].signMessage({
      message: `connect:${ticket.body.ticketId}`,
    });
    const worker = await runtime.mf.getWorker("operator");
    const response = await worker.fetch(
      `http://operator.localhost/attempt?ticketId=${ticket.body.ticketId}&proof=${proof}`,
      { headers: { Upgrade: "websocket" } },
    );
    assert.equal(response.status, 101);
    const ws = response.webSocket!;
    ws.accept();
    const result = await new Promise<Signed<Result>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("websocket_timeout")),
        10000,
      );
      ws.addEventListener(
        "message",
        (event) => {
          clearTimeout(timeout);
          const value = JSON.parse(String(event.data));
          if (value.error) reject(new Error(value.error));
          else resolve(value);
        },
        { once: true },
      );
      ws.send(JSON.stringify({ words: performance, consumedMs: 2000 }));
    });
    ws.close();
    assert.equal(result.body.charged, 2);
    assert.equal(result.body.summary.coverageBps, 10000);
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
      score: e.summary.scoreBps,
      charged: e.charged,
    })),
  );
  const pool = await deploy("RewardPool", [
    token,
    jackpot,
    accounts[8].address,
    accounts[1].address,
    accounts[4].address,
    1n,
    1800000100n,
    60n,
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
  await clock(1800000100);
  await write(jackpot, "MockJackpot", "draw", [1n, 10000001n]);
  await write(pool, "RewardPool", "settle");
  assert.equal(await read(pool, "RewardPool", "winnings"), 10000001n);
  const scope = (await read(pool, "RewardPool", "scope")) as Hex;
  for (let i = 0; i < entries.length; i++) {
    const permit = (await fetcher("very", "/attest", {
      pool,
      scope,
      claimant: entries[i].participant,
      subject: i + 1,
    })) as { nullifier: Hex; expiresAt: string; signature: Hex };
    await write(
      pool,
      "RewardPool",
      "register",
      [
        entries[i].attemptId,
        proofs[i],
        permit.nullifier,
        BigInt(permit.expiresAt),
        permit.signature,
      ],
      5 + i,
    );
  }
  log("registration", {
    registered: Number(await read(pool, "RewardPool", "registeredCount")),
    winnings: "10000001",
  });
  await clock(Number(await read(pool, "RewardPool", "deadline")));
  await write(pool, "RewardPool", "finalize");
  assert.equal(await read(pool, "RewardPool", "share"), 3333333n);
  assert.equal(await read(pool, "RewardPool", "sponsorBalance"), 2n);
  for (let i = 5; i < 8; i++) {
    await write(pool, "RewardPool", "withdraw", [accounts[i].address], i);
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
  const charges = (await fetcher("provider", "/__state", {})) as {
    key: string;
    value: { units: number };
  }[];
  const paid = charges.filter((r) => r.key.startsWith("charge:"));
  assert.equal(paid.length, 4);
  assert.equal(
    paid.reduce((sum, p) => sum + p.value.units, 0),
    8,
  );
  log("accounting", { charges: paid.length, total: 8, unit: "simulated" });
  log("acceptance", { status: "passed", scope: "local-skeleton/0" });
} finally {
  await runtime.mf.dispose();
  if (evm) {
    evm.child.kill();
    await new Promise<void>((resolve) => {
      if (evm!.child.exitCode !== null) resolve();
      else evm!.child.once("exit", () => resolve());
    });
  }
}
