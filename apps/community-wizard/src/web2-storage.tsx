import { createSignal, Match, Show, Switch } from "solid-js";
import type {
  Web2ActionView,
  Web2WizardView,
} from "../server/web2-setup.ts";
import type { Web2StorageOutcome } from "../server/web2-storage-setup.ts";

/** Community media storage section of the paired operator setup. Behavior and
 * copy follow the reviewed design preview exactly; the visual component kit is
 * a separate vendoring step, so structure here uses the wizard's own markup.
 *
 * The browser retains only the non-secret request id, in session storage,
 * before the save is ever submitted. A lost reply is then recoverable after a
 * full browser refresh without the token being retained or requested again:
 * the interrupted step reconciles the original request id, and the token
 * field is always cleared on submission. The stored-credential fact and the
 * provider's latest answer stay visibly separate: a token can be saved and
 * currently declined at the same time. */

const PENDING_KEY = "pirate.web2-media-save-request";

type Step = "entry" | "replace" | "revoked" | "interrupted" | "saved";

export function retainPendingRequest(id: string) {
  sessionStorage.setItem(PENDING_KEY, id);
}
export function pendingRequest(): string | null {
  return sessionStorage.getItem(PENDING_KEY);
}
export function clearPendingRequest() {
  sessionStorage.removeItem(PENDING_KEY);
}

