// Source route-state composition from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db.
// Decentralized service doubles below are story-only; no provider or microphone.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { KaraokePage } from "./page.tsx";
import type {
  OperatorKaraokePort,
  KaraokeAttemptView,
} from "./operator-karaoke-adapter.ts";
import type {
  UseKaraokeCaptureOptions,
  UseKaraokeCaptureResult,
} from "./use-karaoke-capture.ts";
import type { KaraokeCaptureState } from "../../../../packages/karaoke/capture-controller.ts";
import type { KaraokePlaybackGraph } from "./playback-graph.ts";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Screens/Karaoke/Decentralized route",
  component: KaraokePage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof KaraokePage>;
export default meta;
type Story = StoryObj<typeof meta>;

const song = {
  lines: [
    {
      lineId: "fixture-line",
      ordinal: 0,
      text: "I am going home",
      startMs: 1000,
      endMs: 5000,
      words: [
        { text: "I", startMs: 1000, endMs: 1400 },
        { text: "am", startMs: 1400, endMs: 2000 },
        { text: "going", startMs: 2000, endMs: 3500 },
        { text: "home", startMs: 3500, endMs: 5000 },
      ],
    },
  ],
  segments: [],
};
function storyPort(
  state: "ready" | "loading" | "empty" | "error" | "unknown" | "recovered",
): OperatorKaraokePort {
  const view: KaraokeAttemptView = {
    state: "open",
    ticket: { body: { ticketId: "story-ticket" } },
    socketUrl: "wss://fixture.invalid/unused",
    proof: "story-proof",
    elapsedMs: 1500,
  };
  return {
    playbackUrl: () => undefined,
    song: async () => {
      if (state === "loading") return new Promise(() => {});
      if (state === "error")
        throw new Error("We couldn't load karaoke for this song.");
      return state === "empty" ? { lines: [], segments: [] } : song;
    },
    attempt: async () => (state === "recovered" ? view : { state: "none" }),
    ticket: async () => {
      if (state === "unknown")
        throw new Error(
          "We couldn't confirm this take's start. Check the same take again; a new take has not been opened.",
        );
      return {
        ticketId: "story-ticket",
        socketUrl: "wss://fixture.invalid/unused",
        proof: "story-proof",
      };
    },
    request: async () => {
      throw new Error(
        "This story has no enrollment, purchase or history capability.",
      );
    },
    dispose() {},
  };
}
/** Explicit lifecycle double; never labels a fixture take as graded/paid. */
export function storyCapture(
  options: UseKaraokeCaptureOptions,
): UseKaraokeCaptureResult {
  const [state, setState] = createSignal<KaraokeCaptureState>({
    status: "idle",
    phase: "idle",
    micError: null,
    error: null,
  });
  const idle = () =>
    setState({ status: "idle", phase: "idle", micError: null, error: null });
  return {
    playbackGraph: {} as KaraokePlaybackGraph,
    playbackInterrupted: () => false,
    state,
    readyFor: (id) => options.enabled && id === options.ticketId,
    controls: {
      start: async () => {
        setState({
          status: "reconnecting",
          phase: "reconnecting",
          micError: null,
          error: null,
        });
      },
      abort: () => idle(),
      stop: idle,
      reconnect: () => true,
      send: () => false,
      attachPlaybackElement() {},
      resumePlayback: async () => false,
      noteTime() {},
      notePlay() {},
      notePause() {},
      noteSeek() {},
      noteFinish() {},
    },
  };
}
const example = (state: Parameters<typeof storyPort>[0]) => () => (
  <KaraokePage
    postId="story-post"
    title="Paper Moon"
    account="story-account"
    csrf="story-csrf"
    serviceMode="internal"
    signInPermission
    onExit={() => {}}
    port={storyPort(state)}
    createCapture={storyCapture}
  />
);
export const Ready: Story = { render: example("ready") };
export const ReadyMobile: Story = {
  ...Ready,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const AuthHold: Story = {
  render: () => (
    <KaraokePage
      postId="story-post"
      title="Paper Moon"
      account={null}
      csrf=""
      onConnect={() => {}}
      onExit={() => {}}
    />
  ),
};
export const Loading: Story = { render: example("loading") };
export const Empty: Story = { render: example("empty") };
export const Error: Story = { render: example("error") };
export const StartUnknown: Story = {
  render: example("unknown"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start karaoke" }),
    );
    await expect(
      await canvas.findByText(/couldn't confirm this take's start/),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Check status" }),
    ).toBeEnabled();
  },
};
export const RecoveredOpenTake: Story = {
  render: example("recovered"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start karaoke" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Start singing" }),
    ).toBeDisabled();
  },
};
export const RecoveryMobile: Story = {
  ...RecoveredOpenTake,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
