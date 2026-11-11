// Presentation primitives are the existing c7cb8783 vendored Solid UI. Routes,
// account sign-in and global styling are supplied by the shell lane.
import { Show } from "solid-js";
import { Button, Type } from "../ui.ts";
import type { TelegramConnectionView } from "./client.ts";

export function TelegramAccountSettings(props: {
  connection: TelegramConnectionView | null;
  busy: boolean;
  error: string;
  onUnlink(): void;
  onPreferences(
    value: NonNullable<TelegramConnectionView["preferences"]>,
  ): void;
}) {
  const toggle = (
    key: keyof NonNullable<TelegramConnectionView["preferences"]>,
    value: boolean,
  ) => {
    const current = props.connection?.preferences;
    if (current) props.onPreferences({ ...current, [key]: value });
  };
  return (
    <section
      aria-label="Telegram connection"
      style={{ display: "flex", "flex-direction": "column", gap: "12px" }}
    >
      <Type as="h2" variant="h3">
        Telegram
      </Type>
      <Show when={props.error}>
        <Type as="p" role="alert">
          {props.error}
        </Type>
      </Show>
      <Show
        when={props.connection?.connected}
        fallback={
          <Type as="p">Connect your account from the community bot.</Type>
        }
      >
        <Type as="p">Connected</Type>
        <Show when={props.connection?.preferences}>
          {(prefs) => (
            <fieldset
              disabled={props.busy}
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "12px",
                border: "none",
                padding: "0",
              }}
            >
              <legend>Notifications</legend>
              <label>
                <input
                  type="checkbox"
                  checked={prefs().reminders}
                  onChange={(event) =>
                    toggle("reminders", event.currentTarget.checked)
                  }
                />{" "}
                Practice reminders
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefs().rewards}
                  onChange={(event) =>
                    toggle("rewards", event.currentTarget.checked)
                  }
                />{" "}
                Reward updates
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={prefs().dance}
                  onChange={(event) =>
                    toggle("dance", event.currentTarget.checked)
                  }
                />{" "}
                Dance reviews
              </label>
            </fieldset>
          )}
        </Show>
        <Button
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onUnlink()}
        >
          Unlink Telegram
        </Button>
      </Show>
    </section>
  );
}

export function TelegramConnectionResult(props: {
  state: "checking" | "connected" | "failed";
  error?: string;
  onReturn(): void;
  onRetry(): void;
}) {
  return (
    <section
      aria-label="Telegram account connection"
      style={{ display: "flex", "flex-direction": "column", gap: "16px" }}
    >
      <Type as="h1" variant="h2">
        {props.state === "connected" ? "Connected" : "Connect account"}
      </Type>
      <Show when={props.state === "checking"}>
        <Type as="p" role="status">
          Checking your connection.
        </Type>
      </Show>
      <Show when={props.state === "connected"}>
        <Button onClick={() => props.onReturn()}>Back to Telegram</Button>
      </Show>
      <Show when={props.state === "failed"}>
        <Type as="p" role="alert">
          {props.error ?? "The connection could not finish."}
        </Type>
        <Button onClick={() => props.onRetry()}>Try again</Button>
      </Show>
    </section>
  );
}
