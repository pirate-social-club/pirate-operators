// Adopted from pirate-web-solid 667a6f22 src/features/activity/activity-progress-header.tsx; independently owned Paper success/spacing correction, 2026-11-12.
import { Show } from "solid-js";

import { cn, IconButton, IconCaretLeft, IconGift, IconX } from "./ui.ts";

export interface ActivityProgressHeaderProps {
  progressMax: number;
  progressValue: number;
  /** Reward value for this activity. Shown as the gift mark's accessible name. */
  rewardLabel?: string;
  /** Uses the compact gift mark from the studying reference or the karaoke badge. */
  rewardPresentation?: "badge" | "icon";
  /** Uses the study green or karaoke warning progress treatment. */
  progressTone?: "success" | "warning";
  onExit?: () => void;
  exitLabel?: string;
  /**
   * The exit control's mark. `back` (the default, used by Karaoke) is a
   * caret; `close` is Study's close mark, since its cards cannot be
   * revisited and leaving loses nothing (Paper, Flows/Studying/Session).
   */
  exitIcon?: "back" | "close";
}

function clampProgress(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.max(0, Math.min(max, value));
}

export function ActivityProgressHeader(props: ActivityProgressHeaderProps) {
  const value = () => clampProgress(props.progressValue, props.progressMax);
  const progressPercent = () => props.progressMax > 0 ? (value() / props.progressMax) * 100 : 0;
  const rewardPresentation = () => props.rewardPresentation ?? "badge";
  const progressTone = () => props.progressTone ?? "warning";

  return (
    <header class={cn("grid min-h-14 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-border-soft px-4 py-2", progressTone() !== "success" && "sm:px-6")}>
      <IconButton
        aria-label={props.exitLabel ?? "Exit activity"}
        class="size-10 bg-secondary"
        data-exit-icon={props.exitIcon ?? "back"}
        onClick={props.onExit}
        variant="secondary"
      >
        <Show when={props.exitIcon === "close"} fallback={<IconCaretLeft class="size-5" />}>
          <IconX class="size-5" />
        </Show>
      </IconButton>
      <div class={cn("flex h-9 min-w-0 flex-1 items-center", rewardPresentation() === "icon" && "gap-3")}>
        <div
          aria-label="Activity progress"
          aria-valuemax={props.progressMax}
          aria-valuemin="0"
          aria-valuenow={value()}
          class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-secondary"
          role="progressbar"
        >
          <div
            class={cn(
              "h-full rounded-full transition-[width] duration-300 ease-out motion-reduce:transition-none",
              progressTone() === "success" ? "bg-success" : "bg-warning",
            )}
            style={{ width: `${progressPercent()}%` }}
          />
        </div>
        <Show when={props.rewardLabel}>
          {(rewardLabel) => (
            <Show
              when={rewardPresentation() === "badge"}
              fallback={(
                <span aria-label={rewardLabel()} class="shrink-0 text-warning" role="img" title={rewardLabel()}>
                  <IconGift aria-hidden="true" class="size-4" />
                </span>
              )}
            >
              <span
                aria-label={rewardLabel()}
                class="relative z-10 -ms-1.5 grid size-9 shrink-0 place-items-center rounded-full border-2 border-warning bg-warning text-white ring-2 ring-background"
                role="img"
                title={rewardLabel()}
              >
                <IconGift aria-hidden="true" class="size-5" />
              </span>
            </Show>
          )}
        </Show>
      </div>
    </header>
  );
}
