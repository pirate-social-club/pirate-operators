// Manual, opt-in run of the actual community and operator services against
// MegaETH testnet (docs/megaeth-testnet.md). Never runs in CI. Chain 6343
// only; the services run in the local Workers runtime and may reach only the
// MegaETH RPC. Keys are read from the private file outside the repository and
// never printed. The learner and the fake attester are ephemeral keys
// generated in memory; the learner only signs. The song is the labelled
// fixture. Spending is bounded to test funds from the existing deposit.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  defineChain,
  formatEther,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { check, type Signed, type Song, type Ticket } from "../../packages/protocol/index.ts";
import {
  PAYMENT_GRACE_S,
  segmentUnit,
  songEndMs,
  unitHash,
  type KaraokeManifest,
  type KaraokeResultBody,
} from "../../packages/protocol/payments.ts";
import { ACTIVITY_KARAOKE, consentMessage, consentTypes, type Consent } from "../../packages/protocol/records.ts";
import { readLearner } from "../../packages/records/reader.ts";
import { openAttempt, post, requestPurchase, type Attempt } from "../karaoke-client.ts";
import { fixtureLyrics, fixtureManifest, sungWords } from "../karaoke-fixture.ts";
import { roles, workers } from "../runtime.ts";

const RPC = process.env.MEGAETH_RPC ?? "https://carrot.megaeth.com/rpc";
const KEYS = process.env.MEGAETH_KEYS ?? join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const PT_USD = "0xC5321666F425812D1C12F44dA7BFe08CEB00044B" as Address;
const PAYMENTS = "0x98a5242f80ecc9e01295e03a18712b4256d9f071" as Address;
const RECORDS = "0x0eae432258c5954cf3d06e707acb3490a2f20a12" as Address;

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const chain = createPublicClient({ chain: megaeth, transport: http(RPC, { timeout: 20_000, retryCount: 2 }) });
const paymentsAbi = parseAbi([
  "function signer(address community) view returns (address)",
  "function balance(address community, address token) view returns (uint256)",
  "function redemption(address community, bytes32 unit) view returns (bytes32)",
  "function closed(address community, bytes32 ticketId, address operator) view returns (bool)",
]);
const recordsAbi = parseAbi([
  "function graders(address grader, bytes32 activity) view returns (bool)",
  "function controller() view returns (address)",
]);
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (step: string, detail: unknown = {}) => console.log(JSON.stringify({ step, ...(detail as object) }));

