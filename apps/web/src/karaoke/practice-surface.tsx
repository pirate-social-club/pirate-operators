// Adopted from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; imports only.
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack } from "solid-js";
import {
  IconArrowCounterClockwise,
  IconMicrophoneStage,
  Spinner,
} from "./ui.ts";
import { ActivityProgressHeader } from "../ui/activity-progress-header.tsx";
import { ActivityResults } from "./activity-results.tsx";
import { ActivityFooter } from "../ui/activity-footer.tsx";
import { LearningActivityFrame } from "../ui/learning-activity-frame.tsx";
import { karaokeResultsView, type KaraokeResultsSummary } from "./results-model.ts";
import { getLyricDurationMs } from "../../../../packages/karaoke/karaoke-timing.ts";
import { KaraokeLyricStage } from "./lyric-stage.tsx";
import type { KaraokeLineRating, KaraokeStageLine } from "./lyric-stage.tsx";
import { createKaraokePlaybackRenewal, type KaraokePlaybackAccess } from "./playback-renewal.ts";

export interface KaraokePracticeSurfaceProps {
  title: string;
  artworkSrc?: string;
  instrumentalAudioUrl?: string;
  playbackAccess?: KaraokePlaybackAccess;
  lines: readonly KaraokeStageLine[];
  rewardLabel?: string;
  rewardSlot?: JSX.Element;
  rating?: KaraokeLineRating | null;
  /** Seeds an offline/story render at a known point in the lyric timeline. */
  initialTimeMs?: number;
  /** Seeds the progress scale for deterministic story renders without audio. */
  initialDurationMs?: number;
  /** Keeps scoring feedback visible in deterministic story renders. */
  ratingPersistent?: boolean;
  onExit?: () => void;
  onStartSinging?: (songMs: number) => void;
  singingStatus?: "idle" | "requesting-mic" | "connecting" | "reconnecting" | "active" | "finishing" | "ended" | "error";
  onTimeChange?: (songMs: number) => void;
  /** Internal playback lifecycle notifications for scoring; no visible controls. */
  onPlaybackElement?: (element: HTMLAudioElement | null) => void;
  playbackInterrupted?: boolean;
  onResumePlayback?: () => Promise<boolean>;
  onPlay?: (songMs: number) => void;
  onPause?: (songMs: number) => void | Promise<void>;
  onSeek?: (songMs: number) => void;
  onFinish?: (songMs: number) => void;
  /** The server's summary for the finished take; null when none arrived. */
  summary?: KaraokeResultsSummary | null;
  /** Longest run of well-sung lines, from the client's live feedback. */
  bestCombo?: number;
  /** Start-screen feedback; result recovery notices belong to the page overlay. */
  startError?: string;
  /** Route-owned recovery status rendered above the activity actions. */
  statusSlot?: JSX.Element;
}

interface AudioElementRef {
  current?: HTMLAudioElement;
}

