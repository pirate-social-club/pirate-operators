// One managed public-policy pin. Default preparation has no remote/private effects.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  preparePin,
  addPin,
  reconcilePin,
  type PinIntent,
} from "../packages/community/ipfs.ts";
import { canonical, insist } from "../packages/community/common.ts";
import { studyQualificationPolicy } from "../packages/records/study-qualification.ts";
import { retainedLearningOperator } from "./study-release-profile.ts";

export async function studyPolicyPinPlan() {
  const bytes = new TextEncoder().encode(
    canonical(studyQualificationPolicy([retainedLearningOperator.publisher])),
  );
  const pin = await preparePin(bytes, "application/json");
  return {
    schema: "pirate.study-policy-pin/1",
    pin,
    bytes,
    maximumAdds: 1 as const,
  };
}
export interface SavedPin {
  uri: string;
  sha256: string;
  state: "prepared" | "received" | "unknown" | "retained";
  receipt?: unknown;
}
export interface PolicyPinPorts {
  now(): number;
  read(): Promise<unknown>;
  save(value: SavedPin): Promise<void>;
  secret(): Promise<string>;
  add(
    pin: PinIntent,
    bytes: Uint8Array,
    secret: string,
    receipt: (value: unknown) => Promise<void>,
  ): Promise<unknown>;
  reconcile(pin: PinIntent, secret: string): Promise<unknown>;
}
function pinWindow(notBefore: string, deadline: string, now: number) {
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  const start = Date.parse(notBefore),
    end = Date.parse(deadline);
  insist(
    utc.test(notBefore) &&
      utc.test(deadline) &&
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start &&
      end - start <= 900000 &&
      now >= start &&
      now < end,
    "study_policy_pin_window_expired",
    409,
  );
}
function savedPin(value: unknown, pin: PinIntent): SavedPin | undefined {
  if (value === undefined) return;
  insist(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "study_policy_pin_journal_changed",
    409,
  );
  const saved = value as Record<string, unknown>;
  insist(
    saved.uri === pin.uri &&
      saved.sha256 === pin.sha256 &&
      typeof saved.state === "string" &&
      ["prepared", "received", "unknown", "retained"].includes(saved.state) &&
      Object.keys(saved).every((key) =>
        ["uri", "sha256", "state", "receipt"].includes(key),
      ),
    "study_policy_pin_journal_changed",
    409,
  );
  return saved as unknown as SavedPin;
}
export async function pinStudyPolicy(
  bounds: { expectedSha256: string; notBefore: string; deadline: string },
  ports: PolicyPinPorts,
) {
  const plan = await studyPolicyPinPlan();
  insist(
    bounds.expectedSha256 === plan.pin.sha256,
    "study_policy_pin_changed",
    409,
  );
  const window = () =>
    pinWindow(bounds.notBefore, bounds.deadline, ports.now());
  window();
  const previous = savedPin(await ports.read(), plan.pin);
  let latest = previous;
  const secret = await ports.secret();
  window();
  if (previous) {
    // Even an uncertain first add is reconciled only; never add again on retry.
    await ports.reconcile(plan.pin, secret);
  } else {
    const saved: SavedPin = {
      uri: plan.pin.uri,
      sha256: plan.pin.sha256,
      state: "prepared",
    };
    await ports.save(saved);
    latest = saved;
    window();
    try {
      await ports.add(plan.pin, plan.bytes, secret, async (receipt) => {
        latest = { ...saved, state: "received", receipt };
        await ports.save(latest);
      });
    } catch (error) {
      await ports.save({ ...latest!, state: "unknown" });
      throw error;
    }
  }
  await ports.save({ ...latest!, state: "retained" });
  return { ...plan.pin, state: "retained", maximumAdds: 1 };
}
export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      execute: { type: "boolean" },
      "expected-sha256": { type: "string" },
      "not-before": { type: "string" },
      deadline: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node --experimental-transform-types harness/study-policy-pin.ts [--execute --expected-sha256 HASH --not-before UTC --deadline UTC]",
    );
    return;
  }
  const plan = await studyPolicyPinPlan();
  if (!values.execute) {
    console.log(
      JSON.stringify({
        schema: plan.schema,
        ...plan.pin,
        maximumAdds: 1,
        executionReady: false,
      }),
    );
    return;
  }
  insist(
    values["expected-sha256"] === plan.pin.sha256 &&
      values["not-before"] &&
      values.deadline,
    "study_policy_pin_bounds_required",
    409,
  );
  pinWindow(values["not-before"], values.deadline, Date.now());
  const { ActivationJournal } = await import("./megaeth/activation-journal.ts");
  const journal = new ActivationJournal(
    join(
      homedir(),
      ".local/state/pirate-learning-results-testnet-20261106/study-policy-pins",
      plan.pin.sha256 + ".sqlite",
    ),
  );
  try {
    const result = await pinStudyPolicy(
      {
        expectedSha256: values["expected-sha256"],
        notBefore: values["not-before"],
        deadline: values.deadline,
      },
      {
        now: Date.now,
        read: async () => journal.get<SavedPin>("policy-pin"),
        save: async (value) => journal.set("policy-pin", value),
        secret: async () => {
          const { infisicalAuth } = await import(
            "../apps/community-wizard/server/infisical-auth.ts"
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
          insist(value.secretValue, "study_policy_pin_secret_unavailable", 503);
          return value.secretValue;
        },
        add: addPin,
        reconcile: reconcilePin,
      },
    );
    console.log(JSON.stringify(result));
  } finally {
    journal.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error("study_policy_pin_failed");
    process.exitCode = 1;
  });
