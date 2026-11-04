// Same activation stages and disk journal as the manual command; only local
// Anvil and disposable fixture keys are used. No captured signature is read.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  encodeFunctionData,
  hashTypedData,
  keccak256,
  parseAbi,
  serializeErc8010Signature,
  stringToBytes,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { accounts, keys } from "../harness/runtime.ts";
import { chain } from "../harness/chain.ts";
import {
  ACTIVITY_KARAOKE,
  consentMessage,
  consentTypes,
  recordsDomain,
  scoringPolicyOf,
  songKeyOf,
  standInSong,
  type Consent,
} from "../packages/protocol/records.ts";
import { ActivationJournal } from "../harness/megaeth/activation-journal.ts";
import {
  runActivation,
  transactionSummary,
  type ActivationRun,
} from "../harness/megaeth/activation-run.ts";
import { dispatch, enqueue } from "../services/operator-tx.ts";
import type { Env } from "../services/runtime.ts";

let evm: Awaited<ReturnType<typeof chain>>;
before(async () => {
  evm = await chain(18846);
});
after(async () => {
  evm.child.kill();
  if (evm.child.exitCode === null) await once(evm.child, "exit");
});
const initializerAbi = parseAbi([
  "function activate(address account,address key)",
]);
const key = (s: string) => keccak256(stringToBytes(s));
async function fixture() {
  const learner = privateKeyToAccount(generatePrivateKey()),
    passkey = privateKeyToAccount(generatePrivateKey());
  const song = standInSong(31337, "activation-run", key("song"));
  const consent: Consent = {
    learner: learner.address,
    attemptId: key(learner.address),
    songKey: songKeyOf(song),
    contentRevision: key("manifest"),
    linesRoot: key("lines"),
    linesTotal: 1,
    activity: ACTIVITY_KARAOKE,
    grader: accounts[2].address,
    scoringPolicy: scoringPolicyOf(5),
    expiresAt: Number((await evm.publicClient.getBlock()).timestamp) + 86400,
  };
  const authorization = await learner.signAuthorization({
    contractAddress: evm.mockAccount,
    chainId: 0,
    nonce: 0,
  });
  const signature = serializeErc8010Signature({
    authorization,
    address: evm.mockInitializer,
    data: encodeFunctionData({
      abi: initializerAbi,
      functionName: "activate",
      args: [learner.address, passkey.address],
    }),
    signature: await passkey.sign({
      hash: hashTypedData({
        domain: recordsDomain(31337, evm.recordsContract),
        types: consentTypes,
        primaryType: "Consent",
        message: consentMessage(consent),
      }),
    }),
  });
  const directory = mkdtempSync(join(tmpdir(), "activation-journal-test-")),
    path = join(directory, "state.sqlite");
  const config: ActivationRun = {
    env: {
      RPC_URL: evm.rpcUrl,
      PAYMENT_CHAIN_ID: "31337",
      PRIVATE_KEY: keys[2],
      ACCOUNT_DELEGATE: evm.mockAccount,
      ACCOUNT_INITIALIZER: evm.mockInitializer,
    } as Env,
    consent,
    signature,
    song,
    records: evm.recordsContract,
    operator: accounts[2].address,
    chainId: 31337,
    limits: {
      maxFeePerGas: 2_000_000_000n,
      maxTotalFee: 2_000_000_000_000_000n,
    },
  };
  return { config, directory, path, learner };
}
async function proxy(
  handler: (input: any, value: any) => any,
  beforeForward?: (input: any) => Promise<void>,
) {
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    await beforeForward?.(input);
    const response = await fetch(evm.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const value = handler(input, await response.json());
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(value));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("the private journal rolls back and permits only one runner, including after process exit", async () => {
  const f = await fixture();
  let j = new ActivationJournal(f.path);
  try {
    assert.throws(() =>
      j.transaction(() => {
        j.set("partial", true);
        throw new Error("interrupted");
      }),
    );
    assert.equal(j.get("partial"), undefined);
    assert.throws(() => new ActivationJournal(f.path), /already_running/);
    j.set("saved", 42);
    j.close();
    j = new ActivationJournal(f.path);
    assert.equal(j.get("saved"), 42);
    j.close();
    const moduleURL = new URL(
      "../harness/megaeth/activation-journal.ts",
      import.meta.url,
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {ActivationJournal} from ${JSON.stringify(moduleURL)}; const journal=new ActivationJournal(${JSON.stringify(f.path)}); journal.set('crash_saved',73); process.stdout.write('ready'); setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout, "data");
      child.kill("SIGKILL");
      await once(child, "exit");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
    j = new ActivationJournal(f.path);
    assert.equal(j.get("crash_saved"), 73);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
  } finally {
    j.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("lost activation receipts resume from disk without a second activation or opening", async () => {
  const f = await fixture();
  let hide = true;
  const p = await proxy((input, value) =>
    input.method === "eth_getTransactionReceipt" && hide
      ? { ...value, result: null }
      : value,
  );
  f.config.env.RPC_URL = p.url;
  let j = new ActivationJournal(f.path);
  try {
    assert.equal((await runActivation(f.config, j, false)).status, "prepared");
    assert.deepEqual(transactionSummary(j), []);
    assert.equal((await runActivation(f.config, j, true)).status, "pending");
    const [saved] = transactionSummary(j);
    assert.equal(saved.step, "record_activate");
    assert.ok(saved.hash);
    assert.ok(
      (
        await evm.publicClient.getCode({ address: f.learner.address })
      )?.startsWith("0xef0100"),
    );
    j.close();
    hide = false;
    j = new ActivationJournal(f.path);
    const result = await runActivation(f.config, j, true);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.transactions.map((t) => [t.step, t.status]),
      [
        ["record_activate", "success"],
        ["record_open", "success"],
      ],
    );
    assert.equal(result.transactions[0].hash, saved.hash);
    const nonce = await evm.publicClient.getTransactionCount({
      address: accounts[2].address,
    });
    j.close();
    j = new ActivationJournal(f.path);
    assert.equal((await runActivation(f.config, j, true)).status, "complete");
    assert.equal(
      await evm.publicClient.getTransactionCount({
        address: accounts[2].address,
      }),
      nonce,
    );
    assert.ok(
      result.transactions.reduce(
        (sum, t) => sum + BigInt(t.maximumFeeWei),
        0n,
      ) <= f.config.limits.maxTotalFee,
    );
    enqueue(
      j,
      "record_line",
      "overspend",
      evm.recordsContract,
      "0x",
      3_000_000n,
    );
    await assert.rejects(
      dispatch(f.config.env, j, "record_line", "overspend", f.config.limits),
      /total_fee_limit/,
    );
    assert.equal(
      await evm.publicClient.getTransactionCount({
        address: accounts[2].address,
      }),
      nonce,
    );
  } finally {
    j.close();
    await p.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("a restart after reverted activation repairs the delegated account before opening", async () => {
  const f = await fixture();
  let failAfterActivation = true,
    failSetup = true;
  const p = await proxy(
    (input, value) => {
      if (
        failAfterActivation &&
        input.method === "eth_getCode" &&
        input.params[0].toLowerCase() === f.learner.address.toLowerCase() &&
        value.result?.startsWith("0xef0100")
      ) {
        failAfterActivation = false;
        return {
          jsonrpc: "2.0",
          id: input.id,
          error: { code: -32000, message: "interrupted after activation" },
        };
      }
      return value;
    },
    async (input) => {
      if (
        failSetup &&
        input.method === "eth_sendRawTransaction" &&
        input.params[0].startsWith("0x04")
      ) {
        failSetup = false;
        await evm.write(evm.mockInitializer, "MockInitializer", "setFailing", [
          true,
        ]);
      }
    },
  );
  f.config.env.RPC_URL = p.url;
  let j = new ActivationJournal(f.path);
  try {
    await assert.rejects(
      runActivation(f.config, j, true),
      /interrupted after activation/,
    );
    assert.deepEqual(
      transactionSummary(j).map((t) => [t.step, t.status]),
      [["record_activate", "reverted"]],
    );
    j.close();
    await evm.write(evm.mockInitializer, "MockInitializer", "setFailing", [
      false,
    ]);
    j = new ActivationJournal(f.path);
    const result = await runActivation(f.config, j, true);
    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.transactions.map((t) => [t.step, t.status]),
      [
        ["record_activate", "reverted"],
        ["record_initialize", "success"],
        ["record_open", "success"],
      ],
    );
  } finally {
    await evm.write(evm.mockInitializer, "MockInitializer", "setFailing", [
      false,
    ]);
    j.close();
    await p.close();
    rmSync(f.directory, { recursive: true });
  }
});

test("fee limits stop signing and broadcasting and cannot be raised silently on resume", async () => {
  const f = await fixture(),
    j = new ActivationJournal(f.path);
  f.config.limits = { maxFeePerGas: 1n, maxTotalFee: 1_000_000n };
  try {
    const nonce = await evm.publicClient.getTransactionCount({
      address: accounts[2].address,
    });
    await assert.rejects(
      runActivation(f.config, j, true),
      /gas_price_above_limit/,
    );
    assert.deepEqual(transactionSummary(j), []);
    assert.equal(
      await evm.publicClient.getTransactionCount({
        address: accounts[2].address,
      }),
      nonce,
    );
    assert.equal(
      await evm.publicClient.getCode({ address: f.learner.address }),
      undefined,
    );
    f.config.limits = {
      maxFeePerGas: 2_000_000_000n,
      maxTotalFee: 2_000_000_000_000_000n,
    };
    await assert.rejects(
      runActivation(f.config, j, true),
      /journal_profile_mismatch/,
    );
  } finally {
    j.close();
    rmSync(f.directory, { recursive: true });
  }
});
