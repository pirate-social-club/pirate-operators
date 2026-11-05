// Manual operator bootstrap, never a member/creator deployment. Defaults to
// a local source-bound plan. Requires an independently reviewed exact profile.
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
import { privateKeyToAccount } from "viem/accounts";
import {
  BaseError,
  ContractFunctionRevertedError,
  keccak256,
  parseAbi,
  parseEventLogs,
  type Hex,
} from "viem";
import { infisicalAuth } from "../../apps/community-wizard/server/infisical-auth.ts";
import {
  canonical,
  CommunityError,
  insist,
} from "../../packages/community/common.ts";
import { addPin, reconcilePin } from "../../packages/community/ipfs.ts";
import {
  directoryAbi,
  readConfiguration,
} from "../../packages/community/directory-reader.ts";
import { deploymentJournal } from "./deployment-journal.ts";
import { saveConfigurationState } from "./configuration-state.ts";
import { adoptConfigurationPin } from "./configuration-pin-recovery.ts";
import {
  configurationClient,
  configurationPlan,
  configurationPreflight,
} from "./configuration-plan.ts";

const state = join(
  homedir(),
  ".local/state/pirate-first-song-managed-20261105/configuration",
);
const privateSave = (name: string, value: unknown) =>
  saveConfigurationState(state, name, value);
