import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { Type } from "../design-system.ts";

function ColorComparison() {
  return (
    <main class="min-h-screen bg-background p-6 text-foreground">
      <Type as="h1" class="mb-2 text-xl font-semibold">Semantic color comparison</Type>
      <Type as="p" class="mb-6 text-muted-foreground">
        Current app tokens beside familiar Tailwind alternatives. Review in light and dark.
      </Type>
      <div class="grid max-w-3xl gap-4 sm:grid-cols-2">
        <section class="space-y-3 rounded-xl border border-border-soft p-4">
          <h2 class="font-semibold">Success</h2>
          <div class="rounded-lg bg-success/14 p-4 font-semibold text-success">
            Current success token
          </div>
          <div class="rounded-lg bg-green-50 p-4 font-semibold text-green-800">
            Tailwind green-800 (light surface)
          </div>
        </section>
        <section class="space-y-3 rounded-xl border border-border-soft p-4">
          <h2 class="font-semibold">Destructive</h2>
          <div class="rounded-lg bg-destructive/15 p-4 font-semibold text-destructive-text">
            Current destructive token
          </div>
          <div class="rounded-lg bg-red-50 p-4 font-semibold text-red-700">
            Tailwind red-700 (light surface)
          </div>
        </section>
      </div>
    </main>
  );
}

const meta = {
  title: "Foundations/Color comparison",
  tags: ["part"],
  component: ColorComparison,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ColorComparison>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
