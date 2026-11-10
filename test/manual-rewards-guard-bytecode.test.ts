import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  createPublicClient,
  decodeEventLog,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  parseAbi,
  keccak256,
  type Hex,
} from "viem";
import { compile } from "../harness/compile.ts";
import {
  guardedRewardCall,
  REWARD_EXECUTE_MODE,
} from "../packages/rewards/guard-call.ts";
import {
  paymentGuardNonce,
  mossGuardAbi,
  MOSS_GUARD_PROXY_HASH,
  MOSS_GUARD_IMPLEMENTATION_HASH,
} from "../packages/rewards/moss-guard.ts";

const abi = parseAbi([
  "function getNonce(uint192) view returns(uint256)",
  "function invalidateNonce(uint256)",
  "function execute(bytes32,bytes)",
  "function supportsExecutionMode(bytes32) view returns(bool)",
  "function mint(address,uint256)",
  "function transfer(address,uint256) returns(bool)",
  "function balanceOf(address) view returns(uint256)",
  "function blockRecipient(address,bool)",
]);
const sender = "0x1000000000000000000000000000000000000001",
  deployer = "0x1000000000000000000000000000000000000002",
  recipient = "0x1000000000000000000000000000000000000003",
  program = `0x${"ab".repeat(32)}`;
const nonce = (id: string) => paymentGuardNonce(program, sender, id);

test("guard calldata agrees with independent ABI encoding, with a separate stable payment nonce namespace", () => {
  const token = "0x1000000000000000000000000000000000000004",
    guardNonce = nonce("payment_001");
  const payment = {
    sender,
    recipient,
    token,
    amountAtomic: "180000",
    guardNonce,
  };
  const guard = encodeFunctionData({
    abi,
    functionName: "invalidateNonce",
    args: [BigInt(guardNonce)],
  });
  const transfer = encodeFunctionData({
    abi,
    functionName: "transfer",
    args: [recipient, 180000n],
  });
  for (const action of ["pay", "cancel"] as const) {
    const calls: (readonly [Hex, bigint, Hex])[] = [[sender, 0n, guard]];
    if (action === "pay") calls.push([token, 0n, transfer]);
    const expected = encodeFunctionData({
      abi,
      functionName: "execute",
      args: [
        REWARD_EXECUTE_MODE,
        encodeAbiParameters(parseAbiParameters("(address,uint256,bytes)[]"), [
          calls,
        ]),
      ],
    });
    assert.deepEqual(guardedRewardCall(payment, action), {
      address: sender,
      data: expected,
    });
  }
  assert.equal(BigInt(guardNonce) >> 240n, 0x5052n);
  assert.equal(BigInt(guardNonce) % (1n << 64n), 0n);
  assert.equal(nonce("payment_001"), guardNonce);
  assert.notEqual(nonce("payment_002"), guardNonce);
  assert.notEqual(
    paymentGuardNonce(`0x${"cd".repeat(32)}`, sender, "payment_001"),
    guardNonce,
  );
  for (const bad of [
    "0",
    "1",
    (BigInt(guardNonce) + 1n).toString(),
    (1n << 256n).toString(),
  ])
    assert.throws(() =>
      guardedRewardCall({ ...payment, guardNonce: bad }, "pay"),
    );
});

