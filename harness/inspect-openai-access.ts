import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { infisicalAuth } from "../apps/community-wizard/server/infisical-auth.ts";
import { canonical, insist } from "../packages/community/common.ts";
import {
  providerFetch,
  providerRequest,
} from "../packages/moderation/provider-http.ts";
import { ownedSourceHashes } from "./content-qualification-source.ts";
import { openAiAccessResult } from "./openai-access-result.ts";

const credential = {
  projectId: "fac45f92-9450-42fb-8c2f-f20d043fdfab",
  environment: "staging",
  secretPath: "/services/api-next",
  secretName: "OPENAI_API_KEY",
};
async function main() {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      "plan-sha256": { type: "string" },
      execute: { type: "boolean" },
    },
    strict: true,
  });
  const directory = values["state-dir"];
  insist(
    directory && isAbsolute(directory),
    "absolute_private_state_directory_required",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  insist(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      !(stat.mode & 0o077) &&
      stat.uid === process.getuid!(),
    "private_state_required",
  );
  const auth = infisicalAuth();
  const plan = {
    schema: "pirate.openai-model-access/1",
    credential,
    secretStoreOrigin: auth.connection.siteUrl,
    authMode: auth.connection.mode,
    request: {
      method: "GET",
      url: "https://api.openai.com/v1/models/gpt-6-luna",
    },
    bounds: { requests: 1, executionSeconds: 120, maxResponseBytes: 8192 },
    sources: await ownedSourceHashes(
      process.cwd(),
      "harness/inspect-openai-access.ts",
    ),
  };
  const planSha256 = createHash("sha256").update(canonical(plan)).digest("hex"),
    lock = await open(join(directory, "access.lock"), "wx", 0o600);
  const save = async (name: string, value: unknown) => {
    const path = join(directory, name),
      temp = path + ".next",
      file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(canonical(value) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    const parent = await open(directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  };
  try {
    const file = join(directory, "journal.json");
    let journal: {
      planSha256: string;
      state: "planned" | "started" | "done";
      requests: number;
      result?: unknown;
    };
    try {
      const metadata = await lstat(file);
      insist(
        metadata.isFile() && !(metadata.mode & 0o077),
        "private_journal_required",
      );
      journal = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      journal = { planSha256, state: "planned", requests: 0 };
      await save("journal.json", journal);
      await save("plan.json", plan);
    }
    insist(journal.planSha256 === planSha256, "access_plan_or_source_changed");
    if (!values.execute) {
      console.log(JSON.stringify({ planSha256, plan }));
      return;
    }
    insist(values["plan-sha256"] === planSha256, "exact_access_plan_required");
    insist(
      journal.state === "planned" && journal.requests === 0,
      "access_request_cannot_repeat",
    );
    const deadline = Date.now() + 120000,
      sdk = await auth.client();
    const secret = await sdk
      .secrets()
      .getSecret({
        ...credential,
        includeImports: false,
        expandSecretReferences: false,
      });
    insist(secret.secretValue, "existing_runtime_key_missing");
    const key = secret.secretValue;
    const request = new Request(plan.request.url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      redirect: "manual",
    });
    journal.state = "started";
    journal.requests = 1;
    await save("journal.json", journal);
    insist(Date.now() < deadline, "access_deadline_expired");
    const outbound = new Request(request, {
      signal: AbortSignal.timeout(deadline - Date.now()),
    });
    insist(Date.now() < deadline, "access_deadline_expired");
    await providerRequest(
      outbound,
      providerFetch,
      async (response) => {
        journal.result = openAiAccessResult(response, key);
        await save("journal.json", journal);
      },
      8192,
    );
    journal.state = "done";
    await save("journal.json", journal);
    console.log(
      JSON.stringify({ planSha256, requests: 1, result: journal.result }),
    );
  } finally {
    await lock.close();
    await unlink(join(directory, "access.lock"));
  }
}
main().catch(() => {
  console.error(
    JSON.stringify({
      error: "model_access_read_failed_or_uncertain",
      detail: "Private journal retained; no retry.",
    }),
  );
  process.exitCode = 1;
});
