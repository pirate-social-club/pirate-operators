// Independently owned copy of pirate-web-solid c7cb87835a1858a1955c820b03d566365e6d42db src/features/karaoke/karaoke-practice-surface.stories.tsx.
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, onCleanup, onSettled } from "solid-js";
import { expect, fn, userEvent, within } from "storybook/test";

import type { KaraokeResultsSummary } from "./results-model.ts";

import { KaraokePracticeSurface } from "./practice-surface.tsx";
import { storyArtworkSrc, storyStageLines } from "./story-fixtures.ts";

const meta = {
  title: "Flows/Karaoke/Practice",
  component: KaraokePracticeSurface,
  parameters: {
    layout: "fullscreen",
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
    // Karaoke keeps the shared header as it was: the back caret, full width.
    const exit = canvasElement.querySelector<HTMLElement>("[data-exit-icon]");
    if (exit === null) throw new Error("Expected the activity header");
    await expect(exit).toHaveAttribute("data-exit-icon", "back");
    const header = exit.closest("header")!.getBoundingClientRect();
    await expect(Math.round(header.width)).toBe(
      Math.round(canvasElement.ownerDocument.documentElement.clientWidth),
    );
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
    await expect(canvas.getByText("Not scored")).toBeInTheDocument();
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
      await canvas.findByRole("button", { name: "Start backing track" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "The backing track could not start",
    );
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
      canvas.getByText("Audio was interrupted. Tap to continue your take."),
    ).toBeVisible();
    await expect(
      canvas.queryByRole("button", { name: "Start karaoke" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      canvas.getByRole("button", { name: "Tap to continue" }),
    );
    await expect(args.onResumePlayback).toHaveBeenCalledOnce();
  },
};
