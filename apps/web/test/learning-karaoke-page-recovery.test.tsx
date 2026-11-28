// Unrun page/controller regressions with memory ports; no actual audio or socket.
import { render } from "@solidjs/web";
import { createSignal, onCleanup } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { KaraokePage } from "../src/karaoke/page.tsx";
import type {
  OperatorKaraokePort,
  KaraokeAttemptView,
} from "../src/karaoke/operator-karaoke-adapter.ts";
import { KARAOKE_START_UNKNOWN_MESSAGE } from "../src/karaoke/operator-karaoke-adapter.ts";
import type {
  UseKaraokeCaptureOptions,
  UseKaraokeCaptureResult,
} from "../src/karaoke/use-karaoke-capture.ts";
import type { KaraokeCaptureState } from "../../../packages/karaoke/capture-controller.ts";
import type { KaraokePlaybackGraph } from "../src/karaoke/playback-graph.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});
const opened: KaraokeAttemptView = {
  state: "open",
  ticket: { body: { ticketId: "same-ticket" } },
  socketUrl: "wss://fixture.invalid/unused",
  proof: "fixture-proof",
  elapsedMs: null,
};
const recovered: KaraokeAttemptView = {
  state: "finished",
  result: {
    body: {
      ticketId: "same-ticket",
      status: "completed",
      summary: { scoreBps: 8200 },
      lines: [],
      unmeasuredCount: 0,
      presentation: {
        finalScore: 0.82,
        lyricsScore: 0.88,
        timingScore: null,
        timingTrend: "on_time",
        scoredLineCount: 1,
        uncertainLineCount: 0,
        bestCombo: 1,
      },
    },
  },
  record: { consented: true, consent: null, publication: { state: "pending" } },
};
function port(): OperatorKaraokePort {
  return {
    playbackUrl: () => undefined,
    song: vi.fn(async () => ({
      lines: [
        {
          lineId: "line",
          ordinal: 0,
          text: "Meet me by the old harbor",
          startMs: 1000,
          endMs: 4000,
          words: [],
        },
      ],
      segments: [],
    })),
    attempt: vi.fn(async () => opened),
    ticket: vi.fn(async () => ({
      ticketId: "new-ticket",
      socketUrl: "wss://fixture.invalid/unused",
      proof: "fixture-proof",
    })),
    request: async () => {
      throw new Error("No history/enrollment capability in this test");
    },
    dispose: vi.fn(),
  };
}
function captureDouble(initialStatus: "idle" | "error" = "error") {
  const started = vi.fn(),
    disposed = vi.fn();
  let updateState: (state: KaraokeCaptureState) => void = () => {};
  const errored = (): KaraokeCaptureState => ({
    status: "error",
    phase: "aborted",
    micError: null,
    error: { code: "connection_lost", message: "Connection lost" },
  });
  const createCapture = (
    options: UseKaraokeCaptureOptions,
  ): UseKaraokeCaptureResult => {
    const [state, setState] = createSignal<KaraokeCaptureState>(
      initialStatus === "error"
        ? errored()
        : { status: "idle", phase: "idle", micError: null, error: null },
    );
    updateState = setState;
    onCleanup(disposed);
    return {
      state,
      playbackGraph: {} as KaraokePlaybackGraph,
      playbackInterrupted: () => false,
      readyFor: (id) => options.enabled && id === options.ticketId,
      controls: {
        start: async () => {
          started();
          setState({
            status: "active",
            phase: "live",
            micError: null,
            error: null,
          });
        },
        abort() {},
        stop() {},
        reconnect: () => true,
        send: () => false,
        resumePlayback: async () => false,
        attachPlaybackElement() {},
        noteTime() {},
        notePlay() {},
        notePause() {},
        noteSeek() {},
        noteFinish() {},
      },
    };
  };
  return {
    createCapture,
    started,
    disposed,
    fail: () => updateState(errored()),
  };
}
function mount(service: OperatorKaraokePort, initialStatus: "idle" | "error" = "error") {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const capture = captureDouble(initialStatus),
    host = document.createElement("div");
  document.body.append(host);
  cleanup.push(
    render(
      () => (
        <KaraokePage
          account="fixture-account"
          csrf="fixture-csrf"
          postId="fixture-post"
          title="Fixture song"
          serviceMode="internal"
          signInPermission
          onExit={() => {}}
          port={service}
          createCapture={capture.createCapture}
        />
      ),
      host,
    ),
  );
  return { host, capture };
}
async function start(host: HTMLElement) {
  const button = await vi.waitFor(() => {
    const value = [...host.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === "Start karaoke",
    );
    expect(value).toBeDefined();
    return value!;
  });
  button.click();
}
test("a late finished receipt recovers this take without another ticket or capture", async () => {
  const service = port();
  vi.mocked(service.attempt)
    .mockResolvedValueOnce(opened)
    .mockResolvedValue(recovered);
  const { host, capture } = mount(service);
  await start(host);
  await vi.waitFor(() => expect(host.textContent).toContain("Great work!"));
  expect(service.ticket).not.toHaveBeenCalled();
  expect(capture.started).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Publication status: pending.");
});
test("recovery refuses another tab's ticket instead of replacing the charged identity", async () => {
  const service = port();
  vi.mocked(service.attempt)
    .mockResolvedValueOnce(opened)
    .mockResolvedValue({
      ...opened,
      ticket: { body: { ticketId: "other-ticket" } },
    });
  const { host, capture } = mount(service);
  await start(host);
  await vi.waitFor(() =>
    expect(host.textContent).toContain("active take changed in another tab"),
  );
  expect(service.ticket).not.toHaveBeenCalled();
  expect(capture.started).not.toHaveBeenCalled();
});