test(
  "captured deployed MOSS account bytecode: retries pay once, nonce cancellation wins safely, token reverts roll the guard back",
  { timeout: 60000 },
  async () => {
    const fixture = JSON.parse(
      await readFile(
        new URL("./fixtures/moss-6343-guard/runtime.json", import.meta.url),
        "utf8",
      ),
    );
    assert.equal(keccak256(fixture.proxyCode), MOSS_GUARD_PROXY_HASH);
    assert.equal(
      keccak256(fixture.implementationCode),
      MOSS_GUARD_IMPLEMENTATION_HASH,
    );
    // Entirely offline. No fork URL, credential, funded key, or external transport is accepted.
    const url = "http://127.0.0.1:19867";
    const child = spawn(
      "anvil",
      [
        "--host",
        "127.0.0.1",
        "--port",
        "19867",
        "--chain-id",
        "31337",
        "--hardfork",
        "osaka",
        "--silent",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (v) => (stderr += String(v)));
    const client = createPublicClient({
      transport: http(url, { retryCount: 0, timeout: 1000 }),
    });
    async function rpc(method: string, params: unknown[]) {
      const result = (await (
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        })
      ).json()) as { result?: unknown; error?: unknown };
      if (result.error) throw Error(JSON.stringify(result.error));
      return result.result;
    }
    async function send(from: Hex, to: Hex | undefined, data: Hex) {
      const hash = (await rpc("eth_sendTransaction", [
        { from, to, data, gas: "0x989680" },
      ])) as Hex;
      return client.waitForTransactionReceipt({ hash });
    }
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw Error(stderr);
        try {
          assert.equal(await client.getChainId(), 31337);
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      assert.ok(ready, "local anvil unavailable");
      for (const [address, code] of [
        [fixture.proxy, fixture.proxyCode],
        [fixture.implementation, fixture.implementationCode],
        [sender, `0xef0100${fixture.proxy.slice(2)}`],
      ])
        await rpc("anvil_setCode", [address, code]);
      for (const address of [sender, deployer]) {
        await rpc("anvil_impersonateAccount", [address]);
        await rpc("anvil_setBalance", [address, "0x56bc75e2d63100000"]);
      }
      const artifact = compile().TestPaymentToken;
      const deployed = await send(deployer, undefined, artifact.bytecode),
        token = deployed.contractAddress!;
      assert.equal(deployed.status, "success");
      const data = (
        functionName: "mint" | "blockRecipient",
        args: readonly [Hex, bigint] | readonly [Hex, boolean],
      ) => encodeFunctionData({ abi, functionName, args: args as never });
      assert.equal(
        (await send(deployer, token, data("mint", [sender, 10000000n]))).status,
        "success",
      );
      assert.equal(
        await client.readContract({
          address: sender,
          abi,
          functionName: "supportsExecutionMode",
          args: [REWARD_EXECUTE_MODE],
        }),
        true,
      );
      const make = (id: string) => ({
        sender,
        recipient,
        token,
        amountAtomic: "180000",
        guardNonce: nonce(id),
      });
      const run = (id: string, action: "pay" | "cancel") => {
        const call = guardedRewardCall(make(id), action);
        return send(sender, call.address, call.data);
      };
      const balance = () =>
        client.readContract({
          address: token,
          abi,
          functionName: "balanceOf",
          args: [recipient],
        });
      const sequence = (id: string) =>
        client.readContract({
          address: sender,
          abi,
          functionName: "getNonce",
          args: [BigInt(nonce(id)) >> 64n],
        });
      const paidReceipt = await run("payment_001", "pay");
      assert.equal(paidReceipt.status, "success");
      const guardLog = paidReceipt.logs.find(
        (log) => log.address.toLowerCase() === sender,
      )!;
      assert.equal(
        decodeEventLog({
          abi: mossGuardAbi,
          eventName: "NonceInvalidated",
          data: guardLog.data,
          topics: guardLog.topics,
        }).args.nonce,
        BigInt(nonce("payment_001")),
      );
      assert.ok(
        guardLog.logIndex! <
          paidReceipt.logs.find(
            (log) => log.address.toLowerCase() === token.toLowerCase(),
          )!.logIndex!,
      );
      assert.equal((await run("payment_001", "pay")).status, "reverted");
      assert.equal((await run("payment_001", "cancel")).status, "reverted");
      assert.equal(await balance(), 180000n);
      assert.equal(
        await sequence("payment_001"),
        BigInt(nonce("payment_001")) + 1n,
      );
      assert.equal((await run("payment_002", "cancel")).status, "success");
      assert.equal((await run("payment_002", "pay")).status, "reverted");
      assert.equal(await balance(), 180000n);
      await send(deployer, token, data("blockRecipient", [recipient, true]));
      assert.equal((await run("payment_003", "pay")).status, "reverted");
      assert.equal(await sequence("payment_003"), BigInt(nonce("payment_003")));
      await send(deployer, token, data("blockRecipient", [recipient, false]));
      assert.equal((await run("payment_003", "pay")).status, "success");
      assert.equal(await balance(), 360000n);
      assert.equal(
        (
          await send(
            deployer,
            sender,
            encodeFunctionData({
              abi,
              functionName: "invalidateNonce",
              args: [BigInt(nonce("payment_004"))],
            }),
          )
        ).status,
        "reverted",
      );
      assert.equal(await sequence("payment_004"), BigInt(nonce("payment_004")));
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
    }
  },
);
