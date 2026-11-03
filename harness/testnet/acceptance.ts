import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { formatEther, parseAbi } from "viem";
import {
  testnetKeys,
  publicNetworks,
  PATH_USD,
  safeError,
  networks,
} from "./config.ts";
import { PrivateStore } from "./store.ts";
import { paymentSession } from "./mpp.ts";
import { baseChain } from "./base.ts";
import { runFlow } from "../flow.ts";
import { verifyEvidence } from "./verify.ts";
import { workers } from "../runtime.ts";
import { check } from "../../packages/protocol/index.ts";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
export async function prepare() {
  const keys = testnetKeys(true);
  const accounts = keys.map((key) => privateKeyToAccount(key));
  const { base, tempo } = await publicNetworks();
  const result = {
    base: {
      chainId: 84532,
      sponsor: accounts[0].address,
      testEth: formatEther(
        await base.getBalance({ address: accounts[0].address }),
      ),
    },
    tempo: {
      chainId: 42431,
      payer: accounts[3].address,
      operator: accounts[2].address,
    },
  };
  check(
    (await tempo.readContract({
      address: PATH_USD,
      abi: erc20,
      functionName: "decimals",
    })) === 6,
    "unexpected_pathusd_decimals",
  );
  for (const i of [2, 3]) {
    const balance = await tempo.readContract({
      address: PATH_USD,
      abi: erc20,
      functionName: "balanceOf",
      args: [accounts[i].address],
    });
    if (balance < 1000000n) {
      const r = await fetch(networks.tempo.rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tempo_fundAddress",
          params: [accounts[i].address],
        }),
      });
      const value = (await r.json()) as { error?: unknown };
      check(!value.error, "moderato_faucet_failed");
    }
  }
  console.log(JSON.stringify({ kind: "preflight", ...result }));
}
export async function run(mode: "tempo" | "base" | "e2e") {
  const keys = testnetKeys();
  const accounts = keys.map((key) => privateKeyToAccount(key));
  const runLease = new PrivateStore("testnet-run");
  const events: unknown[] = [];
  const record = (event: unknown) => {
    events.push(event);
    console.log(
      JSON.stringify(event, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    );
  };
  let payment: Awaited<ReturnType<typeof paymentSession>> | undefined;
  let runtime: Awaited<ReturnType<typeof workers>> | undefined;
  const receiptFile = `.local/testnet/${Date.now()}-${mode}.json`;
  try {
    record({
      kind: "configuration",
      mode,
      networks: {
        payments: mode === "base" ? "simulated" : 42431,
        rewards: mode === "tempo" ? "not_exercised" : 84532,
      },
      simulated: ["identification", "Very", "Jackpot", "test-USDC"],
      bridge: "not_exercised",
      claims: "sponsored_wallet_authorization",
      actors: Object.fromEntries(
        [
          ["sponsor", 0],
          ["verifier", 1],
          ["operator", 2],
          ["payer", 3],
          ["attester", 4],
          ["executor", 8],
        ].map(([role, i]) => [role, accounts[Number(i)].address]),
      ),
    });
    if (mode !== "base") payment = await paymentSession(keys, record);
    if (mode === "tempo") {
      await payment!.charge("first", 2);
      await payment!.charge("first", 2);
      await payment!.charge("second", 2);
      check(payment!.audit().count === 2, "duplicate_payment_job");
    } else {
      const evm = await baseChain(keys, record);
      const now = await evm.timestamp();
      const cutoff = now + 120;
      runtime = await workers(undefined, {
        keys,
        chainId: 84532,
        now,
        cutoff,
        ...(payment
          ? {
              paymentProvider: async (request: Request) => {
                try {
                  check(
                    new URL(request.url).pathname === "/charge",
                    "unsupported_payment_route",
                  );
                  const input = (await request.json()) as {
                    jobId: string;
                    units: number;
                  };
                  return Response.json(
                    await payment!.charge(input.jobId, input.units),
                  );
                } catch (error) {
                  return Response.json(
                    { error: safeError(error).message },
                    { status: 503 },
                  );
                }
              },
            }
          : {}),
      });
      await runFlow({
        runtime,
        evm,
        accounts,
        cutoff,
        windowSeconds: 30,
        billing: payment ? "moderato" : "simulated",
        ...(payment ? { auditCharges: async () => payment!.audit() } : {}),
        log: (step, state) => record({ step, state }),
      });
    }
    record({ kind: "application_flow", status: "passed" });
  } catch (error) {
    record({
      kind: "application_flow",
      status: "failed",
      error: safeError(error),
    });
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      if (runtime) await runtime.mf.dispose();
    } catch (error) {
      cleanupError = error;
    }
    try {
      if (payment) await payment.close();
    } catch (error) {
      cleanupError ??= error;
    } finally {
      runLease.close();
      mkdirSync(".local/testnet", { recursive: true });
      writeFileSync(
        receiptFile,
        JSON.stringify(
          { mode, events },
          (_, v) => (typeof v === "bigint" ? v.toString() : v),
          2,
        ),
      );
      console.log(JSON.stringify({ kind: "receipt_file", file: receiptFile }));
    }
    if (cleanupError) throw cleanupError;
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const mode = process.argv[2];
  try {
    if (mode === "verify")
      console.log(
        JSON.stringify(await verifyEvidence(process.argv[3]), (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
    else if (mode === "prepare") await prepare();
    else {
      check(
        ["tempo", "base", "e2e"].includes(mode),
        "expected_prepare_tempo_base_or_e2e",
      );
      await run(mode as "tempo" | "base" | "e2e");
    }
  } catch (error) {
    console.error(JSON.stringify({ error: safeError(error) }));
    process.exitCode = 1;
  }
}
