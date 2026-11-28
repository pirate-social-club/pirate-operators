// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/karaoke/karaoke-practice-surface.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { expect, fn, userEvent, within } from "storybook/test";
import { expectInsideLearningActivityColumn, expectLearningActivityFrameGeometry } from "../test-support/activity-frame-geometry.ts";

import type { KaraokeResultsSummary } from "./results-model.ts";

import { KaraokePracticeSurface } from "./practice-surface.tsx";
import { storyArtworkSrc, storyStageLines } from "./story-fixtures.ts";

const meta = {
  title: "Karaoke/Flows/Practice",
  // The tier lives in metadata so the sidebar can group feature-first.
  tags: ["flow"],
  component: KaraokePracticeSurface,
  // Bind the owned lyric fixture directly instead of sending its array through args.
  render: (args) => (
    <KaraokePracticeSurface {...args} lines={args.lines ?? storyStageLines} />
  ),
  parameters: {
    layout: "fullscreen",
    // Fragment tier: the surface renders below page level; the app shell
    // supplies main and the page heading in production. Page-level axe rules
    // are disabled here instead of nesting a main the real mount would
    // duplicate (the repaired November 12 karaoke nested-main class).
    a11y: {
      config: {
        rules: [
          { id: "landmark-one-main", enabled: false },
          { id: "page-has-heading-one", enabled: false },
        ],
      },
    },
    docs: {
      description: {
        component:
          "Full-screen karaoke surface matching the reviewed mobile design: the shared activity progress header, an artwork-backed lyric stage, and one full-width action before singing starts. Stories cover the designed states — primed, connecting, active, scoring feedback and the results page after a take — and do not touch the mic, WebSocket sessions, or real audio. The production route never supplies a reward label, so no story here shows the gift badge.",
      },
    },
  },
} satisfies Meta<typeof KaraokePracticeSurface>;

export default meta;

type Story = StoryObj<typeof meta>;

export const NotScorable: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    lines: storyStageLines,
  },
  parameters: {
    docs: {
      description: {
        story:
          "A song with no scorable lines: lyrics render with no singing affordance. Signed-out visitors get the Start action instead.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const exit = canvasElement.querySelector<HTMLElement>("[data-exit-icon]");
    if (exit === null) throw new Error("Expected the activity header");
    await expect(exit).toHaveAttribute("data-exit-icon", "back");
    await expectLearningActivityFrameGeometry(canvasElement, { footer: false });
  },
};

export const PausedPrimed: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    lines: storyStageLines,
    singingStatus: "idle",
    onStartSinging: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Signed-in, paused before the first line: the cue line is primed and the Start karaoke action is available.",
      },
    },
  },
};

export const PausedPrimedGeometry: Story = {
  ...PausedPrimed,
  name: "Paused Primed Geometry",
  play: async ({ canvasElement }) => {
    const column = await expectLearningActivityFrameGeometry(canvasElement);
    const lyric = canvasElement.querySelector(".karaoke-line");
    if (!lyric) throw new Error("Expected a lyric line");
    await expectInsideLearningActivityColumn(lyric, column);
    const action = within(canvasElement).getByRole("button", { name: "Start karaoke" });
    await expectInsideLearningActivityColumn(action, column);
  },
};

function timedLongLine(text: string) {
  const words = text.split(" ");
  const startMs = 1000;
  const endMs = 7000;
  const step = (endMs - startMs) / words.length;
  return {
    id: "long-line",
    text,
    startMs,
    endMs,
    tokens: words.map((word, index) => ({
      text: word,
      startMs: Math.round(startMs + index * step),
      endMs: Math.round(startMs + (index + 1) * step),
      trailing: index < words.length - 1 ? " " : undefined,
    })),
  };
}

const longLyricLines = [
  timedLongLine("I don't know why the harbor lights kept burning through the longest night while every wave was calling out your name"),
  storyStageLines[1],
];

export const LongLyricGeometry: Story = {
  ...PausedPrimed,
  name: "Long Lyric Geometry",
  args: {
    ...PausedPrimed.args,
    lines: longLyricLines,
  },
  play: async ({ canvasElement }) => {
    const column = await expectLearningActivityFrameGeometry(canvasElement);
    const lyric = canvasElement.querySelector(".karaoke-line");
    if (!lyric) throw new Error("Expected the long lyric line");
    await expectInsideLearningActivityColumn(lyric, column);
    const action = within(canvasElement).getByRole("button", { name: "Start karaoke" });
    await expectInsideLearningActivityColumn(action, column);
  },
};

