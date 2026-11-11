// Independently owned Karaoke route: c7cb87835a1858a1955c820b03d566365e6d42db
// karaoke-route-view/scoring hook choreography over the existing decentralized
// capture controller, operator ticket transport and actual MOSS wallet.
// Preserves the owned LiveKaraoke adapter from base af714492; no central API,
// session/persona preparation or localStorage is imported.
// Live transport adapter for the centralized Karaoke presentation. Internal
// accounting uses one automatic terminal publication per take, permitted by
// standing enrollment or, in a V4 community, by the learner's sign-in alone.
// A reload resumes an open take or shows its canonical completion screen.
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  karaokeStageLinesOf,
  type KaraokeTimedLine,
} from "../../../../packages/karaoke/manifest-lines.ts";
import { KaraokePracticeSurface } from "./practice-surface.tsx";
import type {
  KaraokeOperatorResult,
  KaraokeLineFeedback as LineFeedback,
} from "../api-contract.ts";
import { useKaraokeCapture } from "./use-karaoke-capture.ts";
import { Button } from "../ui.ts";
import {
  KaraokeAuthRequiredState,
  KaraokeRouteLoadingState,
  KaraokeRouteLoadFailureState,
} from "./route-states.tsx";
import { deriveKaraokeFeedback } from "./scoring-feedback.ts";
import { ScoringResponseWatch } from "./scoring-response-watch.ts";
import { positionPlaybackWhenReady } from "./playback-position.ts";
import {
  createOperatorKaraokePort,
  type OperatorKaraokePort,
} from "./operator-karaoke-adapter.ts";
import { KaraokeCompletionStatus } from "./completion-status.tsx";

