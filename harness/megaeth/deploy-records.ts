// Manual, opt-in MegaETH testnet deployment of LearningRecords that measures
// publication gas (docs/learning-records-contract.md). Never runs in CI.
// Chain 6343 only; the community admin and operator keys are read from the
// private file outside the repository and never printed. The learner is an
// ephemeral key generated in memory that only signs consent. The records are
// synthetic: a 40-line fixture manifest, labelled as such.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, stringToBytes, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { check, digest } from "../../packages/protocol/index.ts";
import type { KaraokeManifest } from "../../packages/protocol/payments.ts";
import {
  ACTIVITY_KARAOKE,
  LINE_STATUS_CODES,
  consentMessage,
  consentTypes,
  lineKeyOf,
  linesRootOf,
  manifestLeaves,
  merkleProof,
  recordsDomain,
  scoringPolicyOf,
  songKeyOf,
  standInSong,
  type Consent,
} from "../../packages/protocol/records.ts";
import { readLearner } from "../../packages/records/reader.ts";
import { compile } from "../compile.ts";

const RPC = process.env.MEGAETH_RPC ?? "https://carrot.megaeth.com/rpc";
const KEYS = process.env.MEGAETH_KEYS ?? join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const LINES = 40;

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { timeout: 20_000, retryCount: 2 });
const publicClient = createPublicClient({ chain: megaeth, transport });

function syntheticManifest(): KaraokeManifest {
  const lines = Array.from({ length: LINES }, (_, i) => ({
    lineId: `line-${String(i + 1).padStart(2, "0")}`,
    lineVersion: 1,
    ordinal: i + 1,
    text: `fixture line ${i + 1}`,
    startMs: i * 3000,
    endMs: i * 3000 + 2500,
    words: [{ text: "fixture", startMs: i * 3000 + 200, endMs: i * 3000 + 2300 }],
  }));
  return {
    manifestVersion: "pirate.karaoke.manifest/1",
    songHash: keccak256(stringToBytes("megaeth-records-gas-fixture")),
    lines,
    segments: lines.map((line) => ({
      segmentId: `seg-${line.lineId}`,
      startMs: line.startMs,
      endMs: line.endMs,
      lineIds: [line.lineId],
    })),
  };
}

