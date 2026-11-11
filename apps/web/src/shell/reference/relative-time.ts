// Independently owned presentation from src/features/posts/shared-engagement/relative-time.ts @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact extraction/adapter boundaries: docs/v1-shell-owner-correction-20261111.md.
/** Shared public timestamps; absent or invalid dates do not produce metadata. */
export function relativeTime(
  value: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes === 0) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The post card's compact age: "now", "5m", "2h", "3d". No separator and no
 * "ago"; the timestamp element carries the exact time for assistive tech.
 */
export function compactRelativeTime(
  value: string | undefined,
  now = Date.now(),
): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes === 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
