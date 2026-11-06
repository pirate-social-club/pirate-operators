// Manual testnet configuration and prospective learning policy. Plan by default.
import { readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infisicalAuth } from "../../apps/community-wizard/server/infisical-auth.ts";
import {
  canonical,
  hashJson,
  insist,
} from "../../packages/community/common.ts";
import { validateConfig } from "../../packages/community/config-manifest.ts";
import {
  preparePin,
  addPin,
  reconcilePin,
} from "../../packages/community/ipfs.ts";
import { readConfiguration } from "../../packages/community/directory-reader.ts";
import {
  resultsAbi,
  resultPeriod,
} from "../../packages/protocol/learning-results.ts";
import { textKey } from "../../packages/protocol/records.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { configureAbi } from "./curated-configuration-plan.ts";
import { deploymentJournal } from "./deployment-journal.ts";
import {
  replacePrivateJson,
  privateJson,
  durableJson,
  digest,
} from "../private-json.ts";

async function put(path: string, value: unknown) {
  const old = await readFile(path).catch((e) => {
    if (e.code === "ENOENT") return null;
    throw e;
  });
  if (old) await replacePrivateJson(path, value, digest(old));
  else await durableJson(path, value);
}
const send = process.argv.includes("--send");
const root = join(
  homedir(),
  ".local/state/pirate-learning-results-testnet-20261106/configuration",
);
const client = createPublicClient({
  transport: http("https://carrot.megaeth.com/rpc", {
    timeout: 30000,
    retryCount: 0,
  }),
});
insist((await client.getChainId()) === 6343, "wrong_chain");
const deployment = JSON.parse(
  await readFile(
    "docs/deployments/learning-results-testnet-20261106.contract.json",
    "utf8",
  ),
);
const priorPlan = JSON.parse(
  await readFile(
    "docs/deployments/first-song-managed-20261105.curated-configuration-plan.json",
    "utf8",
  ),
);
const original = JSON.parse(
  await readFile(
    "docs/deployments/first-song-managed-20261105.configuration.json",
    "utf8",
  ),
);
const genesis = validateConfig(original.configuration);
const previous = validateConfig(priorPlan.profile.manifest, [genesis]);
insist(previous.configurationRevision === 2, "wrong_configuration_predecessor");
const manifest = validateConfig(
  {
    ...previous,
    configurationRevision: 3,
    learningRecords: deployment.learningResults,
  },
  [genesis, previous],
);
const configBytes = new TextEncoder().encode(canonical(manifest));
const policy = {
  schema: "pirate.learning-policy/2",
  version: "pirate.karaoke-testnet/2026-11-06/1",
  clockVersion: 1,
  activity: 1,
  graders: [deployment.grader],
  scoringPolicies: [textKey("karaoke-scoring/5")],
  terminalStatuses: [1, 2, 3, 4],
  minScoreBps: 7000,
  maxUnmeasuredBps: 1000,
  rewards: false,
};
const policyBytes = new TextEncoder().encode(canonical(policy));
const [configPin, policyPin] = await Promise.all([
  preparePin(configBytes, "application/json"),
  preparePin(policyBytes, "application/json"),
]);
let saved = await privateJson(join(root, "profile.json"));
const effectivePeriod = saved
  ? BigInt(String(saved.effectivePeriod))
  : resultPeriod((await client.getBlock()).timestamp) + 1n;
const profile = {
  chainId: 6343,
  manifest,
  previous: hashJson(previous),
  configPin,
  policy,
  policyPin,
  effectivePeriod: String(effectivePeriod),
  maximumGasPriceWei: "1000000",
  gasPerTransaction: "1500000",
  maximumExecutionFeeWei: "3000000000000",
  dataFeeReservePerTransactionWei: "100000000000",
  pinAdds: 2,
  transactions: 2,
};
const profileHash = hashJson(profile);
if (saved)
  insist(saved.profileHash === profileHash, "configuration_profile_changed");
