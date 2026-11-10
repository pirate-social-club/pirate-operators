// Public plan by default. The live adapter is dynamically imported only for explicit modes.
import { open } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { operatorPlan, operatorProfile } from "./study-operator-profile.ts";
import {
  runOperator,
  type OperatorRunnerPorts,
} from "./study-operator-runner.ts";
import { insist, CommunityError } from "../packages/community/common.ts";
async function readPublic(path: string) {
  const handle = await open(path, "r"),
    bytes = Buffer.alloc(65537);
  let size = 0;
  try {
    while (size < bytes.length) {
      const part = await handle.read(bytes, size, bytes.length - size, null);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
  } finally {
    await handle.close();
  }
  insist(size <= 65536, "study_operator_profile_too_large", 409);
  return operatorProfile(JSON.parse(bytes.subarray(0, size).toString("utf8")));
}
export async function main(
  args = process.argv.slice(2),
  io: {
    readPublic?: typeof readPublic;
    loadLive?: () => Promise<{
      makeLiveOperatorPorts: () => OperatorRunnerPorts;
    }>;
    print?: (text: string) => void;
  } = {},
) {
  const { values } = parseArgs({
    args,
    options: {
      profile: { type: "string" },
      help: { type: "boolean" },
      preflight: { type: "boolean" },
      "cloud-plan": { type: "boolean" },
      execute: { type: "boolean" },
      "expected-profile": { type: "string" },
    },
  });
  const print = io.print ?? console.log;
  if (values.help || !values.profile) {
    print(
      "Usage: node harness/study-operator-release.ts --profile PUBLIC_PROFILE.json [--preflight | --cloud-plan --expected-profile HASH | --execute --expected-profile HASH]\nDefault public plan reads no keys, private journals, credentials or network and creates no state. Explicit cloud-plan authenticates and preserves existing state, loads managed secrets and runs Alchemy plan only.",
    );
    return;
  }
  insist(
    [values.preflight, values["cloud-plan"], values.execute].filter(Boolean)
      .length <= 1,
    "study_operator_conflicting_modes",
    409,
  );
  const profile = await (io.readPublic ?? readPublic)(values.profile),
    plan = operatorPlan(profile);
  if (!values.preflight && !values["cloud-plan"] && !values.execute) {
    print(JSON.stringify(plan, null, 2));
    return plan;
  }
  if (values.execute || values["cloud-plan"])
    insist(
      values["expected-profile"] === plan.profileHash,
      "study_operator_profile_not_reviewed",
      409,
    );
  const live = await (
    io.loadLive ?? (() => import("./study-operator-live.ts"))
  )();
  const result = await runOperator(
    profile,
    values.execute
      ? "execute"
      : values["cloud-plan"]
        ? "cloud-plan"
        : "preflight",
    live.makeLiveOperatorPorts(),
    values["expected-profile"],
  );
  print(JSON.stringify(result, null, 2));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      error instanceof CommunityError
        ? error.code
        : "study_operator_release_failed",
    );
    process.exitCode = 1;
  });
