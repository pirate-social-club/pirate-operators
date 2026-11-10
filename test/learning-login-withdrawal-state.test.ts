import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { encodeFunctionData, type Address } from "viem";
import { authorizationState } from "../services/learning-authorization.ts";
import { resultsV4Abi } from "../packages/protocol/learning-results-v4.ts";
import { revocationKey } from "../services/learning-contract.ts";
import type { ResultStore } from "../services/learning-transactions.ts";
import type { Env } from "../services/runtime.ts";

test("a revocation confirming during pinned reads cannot make its older snapshot ready for turn-on", async () => {
  const learner = "0x00000000000000000000000000000000000000a1" as Address;
  const contract = "0x00000000000000000000000000000000000000c4" as Address;
  const grantId = `0x${"11".repeat(32)}`;
  const key = revocationKey({ chainId: 31337, version: 4, contract }, learner, 0n);
  const rows = new Map<string, unknown>([[key, { pending: true, nonce: "0", grantId }]]);
  const store = {
    get: <T>(key: string) => rows.get(key) as T | undefined,
    entries: (prefix: string) => [...rows].filter(([key]) => key.startsWith(prefix)).map(([key,value]) => ({key,value})),
  } as unknown as ResultStore;
  let head = 10;
  const selector = (functionName: "authorizedSince" | "revokedAt" | "nextNonce") =>
    encodeFunctionData({ abi: resultsV4Abi, functionName, args: [learner] });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const input = JSON.parse(body);
    let result: string;
    if (input.method === "eth_blockNumber") result = `0x${head.toString(16)}`;
    else {
      assert.equal(input.method, "eth_call");
      const [call, block] = input.params;
      const later = block === "0xb";
      const value = call.data === selector("nextNonce") ? (later ? 1n : 0n)
        : call.data === selector("revokedAt") ? (later ? 1700000001n : 0n)
        : (later ? 0n : 1699999990n);
      result = `0x${value.toString(16).padStart(64, "0")}`;
      // The operator records confirmation in block 11 while the reads are
      // still observing block 10. pending=false alone is insufficient.
      rows.set(key, { pending: false, nonce: "0", grantId });
      rows.set(`intent:record_revoke:${grantId}`, { nonce: 1 });
      rows.set("tx:0000000001", { mined: { status: "success", block: 11 } });
      head = 11;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as { port: number };
    const env = { RPC_URL: `http://127.0.0.1:${port}`, PAYMENT_CHAIN_ID: "31337", RESULTS_V4_CONTRACT: contract } as Env;
    assert.deepEqual(await authorizationState(env, learner, store), {
      since: 1699999990, revokedAt: 0, revocationNonce: "0", pendingWithdrawal: true,
    });
    assert.deepEqual(await authorizationState(env, learner, store), {
      since: 0, revokedAt: 1700000001, revocationNonce: "1",
    });
  } finally {
    await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
