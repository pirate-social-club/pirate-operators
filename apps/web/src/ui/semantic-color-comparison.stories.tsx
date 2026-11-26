import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createEffect, createSignal, For, Show } from "solid-js";
import { expect, within } from "storybook/test";
import { ErrorState } from "./error-state.tsx";

type Sample = {
  id: string;
  context: string;
  state: string;
  foreground: string;
  background: string;
  border?: string;
  text: string;
  detail?: string;
};

const current: Sample[] = [
  {
    id: "study-correct-current",
    context: "Study feedback",
    state: "Correct result box",
    foreground: "var(--success)",
    background: "color-mix(in oklab, var(--success) 14%, var(--card))",
    border: "var(--success)",
    text: "Correct",
    detail: "You said: “Yo no sé por qué te fuiste tan temprano”",
  },
  {
    id: "study-incorrect-current",
    context: "Study feedback",
    state: "Incorrect result box",
    foreground: "var(--destructive-text)",
    background: "color-mix(in oklab, var(--destructive) 15%, var(--card))",
    border: "var(--destructive)",
    text: "Incorrect",
    detail: "You said: “Yo no se por que”",
  },
  {
    id: "wallet-copied-current",
    context: "Wallet Receive",
    state: "Address copied confirmation",
    foreground: "var(--success)",
    background: "var(--card)",
    text: "✓ Address copied",
    detail: "0x742d35…9f0e",
  },
  {
    id: "dance-error-current",
    context: "Dance recovery",
    state: "Status could not be confirmed",
    foreground: "var(--destructive-text)",
    background: "var(--card)",
    text: "Your recording’s status couldn’t be confirmed.",
    detail: "Check again · Resume submission",
  },
];

const tailwind: Sample[] = current.map((sample) => ({
  ...sample,
  id: sample.id.replace("current", "tailwind"),
  foreground: sample.id.includes("study-correct") || sample.id.includes("wallet-copied")
    ? "#166534"
    : "#b91c1c",
  background: sample.id.includes("study-correct")
    ? "color-mix(in oklab, #166534 14%, var(--card))"
    : sample.id.includes("study-incorrect")
      ? "color-mix(in oklab, #b91c1c 15%, var(--card))"
      : "var(--card)",
  border: sample.border
    ? sample.id.includes("study-correct")
      ? "#166534"
      : "#b91c1c"
    : undefined,
}));

function rgbParts(value: string): [number, number, number] {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return [0, 0, 0];
  return match[1].split(",").slice(0, 3).map((part) => Number.parseFloat(part)) as [number, number, number];
}

function luminance(value: string) {
  const [r, g, b] = rgbParts(value).map((channel) => {
    const linear = channel / 255;
    return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function SampleCard(props: { sample: Sample }) {
  const [ratio, setRatio] = createSignal(0);
  let card: HTMLDivElement | undefined;
  let label: HTMLParagraphElement | undefined;
  createEffect(
    () => true,
    () => {
      if (!card || !label) return;
      setRatio(contrast(getComputedStyle(label).color, getComputedStyle(card).backgroundColor));
    },
  );
  return (
    <div
      ref={card}
      class="rounded-[var(--radius-xl)] border p-4"
      style={{
        color: props.sample.foreground,
        background: props.sample.background,
        "border-color": props.sample.border ?? "var(--border)",
      }}
      data-color-sample={props.sample.id}
    >
      <p ref={label} class="text-base font-semibold leading-6">{props.sample.text}</p>
      <Show when={props.sample.detail}>
        <p class="mt-2 text-foreground">{props.sample.detail}</p>
      </Show>
      <p class="mt-3 text-xs text-muted-foreground" data-contrast-ratio>
        {ratio() ? `${ratio().toFixed(2)}:1 foreground/background` : "measuring contrast…"}
      </p>
    </div>
  );
}

function ComparisonGrid(props: { title: string; samples: Sample[] }) {
  return (
    <section class="flex flex-col gap-4">
      <h2 class="text-lg font-semibold">{props.title}</h2>
      <div class="grid gap-4 md:grid-cols-2">
        <For each={props.samples}>
          {(sample) => (
            <article class="flex flex-col gap-3 rounded-[var(--radius-xl)] border border-border bg-card p-4">
              <header>
                <p class="text-sm text-muted-foreground">{sample.context}</p>
                <h3 class="font-semibold">{sample.state}</h3>
                <p class="text-xs text-muted-foreground">foreground {sample.foreground} · background {sample.background}</p>
              </header>
              <SampleCard sample={sample} />
            </article>
          )}
        </For>
      </div>
    </section>
  );
}

function SemanticColorComparison() {
  return (
    <main class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8">
      <header class="flex flex-col gap-2">
        <h1 class="text-2xl font-semibold">Semantic color comparison</h1>
        <p class="max-w-3xl text-muted-foreground">
          Light-mode comparison for the owner decision. Left-to-right pairs show the current semantic tokens and Tailwind green-800/red-700 in the same Study, Wallet Receive and Dance recovery contexts. Ratios are measured from computed browser colors, including tinted backgrounds.
        </p>
      </header>
      <section class="flex max-w-2xl flex-col gap-3 rounded-[var(--radius-xl)] border border-border bg-card p-4">
        <h2 class="text-lg font-semibold">Production Dance recovery copy</h2>
        <ErrorState
          title="Your recording’s status couldn’t be confirmed."
          description="The status check did not settle. Check again before resuming submission."
          tone="resumable"
          status="Submission is paused; no duplicate upload is created."
          primaryAction={{ label: "Resume submission" }}
          secondaryAction={{ label: "Check again" }}
        />
      </section>
      <ComparisonGrid title="Current semantic tokens" samples={current} />
      <ComparisonGrid title="Tailwind green-800 / red-700" samples={tailwind} />
    </main>
  );
}

const meta = {
  title: "Design/Parts/Semantic color comparison",
  tags: ["part"],
  component: SemanticColorComparison,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Owner decision fixture only: it compares the current semantic success/destructive tokens with Tailwind green-800/red-700 in real product-state copy and geometry, then measures the computed foreground/background contrast. It does not change production tokens or qualify the affected states.",
      },
    },
  },
} satisfies Meta<typeof SemanticColorComparison>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LightModeComparison: Story = {
  globals: { theme: "light" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "Semantic color comparison" })).toBeVisible();
    await expect(canvas.getAllByText(/foreground\/background/).length).toBe(8);
    await expect(canvas.getByText("Correct")).toBeVisible();
    await expect(canvas.getByText("Your recording’s status couldn’t be confirmed.")).toBeVisible();
  },
};
