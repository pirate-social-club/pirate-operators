// Manual testnet-only deployment. Defaults to a read-only plan; journal before send.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compile } from "../compile.ts";
import { check } from "../../packages/protocol/index.ts";
import { directoryAbi } from "../../packages/community/directory-reader.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import {
  learningPrivacy,
  learningTerms,
} from "../../services/learning-policy-pages.ts";

const send = process.argv.includes("--send");
const RPC = "https://carrot.megaeth.com/rpc";
const MAX_PRICE = 1_000_000n,
  MAX_GAS = 150_000_000n,
  DATA_RESERVE = 1_000_000_000_000n;
const MAX_TOTAL = MAX_GAS * MAX_PRICE + 2n * DATA_RESERVE;
const directory = join(
  homedir(),
  ".local/state/pirate-learning-results-testnet-20261106",
);
interface Intent {
  nonce: number;
  to?: Address;
  data: Hex;
  gas: string;
  gasPrice: string;
  raw: Hex;
  hash: Hex;
  address?: Address;
  settled?: boolean;
}
interface Journal {
  source: Hex;
  communityId: Hex;
  controller: Address;
  operator: Address;
  publicity: Hex;
  maximumTotalWei: string;
  intents: Record<string, Intent>;
}
const file = join(directory, "deployment.json");
let lock: DatabaseSync | undefined;
const persist = (journal: Journal) => {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(journal, null, 2) + "\n", {
    mode: 0o600,
  });
  const fd = openSync(temporary, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(temporary, file);
  const parent = openSync(directory, "r");
  fsyncSync(parent);
  closeSync(parent);
};

