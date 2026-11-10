import { createSignal, For, onCleanup, Show } from "solid-js";
import type { DanceReview } from "../../../../packages/dance/contracts.ts";
import { DanceClientError, type DanceClient } from "./client.ts";
import { danceError, danceStatus } from "./presentation.ts";

/** Caller provides same-origin lane3 playback endpoint, authorizing every range.
 * No public media URL, bearer capability or role flag is accepted here.
 */
export function DanceReviewQueue(props: {
  client: DanceClient;
  accountId: string;
  privatePlayback: (review: DanceReview) => string;
  rulesSummary: (review: DanceReview) => string;
}) {
  const [items, setItems] = createSignal<DanceReview[]>([]),
    [loaded, setLoaded] = createSignal(false),
    [selected, setSelected] = createSignal<DanceReview | null>(null),
    [error, setError] = createSignal(""),
    [busy, setBusy] = createSignal(false),
    [cursor, setCursor] = createSignal<string | null>(null);
  let active = true;
  const account = props.accountId;
  onCleanup(() => {
    active = false;
  });
  const current = () => active && account === props.accountId;
  // Ambiguous verdict response pins the original choice until recovered.
  let pending: {
    reviewId: string;
    revision: number;
    verdict: "passed" | "not_passed";
  } | null = null;
  function failure(error: unknown) {
    if (!current()) return;
    if (!(error instanceof DanceClientError) || !error.unknown) pending = null;
    if (
      error instanceof DanceClientError &&
      (error.status === 401 ||
        error.status === 403 ||
        error.code === "dance_account_changed")
    ) {
      setSelected(null);
      setItems([]);
      setLoaded(false);
    }
    setError(danceError(error));
  }
  async function load(more = false) {
    setBusy(true);
    setError("");
    try {
      const result = await props.client.queue(more ? cursor() : null);
      if (!current()) return;
      setItems(more ? [...items(), ...result.items] : result.items);
      setCursor(result.cursor);
      setLoaded(true);
    } catch (e) {
      failure(e);
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function decide(verdict: "passed" | "not_passed") {
    const review = selected();
    if (!review) return;
    setBusy(true);
    setError("");
    pending ??= {
      reviewId: review.reviewId,
      revision: review.revision,
      verdict,
    };
    try {
      await props.client.decide(
        pending.reviewId,
        pending.revision,
        pending.verdict,
      );
      if (!current()) return;
      const r = await props.client.get(pending.reviewId);
      if (!current()) return;
      pending = null;
      setSelected(r);
      await load();
    } catch (e) {
      failure(e);
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Dance moderator review"
      style={{ padding: "1rem", "max-width": "52rem" }}
    >
      <h2>Dance review</h2>
      <p>
        Assess the performance against its frozen community rules. There is no
        opening-pose requirement.
      </p>
      <button disabled={busy() || !!pending} onClick={() => void load()}>
        Refresh review queue
      </button>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={loaded() && items().length === 0}>
        <p>No performances are awaiting your review.</p>
      </Show>
      <ul>
        <For each={items()}>
          {(r) => (
            <li>
              <button
                disabled={busy() || !!pending}
                onClick={() => setSelected(r)}
              >
                Review song revision {r.capture.songRevision} · submitted{" "}
                {new Date(r.submittedAtMs).toLocaleString()}
              </button>
            </li>
          )}
        </For>
      </ul>
      <Show when={cursor()}>
        <button disabled={busy() || !!pending} onClick={() => void load(true)}>
          Load more
        </button>
      </Show>
      <Show when={selected()}>
        {(r) => (
          <article>
            <h3>{danceStatus(r()).title}</h3>
            <p>{props.rulesSummary(r())}</p>
            <video
              controls
              preload="none"
              playsinline
              src={props.privatePlayback(r())}
              style={{ "max-width": "100%" }}
            />
            <p role="status">{danceStatus(r()).detail}</p>
            <Show when={r().state === "pending"}>
              <button
                disabled={busy() || (!!pending && pending.verdict !== "passed")}
                onClick={() => void decide("passed")}
              >
                Pass
              </button>
              <button
                disabled={
                  busy() || (!!pending && pending.verdict !== "not_passed")
                }
                onClick={() => void decide("not_passed")}
              >
                Not passed
              </button>
            </Show>
          </article>
        )}
      </Show>
    </section>
  );
}
