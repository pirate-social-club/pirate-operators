// Adopted from pirate-web-solid 667a6f22 src/features/activity/activity-results.tsx; only imports changed.
/** @jsxImportSource @solidjs/web */
import { For, Show } from "solid-js";

import { Type, cn } from "./ui.ts";

export type ActivityResultTone = "success" | "primary" | "warning";

export interface ActivityResultStat {
  readonly label: string;
  readonly value: string;
  readonly tone: ActivityResultTone;
}

export interface ActivityResultsProps {
  readonly heading: string;
  /** Rounded 0–100 score, or null when no score exists for this session. */
  readonly scorePercent: number | null;
  readonly scoreLabel: string;
  readonly stats: readonly ActivityResultStat[];
  /** An honest caveat, such as lines that could not be measured. */
  readonly note?: string;
}

const toneClasses = {
  success: { tile: "border-success/50", label: "bg-success text-background" },
  primary: { tile: "border-primary/50", label: "bg-primary text-primary-foreground" },
  warning: { tile: "border-warning/50", label: "bg-warning text-background" },
} satisfies Record<ActivityResultTone, { tile: string; label: string }>;

/** Encouragement follows the score; it never claims more than the number shows. */
export function resultHeadline(scorePercent: number | null, fallback: string): string {
  if (scorePercent === null) return fallback;
  if (scorePercent >= 90) return "Outstanding!";
  if (scorePercent >= 70) return "Great work!";
  if (scorePercent >= 40) return "Nice effort!";
  return "Keep practising!";
}

export function clampResultPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * The first completion page shared by Study and Karaoke, shaped like a
 * Duolingo lesson result: one heading, one big number and a row of labelled
 * tiles, with nothing decorative that says nothing about the result. The
 * owning surface supplies Continue and "again".
 */
export function ActivityResults(props: ActivityResultsProps) {
  return (
    <div class="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-8 px-4 py-10 sm:px-6" data-activity-results>
      <div class="flex flex-col items-center gap-4 text-center">
        <Type as="h2" variant="h2">{props.heading}</Type>
        <Show when={props.scorePercent !== null}>
          <p aria-label={`${props.scoreLabel} ${props.scorePercent}%`} class="text-7xl font-bold leading-none tabular-nums sm:text-8xl">
            {props.scorePercent}%
          </p>
        </Show>
      </div>
      <Show when={props.stats.length > 0}>
        <dl class={cn("grid w-full gap-3", props.stats.length >= 3 ? "grid-cols-3" : props.stats.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
          <For each={props.stats}>
            {(stat) => (
              <div class={cn("overflow-hidden rounded-[var(--radius-lg)] border-2 text-center", toneClasses[stat.tone].tile)}>
                <dt class={cn("px-2 py-1 text-xs font-bold uppercase tracking-wide", toneClasses[stat.tone].label)}>{stat.label}</dt>
                <dd class="px-2 py-3 text-xl font-bold tabular-nums">{stat.value}</dd>
              </div>
            )}
          </For>
        </dl>
      </Show>
      <Show when={props.note}>
        <Type as="p" class="text-center text-muted-foreground" variant="body">{props.note}</Type>
      </Show>
    </div>
  );
}
