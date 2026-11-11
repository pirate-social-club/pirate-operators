// Unrun page/controller regressions with memory ports; no actual audio or socket.
import { render } from "@solidjs/web";
import { createSignal, onCleanup } from "solid-js";
import { afterEach, expect, test, vi } from "vitest";
import { KaraokePage } from "../src/karaoke/page.tsx";
import type {
  OperatorKaraokePort,
  KaraokeAttemptView,
} from "../src/karaoke/operator-karaoke-adapter.ts";
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
          text: "I am going home",
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
function captureDouble() {
  const started = vi.fn(),
    disposed = vi.fn();
  const createCapture = (
    options: UseKaraokeCaptureOptions,
  ): UseKaraokeCaptureResult => {
    const [state, setState] = createSignal<KaraokeCaptureState>({
      status: "error",
      phase: "aborted",
      micError: null,
      error: { code: "connection_lost", message: "Connection lost" },
    });
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
  return { createCapture, started, disposed };
}
function mount(service: OperatorKaraokePort) {
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const capture = captureDouble(),
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
