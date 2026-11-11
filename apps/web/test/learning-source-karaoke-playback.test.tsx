// Source playback transition cases from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db; imports adapted. UNRUN.
import type { JSX } from "@solidjs/web";
import { render as solidRender } from "@solidjs/web";
import { createSignal } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { KaraokePracticeSurface } from "../src/karaoke/practice-surface.tsx";
import type { KaraokePlaybackAccess } from "../src/karaoke/playback-renewal.ts";

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
