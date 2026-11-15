import { For, Show } from "solid-js";
import type { LinuxSnapshot } from "./linux-api.ts";
import type { LinuxPanelActions } from "./linux-recovery-panel.tsx";
export function LinuxCredentialsPanel(
  props: LinuxPanelActions & {
    snapshot: Extract<LinuxSnapshot, { available: true }>;
    credentials(): Record<string, string>;
    setCredentials(value: Record<string, string>): void;
  },
) {
  const s = () => props.snapshot;
  const { working, pending, credentials, setCredentials, action } = props;
  return (
    <section class="card">
      <h2>Credentials and verified services</h2>
      <p>
        Only selected feature requirements are shown. Community speech, storage,
        SSH connections and publication scopes stay separate from platform login
        and signing credentials.
      </p>
      <For
        each={s().state.requirements}
        fallback={
          <p>
            No requirements have been discovered. Inspect the host or prepare a
            plan; this is not a readiness claim.
          </p>
        }
      >
        {(r) => (
          <label class="field">
            <span>
              {r.label} · {r.state}
            </span>
            <small>
              {r.role} · {r.scope}. {r.correction}
            </small>
            <input
              aria-label={r.label}
              type="password"
              autocomplete="off"
              value={credentials()[r.id] ?? ""}
              disabled={
                working() || pending() || Boolean(s().state.secretRequest)
              }
              onInput={(e) =>
                setCredentials({
                  ...credentials(),
                  [r.id]: e.currentTarget.value,
                })
              }
            />
          </label>
        )}
      </For>
      <button
        class="secondary"
        disabled={
          working() ||
          pending() ||
          Boolean(s().state.secretRequest) ||
          !Object.values(credentials()).some(Boolean)
        }
        onClick={() => {
          const values = Object.fromEntries(
            Object.entries(credentials()).filter(([, v]) => v),
          );
          setCredentials({});
          void action("credentials", {
            revision: s().state.revision,
            values,
          });
        }}
      >
        Save to managed scope
      </button>
      <Show when={s().state.secretRequest}>
        <button
          class="secondary"
          disabled={working()}
          onClick={() => void action("credentials/reconcile")}
        >
          Reconcile original credential write
        </button>
      </Show>
      <button
        class="secondary"
        disabled={
          working() ||
          pending() ||
          !s().state.target ||
          Boolean(s().state.secretRequest)
        }
        onClick={() => void action("credentials/verify")}
      >
        Verify selected services
      </button>
      <p class="fine">
        Saved credentials remain separate from verified service identity and
        deployed application health.
      </p>
    </section>
  );
}