export function KaraokePracticeSurface(props: KaraokePracticeSurfaceProps) {
  const audioRef: AudioElementRef = {};
  const [currentTimeMs, setCurrentTimeMs] = createSignal(Math.max(0, props.initialTimeMs ?? 0));
  const [durationMs, setDurationMs] = createSignal(props.initialDurationMs ?? getLyricDurationMs(props.lines));
  const [isPlaying, setIsPlaying] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(Boolean(props.instrumentalAudioUrl));
  let pendingPlay = false;
  let disposed = false;
  let playRequest = 0;
  const [playbackIssue, setPlaybackIssue] = createSignal(false);
  // Access belongs to this mounted payload; renewal preserves its scored take.
  const initialPlaybackAccess = untrack(() => props.playbackAccess);
  const playbackRenewal = initialPlaybackAccess ? createKaraokePlaybackRenewal({
    access: initialPlaybackAccess,
    audio: () => audioRef.current,
    canResume: () => untrack(() => props.singingStatus === "active" && !props.playbackInterrupted),
    onPause: (songMs) => {
      setIsPlaying(false);
      setCurrentTimeMs(songMs);
      return props.onPause?.(songMs);
    },
    onIssue: setPlaybackIssue,
  }) : undefined;
  const [resuming, setResuming] = createSignal(false);
  let recoveryRequest = 0;
  const resumeInterruptedPlayback = () => {
    const request = ++recoveryRequest;
    setResuming(true);
    // Invoke synchronously from the click; awaiting first loses user activation.
    const resume = props.onResumePlayback?.() ?? Promise.resolve(false);
    void resume.then((running) => {
      if (disposed || request !== recoveryRequest || props.singingStatus !== "active") return;
      setResuming(false);
      if (running) playBackingTrack();
    }, () => {
      if (!disposed && request === recoveryRequest) setResuming(false);
    });
  };
  const playBackingTrack = () => {
    if (playbackRenewal) { playbackRenewal.play(); return; }
    const audio = audioRef.current;
    if (!audio) return;
    const request = ++playRequest;
    setPlaybackIssue(false);
    void audio.play().catch(() => {
      if (disposed || request !== playRequest || props.singingStatus !== "active") return;
      setIsPlaying(false);
      setPlaybackIssue(true);
      props.onPause?.(currentTimeMs());
    });
  };
  const firstLineStartMs = props.lines[0]?.startMs ?? Number.POSITIVE_INFINITY;
  const ended = () => props.singingStatus === "ended";
  const busy = () => props.singingStatus === "requesting-mic" || props.singingStatus === "connecting" || props.singingStatus === "reconnecting";

  const syncTime = () => {
    const songMs = (playbackRenewal?.positionSeconds() ?? audioRef.current?.currentTime ?? 0) * 1000;
    setCurrentTimeMs(songMs);
    props.onTimeChange?.(songMs);
    return songMs;
  };
  createEffect(
    () => props.instrumentalAudioUrl,
    (instrumentalAudioUrl) => {
      if (!instrumentalAudioUrl) setIsLoading(false);
    },
  );
  createEffect(
    () => props.singingStatus,
    (singingStatus) => {
      if (singingStatus !== "active") {
        recoveryRequest += 1;
        setResuming(false);
        if (singingStatus === "idle" || singingStatus === "finishing" || singingStatus === "ended" || singingStatus === "error") {
          playbackRenewal?.cancel();
          pendingPlay = false;
          playRequest += 1;
          audioRef.current?.pause();
        }
        return;
      }
      if (!pendingPlay) { playbackRenewal?.resume(); return; }
      pendingPlay = false;
      const audio = audioRef.current;
      if (audio && !untrack(isPlaying)) playBackingTrack();
    },
  );
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => props.singingStatus, (status) => {
    clearInterval(clockTimer);
    clockTimer = status === "active" ? setInterval(syncTime, 50) : undefined;
  });
  createEffect(() => props.playbackInterrupted, (interrupted) => {
    if (!interrupted) return;
    playbackRenewal?.interrupt();
    playRequest += 1;
    setPlaybackIssue(false);
    setIsPlaying(false);
  });
  onCleanup(() => { clearInterval(clockTimer); playbackRenewal?.dispose(); props.onPlaybackElement?.(null); disposed = true; playRequest += 1; audioRef.current?.pause(); });

  const footerKind = createMemo(() => props.playbackInterrupted && props.singingStatus === "active"
    ? "interrupted"
    : playbackIssue() && !props.playbackInterrupted && props.singingStatus === "active"
      ? "issue"
      : props.onStartSinging && props.singingStatus !== "active"
        ? "start"
        : undefined);
  const startAction = () => {
    pendingPlay = true;
    if (!ended()) { props.onStartSinging?.(currentTimeMs()); return; }
    // A finished take leaves the track at its end; another take starts from the top.
    if (audioRef.current) audioRef.current.currentTime = 0;
    setCurrentTimeMs(0);
    props.onStartSinging?.(0);
  };
  const startLabel = () => ended() ? "Sing again" : busy() ? "Start singing" : "Start karaoke";
  const resultsFooter = () => Boolean(ended() && props.onExit);
  const showHeader = createMemo(() => !ended());
  const primaryFooterAction = () => {
    const kind = footerKind();
    if (kind === "interrupted") return resumeInterruptedPlayback();
    if (kind === "issue") return playBackingTrack();
    if (resultsFooter()) return props.onExit?.();
    startAction();
  };

  return (
    <LearningActivityFrame
      as="main"
      ariaLabel={props.title}
      background={props.artworkSrc ? (
        <>
          <img alt="" aria-hidden="true" class="pointer-events-none absolute inset-0 size-full scale-110 object-cover opacity-20 blur-2xl" src={props.artworkSrc} />
          <div aria-hidden="true" class="absolute inset-0 bg-gradient-to-b from-background/50 via-background/70 to-background" />
        </>
      ) : undefined}
      contentLabel={ended() ? "Results" : undefined}
      footer={footerKind() || props.statusSlot ? (
        <ActivityFooter
          error={footerKind() === "start" ? props.startError : undefined}
          notice={footerKind() === "interrupted"
            ? "Audio was interrupted. Tap to continue your take."
            : footerKind() === "issue"
              ? "The backing track could not start. Press play to continue."
              : undefined}
          onPrimaryAction={primaryFooterAction}
          onSecondaryAction={startAction}
          primaryDisabled={footerKind() === "interrupted" ? resuming() : !resultsFooter() && busy()}
          primaryIcon={footerKind() === "start" && !resultsFooter() ? <IconMicrophoneStage class="size-5" /> : undefined}
          primaryLabel={footerKind() ? (footerKind() === "interrupted"
            ? "Tap to continue"
            : footerKind() === "issue"
              ? "Start backing track"
              : resultsFooter()
                ? "Continue"
                : startLabel()) : undefined}
          primaryLoading={footerKind() === "interrupted" ? resuming() : !resultsFooter() && busy()}
          primaryVariant="default"
          results={footerKind() === "start" && resultsFooter()}
          secondaryDisabled={resultsFooter() && busy()}
          secondaryIcon={resultsFooter() ? <IconArrowCounterClockwise class="size-5" /> : undefined}
          secondaryLabel={footerKind() === "start" && resultsFooter() ? "Sing again" : undefined}
          secondaryLoading={resultsFooter() && busy()}
          topSlot={props.statusSlot}
        />
      ) : undefined}
      header={showHeader() ? (
        <ActivityProgressHeader
          exitLabel="Exit karaoke"
          onExit={props.onExit}
          progressMax={durationMs()}
          progressValue={currentTimeMs()}
          rewardLabel={props.rewardLabel}
        />
      ) : undefined}
    >
      {/* A finished take needs no exit arrow or progress bar; Continue leaves. */}
      <h1 class="sr-only">{props.title}</h1>
      <div class="relative z-10 flex min-h-full w-full min-w-0 flex-1 flex-col">
        <Show when={ended()}>
          {(_) => {
            const view = () => karaokeResultsView(props.summary ?? null, props.bestCombo ?? 0);
            return (
              <div class="flex min-h-full flex-1 flex-col">
                <ActivityResults
                  heading={view().heading}
                  note={view().note}
                  scoreLabel="Score"
                  scorePercent={view().scorePercent}
                  stats={view().stats}
                />
                <div class="mx-auto w-full max-w-md px-4 pb-6 empty:hidden">{props.rewardSlot}</div>
              </div>
            );
          }}
        </Show>
        <Show when={!ended() && !isLoading()} fallback={<Show when={!ended()}><div class="grid flex-1 place-items-center"><Spinner class="size-8" /></div></Show>}>
          <Show when={props.lines.length > 0}>
            <div class="min-h-0 flex-1">
              <KaraokeLyricStage
                currentTimeMs={currentTimeMs()}
                lines={props.lines}
                primed={!isPlaying() && currentTimeMs() <= firstLineStartMs}
                rating={props.rating}
                ratingPersistent={props.ratingPersistent}
              />
            </div>
          </Show>
        </Show>
      </div>
      <audio
        ref={(element) => { audioRef.current = element; props.onPlaybackElement?.(element); }}
        crossorigin="anonymous"
        preload="auto"
        src={props.instrumentalAudioUrl}
        onLoadedMetadata={() => playbackRenewal?.metadata()}
        onCanPlay={() => setIsLoading(false)}
        onDurationChange={(event) => {
          const nextDurationMs = event.currentTarget.duration * 1000;
          if (Number.isFinite(nextDurationMs) && nextDurationMs > 0) {
            setDurationMs(Math.round(nextDurationMs));
          }
        }}
        onEnded={() => { setIsPlaying(false); props.onFinish?.(syncTime()); }}
        onError={() => { setIsLoading(false); playbackRenewal?.error(); }}
        onPause={() => { setIsPlaying(false); props.onPause?.(syncTime()); }}
        onPlay={() => setIsPlaying(true)}
        onPlaying={() => {
          if (playbackRenewal && !playbackRenewal.playing()) return;
          setIsPlaying(true); props.onPlay?.(syncTime());
        }}
        onWaiting={() => { props.onPause?.(syncTime()); }}
        onStalled={(event) => {
          const songMs = syncTime();
          // A stalled download can leave enough buffered audio to keep playing.
          if (event.currentTarget.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) props.onPause?.(songMs);
        }}
        onTimeUpdate={syncTime}
      />
    </LearningActivityFrame>
  );
}
