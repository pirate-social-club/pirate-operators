import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { check } from "../../packages/protocol/index.ts";
import { hostedProvider } from "../../packages/very/transport.ts";
import {
  configuration,
  type AttesterConfig,
} from "../../services/very-attester/policy.ts";
import {
  privateStoreDirectory,
  publicNetworks,
  testnetKeys,
} from "../testnet/config.ts";
import { PrivateStore } from "../testnet/store.ts";
import { baseChain } from "../testnet/base.ts";
import { attesterRuntime } from "./attester-runtime.ts";
import {
  prepareReward,
  registerReward,
  type PreparedReward,
} from "./reward-fixture.ts";
import { testnetPool } from "./testnet-pool.ts";
import { RewardCeremony } from "./reward-ceremony.ts";
import { serveProbe } from "./server.ts";
import { rewardPage } from "./reward-page.ts";

interface Manifest {
  version: 1;
  config: AttesterConfig;
  reward: PreparedReward;
}
function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  check(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o077) === 0 &&
      stat.size <= 32000,
    "private_manifest_required",
  );
  return JSON.parse(readFileSync(path, "utf8"));
}
function record(event: unknown) {
  console.log(
    JSON.stringify(event, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
export async function rewardTestnet() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      live: { type: "boolean" },
      "app-id-file": { type: "string" },
      manifest: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "npm run very:reward -- prepare --live --app-id-file <private-text-file>\nnpm run very:reward -- serve --live --manifest <private-json> [--port <loopback-port>]",
    );
    return;
  }
  check(
    values.live &&
      positionals.length === 1 &&
      ["prepare", "serve"].includes(positionals[0]),
    "explicit_testnet_mode_required",
  );
  const keys = testnetKeys(); // Reuse existing dedicated keys; never create here.
  const accounts = keys.map((key) => privateKeyToAccount(key));
  const lease = new PrivateStore("testnet-run");
  let runtime: Awaited<ReturnType<typeof attesterRuntime>> | undefined;
  let server: Awaited<ReturnType<typeof serveProbe>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (positionals[0] === "prepare") {
      check(values["app-id-file"], "existing_app_id_file_required");
      const file = lstatSync(values["app-id-file"]);
      check(file.isFile() && file.size < 1024, "invalid_app_file");
      const appId = readFileSync(values["app-id-file"], "utf8").trim();
      check(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          appId,
        ),
        "invalid_app_id",
      );
      const evm = await baseChain(keys, record);
      const reward = await prepareReward(evm, accounts, 84532); // Seven days, the contract default.
      const { base } = await publicNetworks();
      const code = await base.getCode({ address: reward.pool });
      check(code, "pool_code_missing");
      const config = configuration({
        chainId: 84532,
        pool: reward.pool,
        drawingId: "1",
        poolCodeHash: keccak256(code),
        attester: accounts[4].address,
        appId,
      });
      const manifest = join(
        privateStoreDirectory(),
        `very-reward-${Date.now()}.json`,
      );
      writeFileSync(
        manifest,
        JSON.stringify({ version: 1, config, reward }, null, 2),
        { flag: "wx", mode: 0o600 },
      );
      record({
        kind: "prepared",
        chainId: 84532,
        pool: reward.pool,
        claimant: reward.claimant,
        deadline: reward.deadline,
        manifest,
        simulated: ["qualification", "Jackpot", "test-token"],
      });
      return;
    }
    check(values.manifest, "private_manifest_required");
    const data = privateJson(values.manifest) as Manifest;
    check(
      data.version === 1 && data.reward.chainId === 84532,
      "invalid_manifest",
    );
    const config = configuration(data.config);
    check(
      config.chainId === 84532 &&
        config.pool.toLowerCase() === data.reward.pool.toLowerCase() &&
        config.attester === accounts[4].address &&
        data.reward.claimant === accounts[5].address,
      "manifest_binding_mismatch",
    );
    const evm = await testnetPool(config, keys, record);
    check(
      (await evm.read(config.pool, "RewardPool", "scope")) ===
        data.reward.scope &&
        Number(await evm.read(config.pool, "RewardPool", "deadline")) ===
          data.reward.deadline,
      "manifest_scope_mismatch",
    );
    const directory = join(
      privateStoreDirectory(),
      "very-attesters",
      config.pool.toLowerCase(),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    runtime = await attesterRuntime(config, keys[4], directory);
    const activeRuntime = runtime;
    const ceremony = new RewardCeremony({
      config,
      claimant: accounts[5],
      provider: hostedProvider(),
      call: async (path, input) => {
        const response = await activeRuntime.dispatchFetch(
          `http://attester${path}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
          },
        );
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error ?? "attester_refused");
        return body;
      },
      registered: async () =>
        Boolean(
          await evm.read(config.pool, "RewardPool", "registered", [
            accounts[5].address,
          ]),
        ),
      register: async (permit) => {
        await registerReward(evm, data.reward, accounts[5], permit);
        record({
          kind: "real_very_registration",
          status: "passed",
          chainId: 84532,
          pool: config.pool,
        });
      },
    });
    server = await serveProbe(
      ceremony,
      values.port === undefined ? 0 : Number(values.port),
      rewardPage,
    );
    console.log(`Very reward ceremony: ${server.url}`);
    console.log(
      "One existing enrollment and a test wallet. Completing the scan publishes a scoped reward identifier and test-wallet address on Base Sepolia. No mainnet funds. The hosted verifier is trusted; app-origin binding and freshness remain unproven. Stops after 30 minutes.",
    );
    await new Promise<void>((done) => {
      timer = setTimeout(done, 30 * 60_000);
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    record(ceremony.view().report);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await server?.close();
    } finally {
      try {
        await runtime?.dispose();
      } finally {
        lease.close();
      }
    }
  }
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  rewardTestnet().catch(() => {
    console.error(
      "Very reward test could not complete. Check the private configuration and testnet state. No provider details or keys are logged.",
    );
    process.exitCode = 1;
  });
}
