// Independently owned presentation from src/features/activity/activity-leaderboard-view.tsx @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
import { IconFire } from "../design-system.ts";
export function StreakCount(props: {
  readonly count: number;
  readonly class?: string;
}) {
  return (
    <span
      class={`inline-flex w-14 shrink-0 items-center justify-end gap-1 font-bold tabular-nums text-warning ${props.class ?? ""}`}
      aria-label={`${props.count} day streak`}
    >
      <span>{props.count}</span>
      <IconFire filled class="size-5 shrink-0" />
    </span>
  );
}
