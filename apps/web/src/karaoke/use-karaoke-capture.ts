// Solid lifecycle edge for the Karaoke capture controller. Adapted from
// pirate-web-solid 667a6f22 scoring/use-karaoke-scoring-session.ts: the
// microphone borrows the playback graph's AudioContext, the AudioWorklet is
// bundled as a module URL, context suspension pauses capture and latches a
// tap-to-continue recovery, and a closed context aborts the take. The take
// opens the operator's ticket socket instead of a centralized session.
// See docs/karaoke-capture-handoff.md.
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import {
  createKaraokeCaptureController,
  type KaraokeCaptureController,
  type KaraokeCaptureState,
} from "../../../../packages/karaoke/capture-controller.ts";
import { KaraokeMicCapture } from "../../../../packages/karaoke/mic-capture.ts";
import {
  KaraokeOperatorAudioClient,
  type KaraokeOperatorSocket,
} from "../../../../packages/karaoke/operator-audio-client.ts";
import { createBrowserMicCaptureDeps } from "./mic-capture-browser.ts";
import {
  KaraokePlaybackGraph,
  type KaraokePlaybackInterruption,
} from "./playback-graph.ts";
// A TypeScript AudioWorklet must be bundled as a module URL, or addModule
// receives an uncompiled data URL in the built application.
import workletModuleUrl from "./capture-processor.ts?worker&url";

export interface UseKaraokeCaptureOptions {
  enabled: boolean;
  ticketId: string;
  /** Opens the operator's /attempt socket for the ticket, proof included. */
  openSocket: () => KaraokeOperatorSocket;
  onMessage?: (message: Record<string, unknown>) => void;
  workletModuleUrl?: URL | string;
}
export interface KaraokeCaptureControls {
  attachPlaybackElement(element: HTMLAudioElement | null): void;
  resumePlayback(): Promise<boolean>;
  start(songMs: number): void;
  noteTime(songMs: number): void;
  notePlay(songMs: number): void;
  notePause(songMs: number): void | Promise<void>;
  noteSeek(songMs: number): void;
  noteFinish(songMs: number): void | Promise<void>;
  stop(): void;
  abort(code: string): void;
}
export interface UseKaraokeCaptureResult {
  playbackGraph: KaraokePlaybackGraph;
  playbackInterrupted: Accessor<boolean>;
  state: Accessor<KaraokeCaptureState | null>;
  controls: KaraokeCaptureControls;
}

export function useKaraokeCapture(
  options: UseKaraokeCaptureOptions,
): UseKaraokeCaptureResult {
  const [state, setState] = createSignal<KaraokeCaptureState | null>(null);
  const [playbackInterrupted, setPlaybackInterrupted] = createSignal(false);
  let recoveryGeneration = 0;
  const onInterrupted: KaraokePlaybackInterruption = (
    songMs,
    contextState,
    alreadyPaused,
  ) => {
    recoveryGeneration += 1;
    const status = currentController?.getState().status;
    if (!alreadyPaused) void currentController?.notePause(songMs);
    if (contextState === "closed") {
      setPlaybackInterrupted(false);
      if (
        ["requesting-mic", "connecting", "active", "reconnecting"].includes(
          status ?? "",
        )
      )
        currentController?.abort("karaoke_audio_closed");
    } else if (["active", "reconnecting"].includes(status ?? "")) {
      setPlaybackInterrupted(true);
    }
  };
  const playbackGraph = new KaraokePlaybackGraph(undefined, onInterrupted);
  onCleanup(() => {
    recoveryGeneration += 1;
    playbackGraph.dispose();
  });
  let playbackElement: HTMLAudioElement | null = null;
  let currentController: KaraokeCaptureController | null = null;
  createEffect(
    () => options.enabled,
    (enabled) => {
      if (!enabled) {
        recoveryGeneration += 1;
        currentController = null;
        setState(null);
        return;
      }
      const controller = createKaraokeCaptureController({
        createCaptureEngine: ({ onChunk, onError }) =>
          new KaraokeMicCapture({
            deps: createBrowserMicCaptureDeps(
              options.workletModuleUrl ??
                new URL(workletModuleUrl, import.meta.url),
              () => playbackGraph.acquire(),
            ),
            onChunk,
            onError,
          }),
        createClient: (hooks) =>
          new KaraokeOperatorAudioClient({
            ...hooks,
            ticketId: options.ticketId,
            openSocket: options.openSocket,
          }),
        deferCaptureUntilPlaying: true,
        getPlaybackPosition: () =>
          playbackElement
            ? {
                songMs: playbackElement.currentTime * 1000,
                playbackRate: playbackElement.playbackRate,
              }
            : null,
        onMessage: (message) => options.onMessage?.(message),
      });
      currentController = controller;
      setState(controller.getState());
      const unsubscribe = controller.subscribe((next) => {
        if (next.status !== "active") recoveryGeneration += 1;
        setState(next);
      });
      return () => {
        recoveryGeneration += 1;
        unsubscribe();
        controller.dispose();
        if (currentController === controller) currentController = null;
      };
    },
  );
  const controls: KaraokeCaptureControls = {
    attachPlaybackElement: (element) => {
      if (element !== playbackElement) recoveryGeneration += 1;
      playbackElement = element;
      playbackGraph.attach(element);
      if (!element) setPlaybackInterrupted(false);
    },
    resumePlayback: async () => {
      const controller = currentController;
      const element = playbackElement;
      const request = ++recoveryGeneration;
      if (!controller || !element || controller.getState().status !== "active")
        return false;
      // Resume inside the gesture; capture still waits for notePlay.
      const running = await playbackGraph.resume();
      if (
        !running ||
        request !== recoveryGeneration ||
        currentController !== controller ||
        playbackElement !== element ||
        controller.getState().status !== "active" ||
        !playbackGraph.isRunning()
      )
        return false;
      setPlaybackInterrupted(false);
      return true;
    },
    abort: (code) => {
      recoveryGeneration += 1;
      setPlaybackInterrupted(false);
      currentController?.abort(code);
    },
    noteFinish: (songMs) => {
      recoveryGeneration += 1;
      setPlaybackInterrupted(false);
      return currentController?.noteFinish(songMs);
    },
    notePause: (songMs) => currentController?.notePause(songMs),
    notePlay: (songMs) => {
      if (playbackInterrupted() && !playbackGraph.isRunning()) return;
      setPlaybackInterrupted(false);
      currentController?.notePlay(songMs);
    },
    noteSeek: (songMs) => currentController?.noteSeek(songMs),
    noteTime: (songMs) => {
      playbackGraph.checkState();
      currentController?.noteTime(songMs);
    },
    start: (songMs) => {
      recoveryGeneration += 1;
      setPlaybackInterrupted(false);
      void currentController?.start(songMs);
    },
    stop: () => {
      recoveryGeneration += 1;
      setPlaybackInterrupted(false);
      currentController?.stop();
    },
  };
  return { controls, playbackInterrupted, state, playbackGraph };
}
