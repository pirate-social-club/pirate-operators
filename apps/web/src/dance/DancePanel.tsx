import { createSignal, onCleanup, Show } from "solid-js";
import type {
  DanceCapture,
  DanceReview,
} from "../../../../packages/dance/contracts.ts";
import type { DanceClient } from "./client.ts";
import { danceError, danceStatus } from "./presentation.ts";

/** Shell supplies lane3 recorder/uploader; this feature never captures media. */
export function DancePanel(props: {
  client: DanceClient;
  accountId: string;
  songKey: string;
  offerId: string | null;
  referenceId?: string | null;
  initialReviewId?: string;
  recordPrivate: (capture: DanceCapture) => Promise<{ mediaId: string } | null>;
}) {
  const [review, setReview] = createSignal<DanceReview | null>(null),
    [busy, setBusy] = createSignal(false),
    [error, setError] = createSignal(""),
    [submittedId, setSubmittedId] = createSignal(props.initialReviewId);
  let active = true;
  const account = props.accountId;
  onCleanup(() => {
    active = false;
  });
  const current = () => active && props.accountId === account;
  // Retain capture/media if submit response is unknown: retry cannot record or
  // select a different offer accidentally. Clearing them requires a new mount.
  let capture: DanceCapture | undefined, mediaId: string | undefined;
  async function refresh() {
    const id = submittedId();
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      const r = await props.client.get(id);
      if (current()) setReview(r);
    } catch (e) {
      if (current()) setError(danceError(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError("");
    try {
      capture ??= await props.client.capture(
        props.songKey,
        props.offerId,
        props.referenceId ?? null,
      );
      if (!current()) return;
      if (!mediaId) {
        const media = await props.recordPrivate(capture);
        if (!current() || !media) return;
        mediaId = media.mediaId;
      }
      await props.client.submit(capture.captureId, mediaId);
      if (!current()) return;
      setSubmittedId(capture.captureId);
      const r = await props.client.get(capture.captureId);
      if (current()) setReview(r);
    } catch (e) {
      if (current()) setError(danceError(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function withdraw() {
    const r = review();
    if (!r) return;
    setBusy(true);
    setError("");
    try {
      await props.client.withdraw(r.reviewId, r.revision);
      if (current()) await refresh();
    } catch (e) {
      if (current()) setError(danceError(e));
    } finally {
      if (current()) setBusy(false);
    }
  }
  return (
    <section
      aria-label="Dance"
      style={{ padding: "1rem", "max-width": "42rem" }}
    >
      <h2>Dance</h2>
      <p>
        Record your performance for private moderator review. A pass and public
        posting are separate.
      </p>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show
        when={review()}
        fallback={
          <>
            <p>
              {props.offerId
                ? "The selected offer is frozen before recording. A pass must be committed within its window."
                : "This is a private performance without a reward offer."}
            </p>
            <button disabled={busy()} onClick={() => void start()}>
              {busy()
                ? "Preparing private submission…"
                : mediaId
                  ? "Retry submission"
                  : "Record Dance"}
            </button>
          </>
        }
      >
        {(r) => (
          <>
            <h3>{danceStatus(r()).title}</h3>
            <p role="status">{danceStatus(r()).detail}</p>
            <Show when={r().state === "pending"}>
              <p>
                Review closes {new Date(r().reviewDeadlineMs).toLocaleString()}.
              </p>
              <button disabled={busy()} onClick={() => void withdraw()}>
                Withdraw submission
              </button>
            </Show>
          </>
        )}
      </Show>
      <Show when={submittedId()}>
        <button disabled={busy()} onClick={() => void refresh()}>
          Refresh result
        </button>
      </Show>
    </section>
  );
}
