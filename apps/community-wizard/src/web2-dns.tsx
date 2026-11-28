import { createSignal, Show } from "solid-js";
import type {
  Web2ActionView,
  Web2WizardView,
} from "../server/web2-setup.ts";
import type { DnsView } from "../server/web2-dns-setup.ts";

/** Community-owned DNS verification section of the paired operator setup,
 * mounted before any wallet connection or enrollment preparation. Copy follows
 * the reviewed design preview. Control proof and routing observation render
 * as separate facts: the TXT proof says the operator controls the hostname,
 * while routing is only observed here and checked for real during
 * installation. A hostname change invalidates the old proof immediately,
 * because the proof binds the exact hostname and challenge value. */

function CopyField(props: { value: string; label: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <span class="copy-field">
      <input
        readonly
        value={props.value}
        aria-label={props.label}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(props.value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied() ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

function expiryCopy(expiresAt: number) {
  return new Date(expiresAt).toLocaleTimeString();
}

export function Web2DnsSection(props: {
  view: () => (Web2WizardView & Partial<Web2ActionView>) | undefined;
  locked: () => boolean;
  act: (
    action: "dns-select" | "dns-check",
    input: Record<string, unknown>,
  ) => Promise<DnsView | null>;
}) {
  const [editing, setEditing] = createSignal(false);
  const [entryError, setEntryError] = createSignal("");
  const [checking, setChecking] = createSignal(false);
  let nameInput: HTMLInputElement | undefined;
  let hostInput: HTMLInputElement | undefined;

  const dns = () => props.view()?.dns ?? null;
  const control = () => dns()?.control ?? "unstarted";
  const verified = () => control() === "verified";
  // The entry form shows when nothing is selected yet or the operator asked
  // to change the address. A change invalidates the old proof server-side.
  const entering = () => !dns()?.selection || editing();

  async function submitSelection(event: Event) {
    event.preventDefault();
    setEntryError("");
    const name = nameInput?.value.trim() ?? "";
    const hostname = hostInput?.value.trim() ?? "";
    if (!name) {
      setEntryError("Enter a community name.");
      nameInput?.focus();
      return;
    }
    if (/\.eth$/i.test(hostname)) {
      setEntryError(
        "Use a web domain here. You can add your ENS name from Addresses and names after your first release.",
      );
      hostInput?.focus();
      return;
    }
    if (!hostname) {
      setEntryError("Enter a domain or subdomain, such as songs.example.com.");
      hostInput?.focus();
      return;
    }
    const result = await props.act("dns-select", { name, hostname });
    if (result === null) return; // wizard-level error already displayed
    setEditing(false);
  }

  async function check() {
    setChecking(true);
    try {
      await props.act("dns-check", {});
    } finally {
      setChecking(false);
    }
  }

  return (
    <section data-testid="dns-section" aria-label="Community web address">
      <h2>Community web address</h2>
      <Show when={entering()}>
        <form onSubmit={submitSelection}>
          <p>You choose the public address for members in this step.</p>
          <label>
            Community name
            <input
              ref={nameInput}
              type="text"
              autocomplete="off"
              value={dns()?.selection?.name ?? ""}
              disabled={props.locked()}
            />
          </label>
          <label>
            Community web address
            <input
              ref={hostInput}
              type="text"
              autocomplete="off"
              placeholder="songs.example.com"
              value={dns()?.selection?.hostname ?? ""}
              disabled={props.locked()}
            />
          </label>
          <Show when={entryError()}>
            <p role="alert">{entryError()}</p>
          </Show>
          <button type="submit" disabled={props.locked()}>
            Show DNS records
          </button>
        </form>
      </Show>
      <Show when={!entering() && dns()?.selection} fallback={null}>
        <Show
          when={verified()}
          fallback={
            <>
              <h3>Verify domain control</h3>
              <p>
                Where you manage DNS for {dns()!.selection!.hostname}, add
                this TXT record. Then check it here.
              </p>
              <Show when={control() === "mismatch"}>
                <div role="alert" data-testid="dns-mismatch">
                  <strong>The TXT record didn’t match</strong>
                  <p>
                    Replace the TXT value at the record name below, then check
                    again.
                  </p>
                </div>
              </Show>
              <Show when={control() === "unanswered"}>
                <div role="alert" data-testid="dns-unanswered">
                  <strong>No TXT record answered yet</strong>
                  <p>
                    DNS can take a few minutes to propagate. Check the record
                    name and value, then check again.
                  </p>
                </div>
              </Show>
              <Show when={control() === "unavailable"}>
                <div role="alert" data-testid="dns-unavailable">
                  <strong>The DNS check could not be completed</strong>
                  <p>
                    This server could not reach a resolver. Try checking
                    again; the TXT record is unchanged.
                  </p>
                </div>
              </Show>
              <Show when={control() === "expired"}>
                <div role="alert" data-testid="dns-expired">
                  <p>
                    The previous code expired. Copy the new TXT value and
                    check again.
                  </p>
                </div>
              </Show>
              <div data-testid="dns-txt-record">
                <h4>TXT record</h4>
                <span>TTL 300 seconds</span>
                <p>Record name</p>
                <CopyField
                  value={dns()!.challenge!.txtName}
                  label="TXT record name"
                />
                <p>Expected TXT value</p>
                <CopyField
                  value={dns()!.challenge!.value}
                  label="TXT value"
                />
                <p>
                  Code expires at {expiryCopy(dns()!.challenge!.expiresAt)}.{" "}
                  <button type="button" onClick={() => setEditing(true)}>
                    Change address
                  </button>
                </p>
              </div>
              <button
                type="button"
                disabled={props.locked() || checking()}
                onClick={check}
              >
                {checking() ? "Checking the TXT record" : "Check the TXT record"}
              </button>
            </>
          }
        >
          <div data-testid="dns-verified">
            <h3>Domain control verified</h3>
            <p>
              The TXT record confirms you control {dns()!.selection!.hostname}.
            </p>
            <p>
              After installation, setup checks that members can reach this
              address over HTTPS.
            </p>
            <button type="button" onClick={() => setEditing(true)}>
              Change address
            </button>
          </div>
        </Show>
        <details data-testid="dns-routing">
          <summary>
            Route traffic to this server · checked during installation
          </summary>
          <p>
            Add an A record at {dns()!.selection!.hostname}. Set TTL to 300
            seconds and the proxy to DNS only.
          </p>
          <p>
            Routing status:{" "}
            {dns()!.routing === "answers"
              ? `answers (${dns()!.routingAddresses.join(", ")})`
              : dns()!.routing === "absent"
                ? "no address records answered yet"
                : dns()!.routing === "unavailable"
                  ? "could not be checked"
                  : "not checked yet"}
          </p>
        </details>
      </Show>
    </section>
  );
}
