// Source playback transition cases from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; imports adapted. UNRUN.
import type { JSX } from "@solidjs/web";
import { render as solidRender } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { KaraokePracticeSurface } from "../src/karaoke/practice-surface.tsx";
import {
  createKaraokePlaybackRenewal,
  type KaraokePlaybackAccess,
  type KaraokePlaybackGrant,
} from "../src/karaoke/playback-renewal.ts";
import { KaraokePlaybackGraph } from "../src/karaoke/playback-graph.ts";
import {
  useKaraokeCapture as useKaraokeScoring,
  type KaraokeCaptureConstruction as KaraokeScoringConstruction,
  type UseKaraokeCaptureResult as UseKaraokeScoringResult,
} from "../src/karaoke/use-karaoke-capture.ts";
import type {
  KaraokeCaptureController as KaraokeScoringController,
  KaraokeCaptureState as KaraokeScoringState,
} from "../../../packages/karaoke/capture-controller.ts";

const mountUi = (ui: () => JSX.Element, host: HTMLElement) =>
  solidRender(ui, host);
const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
function mount(
  resumePlayback = vi.fn(async () => true),
  playbackAccess?: KaraokePlaybackAccess,
) {
  const [status, setStatus] = createSignal<
    | "idle"
    | "connecting"
    | "reconnecting"
    | "active"
    | "finishing"
    | "ended"
    | "error"
  >("idle");
  const [interrupted, setInterrupted] = createSignal(false);
  const onPause = vi.fn();
  const onPlay = vi.fn();
  const onTimeChange = vi.fn();
  const onPlaybackElement = vi.fn();
  const onStartSinging = vi.fn(() => setStatus("connecting"));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = mountUi(
    () => (
      <KaraokePracticeSurface
        title="Fixture song"
        lines={[]}
        instrumentalAudioUrl={playbackAccess?.grant.url ?? "/fixture.mp3"}
        playbackAccess={playbackAccess}
        playbackInterrupted={interrupted()}
        onResumePlayback={resumePlayback}
        singingStatus={status()}
        onStartSinging={onStartSinging}
        onPause={onPause}
        onPlay={onPlay}
        onTimeChange={onTimeChange}
        onPlaybackElement={onPlaybackElement}
      />
    ),
    host,
  );
  cleanups.push(dispose);
  return {
    host,
    setStatus,
    setInterrupted,
    onStartSinging,
    onPause,
    onPlay,
    onTimeChange,
    onPlaybackElement,
    dispose,
  };
}
const button = (host: HTMLElement, name: string) =>
  [...host.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === name,
  );

test("starts the backing track once the scored microphone session becomes active", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { host, setStatus } = mount();
  button(host, "Start karaoke")!.click();
  await vi.waitFor(() =>
    expect(button(host, "Start singing")?.disabled).toBe(true),
  );
  expect(play).not.toHaveBeenCalled();
  setStatus("active");
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
});

test("offers gesture recovery and waits for a running context before restarting media", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  let resolve: ((value: boolean) => void) | undefined;
  const resume = vi.fn(
    () =>
      new Promise<boolean>((r) => {
        resolve = r;
      }),
  );
  const { host, setStatus, setInterrupted } = mount(resume);
  setStatus("active");
  setInterrupted(true);
  await vi.waitFor(() => expect(button(host, "Tap to continue")).toBeDefined());
  button(host, "Tap to continue")!.click();
  expect(resume).toHaveBeenCalledOnce();
  expect(play).not.toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(button(host, "Tap to continue")!.disabled).toBe(true),
  );
  resolve?.(false);
  await vi.waitFor(() =>
    expect(button(host, "Tap to continue")!.disabled).toBe(false),
  );
  button(host, "Tap to continue")!.click();
  await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
  resolve?.(true);
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
});

