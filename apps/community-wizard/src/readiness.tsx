import { For, Show } from "solid-js";
import type { Snapshot } from "./types.ts";
export function Readiness(props: { state: Snapshot; onRetry: () => void }) {
  return (
    <>
      <h2>The path to your first song</h2>
      <p class="lede">
        Each milestone needs its own evidence. Infrastructure can be provisioned
        while contract and publication work continues.
      </p>
      <Show when={props.state.message}>
        <p class="notice" role="status">
          {props.state.message}
        </p>
      </Show>
      <div class="card readiness">
        <For each={props.state.readiness}>
          {(item) => (
            <div class="milestone">
              <span
                classList={{
                  status: true,
                  good: ["saved", "provisioned"].includes(item.state),
                }}
              >
                {["saved", "provisioned"].includes(item.state) ? "✓" : "○"}
              </span>
              <div>
                <h3>{item.title}</h3>
                <p>{item.detail}</p>
              </div>
              <span class="state">{item.state.replaceAll("_", " ")}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.state.deployment === "provisioned"}>
        <a
          class="primary link"
          href={props.state.plan?.origin}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open setup page ↗
        </a>
      </Show>
      <Show
        when={
          props.state.deployment === "failed" ||
          props.state.deployment === "interrupted" ||
          props.state.deployment === "health_pending"
        }
      >
        <button class="primary" onClick={() => props.onRetry()}>
          Review and retry →
        </button>
      </Show>
      <div class="note">
        <h3>Handshake is separate</h3>
        <p>
          Song tests use ordinary HTTPS without HNS delegation. Verified Pirate
          discovery needs delegation and namespace verification. Opening app.
          {props.state.settings?.tld || "your-tld"} is a separate transport
          check.
        </p>
      </div>
    </>
  );
}