async function main() {
  check((await publicClient.getChainId()) === 6343, "refusing_non_megaeth_testnet_chain");
  const file = JSON.parse(readFileSync(KEYS, "utf8")) as {
    chainId: number;
    keys: Record<"communityAdmin" | "operator", Hex>;
  };
  check(file.chainId === 6343, "keys_not_for_megaeth_testnet");
  const admin = privateKeyToAccount(file.keys.communityAdmin);
  const operator = privateKeyToAccount(file.keys.operator);
  const learner = privateKeyToAccount(generatePrivateKey());
  check((await publicClient.getBalance({ address: admin.address })) >= parseEther("0.005"), `fund_community_admin:${admin.address}`);
  check((await publicClient.getBalance({ address: operator.address })) >= parseEther("0.001"), `fund_operator:${operator.address}`);

  const artifact = compile().LearningRecords;
  const adminWallet = createWalletClient({ chain: megaeth, transport, account: admin });
  const operatorWallet = createWalletClient({ chain: megaeth, transport, account: operator });
  const transactions: { step: string; hash: Hex; gasUsed: string; block: string }[] = [];
  const confirm = async (step: string, hash: Hex) => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    check(receipt.status === "success", `transaction_reverted:${step}`);
    transactions.push({ step, hash, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() });
    return receipt;
  };
  const deployed = await confirm(
    "deploy_learning_records",
    await adminWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [admin.address] }),
  );
  const records = deployed.contractAddress!;
  const write = (step: string, functionName: string, args: readonly unknown[], wallet = operatorWallet) =>
    wallet
      .writeContract({ address: records, abi: artifact.abi, functionName, args })
      .then((hash) => confirm(step, hash));
  await write("set_grader", "setGrader", [operator.address, ACTIVITY_KARAOKE, true], adminWallet);

  const manifest = syntheticManifest();
  const leaves = manifestLeaves(manifest);
  const song = standInSong(6343, "megaeth-records-gas-fixture", manifest.songHash);
  const now = Number((await publicClient.getBlock()).timestamp);
  const open = async (label: string) => {
    const consent: Consent = {
      learner: learner.address,
      attemptId: keccak256(stringToBytes(`megaeth-records-gas:${label}:${now}`)),
      songKey: songKeyOf(song),
      contentRevision: digest(manifest),
      linesRoot: linesRootOf(manifest),
      linesTotal: LINES,
      activity: ACTIVITY_KARAOKE,
      grader: operator.address,
      scoringPolicy: scoringPolicyOf(5),
      expiresAt: now + 3600,
    };
    const signature = await learner.signTypedData({
      domain: recordsDomain(6343, records),
      types: consentTypes,
      primaryType: "Consent",
      message: consentMessage(consent),
    });
    await write(`open_attempt:${label}`, "openAttempt", [
      consentMessage(consent),
      signature,
      { ...song, chainId: 6343n },
    ]);
    return consent.attemptId;
  };
  // Alternating statuses so the records exercise scored and unscored lines.
  const input = (ordinal: number, revision = 1) => {
    const status = revision > 1 ? "unmeasured" : ordinal % 4 === 0 ? "silent" : "assessed";
    return {
      ordinal,
      lineKey: lineKeyOf(manifest.lines[ordinal - 1].lineId),
      lineVersion: 1,
      status: LINE_STATUS_CODES[status],
      scoreBps: status === "assessed" ? 7000 + ordinal * 50 : 0,
      final_: true,
      proof: merkleProof(leaves, ordinal - 1),
    };
  };
  const completion = (hasRewardScore: boolean, rewardScoreBps: number, unmeasuredCount: number) => ({
    completedAt: BigInt(now - 60),
    status: 1,
    unmeasuredCount,
    hasRewardScore,
    rewardScoreBps,
  });

  // As the publisher sends them: one transaction per line.
  const perLine = await open("per_line");
  for (let ordinal = 1; ordinal <= LINES; ordinal++)
    await write(`assess_one_line:${ordinal}`, "assessLines", [perLine, [input(ordinal)]]);
  // 30 assessed lines scoring 7000 + 50·ordinal, 10 silent: computed by the reader below.
  const expected = (() => {
    let sum = 0;
    for (let o = 1; o <= LINES; o++) if (o % 4 !== 0) sum += 7000 + o * 50;
    return Math.floor(sum / LINES);
  })();
  await write("complete_attempt", "completeAttempt", [perLine, completion(true, expected, 0)]);
  // A correction of line 5 and the completion that follows it.
  await write("correct_one_line", "assessLines", [perLine, [input(5, 2)]]);
  const corrected = (() => {
    let sum = 0;
    for (let o = 1; o <= LINES; o++) if (o % 4 !== 0 && o !== 5) sum += 7000 + o * 50;
    return Math.floor(sum / (LINES - 1));
  })();
  await write("complete_after_correction", "completeAttempt", [perLine, completion(true, corrected, 1)]);

  // For comparison: the same 40 lines in batches of 10.
  const batched = await open("batched");
  for (let first = 1; first <= LINES; first += 10)
    await write(
      `assess_ten_lines:${first}`,
      "assessLines",
      [batched, Array.from({ length: 10 }, (_, i) => input(first + i))],
    );
  await write("complete_batched", "completeAttempt", [batched, completion(true, expected, 0)]);

  // Independent reconstruction from logs and the manifest alone. The last
  // completion's log can trail its receipt briefly, so read until it appears.
  const source = {
    rpcUrl: RPC,
    records,
    fromBlock: deployed.blockNumber,
    manifest: async (revision: Hex) => (revision === digest(manifest) ? manifest : undefined),
  };
  let read = await readLearner(source, learner.address);
  for (let i = 0; i < 20 && read.find((x) => x.attemptId === batched)?.completions.length !== 1; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    read = await readLearner(source, learner.address);
  }
  const byId = new Map(read.map((a) => [a.attemptId, a]));
  const a = byId.get(perLine);
  const b = byId.get(batched);
  const seen = (x: typeof a) =>
    x && { lines: x.lines.length, completions: x.completions.length, grade: x.grade && { revision: x.grade.revision, rewardScoreBps: x.grade.rewardScoreBps, claim: x.grade.claim }, problems: x.problems };
  const verified = {
    perLineVerified: a?.verified === true && a.problems.length === 0,
    perLineGradeRevision2: a?.grade?.revision === 2,
    perLineCorrectedLine: a?.grade?.lines[4].status === "unmeasured" && a.grade.lines[4].revision === 2,
    perLineRecomputed: a?.grade?.rewardScoreBps === corrected && a.grade.unmeasuredCount === 1,
    batchedVerified: b?.verified === true && b.problems.length === 0,
    batchedRecomputed: b?.grade?.rewardScoreBps === expected,
  };
  check(
    Object.values(verified).every(Boolean),
    `verification_failed:${JSON.stringify({ verified, records, perLine: seen(a), batched: seen(b), expected, corrected })}`,
  );

  const gas = (prefix: string) =>
    transactions.filter((t) => t.step.startsWith(prefix)).map((t) => Number(t.gasUsed));
  const total = (values: number[]) => values.reduce((s, v) => s + v, 0);
  const perLineGas = gas("assess_one_line:");
  const summary = {
    deploy: total(gas("deploy_learning_records")),
    openAttempt: gas("open_attempt:per_line")[0],
    assessOneLine: { min: Math.min(...perLineGas), max: Math.max(...perLineGas), total: total(perLineGas) },
    completeFortyLines: gas("complete_attempt")[0],
    correctOneLine: gas("correct_one_line")[0],
    completeAfterCorrection: gas("complete_after_correction")[0],
    assessTenLines: gas("assess_ten_lines:"),
    publishFortyLinesPerLine: gas("open_attempt:per_line")[0] + total(perLineGas) + gas("complete_attempt")[0],
    publishFortyLinesBatched:
      gas("open_attempt:batched")[0] + total(gas("assess_ten_lines:")) + gas("complete_batched")[0],
  };
  const evidence = {
    kind: "megaeth-learning-records-testnet",
    recordedAt: new Date().toISOString(),
    chainId: 6343,
    rpc: RPC,
    contract: records,
    runtimeCodeHash: keccak256((await publicClient.getCode({ address: records }))!),
    controller: admin.address,
    grader: operator.address,
    learner: learner.address,
    learnerKey: "ephemeral, generated in memory, never stored",
    manifest: { lines: LINES, contentRevision: digest(manifest), linesRoot: linesRootOf(manifest), synthetic: true },
    attempts: { perLine, batched },
    gas: summary,
    effectiveGasPriceWei: (await publicClient.getGasPrice()).toString(),
    transactions,
    verified,
    remainingAdminEth: formatEther(await publicClient.getBalance({ address: admin.address })),
    remainingOperatorEth: formatEther(await publicClient.getBalance({ address: operator.address })),
  };
  mkdirSync("docs/evidence", { recursive: true });
  const path = `docs/evidence/megaeth-learning-records-${evidence.recordedAt.slice(0, 10)}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: path, contract: records, gas: summary, verified }));
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