test("a recovery resolving after the take ends never restarts playback", async () => {
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  let resolve: ((value: boolean) => void) | undefined;
  const { host, setStatus, setInterrupted } = mount(
    vi.fn(
      () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
    ),
  );
  setStatus("active");
  setInterrupted(true);
  await vi.waitFor(() => expect(button(host, "Tap to continue")).toBeDefined());
  button(host, "Tap to continue")!.click();
  setStatus("ended");
  resolve?.(true);
  await Promise.resolve();
  expect(play).not.toHaveBeenCalled();
});

test("offers a direct playback retry and pauses scoring when the browser refuses the backing track", async () => {
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockRejectedValueOnce(
      new DOMException("User activation required", "NotAllowedError"),
    )
    .mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { host, setStatus, onPause } = mount();
  button(host, "Start karaoke")!.click();
  setStatus("active");
  await vi.waitFor(() =>
    expect(host.textContent).toContain("Start backing track"),
  );
  expect(onPause).toHaveBeenCalledWith(0);
  button(host, "Start backing track")!.click();
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(host.textContent).not.toContain("Start backing track"),
  );
});

test("capture waits for playing and suspends on waiting and stalled", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { host, onPlay, onPause } = mount();
  const audio = host.querySelector("audio")!;
  audio.currentTime = 1.25;
  audio.dispatchEvent(new Event("play"));
  expect(onPlay).not.toHaveBeenCalled();
  audio.dispatchEvent(new Event("playing"));
  expect(onPlay).toHaveBeenCalledWith(1250);
  audio.currentTime = 1.5;
  audio.dispatchEvent(new Event("waiting"));
  audio.dispatchEvent(new Event("stalled"));
  expect(onPause.mock.calls).toEqual([[1500], [1500]]);
});

test("keeps capture active when a stalled download still has buffered playback", () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { host, onPlay, onPause, onTimeChange } = mount();
  const audio = host.querySelector("audio")!;
  Object.defineProperty(audio, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_FUTURE_DATA,
  });
  audio.dispatchEvent(new Event("playing"));
  audio.currentTime = 2;
  audio.dispatchEvent(new Event("stalled"));
  expect(onPlay).toHaveBeenCalledOnce();
  expect(onPause).not.toHaveBeenCalled();
  expect(onTimeChange).toHaveBeenLastCalledWith(2000);
});

test("samples the real media position between timeupdate events and stops on cleanup", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const { host, setStatus, onTimeChange, onPlaybackElement } = mount();
  const audio = host.querySelector("audio")!;
  expect(onPlaybackElement).toHaveBeenCalledWith(audio);
  setStatus("active");
  audio.currentTime = 2;
  await vi.waitFor(() => expect(onTimeChange).toHaveBeenCalledWith(2000));
  cleanups.splice(0).forEach((dispose) => dispose());
  expect(onPlaybackElement).toHaveBeenLastCalledWith(null);
  const calls = onTimeChange.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(onTimeChange).toHaveBeenCalledTimes(calls);
});

// Restored remainder of the c7 suite: real adopted renewal/surface/hook/graph,
// original source controller double. Assertions retained; operator seam adapted.
function renewalFixture(flush?: Promise<void>) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const audio = document.createElement("audio");
  audio.src = "https://media.test/first";
  audio.currentTime = 12.5;
  Object.defineProperty(audio, "duration", { value: 120 });
  Object.defineProperty(audio, "paused", { value: false, configurable: true });
  const play = vi.spyOn(audio, "play").mockResolvedValue(undefined);
  const pause = vi.spyOn(audio, "pause").mockImplementation(() => {});
  const load = vi.spyOn(audio, "load").mockImplementation(() => {
    audio.currentTime = 0;
  });
  let active = true;
  let resolve: ((grant: KaraokePlaybackGrant) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const renew = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<KaraokePlaybackGrant>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  const onPause = vi.fn(() => flush),
    onIssue = vi.fn();
  const renewal = createKaraokePlaybackRenewal({
    access: {
      grant: { url: audio.src, expiresAtMs: 1_060_000, renewAtMs: 1_030_000 },
      renew,
    },
    audio: () => audio,
    canResume: () => active,
    onPause,
    onIssue,
  });
  cleanups.push(() => renewal.dispose());
  return {
    audio,
    play,
    pause,
    load,
    renew,
    onPause,
    onIssue,
    renewal,
    stop: () => {
      active = false;
      renewal.cancel();
    },
    resolve: () =>
      resolve!({
        url: "https://media.test/renewed",
        expiresAtMs: Date.now() + 60_000,
        renewAtMs: Date.now() + 30_000,
      }),
    reject: () => reject!(new Error("access refused")),
  };
}