async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean" },
      "expected-profile": { type: "string" },
      "write-plan": { type: "boolean" },
      preflight: { type: "boolean" },
      "adopt-existing-pin": { type: "boolean" },
    },
  });
  const planned = await configurationPlan(),
    { profile, profileHash } = planned;
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.configuration-plan.json",
      JSON.stringify(
        { profileHash, journalHash: planned.journalHash, profile },
        null,
        2,
      ) + "\n",
    );
  if (!values.execute && values.preflight) {
    console.log(JSON.stringify(await configurationPreflight(planned), null, 2));
    return;
  }
  if (!values.execute) {
    console.log(JSON.stringify({ profileHash, profile }, null, 2));
    return;
  }
  insist(
    values["expected-profile"] === profileHash,
    "configuration_profile_not_reviewed",
  );
  await mkdir(state, { mode: 0o700, recursive: true });
  const metadata = await lstat(state);
  insist(
    metadata.isDirectory() && !(metadata.mode & 0o077),
    "configuration_state_not_private",
  );
  const lockFile = join(state, "execution.lock"),
    lock = await open(lockFile, "wx", 0o600);
  const lockIdentity = canonical({
    pid: process.pid,
    profileHash,
    at: new Date().toISOString(),
  });
  await lock.writeFile(lockIdentity);
  await lock.sync();
  const deadline = Date.now() + profile.bounds.executionSeconds * 1000;
  try {
    const client = configurationClient();
    insist(
      (await client.getChainId()) === 6343,
      "refusing_non_megaeth_testnet",
    );
    const liveCode = await client.getCode({ address: planned.call.to });
    insist(
      liveCode &&
        keccak256(liveCode) === profile.directoryProfile.directoryCodeHash,
      "configuration_directory_code_changed",
    );
    const actorFile = join(
        homedir(),
        ".config/pirate-registry/megaeth-testnet-operator.json",
      ),
      actorStat = await lstat(actorFile);
    insist(
      actorStat.isFile() &&
        !(actorStat.mode & 0o077) &&
        actorStat.uid === process.getuid!(),
      "configuration_actor_not_private",
    );
    const actor = JSON.parse(await readFile(actorFile, "utf8"));
    insist(actor.chainId === 6343, "configuration_actor_wrong_chain");
    const account = privateKeyToAccount(actor.privateKey);
    insist(
      account.address.toLowerCase() === profile.manifest.controller,
      "configuration_actor_mismatch",
    );
    // Registering no already-existing community avoids any unrelated revision.
    let current = null;
    try {
      current = await client.readContract({
        address: profile.manifest.directory,
        abi: [...directoryAbi, ...parseAbi(["error UnknownCommunity()"])],
        functionName: "getCommunity",
        args: [profile.manifest.communityId],
      });
    } catch (error) {
      const cause =
        error instanceof BaseError
          ? error.walk(
              (value) => value instanceof ContractFunctionRevertedError,
            )
          : null;
      insist(
        cause instanceof ContractFunctionRevertedError &&
          cause.data?.errorName === "UnknownCommunity",
        "configuration_state_uncertain",
        503,
      );
    }
    if (current) {
      insist(
        current.registry.toLowerCase() === profile.manifest.registry &&
          current.configurationRevision === 1n &&
          current.configuration.sha256Digest === profile.pin.sha256 &&
          current.configuration.uri === profile.pin.uri,
        "configuration_already_differs",
        409,
      );
      const savedJournal = JSON.parse(
        await readFile(join(state, "evm/transactions.json"), "utf8"),
      );
      insist(
        savedJournal.profileHash === planned.journalHash &&
          savedJournal.transactions.register_configuration,
        "configuration_confirmed_without_own_journal",
        409,
      );
    }
    const storedJournal = await readFile(
      join(state, "evm/transactions.json"),
      "utf8",
    )
      .then(JSON.parse)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
    if (storedJournal)
      insist(
        storedJournal.profileHash === planned.journalHash &&
          Object.keys(storedJournal.transactions).every(
            (step) => step === "register_configuration",
          ) &&
          (!storedJournal.transactions.register_configuration ||
            storedJournal.transactions.register_configuration.nonce ===
              profile.transaction.nonce),
        "configuration_journal_changed",
        409,
      );
    if (!storedJournal?.transactions.register_configuration) {
      const [latest, pending, estimated] = await Promise.all([
        client.getTransactionCount({
          address: account.address,
          blockTag: "latest",
        }),
        client.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        }),
        client.estimateGas({
          account,
          to: planned.call.to,
          data: planned.call.data,
        }),
      ]);
      insist(
        latest === profile.transaction.nonce &&
          pending === latest &&
          estimated <= planned.call.gas,
        "configuration_actor_or_gas_readiness_changed",
        409,
      );
    }
    const sdk = await infisicalAuth().client(),
      credentials = profile.credential;
    const secret = await sdk.secrets().getSecret({
      projectId: credentials.projectId,
      environment: credentials.environment,
      secretPath: credentials.path,
      secretName: credentials.name,
      includeImports: false,
      expandSecretReferences: false,
    });
    const token = secret.secretValue;
    insist(token, "configuration_pin_credential_missing", 503);
    let pinState: { profileHash: Hex; state: string; result?: unknown };
    try {
      pinState = JSON.parse(await readFile(join(state, "pin.json"), "utf8"));
    } catch (error) {
      insist(
        (error as NodeJS.ErrnoException).code === "ENOENT",
        "configuration_pin_state_invalid",
      );
      insist(
        !profile.pinRecovery.required && !current,
        "configuration_pin_journal_missing",
        409,
      );
      pinState = { profileHash, state: "planned" };
      await privateSave("pin.json", pinState);
    }
    if (pinState.profileHash !== profileHash) {
      insist(
        values["adopt-existing-pin"],
        "configuration_pin_adoption_required",
        409,
      );
      pinState = await adoptConfigurationPin(state, planned, token);
    }
    insist(
      pinState.profileHash === profileHash,
      "configuration_pin_profile_changed",
    );
    if (pinState.state === "planned") {
      insist(
        profile.bounds.pinAdds > 0,
        "configuration_new_pin_forbidden",
        409,
      );
      insist(!current, "configuration_pin_journal_inconsistent", 409);
      insist(Date.now() < deadline, "configuration_window_expired");
      pinState.state = "running";
      await privateSave("pin.json", pinState);
      // No retry after entry. The expected CID is already in the profile.
      pinState.result = await addPin(
        profile.pin,
        planned.bytes,
        token,
        (receipt) =>
          privateSave("pin-receipt.json", { profileHash, ...receipt }),
      );
      pinState.state = "confirmed";
      await privateSave("pin.json", pinState);
    } else {
      pinState.result = await reconcilePin(profile.pin, token);
      pinState.state = "confirmed";
      await privateSave("pin.json", pinState);
    }
    insist(Date.now() < deadline, "configuration_window_expired");
    const journal = await deploymentJournal(
      join(state, "evm"),
      profile,
      client,
      account,
      planned.limits,
      deadline,
    );
    try {
      const receipt = await journal.send(
        "register_configuration",
        planned.call,
        async (stage) => {
          if (stage === "prepared")
            insist(
              journal.snapshot().transactions.register_configuration!.nonce ===
                profile.transaction.nonce,
              "configuration_nonce_changed_before_broadcast",
              409,
            );
        },
      );
      const events = parseEventLogs({
        abi: directoryAbi,
        eventName: "ConfigurationPublished",
        logs: receipt.logs,
        strict: true,
      }).filter(
        (log) => log.address.toLowerCase() === profile.manifest.directory,
      );
      insist(
        events.length === 1 &&
          events[0]!.args.communityId === profile.manifest.communityId &&
          events[0]!.args.revision === 1n &&
          events[0]!.args.sha256Digest === profile.pin.sha256 &&
          events[0]!.args.uri === profile.pin.uri,
        "configuration_receipt_mismatch",
      );
      const readback = await readConfiguration(client, {
        ...profile.directoryProfile,
        deploymentBlock: BigInt(profile.directoryProfile.deploymentBlock),
      });
      insist(
        canonical(readback) === canonical(profile.manifest),
        "configuration_readback_mismatch",
      );
      const evidence = {
        schema: "pirate.first-song-configuration/1",
        at: new Date().toISOString(),
        profileHash,
        profile,
        pin: pinState.result,
        journal: journal.snapshot(),
        configuration: readback,
      };
      await privateSave("result.json", evidence);
      await writeFile(
        "docs/deployments/first-song-managed-20261105.configuration.json",
        JSON.stringify(evidence, null, 2) + "\n",
      );
      console.log(
        JSON.stringify({
          profileHash,
          uri: profile.pin.uri,
          transactionHash: receipt.transactionHash,
          status: "confirmed",
        }),
      );
    } finally {
      await journal.close();
    }
  } finally {
    await lock.close();
    insist(
      (await readFile(lockFile, "utf8")) === lockIdentity,
      "configuration_lock_changed",
    );
    await unlink(lockFile);
  }
}
main().catch((error) => {
  console.error(
    error instanceof CommunityError
      ? error.code
      : "configuration_result_uncertain; preserve journal and reconcile before retry",
  );
  process.exitCode = 1;
});
