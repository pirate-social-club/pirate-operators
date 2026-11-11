import { createSignal, For, Show } from "solid-js";
import type { Snapshot } from "./types.ts";
import type {
  CommunitySetupV1,
  LearningSecretName,
} from "../../../packages/community-setup/manifest.ts";

type Props = {
  state: Snapshot;
  busy: boolean;
  action: (path: string, value: unknown) => Promise<void>;
};
const blank = (): CommunitySetupV1 => ({
  version: 1,
  communityId: "",
  slug: "",
  accountId: "",
  origin: "",
  operatorOrigin: "",
  chainId: 6343,
  resultsContract: "",
  owner: "",
  grader: "",
  infisical: {
    projectId: "",
    environment: "dev",
    secretPath: "/communities/community/learning",
  },
  limits: {
    sponsorWei: "1000000000000000000",
    gasPriceWei: "10000000000",
    gasLimit: "2000000",
    dataFeeWei: "0",
    activationTotalWei: "800000000000000000",
    activationAccountWei: "40000000000000000",
    activationAccounts: 20,
    speechDailyUnits: 200,
    websiteReservedUnits: 100,
    telegramDailyUnits: 0,
    perAccountDailyUnits: 20,
    providerMonthlyBudgetUsdCents: 1000,
  },
  telegram: { enabled: false, botId: "", generation: 1 },
  songs: [],
});
export function LearningSetup(props: Props) {
  const [draft, setDraft] = createSignal<CommunitySetupV1>(
    structuredClone(props.state.learning.settings ?? blank()),
  );
  const [values, setValues] = createSignal<
    Partial<Record<LearningSecretName, string>>
  >({});
  const dirty = () =>
    JSON.stringify(draft()) !== JSON.stringify(props.state.learning.settings);
  const field = (
    label: string,
    value: () => string | number,
    update: (v: string) => void,
    numeric = false,
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        value={value()}
        type={numeric ? "number" : "text"}
        required
        disabled={props.busy}
        onInput={(e) => update(e.currentTarget.value)}
      />
    </label>
  );
  const textField = (
    key:
      | "communityId"
      | "slug"
      | "accountId"
      | "origin"
      | "operatorOrigin"
      | "resultsContract"
      | "owner"
      | "grader",
    label: string,
  ) =>
    field(
      label,
      () => draft()[key],
      (v) => setDraft((s) => ({ ...s, [key]: v })),
    );
  return (
    <section aria-label="Community learning setup">
      <h2>Learning in your community</h2>
      <p class="lede">
        Your community pays for speech and first-use account setup. Save its own
        credentials in Infisical and prepare a bounded testnet plan for review.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setValues({});
          void props.action("learning/settings", draft());
        }}
      >
        <div class="card">
          <h3>Community and permissions</h3>
          <p>
            Use the reviewed contract and public addresses. Enter credentials
            only in the managed secrets form below.
          </p>
          {textField("slug", "Community deployment ID")}
          {textField("communityId", "Community ID")}
          {textField("accountId", "Community Cloudflare account ID")}
          {textField("origin", "Community HTTPS origin")}
          {textField("operatorOrigin", "Learning operator HTTPS origin")}
          {textField("resultsContract", "Learning results contract")}
          {textField("owner", "Community owner address")}
          {textField("grader", "Dedicated grader address")}
        </div>
        <div class="card">
          <h3>Community Infisical scope</h3>
          <For
            each={
              [
                ["projectId", "Infisical project UUID"],
                ["environment", "Infisical environment"],
                ["secretPath", "Community learning secret folder"],
              ] as const
            }
          >
            {([key, label]) =>
              field(
                label,
                () => draft().infisical[key],
                (v) =>
                  setDraft((s) => ({
                    ...s,
                    infisical: { ...s.infisical, [key]: v },
                  })),
              )
            }
          </For>
          <p>
            Use an existing dedicated folder. Managed login belongs to this
            runner; platform Telegram login credentials are separate.
          </p>
        </div>
        <div class="card">
          <h3>Spending and speech limits</h3>
          <p>
            Initial values are a proposal: 20 first-use accounts, 200 speech
            units per day, 100 reserved for website Study and a $10 monthly
            provider ceiling. Review the gas bounds and provider-side spending
            controls before activation.
          </p>
          <For
            each={
              Object.keys(
                draft().limits,
              ) as (keyof CommunitySetupV1["limits"])[]
            }
          >
            {(key) =>
              field(
                {
                  sponsorWei: "Lifetime transaction budget (wei)",
                  gasPriceWei: "Maximum gas price (wei)",
                  gasLimit: "Maximum gas per transaction",
                  dataFeeWei: "Maximum data fee (wei)",
                  activationTotalWei: "Total first-use budget (wei)",
                  activationAccountWei: "First-use budget per account (wei)",
                  activationAccounts: "Maximum new accounts",
                  speechDailyUnits: "Daily speech units",
                  websiteReservedUnits: "Units reserved for website Study",
                  telegramDailyUnits: "Daily Telegram units",
                  perAccountDailyUnits: "Daily units per account",
                  providerMonthlyBudgetUsdCents:
                    "Monthly provider ceiling (USD cents)",
                }[key],
                () => draft().limits[key],
                (v) =>
                  setDraft((s) => ({
                    ...s,
                    limits: {
                      ...s.limits,
                      [key]: typeof s.limits[key] === "number" ? Number(v) : v,
                    },
                  })),
                typeof draft().limits[key] === "number",
              )
            }
          </For>
        </div>
        <div class="card">
          <h3>Telegram · optional</h3>
          <label class="check">
            <input
              type="checkbox"
              disabled={props.busy}
              checked={draft().telegram.enabled}
              onChange={(e) => {
                const enabled = e.currentTarget.checked;
                setDraft((s) => ({
                  ...s,
                  telegram: {
                    ...s.telegram,
                    enabled,
                    botId: enabled ? s.telegram.botId : "",
                  },
                  limits: {
                    ...s.limits,
                    telegramDailyUnits: enabled
                      ? s.limits.telegramDailyUnits
                      : 0,
                  },
                }));
              }}
            />
            Enable a community bot
          </label>
          <Show when={draft().telegram.enabled}>
            {field(
              "Community bot ID",
              () => draft().telegram.botId,
              (v) =>
                setDraft((s) => ({
                  ...s,
                  telegram: { ...s.telegram, botId: v },
                })),
            )}
            {field(
              "Bot generation",
              () => draft().telegram.generation,
              (v) =>
                setDraft((s) => ({
                  ...s,
                  telegram: { ...s.telegram, generation: Number(v) },
                })),
              true,
            )}
          </Show>
          <p>
            Connecting or replacing a bot requires the Telegram integration
            review. Bot health stays unverified until checked.
          </p>
        </div>
        <button type="submit" class="primary" disabled={props.busy}>
          Save learning settings
        </button>
      </form>
      <Show when={props.state.learning.settings}>
        <Show when={dirty()}>
          <p role="status">
            Save changed learning settings before managing credentials or
            preparing a plan.
          </p>
        </Show>
        <div class="card">
          <h3>Managed community credentials</h3>
          <button
            class="secondary"
            disabled={props.busy || dirty()}
            onClick={() => void props.action("learning/infisical/connect", {})}
          >
            Connect and check Infisical
          </button>
          <p>
            Connection: {props.state.learning.connected ? "verified" : "needed"}
            . Bot: {props.state.learning.telegram.health}.
          </p>
          <form
            autocomplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              const payload = { ...values() };
              setValues({});
              void props.action("learning/secrets", payload);
            }}
          >
            <For
              each={
                props.state.learning.settings?.telegram.enabled
                  ? (["ELEVENLABS_API_KEY", "TELEGRAM_BOT_TOKEN"] as const)
                  : (["ELEVENLABS_API_KEY"] as const)
              }
            >
              {(name) => (
                <label class="field">
                  <span>
                    {name === "ELEVENLABS_API_KEY"
                      ? "ElevenLabs API key"
                      : "Community bot token"}{" "}
                    ·{" "}
                    {props.state.learning.saved.includes(name)
                      ? "saved ••••"
                      : "needed"}
                  </span>
                  <input
                    type="password"
                    autocomplete="new-password"
                    spellcheck={false}
                    disabled={
                      props.busy || dirty() || !props.state.learning.connected
                    }
                    value={values()[name] ?? ""}
                    onInput={(e) => {
                      const v = e.currentTarget.value;
                      setValues((s) => {
                        const next = { ...s };
                        if (v) next[name] = v;
                        else delete next[name];
                        return next;
                      });
                    }}
                  />
                </label>
              )}
            </For>
            <button
              class="secondary"
              type="submit"
              disabled={
                props.busy ||
                dirty() ||
                !props.state.learning.connected ||
                !Object.keys(values()).length
              }
            >
              Save to Infisical
            </button>
          </form>
          <button
            class="primary"
            disabled={
              props.busy ||
              dirty() ||
              !props.state.learning.acceptance.credentials
            }
            onClick={() => void props.action("learning/plan", {})}
          >
            Prepare review plan
          </button>
        </div>
      </Show>
      <Show when={!dirty() && props.state.learning.plan}>
        {(plan) => (
          <div class="card">
            <h3>Review package prepared</h3>
            <p>
              Deployment remains held for coordinator review and Alchemy
              integration.
            </p>
            <details>
              <summary>View exact review data</summary>
              <pre
                style={{
                  "white-space": "pre-wrap",
                  "overflow-wrap": "anywhere",
                }}
              >
                {JSON.stringify(plan(), null, 2)}
              </pre>
            </details>
          </div>
        )}
      </Show>
      <p>
        Publish real songs after the reviewed community deployment; bind each
        exact song revision in its acceptance package. Spaces: Coming soon.
      </p>
    </section>
  );
}