test("renews the instrumental on the same element and resumes its exact song clock only after metadata", async () => {
  const h = renewalFixture();
  expect(h.renewal.playing()).toBe(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(h.renew).toHaveBeenCalledOnce();
  expect(h.pause).toHaveBeenCalledOnce();
  expect(h.onPause).toHaveBeenCalledWith(12_500);
  expect(h.play).not.toHaveBeenCalled();
  h.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.audio.src).toBe("https://media.test/renewed");
  expect(h.audio.currentTime).toBe(0);
  expect(h.play).not.toHaveBeenCalled();
  h.renewal.metadata();
  expect(h.audio.currentTime).toBe(12.5);
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.renewal.playing()).toBe(true);
});

test("an expired idle grant is reacquired once and a refusal never plays the stale URL", async () => {
  const h = renewalFixture();
  vi.setSystemTime(1_070_000);
  h.renewal.play();
  h.renewal.play();
  expect(h.renew).toHaveBeenCalledOnce();
  h.reject();
  await Promise.resolve();
  expect(h.onIssue).toHaveBeenLastCalledWith(true);
  expect(h.play).not.toHaveBeenCalled();
  h.renewal.play();
  expect(h.renew).toHaveBeenCalledTimes(2);
  h.resolve();
  await Promise.resolve();
  await Promise.resolve();
  h.renewal.metadata();
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.audio.currentTime).toBe(12.5);
});

test.each(["route cleanup", "take completion"])(
  "%s aborts access and rejects a late renewal without restarting playback",
  async (ending) => {
    const h = renewalFixture();
    vi.setSystemTime(1_070_000);
    h.renewal.play();
    const signal = h.renew.mock.calls[0]![0];
    if (ending === "route cleanup") h.renewal.dispose();
    else h.stop();
    expect(signal.aborted).toBe(true);
    h.resolve();
    await Promise.resolve();
    await Promise.resolve();
    h.renewal.metadata();
    expect(h.audio.src).toBe("https://media.test/first");
    expect(h.play).not.toHaveBeenCalled();
    expect(h.load).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("a refused play from an earlier take cannot pause its successor", async () => {
  const h = renewalFixture();
  let refuse: ((reason: Error) => void) | undefined;
  h.play.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        refuse = reject;
      }),
  );
  h.renewal.play();
  h.renewal.cancel();
  h.renewal.play();
  refuse!(new Error("interrupted earlier play"));
  await Promise.resolve();
  expect(h.play).toHaveBeenCalledTimes(2);
  expect(h.pause).not.toHaveBeenCalled();
  expect(h.onIssue).not.toHaveBeenCalledWith(true);
});

test("a new grant waits for the microphone tail and freezes the reported clock while metadata loads", async () => {
  let flushed: (() => void) | undefined;
  const h = renewalFixture(
    new Promise<void>((resolve) => {
      flushed = resolve;
    }),
  );
  vi.setSystemTime(1_070_000);
  h.renewal.play();
  h.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.audio.src).toBe("https://media.test/first");
  expect(h.load).not.toHaveBeenCalled();
  expect(h.renewal.positionSeconds()).toBe(12.5);
  flushed!();
  await Promise.resolve();
  expect(h.audio.src).toBe("https://media.test/renewed");
  expect(h.audio.currentTime).toBe(0);
  expect(h.renewal.positionSeconds()).toBe(12.5);
  h.renewal.metadata();
  expect(h.audio.currentTime).toBe(12.5);
  expect(h.renewal.positionSeconds()).toBeUndefined();
});

