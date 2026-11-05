import { pathToFileURL } from "node:url";
import {
  createPlan,
  canonical,
  digest,
  requireThat,
  SetupFailure,
} from "./model.ts";
import { withJournal, readPrivate } from "./journal.ts";
import { Context } from "./http.ts";
import { authenticatedSdk, createVault } from "./vault.ts";
import { provisionAcr, qualifyAcr } from "./acrcloud.ts";
import { provisionOpenAi, qualifyOpenAi } from "./openai.ts";
import {
  filebaseClient,
  provisionFilebase,
  qualifyFilebase,
} from "./filebase.ts";

export async function main(args: string[]): Promise<Record<string, unknown>> {
  if (args.length === 0 || args[0] === "--help")
    return {
      usage:
        "node tooling/provider-setup/run.ts init|status|provision|qualify --state-dir /private/path [--profile /private/profile.json] [--provider filebase|acrcloud|openai] [--execute --approve PLAN_DIGEST]",
      credentials:
        "Infisical CLI login; bootstrap keys stay in the selected vault folder. No secret arguments.",
    };
  const [command, ...rest] = args;
  requireThat(
    ["init", "status", "provision", "qualify"].includes(command),
    "unknown_command",
  );
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i];
    requireThat(
      [
        "--state-dir",
        "--profile",
        "--provider",
        "--execute",
        "--approve",
      ].includes(key) && !(key in options),
      "unknown_or_duplicate_option",
    );
    if (key === "--execute") options[key] = "true";
    else {
      requireThat(
        rest[i + 1] && !rest[i + 1].startsWith("--"),
        "option_value_required",
      );
      options[key] = rest[++i];
    }
  }
  requireThat(options["--state-dir"], "state_directory_required");
  const provider = options["--provider"] ?? "filebase";
  requireThat(
    ["filebase", "acrcloud", "openai"].includes(provider),
    "unknown_provider",
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    return await withJournal(options["--state-dir"], async (store) => {
      if (command === "init") {
        requireThat(
          options["--profile"] &&
            !options["--execute"] &&
            !options["--approve"],
          "init_profile_required",
        );
        const bytes = await readPrivate(options["--profile"], 16384);
        await store.initialize(
          createPlan(JSON.parse(Buffer.from(bytes).toString())),
        );
        return store.summary();
      }
      requireThat(!options["--profile"], "profile_is_immutable_use_saved_plan");
      await store.load();
      if (command === "status" || !options["--execute"])
        return {
          ...store.summary(),
          execution: "none",
          selectedProvider: provider,
        };
      requireThat(
        store.journal &&
          options["--approve"] === digest(canonical(store.journal.plan)),
        "exact_plan_approval_required",
      );
      const vault = await createVault(
        store.journal.plan,
        await authenticatedSdk(),
      );
      const ctx = new Context(store, vault, undefined, controller.signal);
      if (provider === "acrcloud")
        await (command === "provision" ? provisionAcr(ctx) : qualifyAcr(ctx));
      if (provider === "openai")
        await (command === "provision"
          ? provisionOpenAi(ctx)
          : qualifyOpenAi(ctx));
      if (provider === "filebase") {
        const client = await filebaseClient(ctx);
        try {
          await (command === "provision"
            ? provisionFilebase(ctx, client)
            : qualifyFilebase(ctx, client));
        } finally {
          client.destroy();
        }
      }
      return store.summary();
    });
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.stdout.write(
      JSON.stringify(await main(process.argv.slice(2)), null, 2) + "\n",
    );
  } catch (error) {
    const code =
      error instanceof SetupFailure
        ? error.code
        : "setup_failed_details_withheld";
    process.stderr.write(JSON.stringify({ error: code }) + "\n");
    process.exitCode = 1;
  }
}
