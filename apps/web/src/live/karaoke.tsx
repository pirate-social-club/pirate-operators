// Live transport adapter for the centralized Karaoke presentation. Internal
// accounting uses standing enrollment and one automatic terminal publication.
// A reload resumes an open take or shows its canonical completion screen.
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../../../../packages/karaoke/manifest-lines.ts";
import { KaraokePracticeSurface } from "../karaoke/practice-surface.tsx";
import type {
  KaraokeOperatorResult,
  KaraokeLineFeedback as LineFeedback,
} from "../api-contract.ts";
import { useKaraokeCapture } from "../karaoke/use-karaoke-capture.ts";
import { Button } from "../ui.ts";
import {
  KaraokeRouteLoadingState,
  KaraokeRouteLoadFailureState,
} from "../karaoke/route-states.tsx";
import { deriveKaraokeFeedback } from "../karaoke/scoring-feedback.ts";
import { ScoringResponseWatch } from "../karaoke/scoring-response-watch.ts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/overlays/dialog/dialog";
import { get, post } from "./api.ts";

import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";
import { enrollmentDisclosure } from "./learning-consent.ts";
export type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "./learning-consent.ts";
export interface LearningActions {
  download: () => Promise<void>;
}
interface TimedSong {
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
      result: {
        body: KaraokeOperatorResult & { ticketId: string };
        presentation?: KaraokeOperatorResult["presentation"];
      };
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
  serviceMode?: "internal";
  onExit: () => void;
  onLearningActions?: (actions: LearningActions) => void;
}) {
  const [song, setSong] = createSignal<TimedSong | null>(null),
    [loaded, setLoaded] = createSignal(false),
    [take, setTake] = createSignal<OpenTake | null>(null),
    [finished, setFinished] = createSignal<Finished | null>(null),
    [notice, setNotice] = createSignal<string | null>(null),
    [feedback, setFeedback] = createSignal<{
      lineScores: readonly LineFeedback[];
      latestLineId: string | null;
    } | null>(null),
    [consentOpen, setConsentOpen] = createSignal(false),
    [consentActivities, setConsentActivities] = createSignal("Karaoke"),
    [consentLinks, setConsentLinks] = createSignal({
      termsUrl: "/terms",
      privacyUrl: "/privacy",
    }),
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
  const scoringResponses = new ScoringResponseWatch();
  let scoringRecoveryUsed = false;
  let consentAnswer: ((accepted: boolean) => void) | undefined;
  onCleanup(() => {
    disposed = true;
    consentAnswer?.(false);
  });
  const confirmEnrollment = (request: KaraokeConsentRequest) => {
    setConsentLinks(enrollmentDisclosure(request));
    const activities = String(request.message.activities);
    if (
      !["1", "2", "3"].includes(activities) ||
      (activities !== "1" && request.target?.version !== 3)
    )
      throw new Error(
        "This enrollment cannot be displayed. Reload and try again.",
      );
    setConsentActivities(
      activities === "3"
        ? "Karaoke and Study"
        : activities === "2"
          ? "Study"
          : "Karaoke",
    );
    return new Promise<boolean>((resolve) => {
      consentAnswer = resolve;
      setConsentOpen(true);
    });
  };
  const answerEnrollment = (accepted: boolean) => {
    const resolve = consentAnswer;
    consentAnswer = undefined;
    setConsentOpen(false);
    resolve?.(accepted);
  };

  const attemptView = () =>
    get<AttemptView>(`/api/karaoke/attempt?postId=${props.postId}`);
  const retainHistoryDownload = (ticketId: string) =>
    props.onLearningActions?.({ download: () => downloadHistory(ticketId) });
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
        result: {
          ...view.result.body,
          presentation:
            view.result.body.presentation ?? view.result.presentation,
        },
        record: view.record,
      });
      retainHistoryDownload(view.result.body.ticketId);
    }
  }
  async function loadSong() {
    setLoaded(false);
    setNotice(null);
    try {
      setSong(
        await get<TimedSong>(`/api/public/posts/${props.postId}/karaoke`),
      );
      const previous = await attemptView();
      // A new visit offers a new take. Keep the retained history downloadable;
      // only an open take resumes here. Current-run completion still uses apply.
      if (previous.state === "finished")
        retainHistoryDownload(previous.result.body.ticketId);
      else apply(previous);
    } catch {
      setSong(null);
    }
    setLoaded(true);
  }
  void loadSong();

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
        if (message.feedback)
          acceptFeedback(message.feedback as Record<string, unknown>);
        void buyAhead();
      } else if (message.type === "line_scores") acceptFeedback(message);
      else if (message.type === "error") {
        // The operator's deadline can precede the media element's final event.
        // Late tail frames then mean completion, not a failed connection.
        if (message.code === "attempt_closed") {
          if (capture.state()?.status === "active") void finish(songMs);
        } else
          stopFailedScoring(
            "The scoring connection stopped. Press Start karaoke to try again.",
          );
      }
    },
  });

  function stopFailedScoring(message: string) {
    scoringResponses.reset();
    setStarting(false);
    setNotice(message);
    capture.controls.abort("karaoke_scoring_unavailable");
  }
  createEffect(
    () => {
      const state = capture.state();
      if (
        state?.status !== "error" ||
        state.error?.code === "karaoke_scoring_unavailable"
      )
        return null;
      return (
        state.micError?.message ??
        "The scoring connection stopped. Press Start karaoke to try again."
      );
    },
    (message) => {
      if (message) {
        setStarting(false);
        setNotice(message);
      }
    },
  );

  function watchScoringResponses(ms: number) {
    const expected =
      song()?.lines.filter((line) => line.endMs <= ms).length ?? 0;
    if (
      scoringResponses.expired({
        playing:
          capture.state()?.status === "active" &&
          !!playback &&
          !playback.paused &&
          !playback.seeking &&
          !capture.playbackInterrupted(),
        expected,
        received: feedback()?.lineScores.length ?? 0,
        now: performance.now(),
      })
    ) {
      if (!scoringRecoveryUsed) {
        scoringRecoveryUsed = true;
        if (capture.controls.reconnect()) {
          scoringResponses.reset();
          return;
        }
      }
      stopFailedScoring(
        "Live scoring isn't responding. Playback stopped. Press Start karaoke to try again.",
      );
    }
  }

  function acceptFeedback(message: Record<string, unknown>) {
    if (!Array.isArray(message.lineScores)) return;
    const lines = message.lineScores as LineFeedback[];
    if (
      !lines.every(
        (line) =>
          Number.isFinite(line.score) &&
          line.score >= 0 &&
          line.score <= 1 &&
          typeof line.uncertain === "boolean" &&
          song()?.lines[line.scoredLineIndex]?.lineId === line.lineId,
      )
    )
      return;
    setFeedback({
      lineScores: lines,
      latestLineId:
        typeof message.latestLineId === "string" ? message.latestLineId : null,
    });
  }
  const currentFeedback = () => deriveKaraokeFeedback(feedback());

  /** Buys every line whose purchase window has opened and not yet closed. */
  async function buyAhead() {
    const current = take(),
      timed = song();
    if (
      !current ||
      !timed ||
      props.serviceMode === "internal" ||
      !attemptStart ||
      buying
    )
      return;
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
    scoringResponses.reset();
    scoringRecoveryUsed = false;
    setStarting(true);
    try {
      let currentTake = take();
      if (currentTake && capture.state()?.status === "error") {
        const current = await attemptView();
        if (current.state === "open") {
          apply(current);
          currentTake = {
            ticketId: current.ticket.body.ticketId,
            socketUrl: current.socketUrl,
            proof: current.proof,
          };
        } else {
          if (current.state === "finished")
            retainHistoryDownload(current.result.body.ticketId);
          setTake(null);
          currentTake = null;
          setFinished(null);
          setFeedback(null);
          setResume(null);
          fromMs = 0;
          if (playback) playback.currentTime = 0;
        }
      }
      setNotice(null);
      if (!currentTake) {
        if (props.serviceMode === "internal") {
          const enrollment = await post<
            KaraokeConsentRequest & { active?: boolean; pending?: boolean }
          >("/api/karaoke/enrollment", {}, props.csrf);
          if (enrollment.pending)
            throw new Error(
              "Your enrollment is still being confirmed. Try again shortly.",
            );
          if (!enrollment.active) {
            if (!(await confirmEnrollment(enrollment))) {
              setStarting(false);
              return;
            }
            const signature = await props.wallet.signConsent(enrollment);
            const accepted = await post<{ state: string }>(
              "/api/karaoke/enrollment",
              {
                enrollment: enrollment.message,
                signature,
                target: enrollment.target,
              },
              props.csrf,
            );
            if (accepted.state !== "success")
              throw new Error(
                "Your enrollment is pending. Try again once it is confirmed.",
              );
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
        setFeedback(null);
        currentTake = {
          ticketId: issued.ticket.body.ticketId,
          socketUrl: issued.socketUrl,
          proof: issued.proof,
        };
        setTake(currentTake);
      }
      const ticketId = currentTake.ticketId;
      await until(() => capture.readyFor(ticketId));
      if (!capture.readyFor(ticketId))
        throw new Error(
          "The microphone connection could not be prepared. Try again.",
        );
      const resumed = resume();
      if (resumed) {
        fromMs = resumed.elapsedMs + (performance.now() - resumed.at);
        if (playback) playback.currentTime = fromMs / 1000;
        setResume(null);
      }
      songMs = fromMs;
      await capture.controls.start(fromMs);
    } catch (failure) {
      setStarting(false);
      setNotice(
        failure instanceof Error
          ? failure.message
          : "This take couldn't start.",
      );
    } finally {
      setStarting(false);
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
    if (status === "ended") return "finishing" as const;
    return starting() && (status === "idle" || status === "error")
      ? ("connecting" as const)
      : status;
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
    await refreshUntil((view) => view.state === "finished");
  }
  async function downloadHistory(ticketId: string) {
    const history = await post(
      "/api/karaoke/history",
      { ticketId },
      props.csrf,
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(history, null, 2)], {
        type: "application/json",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `learning-history-${ticketId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section class="live-karaoke" aria-label={`Karaoke: ${props.title}`}>
      <Show when={notice()}>
        <div
          role="alert"
          class="fixed inset-x-4 bottom-24 z-50 rounded-lg bg-card p-4 text-center"
        >
          <p>{notice()}</p>
        </div>
      </Show>
      <Show
        when={loaded()}
        fallback={<KaraokeRouteLoadingState label="Loading karaoke" />}
      >
        <Show
          when={song()}
          fallback={
            <KaraokeRouteLoadFailureState
              title="Karaoke unavailable"
              description="We couldn't load karaoke for this song."
              onRetry={() => void loadSong()}
              onGoHome={props.onExit}
            />
          }
        >
          {(timed) => (
            <KaraokePracticeSurface
              title={props.title}
              instrumentalAudioUrl={`/api/karaoke/posts/${props.postId}/instrumental`}
              lines={karaokeStageLinesOf(timed().lines)}
              initialTimeMs={resume()?.elapsedMs ?? 0}
              singingStatus={singingStatus()}
              summary={finished()?.result.presentation ?? null}
              bestCombo={
                finished()?.result.presentation?.bestCombo ??
                currentFeedback().bestCombo
              }
              rating={currentFeedback().rating}
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
                watchScoringResponses(ms);
                void buyAhead();
              }}
              onPlay={(ms) => capture.controls.notePlay(ms)}
              onPause={(ms) => {
                scoringResponses.reset();
                return capture.controls.notePause(ms);
              }}
              onSeek={(ms) => {
                scoringResponses.reset();
                capture.controls.noteSeek(ms);
              }}
              onFinish={(ms) => void finish(ms)}
            />
          )}
        </Show>
      </Show>
      <Dialog
        open={consentOpen()}
        onOpenChange={(open) => {
          if (!open) answerEnrollment(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable public learning results</DialogTitle>
            <DialogDescription>
              Your {consentActivities()} line grades, song and completion time
              will be permanently public under your wallet address, including
              incomplete and unsuccessful sessions. Enrollment lasts until
              expiry or revocation.
            </DialogDescription>
          </DialogHeader>
          <p class="text-sm text-muted-foreground">
            <a href={consentLinks().termsUrl} target="_blank" rel="noopener">
              Terms
            </a>{" "}
            ·{" "}
            <a href={consentLinks().privacyUrl} target="_blank" rel="noopener">
              Privacy
            </a>
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => answerEnrollment(false)}>
              Cancel
            </Button>
            <Button onClick={() => answerEnrollment(true)}>Continue</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
