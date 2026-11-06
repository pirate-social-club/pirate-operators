// Adopted from pirate-web-solid 667a6f22 src/features/karaoke/capture/karaoke-playback-graph.test.ts; only imports changed.
import { afterEach, expect, test, vi } from "../../../test/karaoke-expect.ts";
import { KaraokePlaybackGraph } from "../src/karaoke/playback-graph.ts";

test("repeat takes borrow one media source and route exit releases its output", () => {
  let created = 0, connected = 0, disconnected = 0, closed = 0;
  const context = { addEventListener: () => {}, removeEventListener: () => {}, destination: {}, createMediaElementSource: () => {
    created += 1;
    return { connect: () => connected += 1, disconnect: () => disconnected += 1 };
  }, close: async () => { closed += 1; } } as unknown as AudioContext;
  const graph = new KaraokePlaybackGraph(() => context);
  const element = {} as HTMLAudioElement;
  graph.attach(element);
  expect(graph.acquire()).toBe(context);
  graph.attach(element);
  expect(graph.acquire()).toBe(context);
  expect(created).toBe(1);
  expect(connected).toBe(1);
  graph.attach(null);
  graph.dispose();
  expect(disconnected).toBe(1);
  expect(closed).toBe(1);
  expect(() => graph.acquire()).toThrow("playback is unavailable");
});

afterEach(() => vi.useRealTimers());

function recoveryGraph() {
  const events = new EventTarget();
  let state: AudioContextState = "suspended";
  const resume = vi.fn(async () => { state = "running"; events.dispatchEvent(new Event("statechange")); });
  const close = vi.fn(async () => { state = "closed"; events.dispatchEvent(new Event("statechange")); });
  const context = Object.assign(events, {
    destination: {}, createMediaElementSource: () => ({ connect: vi.fn(), disconnect: vi.fn() }), resume, close,
  });
  Object.defineProperty(context, "state", { get: () => state });
  const element = { paused: true, currentTime: 12.5, pause: vi.fn(() => { element.paused = true; }) };
  const interrupted = vi.fn();
  const graph = new KaraokePlaybackGraph(() => context as unknown as AudioContext, interrupted);
  graph.attach(element as unknown as HTMLAudioElement);
  graph.acquire();
  const transition = (next: AudioContextState, notify = true) => {
    state = next; if (notify) events.dispatchEvent(new Event("statechange"));
  };
  return { graph, element, resume, close, interrupted, transition };
}

test("suspension pauses shared playback immediately without a media waiting event", () => {
  const f = recoveryGraph();
  expect(f.interrupted).not.toHaveBeenCalled();
  f.transition("running"); f.element.paused = false;
  f.transition("suspended");
  expect(f.element.pause).toHaveBeenCalledOnce();
  expect(f.interrupted).toHaveBeenCalledWith(12500, "suspended", false);
  f.graph.checkState();
  expect(f.interrupted).toHaveBeenCalledOnce();
  f.graph.dispose();
});

test("clock sampling catches a non-running context when no statechange was delivered", () => {
  const f = recoveryGraph(); f.transition("running"); f.element.paused = false;
  f.transition("suspended", false); f.graph.checkState();
  expect(f.interrupted).toHaveBeenCalledWith(12500, "suspended", false);
  f.graph.dispose();
});

test("resume is invoked synchronously and a pending request times out without preventing another tap", async () => {
  vi.useFakeTimers();
  const f = recoveryGraph();
  let settle: (() => void) | undefined;
  f.resume.mockImplementationOnce(() => new Promise<void>(resolve => { settle = resolve; }));
  const first = f.graph.resume();
  expect(f.resume).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(2000);
  expect(await first).toBe(false);
  expect(await f.graph.resume()).toBe(true);
  settle?.();
  expect(await first).toBe(false);
  f.graph.dispose();
});

test("rejected resume can be retried and disposing cancels pending recovery", async () => {
  const f = recoveryGraph();
  f.resume.mockRejectedValueOnce(new DOMException("Not allowed", "NotAllowedError"));
  expect(await f.graph.resume()).toBe(false);
  f.resume.mockImplementationOnce(() => new Promise<void>(() => {}));
  const pending = f.graph.resume();
  f.graph.dispose();
  expect(await pending).toBe(false);
  expect(f.interrupted).not.toHaveBeenCalled();
  expect(await f.graph.resume()).toBe(false);
});

test("intentional owner disposal removes its listener before closing an active context", () => {
  const f = recoveryGraph(); f.transition("running"); f.element.paused = false;
  f.graph.dispose(); f.transition("suspended");
  expect(f.interrupted).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledOnce();
});

test("unexpected context closure pauses playback and reports that it cannot resume", async () => {
  const f = recoveryGraph(); f.transition("running"); f.element.paused = false;
  f.transition("closed");
  expect(f.element.paused).toBe(true);
  expect(f.interrupted).toHaveBeenCalledWith(12500, "closed", false);
  expect(await f.graph.resume()).toBe(false);
  expect(f.resume).not.toHaveBeenCalled();
  f.graph.dispose();
});

test("a failed media source releases the context and never silently falls back", () => {
  let closed = 0;
  const graph = new KaraokePlaybackGraph(() => ({ createMediaElementSource: () => { throw Error("cross-origin source"); }, close: async () => { closed += 1; } }) as unknown as AudioContext);
  graph.attach({} as HTMLAudioElement);
  expect(() => graph.acquire()).toThrow("cross-origin source");
  expect(closed).toBe(1);
});

test("context changes while media is already paused revoke recovery once per transition", () => {
  const f = recoveryGraph();
  f.transition("running");
  f.transition("suspended");
  f.graph.checkState();
  expect(f.interrupted).toHaveBeenCalledOnce();
  expect(f.interrupted).toHaveBeenLastCalledWith(12500, "suspended", true);
  expect(f.element.pause).not.toHaveBeenCalled();
  f.transition("running"); f.transition("suspended");
  expect(f.interrupted).toHaveBeenCalledTimes(2);
  f.transition("closed");
  expect(f.interrupted).toHaveBeenLastCalledWith(12500, "closed", true);
  expect(f.interrupted).toHaveBeenCalledTimes(3);
  f.graph.dispose();
});