import type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "../live/learning-consent.ts";
import { enrollmentDisclosure } from "../live/learning-consent.ts";
export type {
  KaraokeConsentRequest,
  KaraokeWallet,
} from "../live/learning-consent.ts";
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
/** A short, bounded wait for a just-made sign-in to be recorded. */
const AUTHORIZATION_RETRIES = 5,
  AUTHORIZATION_RETRY_MS = 2000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface KaraokePageProps {
  account: string | null;
  onConnect?: () => void;
  rewardSlot?: JSX.Element;
  port?: OperatorKaraokePort;
  createCapture?: typeof useKaraokeCapture;
  postId: string;
  title: string;
  csrf: string;
  wallet?: KaraokeWallet;
  serviceMode?: "internal";
  /** V4: signing in is the publication permission; no enrollment step. */
  signInPermission?: boolean;
  onExit: () => void;
  onLearningActions?: (actions: LearningActions) => void;
}
export function KaraokePage(props: KaraokePageProps) {
  return (
    <Show
      when={props.account ? `${props.account}\u0000${props.postId}` : null}
      keyed
      fallback={
        <KaraokeAuthRequiredState
          title="Sign in to sing"
          description="This song is available to everyone, but recording a scored take requires an account."
          onConnect={props.onConnect}
          onExit={props.onExit}
        />
      }
    >
      {() => <OwnedKaraokePage {...props} account={props.account!} />}
    </Show>
  );
}
function OwnedKaraokePage(props: KaraokePageProps & { account: string }) {
  const port =
    props.port ??
    createOperatorKaraokePort({
      postId: props.postId,
      account: props.account,
      csrf: () => props.csrf,
    });
  const get = <T,>(path: string) => port.request<T>(path, undefined);
  const post = <T,>(path: string, body: unknown, _csrf?: string) =>
    port.request<T>(path, body);
  const [authRequired, setAuthRequired] = createSignal(false);
  const [song, setSong] = createSignal<TimedSong | null>(null),
    [loaded, setLoaded] = createSignal(false),
    [take, setTake] = createSignal<OpenTake | null>(null),
    [finished, setFinished] = createSignal<Finished | null>(null),
    [notice, setNotice] = createSignal<string | null>(null),
    [restoredRatingKey, setRestoredRatingKey] = createSignal<string | null>(
      null,
    ),
    [feedback, setFeedback] = createSignal<{
      lineScores: readonly LineFeedback[];
      latestLineId: string | null;
    } | null>(null),
    [starting, setStarting] = createSignal(false),
    [playingOutro, setPlayingOutro] = createSignal(false),
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
  let finishing: Promise<void> | undefined;
  let cancelPlaybackPosition: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    port.dispose();
    cancelPlaybackPosition?.();
  });
  const validateEnrollment = (request: KaraokeConsentRequest) => {
    // The disclosure bound by the signature must be the expected one.
    enrollmentDisclosure(request);
    const activities = String(request.message.activities);
    if (
      !["1", "2", "3"].includes(activities) ||
      (activities !== "1" && request.target?.version !== 3)
    )
      throw new Error(
        "This enrollment cannot be displayed. Reload and try again.",
      );
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
      setResume(null);
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
    if (disposed) return;
    setLoaded(false);
    setNotice(null);
    try {
      const loaded = await port.song();
      if (disposed) return;
      if (!loaded.lines.length)
        throw new Error("This song does not have scorable lyrics yet.");
      setSong(loaded);
      const previous = await attemptView();
      if (disposed) return;
      // A new visit offers a new take. Keep the retained history downloadable;
      // only an open take resumes here. Current-run completion still uses apply.
      if (previous.state === "finished")
        retainHistoryDownload(previous.result.body.ticketId);
      else apply(previous);
    } catch (error) {
      if (disposed) return;
      if ((error as { status?: number }).status === 401) setAuthRequired(true);
      setNotice(
        error instanceof Error
          ? error.message
          : "We couldn't load karaoke for this song.",
      );
      setSong(null);
    }
    if (!disposed) setLoaded(true);
  }
  void loadSong();

  const capture = (props.createCapture ?? useKaraokeCapture)({
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
      if (disposed) return;
      if (message.type === "ready") {
        attemptStart = message.attemptStart;
        if (message.feedback)
          acceptFeedback(message.feedback as Record<string, unknown>, true);
        void buyAhead();
      } else if (message.type === "line_scores") acceptFeedback(message);
      else if (message.type === "error") {
        // The operator's deadline can precede the media element's final event.
        // Late tail frames then mean completion, not a failed connection.
        if (message.code === "attempt_closed") {
          if (capture.state()?.status === "active") {
            const lastEndMs = song()?.lines.at(-1)?.endMs;
            // The scoring deadline ends capture, not the instrumental outro.
            // An early closure must still stop playback normally.
            setPlayingOutro(
              lastEndMs !== undefined &&
                songMs >= lastEndMs &&
                !!playback &&
                !playback.ended &&
                playback.currentTime < playback.duration,
            );
            void finish(songMs);
          }
        } else
          stopFailedScoring(
            "The scoring connection stopped. Press Start karaoke to try again.",
          );
      }
    },
  });

  function stopFailedScoring(message: string) {
    setPlayingOutro(false);
    cancelPlaybackPosition?.();
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
      return state.micError?.code === "permission_denied"
        ? "Microphone access is blocked. Allow microphone access in your browser and try again."
        : state.micError?.code === "no_device"
          ? "No microphone is available. Connect a microphone and try again."
          : state.micError
            ? "Audio capture could not start. Refresh Karaoke and try again."
            : state.error?.code === "karaoke_audio_closed"
              ? "Audio stopped. Refresh Karaoke before starting another take."
              : "Scoring could not connect. Try starting your take again.";
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

  function acceptFeedback(message: Record<string, unknown>, restored = false) {
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
    const next = {
      lineScores: lines,
      latestLineId:
        typeof message.latestLineId === "string" ? message.latestLineId : null,
    };
    if (restored)
      setRestoredRatingKey(deriveKaraokeFeedback(next).rating?.key ?? null);
    setFeedback(next);
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
          if (disposed || take()?.ticketId !== current.ticketId) return;
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

  /**
   * The take's ticket. A just-made sign-in may still be being recorded; the
   * same request is retried briefly while the screen keeps its starting state.
   */
  async function ticket() {
    for (let retry = 0; ; retry++) {
      try {
        return await port.ticket();
      } catch (error) {
        if (
          (error as { code?: string }).code !==
            "karaoke_authorization_pending" ||
          retry + 1 >= AUTHORIZATION_RETRIES
        )
          throw error;
        await sleep(AUTHORIZATION_RETRY_MS);
        if (disposed) return null;
      }
    }
  }
  async function until(ready: () => boolean) {
    for (let i = 0; i < 150 && !disposed && !ready(); i++) await sleep(20);
  }
  async function start(fromMs: number) {
    if (disposed || starting()) return;
    setPlayingOutro(false);
    finishing = undefined;
    cancelPlaybackPosition?.();
    scoringResponses.reset();
    scoringRecoveryUsed = false;
    setStarting(true);
    try {
      let currentTake = take();
      if (currentTake && capture.state()?.status === "error") {
        const current = await attemptView();
        if (disposed) return;
        const recoveredId =
          current.state === "open"
            ? current.ticket.body.ticketId
            : current.state === "finished"
              ? current.result.body.ticketId
              : null;
        if (recoveredId && recoveredId !== currentTake.ticketId)
          throw new Error(
            "The active take changed in another tab. Leave Karaoke to open that take; this take has not been replaced.",
          );
        if (current.state === "open") {
          apply(current);
          currentTake = {
            ticketId: current.ticket.body.ticketId,
            socketUrl: current.socketUrl,
            proof: current.proof,
          };
        } else {
          if (current.state === "finished") {
            // A lost finish acknowledgement is a recovered result, not
            // permission to silently replace this take with another charge.
            apply(current);
            setNotice(null);
            return;
          }
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
        if (props.serviceMode === "internal" && !props.signInPermission) {
          const enrollment = await post<
            KaraokeConsentRequest & { active?: boolean; pending?: boolean }
          >("/api/karaoke/enrollment", {}, props.csrf);
          if (disposed) return;
          if (enrollment.pending)
            throw new Error(
              "Your enrollment is still being confirmed. Try again shortly.",
            );
          if (!enrollment.active) {
            validateEnrollment(enrollment);
            if (!props.wallet)
              throw new Error("Connect your MOSS account to continue Karaoke.");
            const signature = await props.wallet.signConsent(enrollment);
            if (disposed) return;
            const accepted = await post<{ state: string }>(
              "/api/karaoke/enrollment",
              {
                enrollment: enrollment.message,
                signature,
                target: enrollment.target,
              },
              props.csrf,
            );
            if (disposed) return;
            if (accepted.state !== "success")
              throw new Error(
                "Your enrollment is pending. Try again once it is confirmed.",
              );
          }
        }
        if (disposed) return;
        const issued = await ticket();
        if (disposed || !issued) return;
        bought.clear();
        attemptStart = null;
        setResume(null);
        setFinished(null);
        setFeedback(null);
        setRestoredRatingKey(null);
        currentTake = {
          ticketId: issued.ticket.body.ticketId,
          socketUrl: issued.socketUrl,
          proof: issued.proof,
        };
        setTake(currentTake);
      }
      const ticketId = currentTake.ticketId;
      await until(() => capture.readyFor(ticketId));
      if (disposed) return;
      if (!capture.readyFor(ticketId))
        throw new Error(
          "The microphone connection could not be prepared. Try again.",
        );
      const resumed = resume();
      if (resumed) {
        const position = () =>
          resumed.elapsedMs + (performance.now() - resumed.at);
        fromMs = position();
        if (playback)
          cancelPlaybackPosition = positionPlaybackWhenReady(
            playback,
            position,
          );
        setResume(null);
      }
      songMs = fromMs;
      await capture.controls.start(fromMs);
    } catch (failure) {
      if (disposed) return;
      if ((failure as { status?: number }).status === 401)
        setAuthRequired(true);
      cancelPlaybackPosition?.();
      setStarting(false);
      setNotice(
        failure instanceof Error
          ? failure.message
          : "This take couldn't start.",
      );
    } finally {
      if (!disposed) setStarting(false);
    }
  }
  /**
   * The surface arms playback on the start tap and cancels it on "idle". The
   * ticket and capture controller are created after that tap, so until
   * capture leaves "idle" the take reads as connecting.
   */
  const singingStatus = () => {
    if (playingOutro()) return "active" as const;
    if (finished()) return "ended" as const;
    const status = capture.state()?.status ?? "idle";
    if (status === "ended") return "finishing" as const;
    return starting() && (status === "idle" || status === "error")
      ? ("connecting" as const)
      : status;
  };
  async function refreshUntil(
    done: (view: AttemptView) => boolean,
    expectedTicketId: string,
  ) {
    for (let i = 0; i < 90 && !disposed; i++) {
      const view = await attemptView().catch(() => null);
      if (disposed) return false;
      if (view) {
        const actual =
          view.state === "open"
            ? view.ticket.body.ticketId
            : view.state === "finished"
              ? view.result.body.ticketId
              : null;
        if (actual && actual !== expectedTicketId) return false;
        apply(view);
        if (done(view)) return true;
      }
      await sleep(1000);
    }
    return false;
  }
  function finish(atMs: number): Promise<void> {
    return (finishing ??= (async () => {
      const ticketId = take()?.ticketId;
      if (!ticketId) return;
      cancelPlaybackPosition?.();
      await capture.controls.noteFinish(atMs);
      const confirmed = await refreshUntil(
        (view) => view.state === "finished",
        ticketId,
      );
      if (!confirmed && !disposed)
        setNotice(
          "Your take ended, but its result has not been confirmed. Check the same take again.",
        );
    })());
  }
  async function downloadHistory(ticketId: string) {
    const history = await post(
      "/api/karaoke/history",
      { ticketId },
      props.csrf,
    );
    if (disposed) return;
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
  async function checkResult() {
    const expected = finished()?.ticketId ?? take()?.ticketId;
    try {
      const value = await attemptView();
      if (disposed) return;
      const actual =
        value.state === "open"
          ? value.ticket.body.ticketId
          : value.state === "finished"
            ? value.result.body.ticketId
            : null;
      if (expected && actual !== expected) {
        setNotice(
          "This take's result is still unavailable. Your saved take has not been replaced.",
        );
        return;
      }
      apply(value);
      if (value.state === "finished") setNotice(null);
    } catch (error) {
      if (!disposed) {
        if ((error as { status?: number }).status === 401)
          setAuthRequired(true);
        else
          setNotice(
            "Your result is still unavailable. Check the same take again.",
          );
      }
    }
  }
  return (
    <Show
      when={!authRequired()}
      fallback={
        <KaraokeAuthRequiredState
          title="Sign in to sing"
          description="Sign in to sing this song."
          onConnect={props.onConnect}
          onExit={props.onExit}
        />
      }
    >
      <section class="live-karaoke" aria-label={`Karaoke: ${props.title}`}>
        <Show when={notice() && song()}>
          <div
            role="alert"
            class="fixed inset-x-4 bottom-24 z-50 rounded-lg bg-card p-4 text-center"
          >
            <p>{notice()}</p>
            <Show when={song() && !starting()}>
              <Button variant="secondary" onClick={() => void checkResult()}>
                Check status
              </Button>
            </Show>
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
                description={
                  notice() ?? "We couldn't load karaoke for this song."
                }
                onRetry={() => void loadSong()}
                onGoHome={props.onExit}
              />
            }
          >
            {(timed) => (
              <KaraokePracticeSurface
                title={props.title}
                rewardSlot={
                  <>
                    <KaraokeCompletionStatus
                      state={finished()?.record.publication?.state ?? null}
                      onCheck={() => void checkResult()}
                    />
                    {props.rewardSlot}
                  </>
                }
                instrumentalAudioUrl={port.playbackUrl()}
                lines={karaokeStageLinesOf(timed().lines)}
                initialTimeMs={resume()?.elapsedMs ?? 0}
                singingStatus={singingStatus()}
                summary={finished()?.result.presentation ?? null}
                bestCombo={
                  finished()?.result.presentation?.bestCombo ??
                  currentFeedback().bestCombo
                }
                rating={
                  singingStatus() === "active" &&
                  currentFeedback().rating?.key !== restoredRatingKey()
                    ? currentFeedback().rating
                    : null
                }
                onExit={props.onExit}
                onStartSinging={(ms) => void start(ms)}
                onPlaybackElement={(element) => {
                  if (playback !== element) cancelPlaybackPosition?.();
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
                  // Once capture is complete, an interrupted outro can show the
                  // result without reopening the microphone or trapping the UI.
                  setPlayingOutro(false);
                  scoringResponses.reset();
                  return capture.controls.notePause(ms);
                }}
                onSeek={(ms) => {
                  scoringResponses.reset();
                  capture.controls.noteSeek(ms);
                }}
                onFinish={(ms) => {
                  setPlayingOutro(false);
                  void finish(ms);
                }}
              />
            )}
          </Show>
        </Show>
      </section>
    </Show>
  );
}
