import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  communitySetupFrom,
  communitySetupPlan,
  learningSecretValues,
  type CommunitySetupV1,
  type LearningSecretName,
} from "../../../packages/community-setup/manifest.ts";
import {
  createInfisicalLearningStore,
  type LearningSecretStore,
} from "./learning-secrets.ts";
import { SetupError } from "./model.ts";
export async function createLearningSetup(
  directory: string,
  store: LearningSecretStore = createInfisicalLearningStore(),
) {
  type Plan = ReturnType<typeof communitySetupPlan>;
  let settings: CommunitySetupV1 | undefined,
    saved: LearningSecretName[] = [],
    plan: Plan | undefined;
  let boundSite: string | undefined,
    connected = false;
  const path = join(directory, "learning-setup.json");
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (value.version !== 1)
      throw new Error("Unsupported learning setup state.");
    settings = communitySetupFrom(value.settings);
    boundSite = value.siteUrl;
    // Saved names are historical observations. Reconnect rechecks the scope.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const persist = async () => {
    await writeFile(
      path + ".tmp",
      JSON.stringify({ version: 1, settings, siteUrl: boundSite }) + "\n",
      { mode: 0o600 },
    );
    await chmod(path + ".tmp", 0o600);
    await rename(path + ".tmp", path);
  };
  const configured = () => {
    if (!settings) throw new SetupError("Save learning settings first.", 409);
    return settings;
  };
  function site() {
    if (boundSite && boundSite !== store.siteUrl)
      throw new SetupError(
        "Restore the original Infisical instance before continuing.",
        409,
      );
  }
  return {
    snapshot: () =>
      structuredClone({
        version: 1 as const,
        settings,
        saved,
        connected,
        plan,
        status: "review_only" as const,
        infisicalSite: store.siteUrl,
        telegram: {
          enabled: settings?.telegram.enabled ?? false,
          botId: settings?.telegram.botId ?? "",
          tokenSaved: saved.includes("TELEGRAM_BOT_TOKEN"),
          health: "unverified" as const,
        },
        acceptance: {
          credentials:
            connected &&
            saved.includes("ELEVENLABS_API_KEY") &&
            (!settings?.telegram.enabled ||
              saved.includes("TELEGRAM_BOT_TOKEN")),
          songs: !!settings?.songs.length,
          deployment: false,
        },
      }),
    async configure(input: unknown) {
      const next = communitySetupFrom(input);
      if (JSON.stringify(next) !== JSON.stringify(settings)) {
        connected = false;
        saved = [];
        plan = undefined;
      }
      settings = next;
      await persist();
    },
    async connect() {
      const s = configured();
      site();
      connected = false;
      saved = [];
      plan = undefined;
      try {
        saved = await store.check(s);
        boundSite = store.siteUrl;
        await persist();
        connected = true;
      } catch {
        throw new SetupError(
          "Could not verify the community Infisical folder. Check managed login and folder access.",
          409,
        );
      }
    },
    async save(input: unknown) {
      const s = configured();
      site();
      if (!connected)
        throw new SetupError(
          "Connect the saved community Infisical scope first.",
          409,
        );
      const values = learningSecretValues(input, s.telegram.enabled);
      plan = undefined;
      saved = [];
      try {
        saved = await store.save(s, values);
      } catch {
        connected = false;
        throw new SetupError(
          "Credential save was not confirmed. Some values may be saved; reconnect and retry. Provider details are withheld.",
          502,
        );
      }
    },
    async review(sourceDigest: string) {
      const s = configured();
      site();
      if (
        !connected ||
        !saved.includes("ELEVENLABS_API_KEY") ||
        (s.telegram.enabled && !saved.includes("TELEGRAM_BOT_TOKEN"))
      )
        throw new SetupError(
          "Confirm required credentials through managed Infisical first.",
          409,
        );
      plan = communitySetupPlan(s, sourceDigest);
      return plan;
    },
  };
}
