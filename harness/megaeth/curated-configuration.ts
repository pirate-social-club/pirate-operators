// Manual bounded operator action. Dry plan/read-only preflight by default.
import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  lstat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { keccak256, type Hex, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { infisicalAuth } from "../../apps/community-wizard/server/infisical-auth.ts";
import {
  canonical,
  hashJson,
  insist,
  CommunityError,
} from "../../packages/community/common.ts";
import { addPin, reconcilePin } from "../../packages/community/ipfs.ts";
import {
  directoryAbi,
  readConfiguration,
} from "../../packages/community/directory-reader.ts";
import { configurationClient } from "./configuration-plan.ts";
import { curatedConfigurationPlan } from "./curated-configuration-plan.ts";
import { deploymentJournal } from "./deployment-journal.ts";
import { saveConfigurationState } from "./configuration-state.ts";

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
      options: {
        execute: { type: "boolean" },
        preflight: { type: "boolean" },
        "write-plan": { type: "boolean" },
        "expected-profile": { type: "string" },
      },
    }),
    planned = await curatedConfigurationPlan(),
    { profile, profileHash } = planned;
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.curated-configuration-plan.json",
      JSON.stringify({ profileHash, profile }, null, 2) + "\n",
    );
  if (!values.execute && !values.preflight) {
    console.log(JSON.stringify({ profileHash, profile }));
    return;
  }
  if (values.execute)
    insist(
      values["expected-profile"] === profileHash,
      "curated_configuration_not_reviewed",
      409,
    );
  const client = configurationClient(),
    directoryProfile = {
      ...profile.directoryProfile,
      deploymentBlock: BigInt(profile.directoryProfile.deploymentBlock),
    },
    current = await readConfiguration(client, directoryProfile),
    already = hashJson(current) === hashJson(profile.manifest);
  insist(
    already || hashJson(current) === profile.originalConfigurationSha256,
    "curated_configuration_predecessor_changed",
    409,
  );
  const [latest, pending, price, balance] = await Promise.all([
    client.getTransactionCount({
      address: profile.manifest.controller,
      blockTag: "latest",
    }),
    client.getTransactionCount({
      address: profile.manifest.controller,
      blockTag: "pending",
    }),
    client.getGasPrice(),
    client.getBalance({ address: profile.manifest.controller }),
  ]);
  if (!already)
    insist(
      latest === profile.transaction.nonce &&
        pending === latest &&
        price > 0n &&
        price <= planned.limits.maximumGasPrice &&
        balance >= planned.call.gas * price,
      "curated_configuration_funding_changed",
      409,
    );
  if (!values.execute) {
    console.log(
      JSON.stringify({
        profileHash,
        latest,
        pending,
        gasPrice: price.toString(),
        balance: balance.toString(),
        already,
        execution: "not_started",
      }),
    );
    return;
  }
  const directory = join(
    homedir(),
    ".local/state/pirate-first-song-managed-20261105/curated-configuration",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "execution.lock"),
    lock = await open(lockPath, "wx", 0o600),
    identity = canonical({
      profileHash,
      pid: process.pid,
      at: new Date().toISOString(),
    }),
    deadline = Date.now() + profile.bounds.executionSeconds * 1000;
  await lock.writeFile(identity);
  await lock.sync();
  try {
    const actorPath = join(
        homedir(),
        ".config/pirate-registry/megaeth-testnet-operator.json",
      ),
      stat = await lstat(actorPath);
    insist(
      stat.isFile() && !(stat.mode & 0o077) && stat.uid === process.getuid!(),
      "curated_controller_file_not_private",
      409,
    );
    const actor = JSON.parse(await readFile(actorPath, "utf8")),
      account = privateKeyToAccount(actor.privateKey);
    insist(
      actor.chainId === 6343 &&
        account.address.toLowerCase() === profile.manifest.controller,
      "curated_controller_changed",
      409,
    );
    const save = (name: string, value: unknown) =>
        saveConfigurationState(directory, name, value),
      journal = await deploymentJournal(
        join(directory, "evm"),
        profile,
        client,
        account,
        planned.limits,
        deadline,
      );
    try {
      if (already)
        insist(
          journal.snapshot().transactions.configure_owner_curated,
          "curated_configuration_missing_own_receipt",
          409,
        );
      const sdk = await infisicalAuth().client(),
        s = await sdk
          .secrets()
          .getSecret({
            projectId: profile.credential.projectId,
            environment: "staging",
            secretPath: profile.credential.path,
            secretName: profile.credential.name,
            includeImports: false,
            expandSecretReferences: false,
          });
      insist(
        s.secretValue,
        "curated_configuration_credential_unavailable",
        503,
      );
      const path = join(directory, "pin.json");
      let pinState: { profileHash: string; state: string; result?: unknown };
      try {
        pinState = JSON.parse(await readFile(path, "utf8"));
      } catch (e) {
        insist(
          (e as NodeJS.ErrnoException).code === "ENOENT" && !already,
          "curated_configuration_pin_state_unresolved",
          409,
        );
        pinState = { profileHash, state: "planned" };
        await save("pin.json", pinState);
      }
      insist(
        pinState.profileHash === profileHash,
        "curated_configuration_pin_profile_changed",
        409,
      );
      if (pinState.state === "planned") {
        insist(
          !already && Date.now() < deadline,
          "curated_configuration_pin_not_authorized",
          409,
        );
        pinState.state = "running";
        await save("pin.json", pinState);
        pinState.result = await addPin(
          profile.pin,
          planned.bytes,
          s.secretValue,
          (receipt) => save("pin-receipt.json", { profileHash, ...receipt }),
        );
      } else pinState.result = await reconcilePin(profile.pin, s.secretValue);
      pinState.state = "confirmed";
      await save("pin.json", pinState);
      const receipt = await journal.send(
        "configure_owner_curated",
        planned.call,
        async (stage) => {
          if (stage === "prepared") {
            insist(
              journal.snapshot().transactions.configure_owner_curated!.nonce ===
                profile.transaction.nonce,
              "curated_configuration_nonce_changed",
              409,
            );
            const live = await readConfiguration(client, directoryProfile);
            insist(
              hashJson(live) === profile.originalConfigurationSha256,
              "curated_configuration_changed_before_broadcast",
              409,
            );
          }
        },
      );
      const events = parseEventLogs({
        abi: directoryAbi,
        eventName: "ConfigurationPublished",
        logs: receipt.logs,
        strict: true,
      }).filter((l) => l.address.toLowerCase() === profile.manifest.directory);
      insist(
        events.length === 1 &&
          events[0]!.args.communityId === profile.manifest.communityId &&
          events[0]!.args.revision === 2n &&
          events[0]!.args.sha256Digest === profile.pin.sha256 &&
          events[0]!.args.uri === profile.pin.uri,
        "curated_configuration_receipt_changed",
        409,
      );
      const readback = await readConfiguration(client, directoryProfile);
      insist(
        canonical(readback) === canonical(profile.manifest),
        "curated_configuration_readback_changed",
        409,
      );
      const evidence = {
        schema: "pirate.owner-curated-configuration/1",
        at: new Date().toISOString(),
        profileHash,
        profile,
        configuration: readback,
        pin: pinState.result,
        journal: journal.snapshot(),
      };
      await save("result.json", evidence);
      await writeFile(
        "docs/deployments/first-song-managed-20261105.curated-configuration.json",
        JSON.stringify(evidence, null, 2) + "\n",
      );
      console.log(
        JSON.stringify({
          profileHash,
          status: "confirmed",
          configurationRevision: 2,
          transactionHash: receipt.transactionHash,
        }),
      );
    } finally {
      await journal.close();
    }
  } finally {
    await lock.close();
    insist(
      (await readFile(lockPath, "utf8")) === identity,
      "curated_configuration_lock_changed",
      409,
    );
    await unlink(lockPath);
  }
}
main().catch((e) => {
  console.error(
    e instanceof CommunityError
      ? e.code
      : "curated_configuration_uncertain; preserve journals and reconcile before retry",
  );
  process.exitCode = 1;
});
