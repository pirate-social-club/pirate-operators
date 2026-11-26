import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { createSignal, For, onSettled } from "solid-js";
import { expect, waitFor, within } from "storybook/test";
import { Button, IconCheck, IconX, Type } from "../design-system.ts";

type PaletteRole = "success" | "error";
type PaletteVariant = "current" | "tailwind";
type ComparisonId =
  | "study-correct"
  | "study-incorrect"
  | "wallet-copied"
  | "dance-error";

type Comparison = {
  id: ComparisonId;
  title: string;
  role: PaletteRole;
  note: string;
};

type SrgbColor = {
  red: number;
  green: number;
  blue: number;
  alpha: number;
};

type MeasuredContrast = {
  status: "measured";
  ratio: number;
  foregroundValue: string;
  surfaceValue: string;
  foregroundSrgb: string;
  backgroundSrgb: string;
};

type Measurement =
  | { status: "measuring" }
  | { status: "unsupported"; message: string }
  | MeasuredContrast;

const comparisons: Comparison[] = [
  {
    id: "study-correct",
    title: "Study correct feedback",
    role: "success",
    note: "Production Study result-box treatment: the icon and label, border and translucent tint sit over the route background.",
  },
  {
    id: "study-incorrect",
    title: "Study incorrect feedback",
    role: "error",
    note: "Production Study result-box treatment: the icon and label, border and translucent tint sit over the route background.",
  },
  {
    id: "wallet-copied",
    title: "Wallet Receive copied button",
    role: "success",
    note: "Production Receive geometry and button background. The production copied icon currently inherits the neutral button foreground; each variant recolors only that icon for this palette decision.",
  },
  {
    id: "dance-error",
    title: "Dance recovery alert",
    role: "error",
    note: "Actual route copy and action order. The production alert currently inherits the neutral page foreground; each variant recolors only that alert for this palette decision.",
  },
];

const variantLabels: Record<PaletteVariant, Record<PaletteRole, string>> = {
  current: {
    success: "Current token: --success",
    error: "Current tokens: --destructive-text over a --destructive tint",
  },
  tailwind: {
    success: "Tailwind 4.3.3: green-800",
    error: "Tailwind 4.3.3: red-700",
  },
};

const walletAddress = `0x${"11".repeat(20)}`;
const expectedStudyCorrectCurrentRatio = 4.94;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function numeric(value: string) {
  const trimmed = value.trim();
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?$/i.test(trimmed)) {
    throw new Error(`unsupported numeric color component "${value}"`);
  }
  return Number(trimmed);
}

function scaledNumber(value: string, percentScale: number) {
  const trimmed = value.trim();
  if (trimmed.endsWith("%"))
    return (numeric(trimmed.slice(0, -1)) * percentScale) / 100;
  return numeric(trimmed);
}

function alphaValue(value: string | undefined) {
  if (value === undefined) return 1;
  return clamp01(scaledNumber(value, 1));
}

function hueValue(value: string) {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith("deg")) return numeric(trimmed.slice(0, -3));
  if (trimmed.endsWith("grad")) return numeric(trimmed.slice(0, -4)) * 0.9;
  if (trimmed.endsWith("rad"))
    return (numeric(trimmed.slice(0, -3)) * 180) / Math.PI;
  if (trimmed.endsWith("turn")) return numeric(trimmed.slice(0, -4)) * 360;
  return numeric(trimmed);
}

function splitModernColor(body: string) {
  const pieces = body.split("/");
  if (pieces.length > 2)
    throw new Error(`unsupported color alpha syntax "${body}"`);
  const channels = pieces[0].trim().split(/\s+/u).filter(Boolean);
  if (!channels.length)
    throw new Error(`missing color components in "${body}"`);
  return { channels, alpha: pieces[1]?.trim() };
}

function rgbChannel(value: string) {
  const trimmed = value.trim();
  if (trimmed.endsWith("%"))
    return clamp01(numeric(trimmed.slice(0, -1)) / 100);
  return clamp01(numeric(trimmed) / 255);
}

