import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Hex } from "viem";
import { baseSepolia, tempoModerato } from "viem/chains";
import { check } from "../../packages/protocol/index.ts";

export const RESERVE = "0x4d50500000000000000000000000000000000000" as const;
export const PATH_USD = "0x20c0000000000000000000000000000000000000" as const;
export function rejectFixtureKeys(keys: readonly Hex[]) {
  check(keys.length === 9, "nine_testnet_keys_required");
  for (const key of keys) {
    check(
      /^0x[0-9a-fA-F]{64}$/.test(key) && BigInt(key) > 9n,
      "public_fixture_key_refused",
    );
    privateKeyToAccount(key);
  }
  check(
    new Set(keys.map((key) => privateKeyToAccount(key).address)).size === 9,
    "duplicate_testnet_key",
  );
}
export function privateStoreDirectory() {
  const path = join(homedir(), ".config", "pirate-operators");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  check(!lstatSync(path).isSymbolicLink(), "private_store_symlink");
  chmodSync(path, 0o700);
  return path;
}
export function testnetKeys(create = false) {
  const directory = privateStoreDirectory();
  const path = join(directory, "testnet-wallets.json");
  if (!existsSync(path)) {
    check(create, "run_testnet_prepare_first");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        keys: Array.from({ length: 9 }, () => generatePrivateKey()),
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  check(
    !lstatSync(path).isSymbolicLink() && (lstatSync(path).mode & 0o077) === 0,
    "private_key_file_permissions",
  );
  const data = JSON.parse(readFileSync(path, "utf8")) as {
    version: number;
    keys: Hex[];
  };
  check(data.version === 1, "unsupported_key_store");
  rejectFixtureKeys(data.keys);
  return data.keys;
}
export const networks = {
  base: { chain: baseSepolia, rpc: "https://sepolia.base.org" },
  tempo: { chain: tempoModerato, rpc: "https://rpc.moderato.tempo.xyz" },
};
export async function assertNetwork(
  actual: () => Promise<number>,
  expected: 84532 | 42431,
) {
  check((await actual()) === expected, "testnet_chain_mismatch");
}
export async function publicNetworks() {
  const base = createPublicClient({
    chain: baseSepolia,
    transport: http(networks.base.rpc, { timeout: 15000, retryCount: 1 }),
  });
  const tempo = createPublicClient({
    chain: tempoModerato,
    transport: http(networks.tempo.rpc, { timeout: 15000, retryCount: 1 }),
  });
  await Promise.all([
    assertNetwork(() => base.getChainId(), 84532),
    assertNetwork(() => tempo.getChainId(), 42431),
  ]);
  return { base, tempo };
}
export function safeError(error: unknown) {
  const e = error as { name?: string; shortMessage?: string; message?: string };
  return {
    name: e?.name ?? "Error",
    message:
      e?.shortMessage?.replace(/0x[0-9a-fA-F]{64}/g, "[redacted_hex]") ??
      (e?.message && /^[a-z][a-z0-9_:.-]{0,120}$/.test(e.message)
        ? e.message
        : "testnet_operation_failed"),
  };
}
