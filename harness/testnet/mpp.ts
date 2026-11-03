import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createClient, http, formatUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempoModerato } from "viem/chains";
import { Mppx, tempo as serverTempo } from "mppx/server";
import { tempo as clientTempo } from "mppx/client";
import { Session } from "mppx/tempo";
import { check } from "../../packages/protocol/index.ts";
import { PrivateStore } from "./store.ts";
import {
  assertNetwork,
  networks,
  PATH_USD,
  RESERVE,
  rejectFixtureKeys,
} from "./config.ts";

export async function paymentSession(
  keys: readonly Hex[],
  onReceipt: (value: unknown) => void = () => {},
) {
  rejectFixtureKeys(keys);
  const operator = privateKeyToAccount(keys[2]);
  const payer = privateKeyToAccount(keys[3]);
  const client = createClient({
    chain: tempoModerato,
    account: payer,
    transport: http(networks.tempo.rpc, { timeout: 15000, retryCount: 1 }),
  });
  const operatorClient = createClient({
    chain: tempoModerato,
    account: operator,
    transport: http(networks.tempo.rpc, { timeout: 15000, retryCount: 1 }),
  });
  const rpcId = async () =>
    Number(await client.request({ method: "eth_chainId" }));
  await assertNetwork(rpcId, 42431);
  const database = new PrivateStore("mpp-testnet-v0");
  const store = database.adapter("server:");
  let secret = database.read<string>("challenge-secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    database.write("challenge-secret", secret);
  }
  const api = Mppx.create({
    secretKey: secret,
    realm: "pirate-operators-testnet",
    methods: [
      serverTempo.session({
        account: operator,
        chainId: 42431,
        currencies: [PATH_USD],
        feeToken: PATH_USD,
        store,
        chargeOnAcceptance: true,
        suggestedDeposit: "0.01",
        getClient: () => operatorClient,
        onSessionSettlement: (context) =>
          onReceipt({
            kind: "settlement",
            chainId: 42431,
            channelId: context.channelId,
            transactionHash: context.txHash,
          }),
      }),
    ],
  });
  const manager = clientTempo.session.manager({
    account: payer,
    allowedChainIds: [42431],
    client,
    maxDeposit: "0.05",
    escrow: RESERVE,
    channelStore: Session.Client.createJsonChannelStore({
      get: (key) => database.read<string>("client:" + key) ?? undefined,
      set: (key, value) => database.write("client:" + key, value),
      delete: (key) => database.remove("client:" + key),
    }),
  });
  const runId = randomBytes(8).toString("hex");
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        check(size <= 32000, "request_too_large");
        chunks.push(Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString();
      const request = new Request(
        `http://127.0.0.1:${(server.address() as { port: number }).port}${req.url ?? "/"}`,
        {
          method: req.method,
          headers: req.headers as Record<string, string>,
          ...(["GET", "HEAD"].includes(req.method ?? "GET")
            ? {}
            : { body: raw }),
        },
      );
      const input = raw
        ? (JSON.parse(raw) as { jobId?: string; units?: number })
        : {};
      const key = input.jobId ? `job:${runId}:${input.jobId}` : undefined;
      let response: Response;
      const cached = key ? database.read<{ charged: number }>(key) : null;
      if (cached) {
        check(input.units === cached.charged, "idempotency_conflict");
        response = Response.json(cached);
      } else {
        const result = await api.session({
          amount: "0.002",
          unitType: "evaluation",
        })(request);
        if (result.status === 402) response = result.challenge;
        else {
          if (key) {
            check(input.units === 2, "spike_supports_two_unit_jobs_only");
            database.write(key, { charged: 2 });
          }
          response = await result.withReceipt(Response.json({ charged: 2 }));
        }
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (error as Error).name }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/evaluate`;
  const jobs = new Set<string>();
  let channelId: Hex | undefined;
  return {
    async charge(jobId: string, units: number) {
      check(units === 2, "spike_supports_two_unit_jobs_only");
      const response = await manager.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, units }),
      });
      check(response.ok, `mpp_response_${response.status}`);
      if (channelId)
        check(channelId === manager.channelId, "unexpected_second_channel");
      channelId = manager.channelId;
      const data = (await response.json()) as { charged: number };
      check(data.charged === units, "mpp_charge_mismatch");
      const replay = jobs.has(jobId);
      jobs.add(jobId);
      onReceipt({
        kind: replay ? "job_replay" : "paid_job",
        jobId,
        chainId: 42431,
        channelId,
        token: PATH_USD,
        amount: formatUnits(replay ? 0n : 2000n, 6),
      });
      return data;
    },
    get channelId() {
      return manager.channelId;
    },
    audit() {
      return { count: jobs.size, units: jobs.size * 2 };
    },
    async close() {
      try {
        const receipt = await manager.close();
        onReceipt({
          kind: "close",
          chainId: 42431,
          channelId,
          receipt,
          jobs: jobs.size,
        });
        return receipt;
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        database.close();
      }
    },
  };
}