test("mounted renewal keeps one scored take and waits for the real playing event to resume capture", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.currentTime = 0;
  });
  let resolve: ((value: KaraokePlaybackGrant) => void) | undefined;
  const renew = vi.fn(
    () =>
      new Promise<KaraokePlaybackGrant>((yes) => {
        resolve = yes;
      }),
  );
  const h = mount(undefined, {
    grant: {
      url: "https://media.test/first",
      expiresAtMs: now + 60_000,
      renewAtMs: now + 30_000,
    },
    renew,
  });
  const audio = h.host.querySelector("audio")!;
  audio.currentTime = 12.5;
  audio.dispatchEvent(new Event("timeupdate"));
  button(h.host, "Start karaoke")!.click();
  await vi.waitFor(() => expect(h.onStartSinging).toHaveBeenCalledOnce());
  now += 70_000;
  h.setStatus("active");
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  expect(h.onPause).toHaveBeenCalledWith(12_500);
  resolve!({
    url: "https://media.test/renewed",
    expiresAtMs: now + 60_000,
    renewAtMs: now + 30_000,
  });
  await vi.waitFor(() => expect(audio.src).toBe("https://media.test/renewed"));
  expect(h.onPlay).not.toHaveBeenCalled();
  audio.dispatchEvent(new Event("timeupdate"));
  expect(audio.currentTime).toBe(0);
  expect(h.onTimeChange).toHaveBeenLastCalledWith(12_500);
  audio.dispatchEvent(new Event("loadedmetadata"));
  expect(audio.currentTime).toBe(12.5);
  expect(play).toHaveBeenCalledOnce();
  expect(h.onPlay).not.toHaveBeenCalled();
  audio.dispatchEvent(new Event("playing"));
  expect(h.onPlay).toHaveBeenCalledWith(12_500);
  expect(h.onStartSinging).toHaveBeenCalledOnce();
  expect(h.host.querySelector("audio")).toBe(audio);
});

async function mountPendingRenewal() {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(function (this: HTMLMediaElement) {
      this.currentTime = 0;
    });
  let resolve: ((value: KaraokePlaybackGrant) => void) | undefined;
  const renew = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<KaraokePlaybackGrant>((yes) => {
        resolve = yes;
      }),
  );
  const h = mount(undefined, {
    grant: {
      url: "https://media.test/first",
      expiresAtMs: now + 60_000,
      renewAtMs: now + 30_000,
    },
    renew,
  });
  const audio = h.host.querySelector("audio")!;
  audio.currentTime = 12.5;
  audio.dispatchEvent(new Event("timeupdate"));
  button(h.host, "Start karaoke")!.click();
  await vi.waitFor(() => expect(h.onStartSinging).toHaveBeenCalledOnce());
  now += 70_000;
  h.setStatus("active");
  await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
  const resolveGrant = () =>
    resolve!({
      url: "https://media.test/renewed",
      expiresAtMs: now + 60_000,
      renewAtMs: now + 30_000,
    });
  return {
    ...h,
    audio,
    play,
    load,
    renew,
    resolveGrant,
    resolve: async () => {
      resolveGrant();
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    },
  };
}

test("a renewed media failure offers a same-take reload and restores the held song clock", async () => {
  const h = await mountPendingRenewal();
  await h.resolve();
  h.audio.dispatchEvent(new Event("error"));
  await vi.waitFor(() =>
    expect(button(h.host, "Start backing track")).toBeDefined(),
  );
  expect(h.play).not.toHaveBeenCalled();
  h.audio.dispatchEvent(new Event("timeupdate"));
  expect(h.onTimeChange).toHaveBeenLastCalledWith(12_500);
  button(h.host, "Start backing track")!.click();
  await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
  expect(h.audio.src).toBe("https://media.test/renewed");
  expect(h.renew).toHaveBeenCalledOnce();
  expect(h.play).not.toHaveBeenCalled();
  h.audio.dispatchEvent(new Event("loadedmetadata"));
  expect(h.audio.currentTime).toBe(12.5);
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.onPlay).not.toHaveBeenCalled();
  h.audio.dispatchEvent(new Event("playing"));
  expect(h.onPlay).toHaveBeenCalledWith(12_500);
  expect(h.onStartSinging).toHaveBeenCalledOnce();
  expect(h.host.querySelector("audio")).toBe(h.audio);
  await vi.waitFor(() =>
    expect(button(h.host, "Start backing track")).toBeUndefined(),
  );
});

