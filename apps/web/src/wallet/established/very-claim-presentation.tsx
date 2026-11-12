// Rendering port of c7cb8783 src/routes/verify/very.tsx. Existing testnet intents/launch URLs replace centralized widget services.
import { Show } from "solid-js";
import type { VerificationIntent } from "../../../../../packages/rewards/contracts.ts";
import { Button, Type } from "./design-system.ts";

export function VeryClaimPresentation(props: {
  intent: VerificationIntent;
  qr: string;
  notice: string;
  busy: boolean;
  retrying: boolean;
  onCheck: () => void;
  onCancel: () => void;
}) {
  return (
    <main
      data-route-path="/verify/very"
      class="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-6"
    >
      <header class="space-y-2">
        <Type as="h1" variant="h1">
          Claim your winnings
        </Type>
        <Type as="p" variant="caption">
          Palm scan with the Very app.
        </Type>
      </header>
      <Type as="p" role="status" variant="body">
        Waiting for Very. Come back here when you're done.
      </Type>
      <Show when={props.qr}>
        <img
          src={props.qr}
          width="256"
          height="256"
          alt="Scan with Very to verify this claim"
        />
      </Show>
      <Show when={props.notice}>
        <Type as="p" role="alert" variant="body">
          {props.notice}
        </Type>
      </Show>
      <div class="flex flex-wrap gap-3">
        <Show when={props.intent.launch_url}>
          <a href={props.intent.launch_url!} rel="noreferrer">
            Open Very
          </a>
        </Show>
        <Show when={props.retrying}>
          <Button type="button" disabled={props.busy} onClick={props.onCheck}>
            Check palm scan
          </Button>
        </Show>
        <Button
          type="button"
          variant="secondary"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </main>
  );
}