function parseRgb(body: string): SrgbColor {
  if (body.includes(",")) {
    const pieces = body.split(",").map((piece) => piece.trim());
    if (pieces.length !== 3 && pieces.length !== 4) {
      throw new Error(`unsupported rgb component count in "${body}"`);
    }
    return {
      red: rgbChannel(pieces[0]),
      green: rgbChannel(pieces[1]),
      blue: rgbChannel(pieces[2]),
      alpha: alphaValue(pieces[3]),
    };
  }
  const { channels, alpha } = splitModernColor(body);
  if (channels.length !== 3)
    throw new Error(`unsupported rgb component count in "${body}"`);
  return {
    red: rgbChannel(channels[0]),
    green: rgbChannel(channels[1]),
    blue: rgbChannel(channels[2]),
    alpha: alphaValue(alpha),
  };
}

function linearToSrgb(value: number) {
  const channel = clamp01(value);
  return channel <= 0.0031308
    ? 12.92 * channel
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function oklabToSrgb(
  lightness: number,
  a: number,
  b: number,
): Omit<SrgbColor, "alpha"> {
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541729 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  return {
    red: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    green: linearToSrgb(
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    ),
    blue: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function parseOklab(body: string): SrgbColor {
  const { channels, alpha } = splitModernColor(body);
  if (channels.length !== 3)
    throw new Error(`unsupported oklab component count in "${body}"`);
  return {
    ...oklabToSrgb(
      scaledNumber(channels[0], 1),
      scaledNumber(channels[1], 0.4),
      scaledNumber(channels[2], 0.4),
    ),
    alpha: alphaValue(alpha),
  };
}

function parseOklch(body: string): SrgbColor {
  const { channels, alpha } = splitModernColor(body);
  if (channels.length !== 3)
    throw new Error(`unsupported oklch component count in "${body}"`);
  const lightness = scaledNumber(channels[0], 1);
  const chroma = scaledNumber(channels[1], 0.4);
  const hue = (hueValue(channels[2]) * Math.PI) / 180;
  return {
    ...oklabToSrgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)),
    alpha: alphaValue(alpha),
  };
}

function parseColor(value: string): SrgbColor {
  const trimmed = value.trim();
  const match = /^(rgba?|oklab|oklch|color)\(\s*([\s\S]*)\)$/iu.exec(trimmed);
  if (!match) throw new Error(`unsupported color format "${value}"`);
  const kind = match[1].toLowerCase();
  const body = match[2].trim();
  if (kind === "rgb" || kind === "rgba") return parseRgb(body);
  if (kind === "oklab") return parseOklab(body);
  if (kind === "oklch") return parseOklch(body);
  const { channels, alpha } = splitModernColor(body);
  if (channels.length !== 4 || channels[0].toLowerCase() !== "srgb") {
    throw new Error(`unsupported color() value "${value}"`);
  }
  return {
    red: rgbChannel(channels[1]),
    green: rgbChannel(channels[2]),
    blue: rgbChannel(channels[3]),
    alpha: alphaValue(alpha),
  };
}

function compositeColors(source: SrgbColor, backdrop: SrgbColor): SrgbColor {
  const alpha = source.alpha + backdrop.alpha * (1 - source.alpha);
  if (alpha === 0) return { red: 0, green: 0, blue: 0, alpha: 0 };
  return {
    red:
      (source.red * source.alpha +
        backdrop.red * backdrop.alpha * (1 - source.alpha)) /
      alpha,
    green:
      (source.green * source.alpha +
        backdrop.green * backdrop.alpha * (1 - source.alpha)) /
      alpha,
    blue:
      (source.blue * source.alpha +
        backdrop.blue * backdrop.alpha * (1 - source.alpha)) /
      alpha,
    alpha,
  };
}

function effectiveBackground(surface: HTMLElement) {
  const chain: HTMLElement[] = [];
  for (
    let current: HTMLElement | null = surface;
    current;
    current = current.parentElement
  ) {
    chain.unshift(current);
  }
  let background: SrgbColor = { red: 1, green: 1, blue: 1, alpha: 1 };
  for (const element of chain) {
    const style = getComputedStyle(element);
    if (style.backgroundImage !== "none") {
      throw new Error(
        `unsupported background image on ${element.tagName.toLowerCase()}`,
      );
    }
    background = compositeColors(parseColor(style.backgroundColor), background);
  }
  return background;
}

function luminance(color: SrgbColor) {
  return (
    0.2126 * srgbToLinear(color.red) +
    0.7152 * srgbToLinear(color.green) +
    0.0722 * srgbToLinear(color.blue)
  );
}

function contrastRatio(foreground: SrgbColor, background: SrgbColor) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function byte(value: number) {
  return Math.round(clamp01(value) * 255)
    .toString(16)
    .padStart(2, "0");
}

function formatSrgb(color: SrgbColor) {
  const hex = `#${byte(color.red)}${byte(color.green)}${byte(color.blue)}`;
  return color.alpha >= 0.999 ? hex : `${hex} alpha ${color.alpha.toFixed(3)}`;
}

function measureContrast(
  foreground: HTMLElement,
  surface: HTMLElement,
): MeasuredContrast {
  const foregroundValue = getComputedStyle(foreground).color;
  const surfaceValue = getComputedStyle(surface).backgroundColor;
  const background = effectiveBackground(surface);
  const visibleForeground = compositeColors(
    parseColor(foregroundValue),
    background,
  );
  return {
    status: "measured",
    ratio: contrastRatio(visibleForeground, background),
    foregroundValue,
    surfaceValue,
    foregroundSrgb: formatSrgb(visibleForeground),
    backgroundSrgb: formatSrgb(background),
  };
}

function studyPalette(correct: boolean, variant: PaletteVariant) {
  if (correct) {
    return variant === "current"
      ? { foreground: "text-success", surface: "border-success bg-success/14" }
      : {
          foreground: "text-green-800",
          surface: "border-green-800 bg-green-800/14",
        };
  }
  return variant === "current"
    ? {
        foreground: "text-destructive-text",
        surface: "border-destructive bg-destructive/15",
      }
    : { foreground: "text-red-700", surface: "border-red-700 bg-red-700/15" };
}

function StudyTreatment(props: { correct: boolean; variant: PaletteVariant }) {
  const palette = () => studyPalette(props.correct, props.variant);
  return (
    <div class="bg-background p-4 text-foreground">
      <div
        class={`rounded-[var(--radius-xl)] border p-4 ${palette().surface}`}
        data-contrast-surface
        role="status"
      >
        <div class="flex items-center gap-3">
          {props.correct ? (
            <IconCheck
              aria-hidden="true"
              class={`size-6 shrink-0 ${palette().foreground}`}
            />
          ) : (
            <IconX
              aria-hidden="true"
              class={`size-6 shrink-0 ${palette().foreground}`}
            />
          )}
          <Type
            as="p"
            class={`text-base font-semibold leading-6 ${palette().foreground}`}
            data-contrast-foreground
            variant="body-strong"
          >
            {props.correct ? "Correct" : "Incorrect"}
          </Type>
        </div>
        <Type as="p" class="mt-2 text-foreground" dir="auto" variant="body">
          {props.correct
            ? "You said: “Yo no sé por qué te fuiste tan temprano”"
            : "You said: “Yo no se por que”"}
        </Type>
      </div>
    </div>
  );
}

function WalletTreatment(props: { variant: PaletteVariant }) {
  const foreground = () =>
    props.variant === "current" ? "text-success" : "text-green-800";
  return (
    <div class="bg-background p-4 text-foreground">
      <div class="flex flex-col items-center gap-3 rounded-[var(--radius-md)] border border-border-soft bg-popover p-4">
        <Type variant="overline">MegaETH address</Type>
        <div class="flex w-full items-center gap-2">
          <Type
            variant="body"
            class="min-w-0 flex-1 truncate font-mono"
            title={walletAddress}
          >
            0x111111…111111
          </Type>
          <span class="sr-only">{walletAddress}</span>
          <Button
            variant="outline"
            size="icon"
            aria-label="Address copied"
            title="Copied"
            data-contrast-surface
            leadingIcon={
              <IconCheck
                class={`size-4 ${foreground()}`}
                data-contrast-foreground
              />
            }
          />
        </div>
        <Type aria-live="polite" class="sr-only" variant="caption">
          Address copied
        </Type>
      </div>
    </div>
  );
}

function DanceTreatment(props: { variant: PaletteVariant }) {
  const foreground = () =>
    props.variant === "current" ? "text-destructive-text" : "text-red-700";
  return (
    <div class="bg-background p-4 text-foreground">
      <div
        class="relative flex min-h-[280px] flex-col overflow-hidden bg-background"
        data-contrast-surface
        data-dance-review="error"
      >
        <div class="relative flex min-h-0 flex-1 flex-col">
          <div class="flex flex-col gap-4 px-4 py-12">
            <p role="alert" class={foreground()} data-contrast-foreground>
              Your recording’s status couldn’t be confirmed.
            </p>
            <Button variant="secondary">Check again</Button>
            <Button>Resume submission</Button>
            <Button variant="secondary">Back to dance</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Treatment(props: { comparison: Comparison; variant: PaletteVariant }) {
  if (props.comparison.id === "study-correct")
    return <StudyTreatment correct variant={props.variant} />;
  if (props.comparison.id === "study-incorrect")
    return <StudyTreatment correct={false} variant={props.variant} />;
  if (props.comparison.id === "wallet-copied")
    return <WalletTreatment variant={props.variant} />;
  return <DanceTreatment variant={props.variant} />;
}

function measurementText(measurement: Measurement) {
  if (measurement.status === "measuring") return "measuring contrast…";
  if (measurement.status === "unsupported")
    return `unsupported color measurement: ${measurement.message}`;
  return `${measurement.ratio.toFixed(2)}:1 foreground/effective background`;
}

function measurementDetail(measurement: Measurement) {
  if (measurement.status !== "measured")
    return "computed browser colors appear here when measurement completes";
  return `${measurement.foregroundValue} on ${measurement.surfaceValue}; effective ${measurement.backgroundSrgb}`;
}

function ComparisonSample(props: {
  comparison: Comparison;
  variant: PaletteVariant;
}) {
  const [measurement, setMeasurement] = createSignal<Measurement>({
    status: "measuring",
  });
  let sample: HTMLElement | undefined;
  const measured = () => {
    const value = measurement();
    return value.status === "measured" ? value : null;
  };

  onSettled(() => {
    const foreground = sample?.querySelector<HTMLElement>(
      "[data-contrast-foreground]",
    );
    const surface = sample?.querySelector<HTMLElement>(
      "[data-contrast-surface]",
    );
    if (!sample || !foreground || !surface) {
      setMeasurement({
        status: "unsupported",
        message: "missing foreground or surface measurement target",
      });
      return;
    }
    try {
      setMeasurement(measureContrast(foreground, surface));
    } catch (error) {
      setMeasurement({
        status: "unsupported",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return (
    <article
      ref={sample}
      class="flex flex-col gap-3 rounded-[var(--radius-xl)] border border-border bg-card p-4"
      data-color-sample={`${props.comparison.id}-${props.variant}`}
      data-ratio-status={measurement().status}
      data-ratio-value={measured()?.ratio.toFixed(4)}
      data-foreground-srgb={measured()?.foregroundSrgb}
      data-effective-background-srgb={measured()?.backgroundSrgb}
    >
      <header class="flex flex-col gap-1">
        <h3 class="font-semibold">
          {props.variant === "current"
            ? "Current semantic tokens"
            : "Pinned Tailwind palette"}
        </h3>
        <p class="text-xs text-muted-foreground">
          {variantLabels[props.variant][props.comparison.role]}
        </p>
      </header>
      <Treatment comparison={props.comparison} variant={props.variant} />
      <div class="flex flex-col gap-1">
        <p class="text-xs font-medium" data-contrast-ratio>
          {measurementText(measurement())}
        </p>
        <p
          class="break-words text-xs text-muted-foreground"
          data-contrast-detail
        >
          {measurementDetail(measurement())}
        </p>
      </div>
    </article>
  );
}

function SemanticColorComparison() {
  return (
    <div class="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 text-foreground">
      <header class="flex flex-col gap-2">
        <h1 class="text-2xl font-semibold">Semantic color comparison</h1>
        <p class="max-w-3xl text-muted-foreground">
          Light-mode comparison for the owner decision. Each row keeps the
          current semantic tokens and the pinned Tailwind candidate adjacent.
          Tailwind colors come from the installed tailwindcss 4.3.3 palette
          utilities rather than hardcoded hex. Ratios use computed browser
          colors converted to sRGB, with translucent tints composited over their
          actual backdrop. Success and error rows are independent decisions;
          this fixture changes no production tokens.
        </p>
      </header>
      <For each={comparisons}>
        {(comparison) => (
          <section
            class="flex flex-col gap-4"
            aria-labelledby={`${comparison.id}-heading`}
          >
            <header class="flex flex-col gap-1">
              <h2 id={`${comparison.id}-heading`} class="text-lg font-semibold">
                {comparison.title}
              </h2>
              <p class="max-w-3xl text-sm text-muted-foreground">
                {comparison.note}
              </p>
            </header>
            <div class="grid gap-4 md:grid-cols-2">
              <ComparisonSample comparison={comparison} variant="current" />
              <ComparisonSample comparison={comparison} variant="tailwind" />
            </div>
          </section>
        )}
      </For>
    </div>
  );
}

function requireSample(
  canvasElement: HTMLElement,
  id: ComparisonId,
  variant: PaletteVariant,
) {
  const sample = canvasElement.querySelector<HTMLElement>(
    `[data-color-sample="${id}-${variant}"]`,
  );
  if (!sample) throw new Error(`Missing ${id} ${variant} sample`);
  return sample;
}

async function measuredRatio(sample: HTMLElement) {
  await waitFor(() => expect(sample.dataset.ratioStatus).toBe("measured"));
  const ratio = Number(sample.dataset.ratioValue);
  expect(Number.isFinite(ratio)).toBe(true);
  expect(ratio).toBeGreaterThan(1.5);
  return ratio;
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
          "Owner decision fixture only: it compares the current semantic success/destructive tokens with the pinned Tailwind green-800/red-700 palette in product-state geometry, then measures computed foreground/effective-background contrast. It does not change production tokens or qualify the affected states.",
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
    await expect(
      canvas.getByRole("heading", { name: "Semantic color comparison" }),
    ).toBeVisible();

    const ratios = new Map<string, number>();
    for (const comparison of comparisons) {
      for (const variant of ["current", "tailwind"] as const) {
        const sample = requireSample(canvasElement, comparison.id, variant);
        const scoped = within(sample);
        if (comparison.id === "study-correct") {
          await expect(
            scoped.getByText("Correct", { exact: true }),
          ).toBeVisible();
        } else if (comparison.id === "study-incorrect") {
          await expect(
            scoped.getByText("Incorrect", { exact: true }),
          ).toBeVisible();
        } else if (comparison.id === "wallet-copied") {
          await expect(
            scoped.getByRole("button", { name: "Address copied" }),
          ).toBeVisible();
        } else {
          await expect(scoped.getByRole("alert")).toHaveTextContent(
            "Your recording’s status couldn’t be confirmed.",
          );
        }
        ratios.set(`${comparison.id}-${variant}`, await measuredRatio(sample));
      }
    }

    const calibration = ratios.get("study-correct-current");
    expect(calibration).toBeDefined();
    expect(
      Math.abs((calibration ?? 0) - expectedStudyCorrectCurrentRatio),
    ).toBeLessThan(0.05);
  },
};