test.each(["take completion", "route cleanup"])(
  "%s cancels recovery from a renewed media failure before metadata",
  async (ending) => {
    const h = await mountPendingRenewal();
    await h.resolve();
    h.audio.dispatchEvent(new Event("error"));
    await vi.waitFor(() =>
      expect(button(h.host, "Start backing track")).toBeDefined(),
    );
    button(h.host, "Start backing track")!.click();
    await vi.waitFor(() => expect(h.load).toHaveBeenCalledTimes(2));
    if (ending === "route cleanup") h.dispose();
    else {
      h.setStatus("ended");
      await vi.waitFor(() =>
        expect(button(h.host, "Sing again")).toBeDefined(),
      );
    }
    h.audio.dispatchEvent(new Event("loadedmetadata"));
    expect(h.play).not.toHaveBeenCalled();
    expect(h.onPlay).not.toHaveBeenCalled();
    expect(h.renew).toHaveBeenCalledOnce();
    expect(h.onStartSinging).toHaveBeenCalledOnce();
  },
);

test.each(["before grant", "before metadata"])(
  "a scoring reconnect %s retains renewal continuation for the same take",
  async (phase) => {
    const h = await mountPendingRenewal();
    if (phase === "before metadata") await h.resolve();
    h.setStatus("reconnecting");
    await vi.waitFor(() =>
      expect(button(h.host, "Start singing")?.disabled).toBe(true),
    );
    if (phase === "before grant") await h.resolve();
    h.audio.dispatchEvent(new Event("loadedmetadata"));
    expect(h.audio.currentTime).toBe(12.5);
    expect(h.play).not.toHaveBeenCalled();
    expect(h.onPlay).not.toHaveBeenCalled();
    h.setStatus("active");
    await vi.waitFor(() => expect(h.play).toHaveBeenCalledOnce());
    h.audio.dispatchEvent(new Event("playing"));
    expect(h.onPlay).toHaveBeenCalledWith(12_500);
    expect(h.renew).toHaveBeenCalledOnce();
    expect(h.load).toHaveBeenCalledOnce();
    expect(h.onStartSinging).toHaveBeenCalledOnce();
    expect(h.host.querySelector("audio")).toBe(h.audio);
  },
);

test("ending during a reconnect cancels a pending grant and its continuation", async () => {
  const h = await mountPendingRenewal();
  h.setStatus("reconnecting");
  await vi.waitFor(() =>
    expect(button(h.host, "Start singing")?.disabled).toBe(true),
  );
  h.setStatus("ended");
  await vi.waitFor(() => expect(button(h.host, "Sing again")).toBeDefined());
  expect(h.renew.mock.calls[0]![0].aborted).toBe(true);
  // A fetch implementation may resolve despite its aborted signal.
  h.resolveGrant();
  await Promise.resolve();
  await Promise.resolve();
  h.audio.dispatchEvent(new Event("loadedmetadata"));
  expect(h.play).not.toHaveBeenCalled();
  expect(h.audio.src).toBe("https://media.test/first");
  expect(h.load).not.toHaveBeenCalled();
});

test("an audio interruption while renewed metadata loads cancels automatic continuation", async () => {
  const h = await mountPendingRenewal();
  await h.resolve();
  h.setInterrupted(true);
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")).toBeDefined(),
  );
  h.audio.dispatchEvent(new Event("loadedmetadata"));
  expect(h.play).not.toHaveBeenCalled();
  h.setInterrupted(false);
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")).toBeUndefined(),
  );
  expect(h.play).not.toHaveBeenCalled();
  expect(h.audio.currentTime).toBe(12.5);
  expect(h.renew).toHaveBeenCalledOnce();
  expect(h.onStartSinging).toHaveBeenCalledOnce();
});

