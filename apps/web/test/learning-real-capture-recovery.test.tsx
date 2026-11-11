// UNRUN. c7cb87835a1858a1955c820b03d566365e6d42db integrated recovery assertions,
// adapted to the actual owned hook, capture controller, operator client and graph.
// Only browser context, microphone hardware and socket I/O are memory fixtures.
import { render } from "@solidjs/web";
import { afterEach, expect, test, vi } from "vitest";
import { KaraokePracticeSurface } from "../src/karaoke/practice-surface.tsx";
import { KaraokePlaybackGraph } from "../src/karaoke/playback-graph.ts";
import {
  useKaraokeCapture,
  type UseKaraokeCaptureResult,
} from "../src/karaoke/use-karaoke-capture.ts";
import {
  createKaraokeCaptureController,
  type KaraokeCaptureController,
} from "../../../packages/karaoke/capture-controller.ts";
import type { KaraokeOperatorSocket } from "../../../packages/karaoke/operator-audio-client.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
class MemorySocket implements KaraokeOperatorSocket {
  private readonly listeners = new Map<string, ((event: never) => void)[]>();
  readonly sent: (string | ArrayBuffer)[] = [];
  send(value: string | ArrayBuffer) {
    this.sent.push(value);
  }
  close() {
    this.emit("close", { code: 1000 });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, value: unknown) {
    this.listeners.get(type)?.forEach((listener) => listener(value as never));
  }
  ready(resumed = false) {
    this.emit("message", {
      data: JSON.stringify({
        type: "ready",
        attemptId: "original-attempt",
        resumed,
        audioSequence: 0,
      }),
    });
  }
}
async function mounted() {
  let contextState: AudioContextState = "running",
    paused = true;
  const context = new EventTarget();
  const transition = (state: AudioContextState) => {
    contextState = state;
    context.dispatchEvent(new Event("statechange"));
  };
  const resume = vi.fn(async () => transition("running"));
  Object.assign(context, {
    destination: {},
    resume,
    close: async () => transition("closed"),
    createMediaElementSource: () => ({ connect() {}, disconnect() {} }),
  });
  Object.defineProperty(context, "state", { get: () => contextState });
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(async () => {
      paused = false;
    });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
    paused = true;
  });
  const sockets: MemorySocket[] = [];
  let graph!: KaraokePlaybackGraph,
    capture!: UseKaraokeCaptureResult,
    controller!: KaraokeCaptureController;
  const engine = {
    start: vi.fn(async () => {
      graph.acquire();
    }),
    activate: vi.fn(async (stamp?: number) => stamp ?? 1000),
    captureClockMs: () => 1000,
    deactivateAndFlush: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(() => {
    capture = useKaraokeCapture(
      {
        enabled: true,
        ticketId: "original-ticket",
        openSocket: () => {
          const socket = new MemorySocket();
          sockets.push(socket);
          return socket;
        },
      },
      {
        createPlaybackGraph: (onInterrupted) =>
          (graph = new KaraokePlaybackGraph(
            () => context as AudioContext,
            onInterrupted,
          )),
        createController: (options) => {
          controller = createKaraokeCaptureController({
            ...options,
            createCaptureEngine: () => engine,
          });
          vi.spyOn(controller, "start");
          vi.spyOn(controller, "notePlay");
          return controller;
        },
      },
    );
    return (
      <KaraokePracticeSurface
        title="Actual controller recovery"
        lines={[]}
        instrumentalAudioUrl="https://media.invalid/fixture"
        singingStatus={capture.state()?.status ?? "idle"}
        playbackInterrupted={capture.playbackInterrupted()}
        onPlaybackElement={capture.controls.attachPlaybackElement}
        onResumePlayback={capture.controls.resumePlayback}
        onStartSinging={(ms) => {
          void capture.controls.start(ms);
        }}
        onPlay={capture.controls.notePlay}
        onPause={capture.controls.notePause}
        onTimeChange={capture.controls.noteTime}
      />
    );
  }, host);
  cleanups.push(dispose);
  const audio = host.querySelector("audio")!;
  Object.defineProperty(audio, "paused", {
    configurable: true,
    get: () => paused,
  });
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === label,
    );
  button("Start karaoke")!.click();
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  sockets[0]!.ready();
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  audio.currentTime = 2;
  audio.dispatchEvent(new Event("playing"));
  await vi.waitFor(() => expect(engine.activate).toHaveBeenCalledOnce());
  return {
    capture,
    controller,
    graph,
    engine,
    host,
    audio,
    sockets,
    play,
    transition,
    resume,
    button,
    dispose,
  };
}
test("real capture and socket reconnect preserve one ticket/controller/graph and resume a fresh epoch", async () => {
  const h = await mounted();
  expect(h.capture.controls.reconnect()).toBe(true);
  await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
  h.sockets[1]!.ready(true);
  await vi.waitFor(() => expect(h.capture.state()?.status).toBe("active"));
  await vi.waitFor(() => expect(h.engine.activate).toHaveBeenCalledTimes(2));
  expect(h.controller.start).toHaveBeenCalledOnce();
  expect(h.engine.start).toHaveBeenCalledOnce();
  expect(h.host.querySelector("audio")).toBe(h.audio);
  expect(h.capture.readyFor("original-ticket")).toBe(true);
  expect(h.engine.deactivateAndFlush).toHaveBeenCalled();
});
for (const boundary of ["unmounted", "detached", "finished"] as const)
  test(`real graph rejects delayed resume after ${boundary}`, async () => {
    const h = await mounted();
    h.transition("suspended");
    await vi.waitFor(() => expect(h.capture.playbackInterrupted()).toBe(true));
    let release!: () => void;
    h.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const recovery = h.capture.controls.resumePlayback();
    expect(h.resume).toHaveBeenCalledOnce();
    if (boundary === "unmounted") {
      h.dispose();
      cleanups.pop();
    } else if (boundary === "detached")
      h.capture.controls.attachPlaybackElement(null);
    else await h.capture.controls.noteFinish(2000);
    h.transition("running");
    release();
    expect(await recovery).toBe(false);
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.controller.start).toHaveBeenCalledOnce();
    expect(h.sockets).toHaveLength(1);
  });
