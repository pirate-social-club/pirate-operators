// Manual opt-in execution. Default plan creates no RPC client or execution state.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  http,
  keccak256,
  type Hex,
  type PublicClient,
} from "viem";
import { CommunityError, insist } from "../../packages/community/common.ts";
import { ActivationJournal } from "./activation-journal.ts";
import {
  privateExistingFile,
  readControllerInventory,
} from "./controller-inventory.ts";
import {
  auditControllerOperation,
  markControllerOperationPrepared,
  readControllerTransaction,
  registerControllerOperation,
} from "./controller-dispatch-catalog.ts";
import {
  compileStudyDeployment,
  type StudyDeploymentArtifact,
} from "./study-deployment-artifact.ts";
import {
  studyDeploymentPlan,
  studyDeploymentWindow,
  type StudyDeploymentProfile,
} from "./study-deployment-plan.ts";
import { observeStudyDeployment } from "./study-deployment-observation.ts";
import {
  runStudyDeploymentOperation,
  studyDeploymentStatus,
} from "./study-deployment-runner.ts";
import type { IpfsTransport } from "../../packages/community/ipfs.ts";

function writableDirectory(path: string) {
  for (let p = path; ; p = dirname(p)) {
    insist(
      !existsSync(join(p, ".git")),
      "study_deployment_state_inside_repository",
    );
    if (p === dirname(p)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const info = lstatSync(path);
  insist(
    realpathSync(path) === path &&
      info.isDirectory() &&
      !(info.mode & 0o077) &&
      (!process.getuid || info.uid === process.getuid()),
    "study_deployment_state_not_private",
  );
}
export interface StudyDeploymentPorts {
  artifact?: StudyDeploymentArtifact;
  client?: () => PublicClient;
  stateDirectory?: string;
  transport?: IpfsTransport;
  now?: () => number;
}
export async function studyDeploymentMain(
  args = process.argv.slice(2),
  ports: StudyDeploymentPorts = {},
) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      profile: { type: "string" },
      execute: { type: "boolean" },
      status: { type: "boolean" },
      observe: { type: "boolean" },
      "expect-profile": { type: "string" },
      "key-file": { type: "string" },
    },
  });
  insist(
    values.profile &&
      Number(!!values.execute) +
        Number(!!values.status) +
        Number(!!values.observe) <=
        1,
    "usage_study_deployment_profile_required",
  );
  const profile: StudyDeploymentProfile = JSON.parse(
    readFileSync(values.profile, "utf8"),
  );
  const artifact = ports.artifact ?? compileStudyDeployment();
  const plan = studyDeploymentPlan(profile, artifact);
  if (!values.execute && !values.status && !values.observe) {
    insist(
      !values["key-file"] && !values["expect-profile"],
      "study_deployment_execution_flags_without_execute",
    );
    return { mode: "plan", ...plan };
  }
  if (values.execute) {
    insist(
      values["expect-profile"] === plan.profileHash && values["key-file"],
      "study_deployment_explicit_profile_and_key_path_required",
    );
    studyDeploymentWindow(profile, (ports.now ?? (() => Date.now()))());
  } else
    insist(
      !values["key-file"] && !values["expect-profile"],
      "study_deployment_execution_flags_without_execute",
    );
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
      ".local/state/pirate-controller",
      "6343",
      profile.controller.toLowerCase(),
    );
  const status = [];
  let lease: ActivationJournal | undefined;
  try {
    for (const operation of plan.operations) {
      const path = join(directory, operation.profileHash.slice(2) + ".sqlite");
      const stored = existsSync(path)
        ? readControllerTransaction(path, "deployment")
        : undefined;
      const state = await studyDeploymentStatus(client, operation, stored);
      if (values.status) {
        status.push({ step: operation.step, ...state });
        continue;
      }
      if (state.state === "confirmed") {
        // A later operation in this plan may be pending. Audit at that current
        // frontier, rather than treating it as unrelated to an old prefix.
        status.push({ step: operation.step, ...state });
        continue;
      }
      if (["confirming", "reverted"].includes(state.state)) {
        await auditControllerOperation(client, operation, path);
        return {
          mode: values.execute ? "execute" : "observe",
          profileHash: plan.profileHash,
          status: [...status, { step: operation.step, ...state }],
          complete: false,
        };
      }
      const observation = await observeStudyDeployment(
        client,
        profile,
        artifact,
        operation,
        ports.transport,
      );
      const inventory = await readControllerInventory(
        client,
        profile,
        BigInt(observation.head.number),
      );
      if (values.observe) {
        const catalog = await auditControllerOperation(client, operation, path);
        return {
          mode: "observe",
          profileHash: plan.profileHash,
          next: operation.step,
          observation,
          inventory,
          catalog,
          status,
          complete: false,
        };
      }
      if (!lease) {
        writableDirectory(directory);
        lease = new ActivationJournal(
          join(directory, "dispatch-custody.sqlite"),
        );
      }
      await registerControllerOperation(client, operation, lease, path);
      const journal = new ActivationJournal(path);
      try {
        const result = await runStudyDeploymentOperation(
          client,
          profile,
          artifact,
          operation,
          journal,
          () => {
            privateExistingFile(values["key-file"]!);
            let key: { chainId?: number; privateKey?: Hex };
            try {
              key = JSON.parse(readFileSync(values["key-file"]!, "utf8"));
            } catch {
              throw new Error("study_deployment_key_unreadable");
            }
            insist(key.chainId === 6343, "study_deployment_key_wrong_chain");
            insist(
              typeof key.privateKey === "string" &&
                /^0x[0-9a-f]{64}$/i.test(key.privateKey) &&
                BigInt(key.privateKey) > 1024n,
              "study_deployment_fixture_key_refused",
            );
            return key.privateKey;
          },
          (row) =>
            markControllerOperationPrepared(lease!, path, row, "deployment"),
          ports.now ?? (() => Date.now()),
          ports.transport,
        );
        status.push({ step: operation.step, ...result });
        if (result.state !== "confirmed")
          return {
            mode: "execute",
            profileHash: plan.profileHash,
            status,
            complete: false,
          };
      } finally {
        journal.close();
      }
    }
    // Audit one current status frontier or the final completed operation. The
    // original unrelated-profile, orphan and prepared-journal guards still run.
    const unsettled = status.findIndex((row) => row.state !== "confirmed");
    const frontier =
      plan.operations[unsettled < 0 ? plan.operations.length - 1 : unsettled];
    await auditControllerOperation(
      client,
      frontier,
      join(directory, frontier.profileHash.slice(2) + ".sqlite"),
    );
    return {
      mode: values.status ? "status" : values.observe ? "observe" : "execute",
      profileHash: plan.profileHash,
      status,
      complete:
        status.length === 5 && status.every((row) => row.state === "confirmed"),
      contract: profile.contract,
      ...(values.status
        ? {}
        : {
            codeHash: keccak256(
              (await client.getCode({ address: profile.contract })) ?? "0x",
            ),
          }),
      directoryActivation:
        "separate reviewed operation after compatible readers and application",
    };
  } finally {
    lease?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  studyDeploymentMain()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const code =
        error instanceof CommunityError
          ? error.code
          : error instanceof Error &&
              /^[a-z][a-z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "study_deployment_failed";
      console.error(code);
      process.exitCode = 1;
    });
