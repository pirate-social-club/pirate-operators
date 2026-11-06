// Manual rehearsal, on a local anvil fork of MegaETH testnet, of opening a
// LearningRecords attempt for a MOSS learner whose account has no code yet.
// Never runs in CI and never sends to the real chain. Input: a captured
// probe result (consent plus its ERC-8010 signature), kept outside the
// repository. The operator first sends one EIP-7702 transaction that carries
// the learner's own signed authorization and MOSS's initialization call,
// which installs the account; it then opens the attempt with the inner
// passkey signature, which the contract checks through ERC-1271.
import { spawn } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseErc8010Signature,
  size,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../../packages/protocol/index.ts";
import { consentMessage, recordsAbi } from "../../packages/protocol/records.ts";
import { OPERATOR, RECORDS, RPC, consentFromJson, song } from "./consent-probe.ts";

const PORT = Number(process.env.FORK_PORT ?? 18890);
const KEYS = process.env.MEGAETH_KEYS ?? join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json");
const RESULT =
  process.argv[2] ?? join(homedir(), ".local/state/pirate-operators-moss-consent/probe-result-2026-11-04.json");

async function main() {
  const probe = JSON.parse(readFileSync(RESULT, "utf8")) as { consent: Record<string, unknown>; signature: Hex };
  const consent = consentFromJson(probe.consent);
  const wrapped = parseErc8010Signature(probe.signature);
  check("authorization" in wrapped && wrapped.authorization && wrapped.address && wrapped.data, "not_erc8010");
  const keys = JSON.parse(readFileSync(KEYS, "utf8")).keys as { operator: Hex };
  const operator = privateKeyToAccount(keys.operator);
  check(operator.address === OPERATOR, "operator_key_mismatch");

  const anvil = spawn(
    "anvil",
    // Osaka includes the P-256 precompile at 0x100 (EIP-7951), which MegaETH
    // has and MOSS passkey signatures need; a Prague fork lacks it.
    ["--fork-url", RPC, "--host", "127.0.0.1", "--port", String(PORT), "--silent", "--hardfork", "osaka"],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  anvil.stderr.on("data", (d) => (stderr += d));
  const fork = defineChain({
    id: 6343,
    name: "MegaETH testnet fork",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [`http://127.0.0.1:${PORT}`] } },
  });
  const transport = http(`http://127.0.0.1:${PORT}`, { timeout: 60_000 });
  const chain = createPublicClient({ chain: fork, transport });
  const wallet = createWalletClient({ chain: fork, transport, account: operator });
  try {
    for (let i = 0; ; i++) {
      if (anvil.exitCode !== null) throw new Error(`anvil_exited:${stderr.slice(0, 400)}`);
      try {
        check((await chain.getChainId()) === 6343, "fork_chain_mismatch");
        break;
      } catch (error) {
        if (i > 240) throw error;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const forkBlock = await chain.getBlockNumber();
    // The fork must verify P-256 the way MegaETH does, or passkey checks fail for the wrong reason.
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const probeHash = createHash("sha256").update("p256 precompile probe").digest();
    const probeSig = createSign("SHA256").update("p256 precompile probe").sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const coord = (v: string) => Buffer.from(v, "base64url").toString("hex").padStart(64, "0");
    const precompile = await chain.call({
      to: "0x0000000000000000000000000000000000000100",
      data: `0x${probeHash.toString("hex")}${probeSig.toString("hex")}${coord(jwk.x)}${coord(jwk.y)}`,
    });
    check(BigInt(precompile.data ?? "0x0") === 1n, "fork_lacks_p256_precompile");
    const codeBefore = (await chain.getCode({ address: consent.learner })) ?? "0x";
    const open = (signature: Hex) =>
      encodeFunctionData({
        abi: recordsAbi,
        functionName: "openAttempt",
        args: [consentMessage(consent), signature, { ...song, chainId: 6343n }],
      });
    const tryOpen = async (signature: Hex) =>
      chain
        .call({ account: operator.address, to: RECORDS, data: open(signature) })
        .then(() => "would_succeed")
        .catch((e: Error) => `reverts: ${/reason:\s*(\S+)/.exec(e.message)?.[1] ?? e.message.split("\n")[0]}`);
    const beforeActivation = await tryOpen(wrapped.signature);

    // The activation: the learner's signed authorization plus MOSS's init call.
    const activationHash = await wallet.sendTransaction({
      to: wrapped.address,
      data: wrapped.data,
      authorizationList: [wrapped.authorization],
      gas: 3_000_000n,
    });
    const activation = await chain.waitForTransactionReceipt({ hash: activationHash });
    const codeAfter = (await chain.getCode({ address: consent.learner })) ?? "0x";

    const withInner = await tryOpen(wrapped.signature);
    const withWrapped = await tryOpen(probe.signature);
    let opened: { status: string; gasUsed: string; attemptLearner: string } | null = null;
    if (withInner === "would_succeed") {
      const hash = await wallet.sendTransaction({ to: RECORDS, data: open(wrapped.signature), gas: 2_000_000n });
      const receipt = await chain.waitForTransactionReceipt({ hash });
      const stored = (await chain.readContract({
        address: RECORDS,
        abi: [
          {
            type: "function",
            name: "attempt",
            stateMutability: "view",
            inputs: [{ type: "bytes32" }],
            outputs: [{ type: "tuple", components: [{ name: "learner", type: "address" }, { name: "grader", type: "address" }] }],
          },
        ],
        functionName: "attempt",
        args: [consent.attemptId],
      })) as { learner: Address };
      opened = { status: receipt.status, gasUsed: receipt.gasUsed.toString(), attemptLearner: stored.learner };
    }
    const evidence = {
      kind: "moss-activation-rehearsal",
      recordedAt: new Date().toISOString(),
      network: "local anvil fork of MegaETH testnet; nothing sent to the real chain",
      forkBlock: forkBlock.toString(),
      records: RECORDS,
      learner: consent.learner,
      attemptId: consent.attemptId,
      erc8010: {
        delegate: wrapped.authorization.address,
        authorizationChainId: wrapped.authorization.chainId,
        authorizationNonce: wrapped.authorization.nonce,
        initializer: wrapped.address,
        initDataBytes: size(wrapped.data),
        innerSignatureBytes: size(wrapped.signature),
      },
      codeBefore,
      openBeforeActivation: beforeActivation,
      activation: { status: activation.status, gasUsed: activation.gasUsed.toString() },
      codeAfter,
      delegatedToMossProxy: codeAfter.toLowerCase() === `0xef0100${wrapped.authorization.address.slice(2).toLowerCase()}`,
      openAfterActivationWithInnerSignature: withInner,
      openAfterActivationWithWrappedSignature: withWrapped,
      opened,
    };
    mkdirSync("docs/evidence", { recursive: true });
    const path = `docs/evidence/moss-activation-rehearsal-${evidence.recordedAt.slice(0, 10)}.json`;
    writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: path, ...evidence }));
  } finally {
    anvil.kill();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