test("a new take consumes the actual flat operator ticket without replacing its identity", async () => {
  const service = port();
  vi.mocked(service.attempt).mockResolvedValue({ state: "none" });
  const { host, capture } = mount(service);
  await start(host);
  await vi.waitFor(() => expect(capture.started).toHaveBeenCalledOnce());
  expect(service.ticket).toHaveBeenCalledOnce();
  expect(host.textContent).not.toContain("could not be prepared");
});

test("a scoring-failure retry re-arms playback on the same take and element", async () => {
  const service = port();
  const { host, capture } = mount(service, "idle");
  await start(host);
  await vi.waitFor(() => expect(capture.started).toHaveBeenCalledOnce());
  const play = vi.mocked(HTMLMediaElement.prototype.play);
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  const audio = host.querySelector("audio");
  expect(audio).not.toBeNull();
  capture.fail();
  await vi.waitFor(() =>
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't connect scoring",
    ),
  );
  expect(host.textContent).not.toContain("Meet me by the old harbor");
  const retry = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Try again",
  );
  expect(retry).toBeDefined();
  retry!.click();
  await vi.waitFor(() => expect(capture.started).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  expect(host.querySelector("audio")).toBe(audio);
  expect(service.ticket).not.toHaveBeenCalled();
});

test("a missing result can be checked again without another ticket or capture", async () => {
  const service = port();
  vi.mocked(service.attempt).mockResolvedValue(opened);
  const { host, capture } = mount(service, "idle");
  await start(host);
  await vi.waitFor(() => expect(capture.started).toHaveBeenCalledOnce());
  const audio = host.querySelector("audio")!;
  vi.useFakeTimers();
  audio.dispatchEvent(new Event("ended"));
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toContain("Checking your result…");
  await vi.advanceTimersByTimeAsync(90_000);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't get your result",
  );
  expect(host.textContent).not.toContain("Great work!");
  vi.mocked(service.attempt).mockResolvedValue(recovered);
  const check = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Check again",
  );
  expect(check).toBeDefined();
  check!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toContain("Great work!");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(service.ticket).not.toHaveBeenCalled();
  expect(capture.started).toHaveBeenCalledOnce();
});

test("an unknown Karaoke start checks itself and centers a safe retry when nothing opened", async () => {
  const service = port();
  vi.mocked(service.attempt).mockResolvedValue({ state: "none" });
  vi.mocked(service.ticket).mockRejectedValue(
    new Error(KARAOKE_START_UNKNOWN_MESSAGE),
  );
  const { host } = mount(service);
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Start karaoke",
      ),
    ).toBe(true),
  );
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Start karaoke",
  )!;
  vi.useFakeTimers();
  button!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toContain("Starting karaoke…");
  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain("Starting karaoke…");
  expect(status?.closest('[aria-busy="true"]')).not.toBeNull();
  expect(host.textContent).not.toContain("Checking whether this take opened.");
  expect(host.textContent).not.toContain("This can take a few seconds.");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Karaoke didn't start",
  );
  expect(host.textContent).not.toContain("Meet me by the old harbor");
  expect(
    [...host.querySelectorAll("button")].some(
      (node) => node.textContent?.trim() === "Check status",
    ),
  ).toBe(false);
  const retry = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Try again",
  );
  expect(retry).toBeDefined();
  expect(
    [...host.querySelectorAll("button")].some(
      (node) => node.textContent?.trim() === "Start karaoke",
    ),
  ).toBe(false);
  expect(service.ticket).toHaveBeenCalledOnce();
  retry!.click();
  await vi.waitFor(() => expect(service.ticket).toHaveBeenCalledTimes(2));
});

test("an unresolved Karaoke start centers the check failure and Check again rechecks the same start", async () => {
  const service = port();
  vi.mocked(service.attempt)
    .mockResolvedValueOnce({ state: "none" })
    .mockRejectedValue(new Error("status unavailable"));
  vi.mocked(service.ticket).mockRejectedValue(
    new Error(KARAOKE_START_UNKNOWN_MESSAGE),
  );
  const { host } = mount(service);
  await vi.waitFor(() =>
    expect(
      [...host.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Start karaoke",
      ),
    ).toBe(true),
  );
  const button = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Start karaoke",
  )!;
  vi.useFakeTimers();
  button!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(host.textContent).toContain("Starting karaoke…");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Couldn't check if Karaoke started",
  );
  expect(host.textContent).not.toContain("Go back and try again in a minute.");
  expect(host.textContent).not.toContain("Meet me by the old harbor");
  const check = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Check again",
  );
  const back = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === "Back",
  );
  expect(check).toBeDefined();
  expect(back).toBeDefined();
  const reads = vi.mocked(service.attempt).mock.calls.length;
  check!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(service.attempt).mock.calls.length).toBeGreaterThan(reads);
  expect(host.textContent).toContain("Starting karaoke…");
});
