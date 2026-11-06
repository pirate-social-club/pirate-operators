// One learner's Karaoke take on a published song in the live community: the
// timed song, a ticket, the operator's audio socket, each line bought just
// ahead of time, the signed result and one consent signature that saves the
// grades to the learning record. A reload resumes the open take at its
// elapsed time, or shows its result. See docs/karaoke-integration-handoff.md.
import { createSignal, onCleanup, Show } from "solid-js";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../../../../packages/karaoke/manifest-lines.ts";
import { KaraokePracticeSurface } from "../karaoke/practice-surface.tsx";
import {
  karaokeOperatorResultsView,
  type KaraokeOperatorResult,
} from "../karaoke/results-model.ts";
import { useKaraokeCapture } from "../karaoke/use-karaoke-capture.ts";
import { Button } from "../ui.ts";
import { get, post } from "./api.ts";

/** The EIP-712 consent the operator asks the learner to sign, once per take. */
export interface KaraokeConsentRequest {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: "Consent" | "Enrollment";
  message: Record<string, unknown>;
}
export interface KaraokeWallet {
  /** The learner's own signature; MOSS in the live app. */
  signConsent(request: KaraokeConsentRequest): Promise<string>;
}
interface TimedSong {
  serviceMode?: "internal";
  lines: KaraokeTimedLine[];
  segments: { segmentId: string; startMs: number; endMs: number }[];
}
interface OpenTake {
  ticketId: string;
  socketUrl: string;
  proof: string;
}
interface Record_ {
  consented: boolean;
  consent: KaraokeConsentRequest | null;
  publication: { state: string } | null;
}
interface Finished {
  ticketId: string;
  result: KaraokeOperatorResult;
  record: Record_;
}
type AttemptView =
  | { state: "none" }
  | {
      state: "open";
      ticket: { body: { ticketId: string } };
      socketUrl: string;
      proof: string;
      elapsedMs: number | null;
    }
  | {
      state: "finished";
      result: { body: KaraokeOperatorResult & { ticketId: string } };
      record: Record_;
    };

