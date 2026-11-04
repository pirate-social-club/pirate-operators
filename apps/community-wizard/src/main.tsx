import { render } from "solid-js/web";
import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { Settings, SecretName } from "../server/model.ts";
import type { Snapshot } from "./types.ts";
import { ManagedServices } from "./managed-services.tsx";
import { Readiness } from "./readiness.tsx";
import "./style.css";

const blank: Settings = {
  name: "",
  slug: "",
  accountId: "",
  subdomain: "",
  projectId: "",
  environment: "dev",
  secretPath: "/communities/my-community",
  acrHost: "identify-eu-west-1.acrcloud.com",
  cloudconvert: false,
  tld: "",
  moderationMode: "pirate",
};
const providers: { key: SecretName; label: string; hint: string }[] = [
  { key: "OPENAI_API_KEY", label: "OpenAI API key", hint: "Moderation" },
  {
    key: "ACRCLOUD_ACCESS_KEY",
    label: "ACRCloud access key",
    hint: "Song identification and release evidence",
  },
  {
    key: "ACRCLOUD_ACCESS_SECRET",
    label: "ACRCloud access secret",
    hint: "Song identification",
  },
  {
    key: "CLOUDCONVERT_API_KEY",
    label: "CloudConvert API key",
    hint: "Media conversion, when required",
  },
];
function App() {
  const [state, setState] = createSignal<Snapshot>();
  const [settings, setSettings] = createSignal<Settings>({ ...blank });
  const [credentials, setCredentials] = createSignal<
    Partial<Record<SecretName, string>>
  >({});
  const [step, setStep] = createSignal(0);
  const [working, setWorking] = createSignal(false);
  const [error, setError] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [approved, setApproved] = createSignal(false);
  const busy = () => working() || Boolean(state()?.busy);
  async function refresh(initial = false) {
    const response = await fetch("/api/state");
    if (!response.ok)
      throw new Error("Could not reach the local setup runner.");
    const next: Snapshot = await response.json();
    setState(next);
    if (initial && next.settings) setSettings({ ...next.settings });
  }
  onMount(() => {
    void refresh(true).catch((e) => setError(e.message));
    const timer = setInterval(() => {
      if (state()?.busy)
        void refresh().catch(() =>
          setError(
            "Connection interrupted. Reload to resume from saved state.",
          ),
        );
    }, 1500);
    onCleanup(() => clearInterval(timer));
  });
  async function action(path: string, payload: unknown, after?: () => void) {
    if (busy()) return;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`/api/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Wizard-Token": state()?.csrf ?? "",
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Setup step failed.");
      setState(result);
      after?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup step failed.");
    } finally {
      setWorking(false);
    }
  }
  const setting = (key: keyof Settings, value: string | boolean) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setApproved(false);
  };
  const input = (
    key: Exclude<keyof Settings, "cloudconvert">,
    label: string,
    placeholder: string,
    help?: string,
  ) => (
    <label class="field">
      <span>{label}</span>
      <input
        aria-label={label}
        aria-describedby={help ? `help-${key}` : undefined}
        value={settings()[key]}
        placeholder={placeholder}
        required={key !== "tld"}
        disabled={busy() || state()?.attempted}
        onInput={(e) => setting(key, e.currentTarget.value)}
      />
      <Show when={help}>
        <small id={`help-${key}`}>{help}</small>
      </Show>
    </label>
  );
  return (
    <>
      <header class="top">
        <a class="brand" href="/" aria-label="Pirate setup home">
          <span class="mark">P</span>PIRATE
        </a>
        <span class="edition">
          COMMUNITY SETUP <i>V1</i>
        </span>
        <span class="local">
          <span /> Local runner
        </span>
      </header>
      <div class="layout">
        <aside class="navigation">
          <p class="eyebrow">MAKE A PLACE FOR YOUR MUSIC</p>
          <h1>
            Your community.
            <br />
            Your home.
          </h1>
          <p class="intro">
            Start with your own HTTPS app. Connect your Handshake name when
            you’re ready.
          </p>
          <nav aria-label="Setup steps">
            <For
              each={["Community", "Services", "Review & deploy", "Readiness"]}
            >
              {(title, i) => (
                <button
                  classList={{ selected: step() === i() }}
                  onClick={() => setStep(i())}
                  aria-current={step() === i() ? "step" : undefined}
                >
                  <span class="number">0{i() + 1}</span>
                  <span>{title}</span>
                  <span class="arrow">↗</span>
                </button>
              )}
            </For>
          </nav>
          <div class="resume">
            <span class="dot" /> Progress stays on this device.
            <p>
              Independent operator keys belong in that operator’s Infisical
              scope. Managed communities do not supply provider keys.
            </p>
          </div>
        </aside>
        <main>
          <div class="section-heading">
            <span class="eyebrow">SETUP / 0{step() + 1}</span>
            <span class="tag">Ordinary HTTPS first</span>
          </div>
          <Show when={error()}>
            <div role="alert" class="alert">
              {error()}
            </div>
          </Show>
          <Show when={notice()}>
            <div role="status" class="notice">
              {notice()}
            </div>
          </Show>
          <Show
            when={state()}
            fallback={<p>Connecting to your local runner…</p>}
          >
            <Show when={step() === 0}>
              <h2>A home for your community</h2>
              <p class="lede">
                Choose its name and where its infrastructure will live. You can
                review everything before deployment.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void action("settings", settings(), () => {
                    setStep(1);
                    setApproved(false);
                  });
                }}
              >
                <div class="card">
                  <h3>Community</h3>
                  {input("name", "Community name", "Your community")}
                  <div class="grid">
                    {input(
                      "slug",
                      "Deployment ID",
                      "my-community",
                      "Used in resource names. Fixed after the first deployment attempt.",
                    )}
                    {input(
                      "tld",
                      "Handshake TLD · optional",
                      "c22",
                      "No delegation or HNS transaction runs in this wizard slice.",
                    )}
                  </div>
                </div>
                <div class="card">
                  <h3>Cloudflare</h3>
                  <p>Use your existing account and workers.dev subdomain.</p>
                  {input("accountId", "Account ID", "32-character account ID")}
                  {input("subdomain", "workers.dev subdomain", "your-account")}
                  <div class="address">
                    https://pirate-{settings().slug || "your-community"}.
                    {settings().subdomain || "your-account"}.workers.dev
                  </div>
                </div>
                <div class="card">
                  <h3>Moderation</h3>
                  <p>
                    Pirate-operated moderation with the existing publication
                    defaults. Explicit lyrics are allowed. Connection
                    verification is still pending.
                  </p>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={settings().moderationMode === "independent"}
                      disabled={busy() || state()?.attempted}
                      onChange={(e) =>
                        setting(
                          "moderationMode",
                          e.currentTarget.checked ? "independent" : "pirate",
                        )
                      }
                    />
                    <span>Advanced: operate moderation myself</span>
                  </label>
                </div>
                <Show when={settings().moderationMode === "independent"}>
                  <div class="card">
                    <h3>Infisical</h3>
                    <p>
                      Choose a dedicated, existing folder accessible to your
                      runner’s machine identity.
                    </p>
                    {input(
                      "projectId",
                      "Project UUID",
                      "Project ID from Infisical settings",
                    )}
                    <div class="grid">
                      {input("environment", "Environment", "dev")}
                      {input(
                        "secretPath",
                        "Secret folder",
                        "/communities/my-community",
                      )}
                    </div>
                  </div>
                  <div class="card">
                    <h3>Moderation providers</h3>
                    {input(
                      "acrHost",
                      "ACRCloud identify host",
                      "identify-eu-west-1.acrcloud.com",
                    )}
                    <label class="check">
                      <input
                        type="checkbox"
                        checked={settings().cloudconvert}
                        disabled={busy() || state()?.attempted}
                        onChange={(e) =>
                          setting("cloudconvert", e.currentTarget.checked)
                        }
                      />
                      <span>Use CloudConvert for media conversion</span>
                    </label>
                  </div>
                </Show>
                <div class="actions">
                  <span>Settings contain no provider keys.</span>
                  <button class="primary" disabled={busy()} type="submit">
                    Save & continue <span>→</span>
                  </button>
                </div>
              </form>
            </Show>
            <Show when={step() === 1}>
              <Show when={state()?.settings?.moderationMode === "pirate"}>
                <ManagedServices />
              </Show>
              <Show when={state()?.settings?.moderationMode !== "pirate"}>
                <h2>Connect your providers</h2>
                <p class="lede">
                  Your keys go through the local runner to Infisical. Saved
                  credentials are a setup step; real moderation still needs to
                  be verified.
                </p>
                <div class="connection">
                  <span
                    classList={{
                      dot: true,
                      off: !state()?.capabilities.infisical,
                    }}
                  />
                  {state()?.capabilities.infisical
                    ? "Infisical identity configured on the runner"
                    : "Infisical identity needed on the runner"}
                </div>
                <Show when={!state()?.settings}>
                  <p class="alert">Save your community settings first.</p>
                </Show>
                <form
                  autocomplete="off"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const values = { ...credentials() };
                    setCredentials({});
                    void action("secrets", values, () =>
                      setNotice(
                        "Required provider credentials are saved in Infisical. Provider checks remain pending.",
                      ),
                    );
                  }}
                >
                  <div class="card">
                    <For
                      each={providers.filter(
                        (p) =>
                          p.key !== "CLOUDCONVERT_API_KEY" ||
                          state()?.settings?.cloudconvert,
                      )}
                    >
                      {(provider) => (
                        <label class="field">
                          <span>
                            {provider.label}
                            <Show
                              when={state()?.secrets.includes(provider.key)}
                            >
                              <em>Saved</em>
                            </Show>
                          </span>
                          <input
                            type="password"
                            autocomplete="new-password"
                            spellcheck={false}
                            value={credentials()[provider.key] ?? ""}
                            placeholder={
                              state()?.secrets.includes(provider.key)
                                ? "Leave blank to keep saved value"
                                : "Paste credential"
                            }
                            disabled={busy()}
                            onInput={(e) => {
                              const value = e.currentTarget.value;
                              setCredentials((current) => {
                                const next = { ...current };
                                if (value) next[provider.key] = value;
                                else delete next[provider.key];
                                return next;
                              });
                            }}
                          />
                          <small>{provider.hint}</small>
                        </label>
                      )}
                    </For>
                    <button
                      class="secondary"
                      type="submit"
                      disabled={
                        busy() ||
                        !state()?.settings ||
                        !state()?.capabilities.infisical ||
                        !Object.keys(credentials()).length
                      }
                    >
                      Save to Infisical
                    </button>
                  </div>
                </form>
              </Show>
              <div class="note">
                <h3>Keep the first release focused</h3>
                <p>
                  ElevenLabs, OpenRouter and Telegram are later additions.
                  Spaces is coming soon.
                </p>
              </div>
              <div class="actions">
                <span>You can review resources before adding keys.</span>
                <button
                  class="primary"
                  disabled={busy() || !state()?.settings}
                  onClick={() =>
                    void action("plan", {}, () => {
                      setApproved(false);
                      setStep(2);
                    })
                  }
                >
                  Review deployment →
                </button>
              </div>
            </Show>
            <Show when={step() === 2}>
              <h2>Know what you’re deploying</h2>
              <p class="lede">
                Alchemy will manage these resources in your Cloudflare account.
                This slice deploys the setup page and infrastructure; posting
                comes after the integrations below.
              </p>
              <Show
                when={state()?.plan}
                fallback={
                  <div class="card">
                    <p>Generate a plan from your saved settings.</p>
                    <button
                      class="primary"
                      disabled={busy() || !state()?.settings}
                      onClick={() =>
                        void action("plan", {}, () => setApproved(false))
                      }
                    >
                      Generate resource plan
                    </button>
                  </div>
                }
              >
                <div class="card plan">
                  <span class="eyebrow">APP ADDRESS</span>
                  <p class="origin">{state()?.plan?.origin}</p>
                  <small>Account {state()?.plan?.accountId}</small>
                  <For each={state()?.plan?.resources}>
                    {(resource) => (
                      <div class="resource">
                        <span class="resource-kind">{resource.kind}</span>
                        <div>
                          <strong>{resource.name}</strong>
                          <p>{resource.purpose}</p>
                        </div>
                      </div>
                    )}
                  </For>
                  <p class="fine">
                    This is the intended resource plan. Alchemy performs its
                    Cloudflare reconciliation during deployment. Your account’s
                    normal charges apply.
                  </p>
                </div>
                <div class="card">
                  <h3>Contract responsibilities</h3>
                  <p>
                    Shared contracts are configured separately. This setup step
                    makes no blockchain transactions.
                  </p>
                  <dl>
                    <dt>Pirate</dt>
                    <dd>
                      Shared registry factory, community directory and song-post
                      index.
                    </dd>
                    <dt>Community operator</dt>
                    <dd>
                      Your TLD registry, sales policy, delegation, directory
                      registration and publisher configuration.
                    </dd>
                    <dt>Later</dt>
                    <dd>
                      Operator payments, learning and rewards. Payment
                      deployment and spending controls stay with the contracts
                      lane.
                    </dd>
                  </dl>
                </div>
                <div class="note">
                  <h3>What stays open</h3>
                  <p>
                    Real moderation, creator activation, media publication and
                    directory/post integration must pass before the first song
                    is ready.
                  </p>
                </div>
                <label class="check approval">
                  <input
                    type="checkbox"
                    checked={approved()}
                    disabled={busy()}
                    onChange={(e) => setApproved(e.currentTarget.checked)}
                  />
                  <span>
                    I reviewed this account, resource plan and the remaining
                    first-song work.
                  </span>
                </label>
                <Show
                  when={
                    !state()?.capabilities.cloudflare ||
                    !state()?.capabilities.stateProtection ||
                    (state()?.settings?.moderationMode === "independent" &&
                      !state()?.capabilities.infisical)
                  }
                >
                  <p class="fine">
                    Deployment needs Cloudflare access and a state protection
                    password on the local runner. Independent moderation also
                    needs its scoped Infisical identity.
                  </p>
                </Show>
                <div class="actions">
                  <button
                    class="text-button"
                    disabled={busy()}
                    onClick={() =>
                      void action("plan", {}, () => setApproved(false))
                    }
                  >
                    Refresh plan
                  </button>
                  <button
                    class="primary"
                    disabled={
                      busy() ||
                      !approved() ||
                      !state()?.capabilities.cloudflare ||
                      !state()?.capabilities.stateProtection ||
                      (state()?.settings?.moderationMode === "independent" &&
                        !state()?.capabilities.infisical) ||
                      !["saved", "managed"].includes(
                        state()?.readiness[0].state ?? "",
                      )
                    }
                    onClick={() =>
                      void action(
                        "deploy",
                        { planId: state()?.plan?.id },
                        () => {
                          setApproved(false);
                          setStep(3);
                        },
                      )
                    }
                  >
                    {state()?.deployment === "health_pending"
                      ? "Check HTTPS again"
                      : state()?.attempted
                        ? "Retry provisioning"
                        : "Deploy infrastructure"}{" "}
                    →
                  </button>
                </div>
              </Show>
            </Show>
            <Show when={step() === 3}>
              <Readiness state={state()!} onRetry={() => setStep(2)} />
            </Show>
          </Show>
        </main>
      </div>
      <footer>
        BUILD A COMMUNITY THAT BELONGS TO YOU.<span>Pirate / Setup v1</span>
      </footer>
    </>
  );
}
render(() => <App />, document.getElementById("root")!);