async function main() {
  check((await chain.getChainId()) === 6343, "refusing_non_megaeth_testnet_chain");
  const file = JSON.parse(readFileSync(KEYS, "utf8")) as {
    chainId: number;
    keys: Record<"communityAdmin" | "purchaseSigner" | "operator", Hex>;
  };
  check(file.chainId === 6343, "keys_not_for_megaeth_testnet");
  const admin = privateKeyToAccount(file.keys.communityAdmin);
  const signer = privateKeyToAccount(file.keys.purchaseSigner);
  const operator = privateKeyToAccount(file.keys.operator);
  const learner = privateKeyToAccount(generatePrivateKey());

  // The deployment this run relies on, read before anything is sent.
  const read = (address: Address, abi: typeof paymentsAbi | typeof recordsAbi | typeof tokenAbi, functionName: string, args: readonly unknown[]) =>
    chain.readContract({ address, abi, functionName, args } as never) as Promise<unknown>;
  check(
    ((await read(PAYMENTS, paymentsAbi, "signer", [admin.address])) as string).toLowerCase() === signer.address.toLowerCase(),
    "payments_signer_mismatch",
  );
  check((await read(RECORDS, recordsAbi, "graders", [operator.address, ACTIVITY_KARAOKE])) === true, "operator_not_grader");
  const depositBefore = (await read(PAYMENTS, paymentsAbi, "balance", [admin.address, PT_USD])) as bigint;
  check(depositBefore >= 10_000n, "deposit_too_small");
  const operatorTokenBefore = (await read(PT_USD, tokenAbi, "balanceOf", [operator.address])) as bigint;
  const operatorEthBefore = await chain.getBalance({ address: operator.address });
  const startBlock = await chain.getBlockNumber();
  const chainNow = async () => Number((await chain.getBlock()).timestamp);
  const start = await chainNow();

  // Role keys by fixture index: 1 issuer and purchase signer, 2 operator,
  // 3 the community's deposit address, 4 the fake attester.
  const keys = [generatePrivateKey(), file.keys.purchaseSigner, file.keys.operator, file.keys.communityAdmin, generatePrivateKey()];
  const runtime = await workers(undefined, {
    keys,
    chainId: 6343,
    now: start,
    cutoff: start + 86400,
    rpcUrl: RPC,
    paymentToken: PT_USD,
    paymentsContract: PAYMENTS,
    recordsContract: RECORDS,
    bindings: {
      PAYMENT_CHAIN_ID: "6343",
      REALTIME_RPC: "1",
      QUOTE_VALID_FROM: String(start - 300),
      QUOTE_VALID_UNTIL: String(start + 86400),
      // MOSS's account proxy and orchestrator on MegaETH testnet.
      ACCOUNT_DELEGATE: "0xf655611abe392f35cbb36181d920a302c4df2284",
      ACCOUNT_INITIALIZER: "0xdb03009c44a36a7490d80c9a9e1a03b53497dc42",
    },
  });
  const { mf } = runtime;
  let now = start;
  /** Moves every service clock to the chain's latest block time. */
  const follow = async () => {
    const t = await chainNow();
    if (t <= now) return now;
    now = t;
    for (const role of roles) {
      const r = await post(mf, role, "/__clock", { now: t });
      check(r.status === 200, `clock_failed:${role}:${JSON.stringify(r.value)}`);
    }
    return now;
  };
  const until = async (t: number) => {
    while ((await follow()) < t) await sleep(500);
  };
  const state = async (prefix: string) =>
    ((await post<{ key: string; value: unknown }[]>(mf, "operator", "/__state", {})).value).filter((r) =>
      r.key.startsWith(prefix),
    );

  try {
    const challenge = await post<{ nonce: string; message: string }>(mf, "community", "/challenge", {
      wallet: learner.address,
    });
    const session = (
      await post<{ token: string }>(mf, "community", "/session", {
        nonce: challenge.value.nonce,
        signature: await learner.signMessage({ message: challenge.value.message }),
      })
    ).value.token;
    check(session, "sign_in_failed");

    const song: Song = {
      communityId: "fixture-community",
      audio: `0x${readFileSync("fixtures/original-tone.mp3").toString("hex")}`,
      title: `MegaETH operator run ${start}`,
      lyrics: fixtureLyrics,
      artwork: "original-cover-fixture-v1",
      original: true,
    };
    const manifest: KaraokeManifest = fixtureManifest(song);
    const posted = await post<{ songHash: Hex; error?: string }>(mf, "community", "/songs", { song, manifest }, session);
    check(posted.status === 200, `publish_failed:${JSON.stringify(posted.value)}`);
    log("admitted", { songHash: posted.value.songHash });

    const issued = await post<Signed<Ticket> & { error?: string }>(
      mf,
      "community",
      "/tickets",
      { songHash: posted.value.songHash, sessionKey: learner.address },
      session,
    );
    check(issued.status === 200, `ticket_failed:${JSON.stringify(issued.value)}`);
    const ticket = issued.value.body;
    // The attempt starts at the chain's current time, as a live service's would.
    await follow();
    const socket = (await openAttempt(mf, ticket.ticketId, learner)) as Attempt;
    check(socket.ready, "socket_refused");
    const startedAt = socket.ready.attemptStart!.body.startedAt;
    log("attempt_open", { ticketId: ticket.ticketId, startedAt });

    for (const segment of manifest.segments) {
      await until(startedAt + Math.max(0, Math.ceil((segment.startMs - 15000) / 1000)));
      const signed = await requestPurchase(mf, session, ticket.ticketId, segment.segmentId, socket.ready.attemptStart);
      check(signed.status === 200, `purchase_refused:${segment.segmentId}:${JSON.stringify(signed.value)}`);
      const answer = await socket.pay(signed.value);
      check(answer.type === "paid", `payment_failed:${segment.segmentId}:${JSON.stringify(answer)}`);
      log("paid", { segmentId: segment.segmentId });
    }

    // Consent is accepted at any point on the live socket; it follows the
    // purchases so the first lines' short windows are not spent on it.
    const offered = socket.ready.consent as {
      domain: { name: string; version: string; chainId: number; verifyingContract: Hex };
      message: Consent;
    };
    check(offered?.domain.chainId === 6343 && offered.domain.verifyingContract.toLowerCase() === RECORDS, "consent_not_offered");
    socket.send({
      type: "consent",
      signature: await learner.signTypedData({
        domain: offered.domain,
        types: consentTypes,
        primaryType: "Consent",
        message: consentMessage(offered.message),
      }),
    });
    const consented = await socket.next();
    check(consented.type === "consented", `consent_refused:${JSON.stringify(consented)}`);
    // The client streams recognized words while singing; the song then ends
    // on the operator's own timer, with every line reached.
    socket.send({ type: "words", words: sungWords(manifest) });
    const songEnd = startedAt + Math.ceil(songEndMs(manifest) / 1000);
    check((await follow()) < songEnd, "words_after_song_end");
    await until(songEnd);
    const finishedAt = now;
    log("song_ended", { finishedAt });

    // Closure after the payment grace, then the result and its publication.
    let publication: { state: string; reason?: string } | undefined;
    for (let i = 0; i < 240; i++) {
      await follow();
      publication = (await state("publication:"))[0]?.value as typeof publication;
      if (publication && publication.state !== "pending") break;
      await sleep(500);
    }
    check(publication?.state === "published", `publication_not_published:${JSON.stringify(publication)}`);
    check(now >= finishedAt + PAYMENT_GRACE_S, "closed_before_grace");
    const result = (await post<{ body: KaraokeResultBody }>(mf, "operator", "/result", { ticketId: ticket.ticketId })).value.body;
    log("published", { attemptId: result.attemptId, statuses: result.lines.map((l) => l.status) });

    // Independent reconstruction from MegaETH logs and the manifest alone.
    const source = {
      rpcUrl: RPC,
      records: RECORDS,
      fromBlock: startBlock,
      manifest: async (revision: Hex) => (revision === ticket.manifestSha256 ? manifest : undefined),
    };
    let grade;
    for (let i = 0; i < 20 && !grade; i++) {
      grade = (await readLearner(source, learner.address)).find((a) => a.attemptId === result.attemptId);
      if (!grade?.grade) {
        grade = undefined;
        await sleep(1000);
      }
    }
    const transactions = await Promise.all(
      (await state("tx:")).map(async (r) => {
        const row = r.value as {
          nonce: number;
          kind: string;
          hash: Hex;
          mined: { status: string; block: number } | null;
          cancellation?: { hash?: Hex };
        };
        // A superseded nonce has no receipt of its own; a cancelled one is
        // the cancellation's. Neither is reported as the row's success.
        if (row.mined?.status === "superseded")
          return { nonce: row.nonce, kind: row.kind, hash: row.hash, status: "superseded", gasUsed: "0", block: String(row.mined.block) };
        const hash = row.mined?.status === "cancelled" ? row.cancellation!.hash! : row.hash;
        const receipt = await chain.getTransactionReceipt({ hash });
        return {
          nonce: row.nonce,
          kind: row.kind,
          hash,
          status: row.mined?.status === "cancelled" ? "cancelled" : receipt.status,
          gasUsed: receipt.gasUsed.toString(),
          block: receipt.blockNumber.toString(),
        };
      }),
    );
    const units = [
      ...manifest.segments.map((s) => unitHash(segmentUnit(ticket.ticketId, s.segmentId, 0))),
    ];
    const redemptions = await Promise.all(units.map((u) => read(PAYMENTS, paymentsAbi, "redemption", [admin.address, u])));
    const depositAfter = (await read(PAYMENTS, paymentsAbi, "balance", [admin.address, PT_USD])) as bigint;
    const operatorTokenAfter = (await read(PT_USD, tokenAbi, "balanceOf", [operator.address])) as bigint;
    const verified = {
      readerVerified: grade?.verified === true && grade.problems.length === 0,
      readerMatchesResult:
        JSON.stringify(grade?.grade?.lines.map((l) => [l.lineId, l.status, l.scoreBps])) ===
        JSON.stringify(result.lines.map((l) => [l.lineId, l.status, l.scoreBps])),
      readerRecomputedReward:
        grade?.grade?.rewardScoreBps === result.rewardScoreBps && grade.grade.unmeasuredCount === result.unmeasuredCount,
      completedAtIsPerformanceEnd: grade?.grade?.completedAt === result.performanceEndedAt,
      completedWithEveryLineAssessed:
        result.status === "completed" && result.lines.every((l) => l.status === "assessed"),
      everySegmentRedeemed: redemptions.every((d) => d !== `0x${"0".repeat(64)}`),
      ticketClosed: (await read(PAYMENTS, paymentsAbi, "closed", [admin.address, ticket.ticketId, operator.address])) === true,
      everyTransactionSucceeded: transactions.every((t) => t.status === "success"),
      operatorPaid: operatorTokenAfter - operatorTokenBefore === depositBefore - depositAfter,
    };
    check(Object.values(verified).every(Boolean), `verification_failed:${JSON.stringify({ verified, grade, transactions })}`);

    const evidence = {
      kind: "megaeth-operator-service-run",
      recordedAt: new Date().toISOString(),
      chainId: 6343,
      rpc: RPC,
      runtime: "actual community and operator services in the local Workers runtime; outbound limited to the RPC",
      contracts: { operatorPayments: PAYMENTS, learningRecords: RECORDS, token: PT_USD },
      community: admin.address,
      purchaseSigner: signer.address,
      operator: operator.address,
      learner: learner.address,
      learnerKey: "ephemeral, generated in memory, never stored",
      song: { title: song.title, songHash: posted.value.songHash, manifestSha256: ticket.manifestSha256, fixture: true },
      ticketId: ticket.ticketId,
      attemptId: result.attemptId,
      result: {
        status: result.status,
        startedAt: result.startedAt,
        performanceEndedAt: result.performanceEndedAt,
        endedAt: result.endedAt,
        closedAtBlock: result.closedAtBlock,
        lines: result.lines,
        rewardScoreBps: result.rewardScoreBps,
        paidCount: result.paidCount,
        paidAmount: result.paidAmount,
      },
      paid: { depositBefore: depositBefore.toString(), depositAfter: depositAfter.toString(), operatorReceived: (operatorTokenAfter - operatorTokenBefore).toString() },
      transactions,
      verified,
      operatorEthSpent: formatEther(operatorEthBefore - (await chain.getBalance({ address: operator.address }))),
    };
    mkdirSync("docs/evidence", { recursive: true });
    const path = `docs/evidence/megaeth-operator-run-${evidence.recordedAt.slice(0, 10)}.json`;
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    log("evidence", { path, verified });
    socket.close();
  } finally {
    await mf.dispose();
    rmSync(runtime.persist, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