async function main() {
  const client = createPublicClient({
    transport: http(RPC, { retryCount: 0, timeout: 15000 }),
  });
  check((await client.getChainId()) === 6343, "wrong_chain");
  const keys = JSON.parse(
    readFileSync(
      join(homedir(), ".config/pirate-operators/megaeth-testnet/keys.json"),
      "utf8",
    ),
  );
  const controllerFile = join(
    homedir(),
    ".config/pirate-registry/megaeth-testnet-operator.json",
  );
  const info = lstatSync(controllerFile);
  check(
    info.isFile() && !(info.mode & 0o077) && info.uid === process.getuid!(),
    "controller_key_not_private",
  );
  const controllerKey = JSON.parse(readFileSync(controllerFile, "utf8"));
  check(controllerKey.chainId === 6343, "controller_key_wrong_chain");
  const admin = privateKeyToAccount(controllerKey.privateKey),
    operator = privateKeyToAccount(keys.keys.operator);
  check(
    BigInt(controllerKey.privateKey) > 9n && BigInt(keys.keys.operator) > 9n,
    "public_fixture_key_refused",
  );
  const community = await client.readContract({
    address: firstSong.directoryProfile.directory,
    abi: directoryAbi,
    functionName: "getCommunity",
    args: [firstSong.directoryProfile.communityId],
  });
  check(
    community.configuration.controller.toLowerCase() ===
      admin.address.toLowerCase(),
    "controller_key_unavailable",
  );
  const artifact = compile().LearningResultsV2;
  const publicity = keccak256(
    stringToHex(`${learningTerms}\n\n${learningPrivacy}`),
  );
  const data = encodeDeployData({
    ...artifact,
    args: [admin.address, firstSong.directoryProfile.communityId, publicity],
  });
  const price = await client.getGasPrice();
  check(price <= MAX_PRICE, "gas_price_above_limit");
  const gas = await client.estimateGas({ account: admin.address, data });
  check(gas <= MAX_GAS, "deployment_gas_above_limit");
  console.log(
    JSON.stringify({
      mode: send ? "send" : "plan",
      chainId: 6343,
      communityId: firstSong.directoryProfile.communityId,
      controller: admin.address,
      grader: operator.address,
      publicityPolicy: publicity,
      estimatedDeploymentGas: String(gas),
      gasPriceWei: String(price),
      maximumTotalWei: String(MAX_TOTAL),
      directoryConfiguration: "separate reviewed operation",
    }),
  );
  if (!send) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  lock = new DatabaseSync(join(directory, "deployment-lock.sqlite"));
  lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  const profile = {
    maximumTotalWei: String(MAX_TOTAL),
    source: keccak256(artifact.bytecode),
    communityId: firstSong.directoryProfile.communityId,
    controller: admin.address,
    operator: operator.address,
    publicity,
  };
  let journal: Journal;
  try {
    journal = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    check(
      (error as NodeJS.ErrnoException).code === "ENOENT",
      "journal_unreadable",
    );
    journal = { ...profile, intents: {} };
    persist(journal);
  }
  check(
    Object.entries(profile).every(
      ([key, value]) => journal[key as keyof Journal] === value,
    ),
    "deployment_profile_changed",
  );
  const write = async (step: string, callData: Hex, to?: Address) => {
    let intent = journal.intents[step];
    if (!intent) {
      const nonce = await client.getTransactionCount({
        address: admin.address,
        blockTag: "pending",
      });
      const gasPrice = await client.getGasPrice();
      check(gasPrice <= MAX_PRICE, "gas_price_above_limit");
      const limit =
        ((await client.estimateGas({
          account: admin.address,
          to,
          data: callData,
        })) *
          12n) /
        10n;
      const allocated = Object.values(journal.intents).reduce(
        (n, row) => n + BigInt(row.gas) * BigInt(row.gasPrice) + DATA_RESERVE,
        0n,
      );
      check(
        allocated + limit * gasPrice + DATA_RESERVE <= MAX_TOTAL,
        "deployment_budget_exhausted",
      );
      const raw = await admin.signTransaction({
        chainId: 6343,
        nonce,
        to,
        data: callData,
        gas: limit,
        gasPrice,
        type: "legacy",
        value: 0n,
      });
      intent = {
        nonce,
        ...(to ? { to } : {}),
        data: callData,
        gas: String(limit),
        gasPrice: String(gasPrice),
        raw,
        hash: keccak256(raw),
      };
      journal.intents[step] = intent;
      persist(journal);
    }
    if (!intent.settled) {
      const feeAbi = parseAbi([
        "function getL1Fee(bytes data) view returns (uint256)",
      ]);
      check(
        (await client.readContract({
          address: "0x420000000000000000000000000000000000000F",
          abi: feeAbi,
          functionName: "getL1Fee",
          args: [intent.raw],
        })) <= DATA_RESERVE,
        "data_fee_above_limit",
      );
      const receipt = await client
        .getTransactionReceipt({ hash: intent.hash })
        .catch(() => null);
      if (!receipt) {
        try {
          await client.sendRawTransaction({
            serializedTransaction: intent.raw,
          });
        } catch {
          /* Never allocate a replacement for an unknown send. */
        }
      }
      const mined =
        receipt ??
        (await client.waitForTransactionReceipt({
          hash: intent.hash,
          timeout: 30000,
        }));
      check(mined.status === "success", "transaction_reverted");
      intent.settled = true;
      if (mined.contractAddress) intent.address = mined.contractAddress;
      persist(journal);
    }
    return intent;
  };
  const deployed = await write("deploy", data);
  check(deployed.address, "deployment_address_missing");
  await write(
    "grader",
    encodeFunctionData({
      abi: artifact.abi,
      functionName: "setGrader",
      args: [operator.address, 1, true],
    }),
    deployed.address,
  );
  console.log(
    JSON.stringify({
      chainId: 6343,
      learningResults: deployed.address,
      codeHash: keccak256(
        (await client.getCode({ address: deployed.address }))!,
      ),
      journal: file,
      directoryConfiguration: "pending",
    }),
  );
}
main()
  .finally(() => lock?.close())
  .catch((error) => {
    console.error(String(error.shortMessage ?? error.message).split("\n")[0]);
    process.exitCode = 1;
  });
