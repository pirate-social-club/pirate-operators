// Explicit fixed testnet activation. Default never creates a client or private state.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import {
  CommunityError,
  canonical,
  insist,
} from "../../packages/community/common.ts";
import { ActivationJournal } from "./activation-journal.ts";
import {
  privateExistingFile,
  readControllerInventory,
} from "./controller-inventory.ts";
import {
  auditControllerOperation,
  registerControllerOperation,
  readControllerTransaction,
  markControllerOperationPrepared,
} from "./controller-dispatch-catalog.ts";
import {
  compileStudyDeployment,
  type StudyDeploymentArtifact,
} from "./study-deployment-artifact.ts";
import {
  studyActivationPlan,
  activationWindow,
  type StudyActivationProfile,
} from "./study-activation-plan.ts";
import { studyActivationSourceHash } from "./study-activation-source.ts";
import { readActivationReadiness } from "./study-activation-readiness.ts";
import { observeStudyActivation } from "./study-activation-observation.ts";
import { pinStudyActivation } from "./study-activation-pin.ts";
import {
  runStudyActivationOperation,
  studyActivationStatus,
} from "./study-activation-runner.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";
function privateDirectory(path: string) {
  for (let at = path; ; at = dirname(at)) {
    insist(
      !existsSync(join(at, ".git")),
      "study_activation_state_inside_repository",
    );
    if (at === dirname(at)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  insist(
    realpathSync(path) === path &&
      info.isDirectory() &&
      !(info.mode & 0o077) &&
      (!process.getuid || info.uid === process.getuid()),
    "study_activation_state_not_private",
  );
}
export interface StudyActivationPorts {
  artifact?: StudyDeploymentArtifact;
  client?: () => PublicClient;
  transport?: IpfsTransport;
  stateDirectory?: string;
  pinDirectory?: string;
  now?: () => number;
  loadKey?: () => Hex;
  loadPinSecret?: () => Promise<string>;
}
export async function studyActivationMain(
  args = process.argv.slice(2),
  ports: StudyActivationPorts = {},
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      profile: { type: "string" },
      help: { type: "boolean" },
      execute: { type: "boolean" },
      status: { type: "boolean" },
      observe: { type: "boolean" },
      "expect-profile": { type: "string" },
      "key-file": { type: "string" },
    },
  });
  if (values.help)
    return {
      usage:
        "node --experimental-transform-types harness/megaeth/study-activation.ts --profile PUBLIC.json [--observe|--status|--execute --expect-profile HASH --key-file PRIVATE_PATH]",
    };
  insist(
    values.profile &&
      Number(!!values.execute) +
        Number(!!values.status) +
        Number(!!values.observe) <=
        1,
    "study_activation_profile_and_one_mode_required",
  );
  const raw = readFileSync(values.profile);
  insist(raw.length <= 65536, "study_activation_profile_too_large");
  const profile = JSON.parse(raw.toString()) as StudyActivationProfile;
  const artifact =
      ports.artifact ??
      compileStudyDeployment(
        undefined,
        profile.schema === "pirate.study-activation/2" ? 4 : 3,
      ),
    sourceHash = studyActivationSourceHash();
  const plan = await studyActivationPlan(profile, artifact, sourceHash),
    now = ports.now ?? Date.now;
  if (!values.execute)
    insist(
      !values["expect-profile"] && !values["key-file"],
      "study_activation_execution_flags_without_execute",
    );
  if (!values.execute && !values.observe && !values.status)
    return { mode: "plan", ...plan };
  if (values.execute) {
    insist(
      values["expect-profile"] === plan.profileHash && values["key-file"],
      "study_activation_explicit_profile_and_key_path_required",
    );
    activationWindow(profile, now());
  }
  const client =
    ports.client?.() ??
    createPublicClient({
      transport: http("https://carrot.megaeth.com/rpc", {
        retryCount: 0,
        timeout: 15000,
        fetchOptions: { redirect: "error" },
      }),
    });
  const directory =
    ports.stateDirectory ??
    join(
      homedir(),
      ".local/state/pirate-controller/6343",
      profile.controller.toLowerCase(),
    );
  const path = join(directory, plan.profileHash.slice(2) + ".sqlite"),
    operation = plan.operation;
  const stored = existsSync(path)
    ? readControllerTransaction(path, "deployment")
    : undefined;
  const status = await studyActivationStatus(client, operation, stored);
  await auditControllerOperation(client, operation, path);
  if (
    ["confirmed", "confirming", "reverted"].includes(status.state) ||
    values.status
  ) {
    if (status.state === "confirmed")
      await observeStudyActivation(
        client,
        profile,
        artifact,
        plan,
        ports.transport,
        true,
        true,
      );
    return {
      mode: values.execute ? "execute" : values.status ? "status" : "observe",
      profileHash: plan.profileHash,
      ...status,
      complete: status.state === "confirmed",
    };
  }
  const admit = async (requirePin = false) => {
    insist(
      studyActivationSourceHash() === profile.sourceHash,
      "study_activation_source_changed",
    );
    const readiness = readActivationReadiness(profile, now());
    const observation = await observeStudyActivation(
      client,
      profile,
      artifact,
      plan,
      ports.transport,
      false,
      requirePin,
    );
    const inventory = await readControllerInventory(
      client,
      profile,
      BigInt(observation.head.number),
    );
    await auditControllerOperation(client, operation, path);
    insist(
      observation.latestNonce === profile.nonce &&
        (observation.pendingNonce === profile.nonce ||
          (!!stored?.hash && observation.pendingNonce === profile.nonce + 1)),
      "study_activation_nonce_not_quiescent",
    );
    insist(
      (await client.estimateGas({
        account: profile.controller,
        to: operation.to,
        data: operation.data,
      })) <= BigInt(operation.gas),
      "study_activation_gas_limit",
    );
    insist(
      (await client.getBalance({ address: profile.controller })) >=
        BigInt(operation.maximumFeeWei),
      "study_activation_insufficient_balance",
    );
    readActivationReadiness(profile, now());
    return { readiness, observation, inventory };
  };
  const observed = await admit();
  if (values.observe)
    return {
      mode: "observe",
      profileHash: plan.profileHash,
      ...observed,
      ...status,
      complete: false,
    };
  privateDirectory(directory);
  const lease = new ActivationJournal(
    join(directory, "dispatch-custody.sqlite"),
  );
  try {
    await admit();
    // Stable content journal is deliberately outside the signer catalog namespace.
    const pinDirectory =
      ports.pinDirectory ??
      join(
        homedir(),
        ".local/state/pirate-learning-results-testnet-20261106/study-activation-pins",
      );
    const pinPath = join(pinDirectory, plan.pin.sha256.slice(2) + ".sqlite");
    if (stored?.raw) privateExistingFile(pinPath);
    privateDirectory(pinDirectory);
    const pins = new ActivationJournal(pinPath);
    try {
      if (stored?.raw) {
        const saved = pins.get<{ pin: unknown; state: string }>(
          "activation-pin",
        );
        insist(
          saved?.state === "retained" &&
            canonical(saved.pin) === canonical(plan.pin),
          "study_activation_signed_pin_missing",
        );
      } else
        await pinStudyActivation(
          profile,
          plan,
          pins,
          ports.loadPinSecret ??
            (async () => {
              const { infisicalAuth } = await import(
                "../../apps/community-wizard/server/infisical-auth.ts"
              );
              const sdk = await infisicalAuth().client();
              const value = await sdk.secrets().getSecret({
                projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
                environment: "staging",
                secretPath: "/services/api-next",
                secretName: "FILEBASE_IPFS_TOKEN",
                includeImports: false,
                expandSecretReferences: false,
              });
              insist(
                value.secretValue,
                "study_activation_pin_secret_unavailable",
              );
              return value.secretValue;
            }),
          now,
          ports.transport,
        );
    } finally {
      pins.close();
    }
    await admit(true);
    await registerControllerOperation(client, operation, lease, path);
    const journal = new ActivationJournal(path);
    try {
      const result = await runStudyActivationOperation(
        client,
        profile,
        artifact,
        operation,
        journal,
        ports.loadKey ??
          (() => {
            privateExistingFile(values["key-file"]!);
            const key = JSON.parse(readFileSync(values["key-file"]!, "utf8"));
            insist(
              key.chainId === 6343 &&
                typeof key.privateKey === "string" &&
                /^0x[0-9a-f]{64}$/i.test(key.privateKey) &&
                BigInt(key.privateKey) > 1024n,
              "study_activation_key_file_invalid",
            );
            return key.privateKey;
          }),
        (row) =>
          markControllerOperationPrepared(lease, path, row, "deployment"),
        now,
        ports.transport,
      );
      if (result.state === "confirmed")
        await observeStudyActivation(
          client,
          profile,
          artifact,
          plan,
          ports.transport,
          true,
          true,
        );
      return {
        mode: "execute",
        profileHash: plan.profileHash,
        ...result,
        complete: result.state === "confirmed",
      };
    } finally {
      journal.close();
    }
  } finally {
    lease.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  studyActivationMain()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const code =
        error instanceof CommunityError
          ? error.code
          : error instanceof Error &&
              /^[a-z][a-z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "study_activation_failed";
      console.error(code);
      process.exitCode = 1;
    });