async function mountProductionRecovery() {
  const context = new EventTarget();
  let contextState: AudioContextState = "running";
  const transition = (next: AudioContextState) => {
    contextState = next;
    context.dispatchEvent(new Event("statechange"));
  };
  const resumeContext = vi.fn(async () => transition("running"));
  const closeContext = vi.fn(async () => transition("closed"));
  Object.assign(context, {
    destination: {},
    resume: resumeContext,
    close: closeContext,
    createMediaElementSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
  });
  Object.defineProperty(context, "state", { get: () => contextState });
  vi.stubGlobal("AudioContext", function () {
    return context;
  });
  let graph: KaraokePlaybackGraph | undefined;
  const acquire = vi.spyOn(KaraokePlaybackGraph.prototype, "acquire");
  let paused = true;
  const play = vi
    .spyOn(HTMLMediaElement.prototype, "play")
    .mockImplementation(async () => {
      paused = false;
    });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
    paused = true;
  });
  const load = vi
    .spyOn(HTMLMediaElement.prototype, "load")
    .mockImplementation(function (this: HTMLMediaElement) {
      this.currentTime = 0;
    });
  const renew = vi.fn(async (): Promise<KaraokePlaybackGrant> => {
    throw Error("fresh grant must not renew");
  });
  const createSession = vi.fn(async () => ({ ticketId: "ticket-1" }));
  let state: KaraokeScoringState = {
    status: "idle",
    phase: "idle",
    error: null,
    micError: null,
  };
  let listener: ((state: KaraokeScoringState) => void) | undefined;
  const setStatus = (status: KaraokeScoringState["status"]) => {
    state = { ...state, status };
    listener?.(state);
  };
  const controller: KaraokeScoringController = {
    getState: () => state,
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    start: vi.fn(async () => {}),
    noteTime: vi.fn(),
    notePlay: vi.fn(),
    notePause: vi.fn(async () => {}),
    noteSeek: vi.fn(),
    noteFinish: vi.fn(async () => setStatus("finishing")),
    reconnect: vi.fn(() => true),
    send: vi.fn(() => false),
    stop: vi.fn(() => setStatus("ended")),
    abort: vi.fn(() => setStatus("error")),
    dispose: vi.fn(),
  };
  // Keep the production hook, graph and surface connected. Only microphone
  // acquisition, scoring transport and the browser AudioContext are fixtures.
  const construction: KaraokeScoringConstruction = {
    createPlaybackGraph: (onInterrupted) => {
      graph = new KaraokePlaybackGraph(undefined, onInterrupted);
      return graph;
    },
    createController: () => {
      vi.mocked(controller.start).mockImplementation(async () => {
        graph!.acquire();
        await createSession();
        setStatus("active");
      });
      return controller;
    },
  };
  let scoring!: UseKaraokeScoringResult;
  const [enabled, setEnabled] = createSignal(true);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const dispose = mountUi(() => {
    scoring = useKaraokeScoring(
      {
        get enabled() {
          return enabled();
        },
        ticketId: "ticket-1",
        openSocket: () => {
          throw new Error(
            "Original controller-double fixture does not open sockets",
          );
        },
      },
      construction,
    );
    return (
      <KaraokePracticeSurface
        title="Recovery fixture"
        lines={[]}
        instrumentalAudioUrl="https://media.test/bound-instrumental"
        playbackAccess={{
          grant: {
            url: "https://media.test/bound-instrumental",
            expiresAtMs: Date.now() + 60_000,
            renewAtMs: Date.now() + 30_000,
          },
          renew,
        }}
        singingStatus={scoring.state()?.status ?? "idle"}
        playbackInterrupted={scoring.playbackInterrupted()}
        onPlaybackElement={scoring.controls.attachPlaybackElement}
        onResumePlayback={scoring.controls.resumePlayback}
        onStartSinging={scoring.controls.start}
        onTimeChange={scoring.controls.noteTime}
        onPlay={scoring.controls.notePlay}
        onPause={scoring.controls.notePause}
      />
    );
  }, host);
  cleanups.push(dispose);
  const audio = host.querySelector("audio")!;
  Object.defineProperty(audio, "paused", {
    configurable: true,
    get: () => paused,
  });
  audio.currentTime = 12.5;
  audio.dispatchEvent(new Event("timeupdate"));
  button(host, "Start karaoke")!.click();
  await vi.waitFor(() => expect(play).toHaveBeenCalledOnce());
  audio.dispatchEvent(new Event("playing"));
  expect(controller.notePlay).toHaveBeenCalledOnce();
  transition("suspended");
  await vi.waitFor(() => expect(button(host, "Tap to continue")).toBeDefined());
  expect(scoring.playbackInterrupted()).toBe(true);
  return {
    host,
    audio,
    play,
    load,
    renew,
    createSession,
    controller,
    scoring,
    acquire,
    resumeContext,
    closeContext,
    transition,
    setStatus,
    setEnabled,
    dispose,
  };
}

