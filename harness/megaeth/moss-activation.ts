// Bounded live activation of one MOSS learner account on MegaETH testnet,
// then the opening of the attempt its captured consent authorizes
// (docs/learning-records-contract.md section 9). Never runs in CI. Without
// --send it only checks, read-only, against the real chain. With --send it
// submits at most three operator transactions: the activation, a repeated
// setup only if the account was delegated but not set up, and openAttempt.
// It uses the same checks as the operator's publisher (services/accounts.ts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, hashTypedData, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../../packages/protocol/index.ts";
import { consentMessage, consentTypes, recordsAbi, recordsDomain } from "../../packages/protocol/records.ts";
import { acceptedByAccount, activationOf, checkActivation, codeOf, designatorOf, nonceOf } from "../../services/accounts.ts";
import type { Env } from "../../services/runtime.ts";
import { OPERATOR, RECORDS, RPC, consentFromJson, song } from "../moss-consent/consent-probe.ts";

const SEND = process.argv.includes("--send");
const KEYS = process.env.MEGAETH_KEYS ?? join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const RESULT = join(homedir(), ".local/state/pirate-operators-moss-consent/probe-result-2026-11-04.json");
const DELEGATE = "0xf655611abe392f35cbb36181d920a302c4df2284";
const INITIALIZER = "0xdb03009c44a36a7490d80c9a9e1a03b53497dc42";

const megaeth = defineChain({
  id: 6343,
  name: "MegaETH testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
const transport = http(RPC, { timeout: 30_000 });
const chain = createPublicClient({ chain: megaeth, transport });
const env = { RPC_URL: RPC, ACCOUNT_DELEGATE: DELEGATE, ACCOUNT_INITIALIZER: INITIALIZER } as Env;
const log = (step: string, detail: unknown = {}) => console.log(JSON.stringify({ step, ...(detail as object) }));

async function main() {
  check((await chain.getChainId()) === 6343, "refusing_non_megaeth_testnet_chain");
  const probe = JSON.parse(readFileSync(RESULT, "utf8")) as { consent: Record<string, unknown>; signature: Hex };
  const consent = consentFromJson(probe.consent);
  const activation = activationOf(probe.signature);
  check(activation, "not_an_activation");
  const operator = privateKeyToAccount((JSON.parse(readFileSync(KEYS, "utf8")).keys as { operator: Hex }).operator);
  check(operator.address === OPERATOR, "operator_key_mismatch");
  const learner = consent.learner;
  const typed = { domain: recordsDomain(6343, RECORDS), types: consentTypes, primaryType: "Consent" as const, message: consentMessage(consent) };
  const digest = hashTypedData(typed);
  const openData = encodeFunctionData({
    abi: recordsAbi,
    functionName: "openAttempt",
    args: [consentMessage(consent), activation.inner, { ...song, chainId: 6343n }],
  });

  // The publisher's checks, read-only.
  await checkActivation(env, learner, activation, 6343);
  const now = Number((await chain.getBlock()).timestamp);
  const before = {
    learner,
    code: await codeOf(env, learner),
    nonce: await nonceOf(env, learner),
    authorizationNonce: activation.authorization.nonce,
    authorizationChainId: activation.authorization.chainId,
    consentExpiresAt: consent.expiresAt,
    consentVerifiedOverRpc: await chain.verifyTypedData({ ...typed, address: learner, signature: probe.signature }),
    activationSimulates: await chain
      .call({ account: operator.address, to: activation.initializer, data: activation.data, authorizationList: [activation.authorization] })
      .then(() => true)
      .catch((e: Error) => e.message.split("\n")[0]),
  };
  log("checked", before);
  check(before.code === "0x" && before.nonce === before.authorizationNonce, "account_not_in_expected_state");
  check(consent.expiresAt > now + 600 && before.consentVerifiedOverRpc && before.activationSimulates === true, "precheck_failed");
  if (!SEND) return log("dry_run", { wouldSend: ["record_activate", "record_open"] });

  const wallet = createWalletClient({ chain: megaeth, transport, account: operator });
  const sent: { step: string; hash: Hex; status: string; gasUsed: string; block: string }[] = [];
  const confirm = async (step: string, hash: Hex) => {
    const receipt = await chain.waitForTransactionReceipt({ hash, timeout: 60_000 });
    sent.push({ step, hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), block: receipt.blockNumber.toString() });
    log(step, sent.at(-1));
    return receipt;
  };
  await confirm(
    "activate",
    await wallet.sendTransaction({
      to: activation.initializer,
      data: activation.data,
      authorizationList: [activation.authorization],
      gas: 1_500_000n,
    }),
  );
  check((await codeOf(env, learner)) === designatorOf(activation.authorization.address), "activation_not_applied");
  // Code alone is not enough: the account must accept the consent itself.
  if (!(await acceptedByAccount(env, learner, digest, activation.inner))) {
    await confirm("initialize_again", await wallet.sendTransaction({ to: activation.initializer, data: activation.data, gas: 1_500_000n }));
    check(await acceptedByAccount(env, learner, digest, activation.inner), "account_not_initialized");
  }
  const opened = await confirm("open_attempt", await wallet.sendTransaction({ to: RECORDS, data: openData, gas: 1_000_000n }));
  check(opened.status === "success", "open_reverted");
  const stored = (await chain.readContract({
    address: RECORDS,
    abi: [{ type: "function", name: "attempt", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [{ name: "learner", type: "address" }] }] }],
    functionName: "attempt",
    args: [consent.attemptId],
  })) as { learner: string };
  const evidence = {
    kind: "megaeth-moss-activation",
    recordedAt: new Date().toISOString(),
    chainId: 6343,
    records: RECORDS,
    attemptId: consent.attemptId,
    before,
    transactions: sent,
    after: {
      code: await codeOf(env, learner),
      acceptsConsent: await acceptedByAccount(env, learner, digest, activation.inner),
      attemptLearner: stored.learner,
    },
    note: "The authorization has chain ID 0; it was sent only to MegaETH testnet. Full signatures stay private.",
  };
  mkdirSync("docs/evidence", { recursive: true });
  const path = `docs/evidence/megaeth-moss-activation-${evidence.recordedAt.slice(0, 10)}.json`;
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
  log("evidence", { path, after: evidence.after });
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
