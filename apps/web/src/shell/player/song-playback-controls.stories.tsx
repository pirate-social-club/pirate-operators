import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createEffect, createSignal } from "solid-js";
import { expect, userEvent, within } from "storybook/test";
import { SongPlaybackControls } from "./playback-controls.tsx";

function PlaybackFixture(props: {
  playing: boolean;
  buffering: boolean;
  canSeek: boolean;
}) {
  const [playing, setPlaying] = createSignal(props.playing, { ownedWrite: true });
  const [position, setPosition] = createSignal(30, { ownedWrite: true });
  createEffect(
    () => props.playing,
    (value) => { setPlaying(value); },
  );
  return (
    <main class="min-h-screen bg-background p-6 text-foreground">
      <h1 class="mb-4 text-xl font-semibold">Playback controls</h1>
      <p class="mb-6 text-muted-foreground">
        UI state only. No audio is loaded or played.
      </p>
      <div class="grid max-w-xl grid-cols-1">
        <SongPlaybackControls
          title="Catalog preview"
          playing={playing()}
          buffering={props.buffering}
          position={position()}
          duration={180}
          canSeek={props.canSeek && !props.buffering}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onSeek={(milliseconds) => setPosition(milliseconds / 1000)}
        />
      </div>
    </main>
  );
}

const meta = {
  title: "Flows/Shell/Playback controls",
  component: PlaybackFixture,
  args: { playing: false, buffering: false, canSeek: true },
  render: (args) => <PlaybackFixture {...args} />,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Uses the production SongPlaybackControls imported by SongPlayer. Local signals model button and position state. These stories do not qualify actual playback, media delivery, permissions or persistence.",
      },
    },
  },
} satisfies Meta<typeof PlaybackFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Paused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Play Catalog preview" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Pause Catalog preview" }),
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Pause Catalog preview" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Play Catalog preview" }),
    ).toBeVisible();
  },
};

export const Playing: Story = {
  args: { playing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Pause Catalog preview" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Play Catalog preview" }),
    ).toBeVisible();
  },
};

export const Buffering: Story = {
  args: { buffering: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Loading Catalog preview" }),
    ).toBeDisabled();
  },
};

export const SeekingUnavailable: Story = { args: { canSeek: false } };