test("production interruption recovery resumes the same take only after a successful context gesture and playing", async () => {
  const h = await mountProductionRecovery();
  button(h.host, "Tap to continue")!.click();
  expect(h.resumeContext).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
  expect(h.controller.notePlay).toHaveBeenCalledOnce();
  expect(h.audio.currentTime).toBe(12.5);
  h.audio.dispatchEvent(new Event("playing"));
  expect(h.controller.notePlay).toHaveBeenCalledTimes(2);
  expect(h.controller.notePlay).toHaveBeenLastCalledWith(12_500);
  expect(h.scoring.playbackInterrupted()).toBe(false);
  expect(h.controller.start).toHaveBeenCalledOnce();
  expect(h.createSession).toHaveBeenCalledOnce();
  expect(h.acquire).toHaveBeenCalledOnce();
  expect(h.renew).not.toHaveBeenCalled();
  expect(h.host.querySelector("audio")).toBe(h.audio);
});

test("production interruption recovery refuses a failed context resume and permits a later gesture", async () => {
  const h = await mountProductionRecovery();
  let reject: ((error: Error) => void) | undefined;
  h.resumeContext.mockImplementationOnce(
    () =>
      new Promise<void>((_yes, no) => {
        reject = no;
      }),
  );
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")?.disabled).toBe(true),
  );
  reject!(new DOMException("Not allowed", "NotAllowedError"));
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")?.disabled).toBe(false),
  );
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.scoring.playbackInterrupted()).toBe(true);
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
  expect(h.controller.notePlay).toHaveBeenCalledOnce();
  expect(h.createSession).toHaveBeenCalledOnce();
  expect(h.acquire).toHaveBeenCalledOnce();
  expect(h.renew).not.toHaveBeenCalled();
});

test.each([
  "finishing",
  "ended",
  "error",
  "disabled",
  "detached",
  "unmounted",
] as const)(
  "production interruption recovery rejects late success after %s",
  async (boundary) => {
    const h = await mountProductionRecovery();
    let resolve: (() => void) | undefined;
    h.resumeContext.mockImplementationOnce(
      () =>
        new Promise<void>((yes) => {
          resolve = yes;
        }),
    );
    button(h.host, "Tap to continue")!.click();
    expect(h.resumeContext).toHaveBeenCalledOnce();
    if (boundary === "unmounted") h.dispose();
    else if (boundary === "detached")
      h.scoring.controls.attachPlaybackElement?.(null);
    else if (boundary === "disabled") h.setEnabled(false);
    else h.setStatus(boundary);
    await Promise.resolve();
    await Promise.resolve();
    h.transition("running");
    resolve!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.controller.notePlay).toHaveBeenCalledOnce();
    expect(h.controller.start).toHaveBeenCalledOnce();
    expect(h.createSession).toHaveBeenCalledOnce();
    expect(h.renew).not.toHaveBeenCalled();
  },
);