console.log(
  JSON.stringify(
    { mode: send ? "send" : "plan", profileHash, ...profile },
    null,
    2,
  ),
);
const directoryProfile = {
  ...firstSong.directoryProfile,
  deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
};
const current = await readConfiguration(client, directoryProfile);
insist(
  hashJson(current) === hashJson(previous) ||
    hashJson(current) === hashJson(manifest),
  "configuration_changed",
);
if (!send) process.exit(0);
await mkdir(root, { recursive: true, mode: 0o700 });
await put(join(root, "profile.json"), {
  profileHash,
  ...profile,
});
const keyPath = join(
  homedir(),
  ".config/pirate-registry/megaeth-testnet-operator.json",
);
const meta = await lstat(keyPath);
insist(
  meta.isFile() && !(meta.mode & 0o077) && meta.uid === process.getuid!(),
  "controller_key_not_private",
);
const key = JSON.parse(await readFile(keyPath, "utf8"));
const account = privateKeyToAccount(key.privateKey);
insist(
  key.chainId === 6343 && account.address.toLowerCase() === manifest.controller,
  "controller_changed",
);
const journal = await deploymentJournal(
  join(root, "evm"),
  profile,
  client,
  account,
  {
    chainId: 6343,
    maximumGasPrice: 1000000n,
    maximumTotalFee: 3000000000000n,
    maximumExecutionMs: 900000,
  },
);
try {
  const sdk = await infisicalAuth().client();
  const s = await sdk.secrets().getSecret({
    projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
    environment: "staging",
    secretPath: "/services/api-next",
    secretName: "FILEBASE_IPFS_TOKEN",
    includeImports: false,
    expandSecretReferences: false,
  });
  insist(s.secretValue, "pin_secret_unavailable");
  for (const [name, pin, bytes] of [
    ["config", configPin, configBytes],
    ["policy", policyPin, policyBytes],
  ] as const) {
    const path = join(root, `${name}-pin.json`);
    const old = await privateJson(path);
    if (!old) {
      await put(path, {
        state: "sent",
        profileHash,
        uri: pin.uri,
      });
      await addPin(pin, bytes, s.secretValue, async (receipt) => {
        await put(path, {
          state: "received",
          profileHash,
          uri: pin.uri,
          receipt,
        });
      });
    } else {
      insist(old.profileHash === profileHash, "pin_profile_changed");
      await reconcilePin(pin, s.secretValue);
    }
    await put(path, {
      state: "retained",
      profileHash,
      uri: pin.uri,
    });
  }
  const feeAbi = parseAbi([
    "function getL1Fee(bytes data) view returns (uint256)",
  ]);
  const boundary =
    (step: string) =>
    async (stage: "prepared" | "before_broadcast" | "broadcast") => {
      if (stage !== "before_broadcast") return;
      const raw = journal.snapshot().transactions[step].raw;
      const fee = await client.readContract({
        address: "0x420000000000000000000000000000000000000F",
        abi: feeAbi,
        functionName: "getL1Fee",
        args: [raw],
      });
      insist(fee <= 100000000000n, "data_fee_limit");
    };
  const configure = encodeFunctionData({
    abi: configureAbi,
    functionName: "configure",
    args: [
      manifest.communityId,
      2n,
      {
        controller: manifest.controller,
        publisher: manifest.publisher,
        operatorPayments: manifest.operatorPayments,
        learningRecords: manifest.learningRecords,
        sha256Digest: configPin.sha256,
        uri: configPin.uri,
      },
    ],
  });
  const configured = await journal.send(
    "configure_results",
    { to: manifest.directory, data: configure, gas: 1500000n },
    boundary("configure_results"),
  );
  const activate = encodeFunctionData({
    abi: resultsAbi,
    functionName: "activatePolicy",
    args: [policyPin.sha256, policyPin.uri, effectivePeriod],
  });
  const activated = await journal.send(
    "activate_learning_policy",
    { to: deployment.learningResults, data: activate, gas: 1500000n },
    boundary("activate_learning_policy"),
  );
  const actual = await readConfiguration(client, directoryProfile);
  insist(
    hashJson(actual) === hashJson(manifest),
    "configuration_not_retrievable",
  );
  const output = {
    ...profile,
    profileHash,
    configurationTransaction: configured.transactionHash,
    policyTransaction: activated.transactionHash,
    configurationBlock: String(configured.blockNumber),
    policyBlock: String(activated.blockNumber),
    namespaceVerification:
      "invalidated by configuration change; community remains permanently unlisted",
  };
  await writeFile(
    "docs/deployments/learning-results-testnet-20261106.configuration.json",
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      profileHash,
      configurationTransaction: configured.transactionHash,
      policyTransaction: activated.transactionHash,
      configurationRevision: 3,
      effectivePeriod: String(effectivePeriod),
    }),
  );
} finally {
  await journal.close();
}
