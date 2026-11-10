import { createLearningSetup } from "./learning-setup.ts";
import type { LearningSecretStore } from "./learning-secrets.ts";
import { HealthPending } from "./health.ts";
import { DeploymentFailure } from "./diagnostics.ts";
import {
  makePlan,
  object,
  readiness,
  requiredSecrets,
  secretsFrom,
  settingsFrom,
  SetupError,
  type Plan,
  type Settings,
  type SetupState,
} from "./model.ts";
import { loadState, saveState } from "./state.ts";
import type { SecretStore } from "./secrets.ts";

export interface Provisioner {
  digest(): Promise<string>;
  health(plan: Plan): Promise<void>;
  deploy(
    settings: Settings,
    plan: Plan,
    secrets: Record<string, string>,
  ): Promise<void>;
}
export async function createSetup(
  directory: string,
  secrets: SecretStore,
  provisioner: Provisioner,
  learningSecrets?: LearningSecretStore,
) {
  let state = await loadState(directory);
  const learning = await createLearningSetup(directory, learningSecrets);
  let busy = false;
  let job: Promise<void> | undefined;
  let connected = false;
  function checkSecretSite() {
    if (!secrets.connection) return;
    if (
      state.secretStoreSite &&
      state.secretStoreSite !== secrets.connection.siteUrl
    )
      throw new SetupError(
        "This setup is bound to another Infisical instance. Restore the original runner configuration; changing stores requires a custom migration.",
        409,
      );
  }
  function requireConnection() {
    checkSecretSite();
    if (secrets.connection && (!connected || !state.secretStoreSite))
      throw new SetupError(
        "Connect Infisical for the saved project and folder first.",
        409,
      );
  }
  const persist = () => saveState(directory, state);
  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (busy)
      throw new SetupError(
        "Another setup step is running. Wait for it to finish.",
        409,
      );
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
  return {
    snapshot() {
      return structuredClone({
        ...state,
        busy,
        readiness: readiness(state),
        learning: learning.snapshot(),
        infisical: secrets.connection
          ? { ...secrets.connection, connected }
          : undefined,
      });
    },
    configureLearning: (input: unknown) =>
      locked(() => learning.configure(input)),
    connectLearningSecrets: () => locked(() => learning.connect()),
    saveLearningSecrets: (input: unknown) => locked(() => learning.save(input)),
    reviewLearning: () =>
      locked(async () => learning.review(`0x${await provisioner.digest()}`)),
    async configure(input: unknown) {
      return locked(async () => {
        const settings = settingsFrom(input);
        if (
          state.attempted &&
          JSON.stringify(settings) !== JSON.stringify(state.settings)
        ) {
          throw new SetupError(
            "This deployment has started. V1 setup is fixed; domain or service changes require a custom migration. Preserve this state for recovery.",
            409,
          );
        }
        if (JSON.stringify(settings) === JSON.stringify(state.settings)) return;
        const old = state.settings;
        const sameScope =
          old &&
          old.projectId === settings.projectId &&
          old.environment === settings.environment &&
          old.secretPath === settings.secretPath;
        if (!sameScope) connected = false;
        state = {
          ...state,
          settings,
          secrets: sameScope ? state.secrets : [],
          secretStoreSite: sameScope ? state.secretStoreSite : undefined,
          revision: state.revision + 1,
          plan: undefined,
        };
        await persist();
      });
    },
    async connectSecrets() {
      return locked(async () => {
        if (!state.settings || state.settings.moderationMode !== "independent")
          throw new SetupError(
            "Save independent-mode settings before connecting Infisical.",
            409,
          );
        if (!secrets.prepare || !secrets.connection)
          throw new SetupError(
            "Infisical connection is unavailable on this runner.",
            409,
          );
        connected = false;
        checkSecretSite();
        await secrets.prepare(state.settings);
        if (!state.secretStoreSite) {
          state.secretStoreSite = secrets.connection.siteUrl;
          state.revision++;
          state.plan = undefined;
        }
        await persist();
        connected = true;
      });
    },
    async saveSecrets(input: unknown) {
      return locked(async () => {
        if (!state.settings)
          throw new SetupError("Save community settings first.");
        if (state.settings.moderationMode !== "independent")
          throw new SetupError(
            "Provider keys belong to the managed operator, not this community.",
            409,
          );
        const values = secretsFrom(input);
        requireConnection();
        state.plan = undefined;
        state.revision++;
        state.secrets = [];
        if (state.attempted) {
          state.deployment = "update_pending";
          state.message =
            "Credential changes need a reviewed redeployment before they reach the Worker.";
        }
        await persist();
        try {
          state.secrets = await secrets.save(state.settings, values);
        } catch (error) {
          connected = false;
          throw error;
        }
        await persist();
      });
    },
    async review() {
      return locked(async () => {
        if (!state.settings)
          throw new SetupError("Save community settings first.");
        const plan = makePlan(
          state.settings,
          state.revision,
          await provisioner.digest(),
        );
        if (state.attempted && state.plan && plan.id !== state.plan.id) {
          state.deployment = "update_pending";
          state.message =
            "The reviewed source changed. Deploy this plan to update the existing resources.";
        }
        state.plan = plan;
        await persist();
      });
    },
    async deploy(input: unknown) {
      if (busy) throw new SetupError("Another setup step is running.", 409);
      if (learning.snapshot().settings)
        throw new SetupError(
          "Learning setup requires coordinator review and Alchemy integration before deployment. Export the learning plan for review.",
          409,
        );
      const { planId } = object(input);
      if (!state.settings || !state.plan || planId !== state.plan.id)
        throw new SetupError("Review the current plan before deploying.", 409);
      if (
        !requiredSecrets(state.settings).every((k) => state.secrets.includes(k))
      )
        throw new SetupError(
          "Save all required credentials to Infisical first.",
          409,
        );
      busy = true;
      try {
        const plan = makePlan(
          state.settings,
          state.revision,
          await provisioner.digest(),
        );
        if (plan.id !== state.plan.id)
          throw new SetupError(
            "Deployment source changed. Review a new plan.",
            409,
          );
        const settings = state.settings;
        const healthOnly = state.deployment === "health_pending";
        if (!healthOnly && requiredSecrets(settings).length)
          requireConnection();
        state.attempted = true;
        state.deployment = "running";
        state.message = healthOnly
          ? "Waiting for the expected HTTPS deployment receipt; infrastructure will not be recreated."
          : "Reconciling the reviewed resources with Alchemy and the selected service configuration.";
        await persist();
        job = (async () => {
          try {
            if (healthOnly) await provisioner.health(plan);
            else {
              const values = requiredSecrets(settings).length
                ? await secrets.read(settings)
                : {};
              await provisioner.deploy(settings, plan, values);
            }
            state.deployment = "provisioned";
            state.message =
              "Alchemy completed. The setup page is provisioned; first-song integrations remain pending.";
          } catch (error) {
            connected = false;
            state.deployment =
              error instanceof HealthPending ? "health_pending" : "failed";
            state.message =
              error instanceof HealthPending ||
              error instanceof DeploymentFailure
                ? error.message
                : "Provisioning did not complete. Check account access, Infisical scope and the private Alchemy state. Retry the same plan; existing resources are preserved.";
          }
          await persist();
        })().finally(() => {
          busy = false;
        });
        // Never emit provider errors: they can contain request headers and secrets.
        void job.catch(() => {
          state.deployment = "failed";
          state.message =
            "Could not save deployment status. Preserve the state directory before recovery.";
        });
      } catch (error) {
        busy = false;
        throw error;
      }
    },
    async settled() {
      await job;
    },
  };
}
export type Setup = Awaited<ReturnType<typeof createSetup>>;