export const ScoringFeedback: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    lines: storyStageLines,
    initialTimeMs: 2550,
    initialDurationMs: 4800,
    rating: {
      key: "line-1:0:0.98",
      label: "Perfect",
      lineId: "line-1",
      points: 50,
      tone: "success",
    },
    ratingPersistent: true,
    singingStatus: "active",
    onStartSinging: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "An active scoring session keeps the latest rating and points visible for review; live sessions use the same feedback as a transient pop.",
      },
    },
  },
};

export const Connecting: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    lines: storyStageLines,
    singingStatus: "connecting",
    onStartSinging: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "The mic has been granted and the scoring session is still opening; the action shows its busy state and stays disabled.",
      },
    },
  },
};

/** A server summary as it arrives when a scored take ends. */
const storySummary: KaraokeResultsSummary = {
  finalScore: 0.82,
  lyricsScore: 0.88,
  timingScore: 0.74,
  scoredLineCount: 12,
  uncertainLineCount: 0,
  timingTrend: "on_time",
};

export const Ended: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    initialTimeMs: 13600,
    lines: storyStageLines,
    singingStatus: "ended",
    summary: storySummary,
    bestCombo: 6,
    onExit: () => {},
    onStartSinging: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "The take is finished: the server summary becomes a results page with the score, lyrics accuracy, timing and best combo, one Continue back to the song and a quiet Sing again.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Great work!" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("On time")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Sing again" }),
    ).toBeInTheDocument();
  },
};

export const EndedUnmeasuredLines: Story = {
  args: {
    ...Ended.args,
    summary: { ...storySummary, uncertainLineCount: 2, timingScore: null },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Lines the service could not measure are named and excluded, and timing that did not count reads Not scored.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText(
        "2 lines couldn't be measured, so they don't count toward your score.",
      ),
    ).toBeInTheDocument();
    await expect(canvas.getByText("—")).toBeInTheDocument();
    expect(canvas.getByText("—").closest("dd")).toHaveAttribute("aria-label", "Not scored");
  },
};

export const EndedWithoutSummary: Story = {
  args: { ...Ended.args, summary: null },
  parameters: {
    docs: {
      description: {
        story: "When no summary arrives the page says so and shows no score.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByText(
        "Your score for this take wasn't received.",
      ),
    ).toBeInTheDocument();
  },
};

/** Only the browser play promise is doubled; the production recovery UI runs normally. */
export const PlaybackRefused: Story = {
  args: { title: "Paper Moon", lines: storyStageLines },
  render: (args) => {
    const [status, setStatus] = createSignal<"idle" | "active">("idle");
    let host!: HTMLDivElement;
    let restore: (() => void) | undefined;
    onSettled(() => {
      const audio = host.querySelector("audio")!;
      const original = audio.play;
      audio.play = () =>
        Promise.reject(new DOMException("Playback refused", "NotAllowedError"));
      restore = () => {
        audio.play = original;
      };
    });
    onCleanup(() => restore?.());
    return (
      <div ref={host}>
        <KaraokePracticeSurface
          {...args}
          lines={storyStageLines}
          singingStatus={status()}
          onStartSinging={() => setStatus("active")}
        />
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story:
          "A refused browser play promise offers a direct retry and pauses capture. This uses a play-promise double and proves no Pixel or autoplay behavior.",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Start karaoke" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Couldn't play audio",
    );
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
  },
};

/** The phone took the audio mid-take (a call, another app). One button resumes the same take. */
export const PlaybackInterrupted: Story = {
  args: {
    artworkSrc: storyArtworkSrc,
    title: "Paper Moon",
    lines: storyStageLines,
    initialTimeMs: 2550,
    initialDurationMs: 4800,
    singingStatus: "active",
    playbackInterrupted: true,
    onResumePlayback: fn(async () => false),
    onStartSinging: () => {},
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Audio paused"),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Start karaoke" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Resume" }),
    );
    await expect(args.onResumePlayback).toHaveBeenCalledOnce();
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
  },
};

export const ResultUnavailable: Story = {
  args: {
    ...PausedPrimed.args,
    singingStatus: "active",
    centeredStatus: { title: "Couldn't get your result", tone: "retryable", error: true },
    centeredStatusAction: { label: "Check again", onClick: fn() },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("Couldn't get your result");
    await expect(canvas.queryByText("Meet me by the old harbor")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await expect(args.centeredStatusAction?.onClick).toHaveBeenCalledOnce();
  },
};
