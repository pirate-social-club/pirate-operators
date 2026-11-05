// Manual testnet-only provisioning. Inject the dedicated key with Infisical.
// The exchange IDs and 10 IKA / SUI rate come from https://faucet.ika.xyz.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";
import { getNetworkConfig } from "@ika.xyz/sdk";
import { b64, unb64 } from "../src/shared.ts";
const operator =
  "0xe80513f6f72a375ef3fc279f74e904ba4ab244554abbd468559a13a811a82ea6";
const key = Ed25519Keypair.fromSecretKey(process.env.SUI_OPERATOR_SECRET_KEY!);
if (key.toSuiAddress() !== operator)
  throw new Error("Wrong dedicated operator.");
const client = new SuiGrpcClient({
  network: "testnet",
  baseUrl: "https://fullnode.testnet.sui.io:443",
});
process.umask(0o077);
const stateDir = resolve(
  homedir(),
  ".local/state/pirate-creator-wallet-testnet",
);
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const pilot = process.argv.includes("--pilot");
const file = `${stateDir}/ika-funding-${pilot ? "pilot" : "1"}.json`;
if (!process.argv.includes("--execute")) {
  console.log(
    JSON.stringify({
      mode: "plan",
      network: "testnet",
      operator,
      spendSui: "2.2",
      receiveIka: "22",
      receipt: file,
      executeFlag: "--execute",
    }),
  );
  process.exit(0);
}
let stored: { bytes: string; signature: string; digest: string };
try {
  stored = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const tx = new Transaction();
  tx.setSender(operator);
  tx.setGasBudget(50_000_000);
  const coin = tx.add(coinWithBalance({ balance: 2_200_000_000n }));
  const ika = tx.moveCall({
    target:
      "0x5d2fd4d021b617a998373b4dfec563adb60b1b47be2a77572c3ff158083e9f89::ika_exchange::exchange_all_for_ika",
    arguments: [
      tx.object(
        "0xb2ba36b1a5927e3f070240a3dfccdeac033a756bf265aa1401037eb300d40d66",
      ),
      coin,
    ],
  });
  tx.transferObjects([ika], operator);
  const bytes = await tx.build({ client });
  const signed = await key.signTransaction(bytes);
  stored = {
    bytes: b64(bytes),
    signature: signed.signature,
    digest: await tx.getDigest(),
  };
  await writeFile(file, JSON.stringify(stored), { mode: 0o600, flag: "wx" });
}
let result;
try {
  result = await client.getTransaction({ digest: stored.digest });
} catch {
  result = await client.executeTransaction({
    transaction: unb64(stored.bytes),
    signatures: [stored.signature],
  });
}
if (result.$kind !== "Transaction" || !result.Transaction.status.success)
  throw new Error(
    "Funding transaction failed; inspect its saved digest before retrying.",
  );
console.log(
  JSON.stringify({
    digest: stored.digest,
    sui: (await client.getBalance({ owner: operator })).balance.balance,
    ika: (
      await client.getBalance({
        owner: operator,
        coinType: `${getNetworkConfig("testnet").packages.ikaPackage}::ika::IKA`,
      })
    ).balance.balance,
  }),
);