export function Web2StorageSection(props: {
  view: () => (Web2WizardView & Partial<Web2ActionView>) | undefined;
  locked: () => boolean;
  /** Null means the reply is unknown: the wizard-level error is already
   * displayed, the retained request id is kept, and the step re-derives to
   * interrupted so the original save can be reconciled. */
  act: (
    action: "storage-save" | "storage-check" | "storage-reconcile",
    input: Record<string, unknown>,
  ) => Promise<Web2StorageOutcome | null>;
}) {
  const [replacing, setReplacing] = createSignal(false);
  const [entryError, setEntryError] = createSignal("");
  const [stillMissing, setStillMissing] = createSignal(false);
  // Session storage survives the refresh; the signal makes it visible to
  // reactivity. Every write goes through these two helpers, never either
  // store alone, so the durable record and the rendered step cannot drift.
  const [pending, setPending] = createSignal<string | null>(pendingRequest());
  const retain = (id: string) => {
    retainPendingRequest(id);
    setPending(id);
  };
  const clearPending = () => {
    clearPendingRequest();
    setPending(null);
  };
  let input: HTMLInputElement | undefined;

  const media = () => props.view()?.mediaStorage;
  const step = (): Step => {
    // A lost reply outranks replacement mode: the operator must be able to
    // recover the original save immediately, not after a refresh.
    if (pending()) return "interrupted";
    if (replacing()) return "replace";
    const state = media();
    if (!state || state.state === "empty") return "entry";
    if (state.observation?.outcome === "declined") return "revoked";
    return "saved";
  };

  function requestId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    setEntryError("");
    setStillMissing(false);
    const current = step();
    if (current === "interrupted") {
      const id = pending();
      if (!id) return;
      const outcome = await props.act("storage-reconcile", { requestId: id });
      if (!outcome) return;
      if (outcome.state === "saved") {
        clearPending();
        setReplacing(false);
      } else {
        // The save provably never committed, or has not landed yet. The
        // operator may check again or re-enter; neither is coerced.
        setStillMissing(true);
      }
      return;
    }
    if (!input) return;
    const token = input.value.trim();
    if (!token) {
      input.setCustomValidity("Enter your Filebase IPFS RPC API token.");
      input.reportValidity();
      return;
    }
    input.setCustomValidity("");
    // Retain the non-secret request id before submission. The token itself is
    // cleared immediately and never stored anywhere by the browser.
    const id = requestId();
    retain(id);
    const baseGeneration =
      media()?.state === "saved" ? (media()?.generation ?? null) : null;
    input.value = "";
    const outcome = await props.act("storage-save", {
      token,
      requestId: id,
      baseGeneration,
    });
    if (!outcome) return;
    if (outcome.state === "saved") {
      clearPending();
      setReplacing(false);
      return;
    }
    // A definitive answer means this request can never complete: the id is
    // pointless to retain. Only an unknown reply keeps it, which the
    // interrupted step then recovers.
    clearPending();
    setEntryError(
      outcome.state === "declined"
        ? "Filebase declined this token. Check that you copied the Secret Access Token for the right bucket."
        : "We couldn’t check the token. Your entry wasn’t saved.",
    );
  }

  return (
    <section class="media-storage" aria-label="Media storage">
      <h2>Connect media storage</h2>
      <Show when={media() !== null && media() !== undefined} fallback={
        <p>
          Media storage is not available on this installation. The community
          credential vault is not configured here.
        </p>
      }>
      <Switch
        fallback={
          <>
            <p>
              Your VPS uploads media directly to your Filebase bucket. Your
              community pays Filebase for storage and bandwidth.
            </p>
            <Show when={step() === "revoked"}>
              <p role="alert">
                Filebase declined the saved token. Generate a replacement for
                the same bucket and paste it below.
              </p>
            </Show>
            <ol>
              <li>
                Sign in or create a Filebase account. Create or choose an IPFS
                bucket dedicated to this community.
              </li>
              <li>
                Under <strong>Access Keys → IPFS RPC API</strong>, select that
                bucket and copy its <strong>Secret Access Token</strong>.
              </li>
            </ol>
            <p>
              <a
                href="https://console.filebase.com/keys"
                target="_blank"
                rel="noreferrer"
              >
                Go to Filebase Access Keys
              </a>
            </p>
            <form onSubmit={submit}>
              <label for="filebase-token">
                Filebase IPFS RPC API token
              </label>
              <input
                id="filebase-token"
                ref={(el) => {
                  input = el;
                }}
                type="password"
                required
                autocomplete="off"
                spellcheck={false}
                disabled={props.locked()}
                onInput={(e) => {
                  e.currentTarget.setCustomValidity("");
                  setEntryError("");
                }}
              />
              <Show when={entryError()}>
                <p role="alert">{entryError()}</p>
              </Show>
              <button type="submit" disabled={props.locked()}>
                {step() === "entry"
                  ? "Check and save token"
                  : "Check and save replacement"}
              </button>
            </form>
            <details>
              <summary>What does this token allow?</summary>
              <p>
                Your server keeps the token and uses it only with Filebase. It
                can manage and remove files and pins. Confirm the bucket name
                in Filebase before copying. Setup lists pins. Your first
                publication checks uploading.
              </p>
            </details>
            <Show when={step() === "replace"}>
              <button type="button" onClick={() => setReplacing(false)}>
                Cancel replacement
              </button>
            </Show>
          </>
        }
      >
        <Match when={step() === "interrupted"}>
          <h3>Save confirmation interrupted</h3>
          <p>
            Setup lost the reply. Check the original save to see whether your
            token was stored.
          </p>
          <form onSubmit={submit}>
            <button type="submit" disabled={props.locked()}>
              Check saved token
            </button>
          </form>
          <Show when={stillMissing()}>
            <p role="alert">
              The original save was not found. You can check again, or enter
              the token again.
            </p>
            <button
              type="button"
              onClick={() => {
                clearPending();
                setStillMissing(false);
              }}
            >
              Enter token again
            </button>
          </Show>
        </Match>
        <Match when={step() === "saved"}>
          <h3>Token saved</h3>
          <Show
            when={media()?.observation?.outcome === "ok" || !media()?.observation}
            fallback={
              <p role="alert">
                Token stored. Filebase could not be checked. The stored token
                stays in place; you can check again or replace it.
              </p>
            }
          >
            <p>
              The token could list pins in Filebase. Your first publication
              will check uploading.
            </p>
          </Show>
          <details>
            <summary>Replace or revoke this token</summary>
            <p>
              Generate a replacement for your community’s bucket in Filebase,
              then enter it here. To withdraw access, revoke the old credential
              in Filebase.
            </p>
            <button
              type="button"
              onClick={() => {
                setEntryError("");
                setReplacing(true);
              }}
            >
              Replace token
            </button>
          </details>
        </Match>
      </Switch>
      </Show>
    </section>
  );
}