test("a second production interruption invalidates an earlier gesture even when the context later runs", async () => {
  const h = await mountProductionRecovery();
  let resolve: (() => void) | undefined;
  h.resumeContext.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")?.disabled).toBe(true),
  );
  h.transition("running");
  h.transition("suspended");
  h.transition("running");
  resolve!();
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")?.disabled).toBe(false),
  );
  expect(h.scoring.playbackInterrupted()).toBe(true);
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.controller.notePlay).toHaveBeenCalledOnce();
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
  expect(h.createSession).toHaveBeenCalledOnce();
  expect(h.renew).not.toHaveBeenCalled();
});

test("a late production recovery cannot authorize a different take on the same controller", async () => {
  const h = await mountProductionRecovery();
  let resolve: (() => void) | undefined;
  h.resumeContext.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  const recovery = h.scoring.controls.resumePlayback!();
  h.scoring.controls.start(0);
  await vi.waitFor(() => expect(h.createSession).toHaveBeenCalledTimes(2));
  h.transition("running");
  resolve!();
  expect(await recovery).toBe(false);
  expect(h.controller.start).toHaveBeenCalledTimes(2);
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.controller.notePlay).toHaveBeenCalledOnce();
});

test("context closure during paused production recovery aborts the take and rejects a late resume", async () => {
  const h = await mountProductionRecovery();
  let resolve: (() => void) | undefined;
  h.resumeContext.mockImplementationOnce(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  button(h.host, "Tap to continue")!.click();
  h.transition("closed");
  expect(h.controller.abort).toHaveBeenCalledWith("karaoke_audio_closed");
  resolve!();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(h.play).toHaveBeenCalledOnce();
  expect(h.controller.notePlay).toHaveBeenCalledOnce();
  expect(h.createSession).toHaveBeenCalledOnce();
});

test.each(["idle", "finishing", "ended", "error"] as const)(
  "context closure after %s preserves the terminal take state",
  async (status) => {
    const h = await mountProductionRecovery();
    h.setStatus(status);
    await Promise.resolve();
    await Promise.resolve();
    h.transition("closed");
    expect(h.controller.abort).not.toHaveBeenCalled();
    expect(h.scoring.state()?.status).toBe(status);
    expect(h.play).toHaveBeenCalledOnce();
    expect(h.controller.notePlay).toHaveBeenCalledOnce();
  },
);

test("production interruption during renewed metadata preserves the held capture clock and waits for a new gesture", async () => {
  const h = await mountProductionRecovery();
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
  h.audio.dispatchEvent(new Event("playing"));
  const now = Date.now() + 70_000;
  vi.spyOn(Date, "now").mockReturnValue(now);
  h.renew.mockResolvedValue({
    url: "https://media.test/renewed",
    expiresAtMs: now + 60_000,
    renewAtMs: now + 30_000,
  });
  h.audio.dispatchEvent(new Event("playing"));
  await vi.waitFor(() => expect(h.load).toHaveBeenCalledOnce());
  expect(h.audio.currentTime).toBe(0);
  expect(h.controller.notePause).toHaveBeenLastCalledWith(12_500);
  const pauses = vi.mocked(h.controller.notePause).mock.calls.length;
  h.transition("suspended");
  await vi.waitFor(() =>
    expect(button(h.host, "Tap to continue")).toBeDefined(),
  );
  expect(h.controller.notePause).toHaveBeenCalledTimes(pauses);
  h.audio.dispatchEvent(new Event("loadedmetadata"));
  expect(h.audio.currentTime).toBe(12.5);
  expect(h.play).toHaveBeenCalledTimes(2);
  h.transition("running");
  await Promise.resolve();
  expect(h.play).toHaveBeenCalledTimes(2);
  expect(h.scoring.playbackInterrupted()).toBe(true);
  button(h.host, "Tap to continue")!.click();
  await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(3));
  expect(h.controller.notePlay).toHaveBeenCalledTimes(2);
  h.audio.dispatchEvent(new Event("playing"));
  expect(h.controller.notePlay).toHaveBeenLastCalledWith(12_500);
  expect(h.createSession).toHaveBeenCalledOnce();
  expect(h.acquire).toHaveBeenCalledOnce();
  expect(h.renew).toHaveBeenCalledOnce();
});