/** The operator opens a line's purchase 15 s before it starts; buy inside that. */
export const PURCHASE_LEAD_MS = 12000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function LiveKaraoke(props: {
  postId: string;
  title: string;
  csrf: string;
  wallet: KaraokeWallet;
  onExit: () => void;
}) {
  const [song, setSong] = createSignal<TimedSong | null>(null),
    [loaded, setLoaded] = createSignal(false),
    [take, setTake] = createSignal<OpenTake | null>(null),
    [finished, setFinished] = createSignal<Finished | null>(null),
    [notice, setNotice] = createSignal<string | null>(null),
    [saving, setSaving] = createSignal(false),
    [starting, setStarting] = createSignal(false),
    [resume, setResume] = createSignal<{
      elapsedMs: number;
      at: number;
    } | null>(null);
  const bought = new Set<string>();
  let attemptStart: unknown = null,
    playback: HTMLAudioElement | null = null,
    buying = false,
    songMs = 0,
    disposed = false;
  onCleanup(() => {
    disposed = true;
  });

  const attemptView = () =>
    get<AttemptView>(`/api/karaoke/attempt?postId=${props.postId}`);
  function apply(view: AttemptView) {
    if (view.state === "open") {
      setTake({
        ticketId: view.ticket.body.ticketId,
        socketUrl: view.socketUrl,
        proof: view.proof,
      });
      // Line purchases run on the operator's clock, so a resumed take picks
      // up where the song now is, measured on the server.
      if (view.elapsedMs !== null)
        setResume({ elapsedMs: view.elapsedMs, at: performance.now() });
    } else if (view.state === "finished") {
      setStarting(false);
      setTake(null);
      setFinished({
        ticketId: view.result.body.ticketId,
        result: view.result.body,
        record: view.record,
      });
    }
  }
  // Loaded once, as the live page loads its feed: writes land after awaits.
  void (async () => {
    try {
      setSong(
        await get<TimedSong>(`/api/public/posts/${props.postId}/karaoke`),
      );
      apply(await attemptView());
    } catch {
      setNotice("Karaoke isn't ready for this song yet.");
    }
    setLoaded(true);
  })();

  const capture = useKaraokeCapture({
    get enabled() {
      return take() !== null;
    },
    get ticketId() {
      return take()?.ticketId ?? "";
    },
    openSocket: () => {
      const current = take()!,
        url = new URL(current.socketUrl);
      url.searchParams.set("ticketId", current.ticketId);
      url.searchParams.set("proof", current.proof);
      const socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      return socket;
    },
    onMessage: (message) => {
      if (message.type === "ready") {
        attemptStart = message.attemptStart;
        void buyAhead();
      }
    },
  });

  /** Buys every line whose purchase window has opened and not yet closed. */
  async function buyAhead() {
    const current = take(),
      timed = song();
    if (!current || !timed || timed.serviceMode === "internal" || !attemptStart || buying) return;
    buying = true;
    try {
      for (const segment of timed.segments) {
        if (
          bought.has(segment.segmentId) ||
          segment.endMs <= songMs ||
          segment.startMs - PURCHASE_LEAD_MS > songMs
        )
          continue;
        try {
          const signed = await post<Record<string, unknown>>(
            "/api/karaoke/purchases",
            {
              ticketId: current.ticketId,
              segmentId: segment.segmentId,
              take: 0,
              attemptStart,
            },
            props.csrf,
          );
          if (capture.controls.send({ type: "purchase", ...signed }))
            bought.add(segment.segmentId);
        } catch {
          // A refused purchase leaves that line unpaid; never retry it.
          bought.add(segment.segmentId);
        }
      }
    } finally {
      buying = false;
    }
  }

  async function until(ready: () => boolean) {
    for (let i = 0; i < 150 && !ready(); i++) await sleep(20);
  }
  async function start(fromMs: number) {
    setStarting(true);
    try {
      if (!take()) {
        if (song()?.serviceMode === "internal") {
          const enrollment = await post<KaraokeConsentRequest & { active?: boolean; pending?: boolean }>("/api/karaoke/enrollment", {}, props.csrf);
          if (enrollment.pending) throw new Error("Your enrollment is still being confirmed. Try again shortly.");
          if (!enrollment.active) {
            if (!window.confirm("Enable public learning results? Your line grades, song and completion time will be permanently public under your wallet address. See Terms and Privacy before continuing.")) {
              setStarting(false); return;
            }
            const signature = await props.wallet.signConsent(enrollment);
            const accepted = await post<{ state: string }>("/api/karaoke/enrollment", { enrollment: enrollment.message, signature }, props.csrf);
            if (accepted.state !== "success") throw new Error("Your enrollment is pending. Try again once it is confirmed.");
          }
        }
        const issued = await post<{
          ticket: { body: { ticketId: string } };
          socketUrl: string;
          proof: string;
        }>("/api/karaoke/tickets", { postId: props.postId }, props.csrf);
        bought.clear();
        attemptStart = null;
        setFinished(null);
        setTake({
          ticketId: issued.ticket.body.ticketId,
          socketUrl: issued.socketUrl,
          proof: issued.proof,
        });
        await until(() => capture.state() !== null);
      }
      const resumed = resume();
      if (resumed) {
        fromMs = resumed.elapsedMs + (performance.now() - resumed.at);
        if (playback) playback.currentTime = fromMs / 1000;
        setResume(null);
      }
      songMs = fromMs;
      capture.controls.start(fromMs);
    } catch (failure) {
      setStarting(false);
      setNotice(
        failure instanceof Error
          ? failure.message
          : "This take couldn't start.",
      );
    }
  }
  /**
   * The surface arms playback on the start tap and cancels it on "idle". The
   * ticket and capture controller are created after that tap, so until
   * capture leaves "idle" the take reads as connecting.
   */
  const singingStatus = () => {
    if (finished()) return "ended" as const;
    const status = capture.state()?.status ?? "idle";
    return starting() && status === "idle" ? ("connecting" as const) : status;
  };
  async function refreshUntil(done: (view: AttemptView) => boolean) {
    for (let i = 0; i < 90 && !disposed; i++) {
      const view = await attemptView().catch(() => null);
      if (view) {
        apply(view);
        if (done(view)) return true;
      }
      await sleep(1000);
    }
    return false;
  }
  async function finish(atMs: number) {
    await capture.controls.noteFinish(atMs);
    setNotice("Scoring your take…");
    const scored = await refreshUntil((view) => view.state === "finished");
    setNotice(
      scored ? null : "Your score is still on its way. Reopen this song soon.",
    );
  }
  async function save() {
    const current = finished();
    if (!current?.record.consent || saving()) return;
    setSaving(true);
    try {
      const signature = await props.wallet.signConsent(current.record.consent);
      await post(
        "/api/karaoke/consent",
        { ticketId: current.ticketId, signature },
        props.csrf,
      );
      await refreshUntil((view) => {
        const state =
          view.state === "finished" ? view.record.publication?.state : null;
        return state === "published" || state === "failed";
      });
    } catch (failure) {
      setNotice(
        failure instanceof Error ? failure.message : "Your score wasn't saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  async function downloadHistory(ticketId: string) {
    try {
      const history = await post("/api/karaoke/history", { ticketId }, props.csrf);
      const url = URL.createObjectURL(new Blob([JSON.stringify(history, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = `learning-history-${ticketId}.json`;
      link.click(); URL.revokeObjectURL(url);
    } catch { setNotice("Your private history could not be downloaded."); }
  }
  const recordSlot = () => {
    const current = finished();
    if (!current) return undefined;
    const state = current.record.publication?.state;
    return (
      <div
        class="flex flex-col items-center gap-3"
        data-record={
          state ?? (current.record.consented ? "pending" : "unsaved")
        }
      >
        <Show
          when={state !== "published"}
          fallback={<p class="text-sm">Saved to your learning record.</p>}
        >
          <Show
            when={state !== "failed"}
            fallback={<p class="text-sm">This score couldn't be saved.</p>}
          >
            <Show
              when={!current.record.consented}
              fallback={<p class="text-sm">Saving to your learning record…</p>}
            >
              <Show when={current.record.consent}>
                <Button disabled={saving()} onClick={() => void save()}>
                  Save your score
                </Button>
              </Show>
            </Show>
          </Show>
        </Show>
        <Show when={song()?.serviceMode === "internal"}>
          <Button variant="ghost" onClick={() => void downloadHistory(current.ticketId)}>Download private history</Button>
        </Show>
        <Button
          variant="ghost"
          onClick={() => {
            setFinished(null);
            setResume(null);
          }}
        >
          Sing again
        </Button>
      </div>
    );
  };
  return (
    <section class="live-karaoke" aria-label={`Karaoke: ${props.title}`}>
      <Show when={notice()}>
        <p class="live-status" role="status" aria-live="polite">
          {notice()}
        </p>
      </Show>
      <Show when={loaded() && song()}>
        {(timed) => (
          <KaraokePracticeSurface
            title={props.title}
            instrumentalAudioUrl={`/api/karaoke/posts/${props.postId}/instrumental`}
            lines={karaokeStageLinesOf(timed().lines)}
            initialTimeMs={resume()?.elapsedMs ?? 0}
            singingStatus={singingStatus()}
            resultsView={
              finished() ? karaokeOperatorResultsView(finished()!.result) : null
            }
            rewardSlot={recordSlot()}
            onExit={props.onExit}
            onStartSinging={(ms) => void start(ms)}
            onPlaybackElement={(element) => {
              playback = element;
              capture.controls.attachPlaybackElement(element);
            }}
            playbackInterrupted={capture.playbackInterrupted()}
            onResumePlayback={() => capture.controls.resumePlayback()}
            onTimeChange={(ms) => {
              songMs = ms;
              capture.controls.noteTime(ms);
              void buyAhead();
            }}
            onPlay={(ms) => capture.controls.notePlay(ms)}
            onPause={(ms) => capture.controls.notePause(ms)}
            onSeek={(ms) => capture.controls.noteSeek(ms)}
            onFinish={(ms) => void finish(ms)}
          />
        )}
      </Show>
    </section>
  );
}
