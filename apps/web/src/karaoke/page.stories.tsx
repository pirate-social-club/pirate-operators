// Source route-state composition from pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db.
// Service doubles below are story-only; no provider or microphone.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal } from "solid-js";
import { KaraokePage } from "./page.tsx";
import { ActivityStatusShell } from "../ui/activity-status-shell.tsx";
import {
  KARAOKE_START_UNKNOWN_MESSAGE,
  type OperatorKaraokePort,
  type KaraokeAttemptView,
} from "./operator-karaoke-adapter.ts";
import type {
  UseKaraokeCaptureOptions,
  UseKaraokeCaptureResult,
} from "./use-karaoke-capture.ts";
import type { KaraokeCaptureState } from "../../../../packages/karaoke/capture-controller.ts";
import type { KaraokePlaybackGraph } from "./playback-graph.ts";
import { expect, userEvent, within } from "storybook/test";

const meta = {
  title: "Karaoke/Screens/Song",
  // The tier lives in metadata so the sidebar can group feature-first.
  tags: ["screen"],
  component: KaraokePage,
  parameters: { layout: "fullscreen" },
  args: {
    account: null,
    postId: "story-post",
    title: "Fixture song",
    csrf: "",
    onExit: () => {},
  },
} satisfies Meta<typeof KaraokePage>;
export default meta;
type Story = StoryObj<typeof meta>;

const song = {
  lines: [
    {
      lineId: "fixture-line",
      ordinal: 0,
      text: "Meet me by the old harbor",
      startMs: 1000,
      endMs: 5000,
      words: [
        { text: "Meet", startMs: 1000, endMs: 1500 },
        { text: "me", startMs: 1500, endMs: 1900 },
        { text: "by", startMs: 1900, endMs: 2200 },
        { text: "the", startMs: 2200, endMs: 2500 },
        { text: "old", startMs: 2500, endMs: 3200 },
        { text: "harbor", startMs: 3200, endMs: 5000 },
      ],
    },
  ],
  segments: [],
};
function storyPort(
  state: "ready" | "loading" | "empty" | "error" | "unknown" | "unknown-unresolved" | "recovered",
): OperatorKaraokePort {
  const view: KaraokeAttemptView = {
    state: "open",
    ticket: { body: { ticketId: "story-ticket" } },
    socketUrl: "wss://fixture.invalid/unused",
    proof: "story-proof",
    elapsedMs: 1500,
  };
  let reads = 0;
  return {
    playbackUrl: () => undefined,
    song: async () => {
      if (state === "loading") return new Promise(() => {});
      if (state === "error")
        throw new globalThis.Error("Karaoke couldn't be loaded for this song.");
      return state === "empty" ? { lines: [], segments: [] } : song;
    },
    attempt: async () => {
      reads++;
      if (state === "unknown-unresolved" && reads > 1)
        throw new globalThis.Error("Karaoke status is unavailable.");
      return state === "recovered" ? view : { state: "none" };
    },
    ticket: async () => {
      if (state === "unknown" || state === "unknown-unresolved")
        throw new globalThis.Error(
          KARAOKE_START_UNKNOWN_MESSAGE,
        );
      return {
        ticketId: "story-ticket",
        socketUrl: "wss://fixture.invalid/unused",
        proof: "story-proof",
      };
    },
    request: async () => {
      throw new globalThis.Error(
        "This story has no enrollment, purchase or history capability.",
      );
    },
    dispose() {},
  };
}
/** Explicit lifecycle double; never labels a fixture take as graded/paid. */
function storyCapture(
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
export const CouldntStart: Story = {
  render: example("unknown"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start karaoke" }),
    );
    await expect(
      await canvas.findByRole("heading", { name: "Starting karaoke…" }),
    ).toBeVisible();
    await expect(
      await canvas.findByText(
        "Karaoke didn't start",
        {},
        { timeout: 15_000 },
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Check status" }),
    ).toBeNull();
    await expect(
      canvas.queryByRole("button", { name: "Start karaoke" }),
    ).toBeNull();
  },
};
export const StartUnconfirmed: Story = {
  render: () => (
    <ActivityStatusShell
      title="Couldn't check if Karaoke started"
      tone="retryable"
      error
      exitIcon="back"
      exitLabel="Exit karaoke"
      onExit={() => {}}
      primaryAction={{ label: "Check again", onClick: () => {} }}
      secondaryAction={{ label: "Back", onClick: () => {} }}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Couldn't check if Karaoke started" }),
    ).toBeVisible();
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Couldn't check if Karaoke started",
    );
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
  },
};
export const StartUnconfirmedRecovery: Story = {
  render: example("unknown-unresolved"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start karaoke" }),
    );
    await expect(
      await canvas.findByRole("heading", { name: "Starting karaoke…" }),
    ).toBeVisible();
    await expect(
      await canvas.findByRole(
        "heading",
        { name: "Couldn't check if Karaoke started" },
        { timeout: 15_000 },
      ),
    ).toBeVisible();
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await expect(
      await canvas.findByRole("heading", { name: "Starting karaoke…" }),
    ).toBeVisible();
    await expect(
      await canvas.findByRole(
        "heading",
        { name: "Couldn't check if Karaoke started" },
        { timeout: 15_000 },
      ),
    ).toBeVisible();
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
