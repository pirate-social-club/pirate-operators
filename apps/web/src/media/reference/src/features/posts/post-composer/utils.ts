// Pure composer helpers ported from the React post-composer-utils.ts.

import type { ComposerTab, LiveComposerState } from "./types.ts";
import { isLiveVisibilityAllowedForAccess } from "./invariants.ts";

export function isValidHttpUrl(value: string) {
  return normalizeHttpUrl(value) !== null;
}

export function normalizeHttpUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parse = (candidate: string) => {
    try {
      const url = new URL(candidate);
      return url.protocol === "http:" || url.protocol === "https:"
        ? url.href
        : null;
    } catch {
      return null;
    }
  };

  const parsed = parse(trimmed);
  if (parsed) return parsed;

  if (/\s/.test(trimmed)) return null;

  const pathStart = trimmed.search(/[/?#]/);
  const authorityCandidate =
    pathStart === -1 ? trimmed : trimmed.slice(0, pathStart);
  const colonIndex = authorityCandidate.indexOf(":");
  if (colonIndex > 0) {
    const hostCandidate = authorityCandidate.slice(0, colonIndex).toLowerCase();
    const portLikeHost =
      hostCandidate.includes(".") ||
      hostCandidate === "localhost" ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostCandidate) ||
      hostCandidate.startsWith("[");
    if (!portLikeHost) return null;
  }

  const normalizedTrimmed = trimmed.toLowerCase();
  const schemelessWebUrl =
    trimmed.includes(".") ||
    normalizedTrimmed.startsWith("localhost") ||
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#]|$)/.test(trimmed) ||
    /^\[[\da-f:]+\](?::\d+)?(?:[/?#]|$)/i.test(trimmed);

  if (!schemelessWebUrl) return null;

  return parse(`https://${trimmed}`);
}

export function canAdvanceComposerWriteStep({
  imageUploadPresent,
  linkUrl,
  liveState,
  mode,
  songAudioUploadPresent,
  title,
  videoUploadPresent,
  fileUploadPresent = false,
}: {
  body: string;
  imageUploadPresent: boolean;
  linkUrl: string;
  liveState?: LiveComposerState;
  mode: ComposerTab;
  songAudioUploadPresent: boolean;
  title: string;
  videoUploadPresent: boolean;
  fileUploadPresent?: boolean;
}) {
  if (mode === "song") return songAudioUploadPresent;
  if (mode === "video") return videoUploadPresent;
  if (mode === "image") return title.trim().length > 0 && imageUploadPresent;
  if (mode === "link") return isValidHttpUrl(linkUrl);
  if (mode === "live")
    return Boolean(liveState && canSubmitLiveRoomDraft(liveState, title));
  if (mode === "file") return title.trim().length > 0 && fileUploadPresent;
  return title.trim().length > 0;
}

export function canSubmitLiveRoomDraft(
  liveState: LiveComposerState,
  title: string,
): boolean {
  if (!title.trim()) return false;
  if (!isLiveVisibilityAllowedForAccess(liveState)) return false;
  if (
    liveState.scheduleForLater &&
    !isValidLiveScheduleAt(liveState.scheduleAt)
  )
    return false;
  if (liveState.roomKind === "duet" && !liveState.guestUserId?.trim())
    return false;
  if (liveState.setlistItems.length === 0) return false;
  if (liveState.setlistItems.some((item) => !item.titleText.trim()))
    return false;
  if (liveState.accessMode !== "paid") return true;
  return (
    liveState.performerAllocations.reduce(
      (sum, allocation) => sum + allocation.sharePct,
      0,
    ) === 100
  );
}

function isValidLiveScheduleAt(scheduleAt: string | undefined): boolean {
  const value = scheduleAt?.trim();
  if (!value) return false;
  return Number.isFinite(Date.parse(value));
}

export function normalizePriceInput(value: string) {
  const normalized = value.replace(/[^\d.]/g, "");
  const [whole, ...rest] = normalized.split(".");
  const decimals = rest.join("").slice(0, 2);
  return rest.length ? `${whole}.${decimals}` : whole;
}

export function normalizeRoyaltyInput(value: string) {
  const normalized = value.replace(/[^\d]/g, "").slice(0, 3);
  const numeric = Math.min(100, Number(normalized || 0));
  return normalized ? String(numeric) : "";
}

export function normalizeSecondsInput(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return String(Math.min(Number.parseInt(digits, 10), 86_400));
}

function formatPreviewPrice(value?: string) {
  const normalized = value?.trim();
  if (!normalized) return "$1.00";
  return normalized.startsWith("$") ? normalized : `$${normalized}`;
}

// Designed composer step tracks. Song is the only multi-step track today; a
// track with no entries is single-step and posts from the composer button.
// Lyrics live inside the Song step as an optional field, so the flow is the
// song itself, its rights, then confirmation.
export type ComposerStepName = "song" | "rights" | "review";

const songStepTrack: readonly ComposerStepName[] = ["song", "rights", "review"];

export function composerStepTrack(
  tab: ComposerTab,
): readonly ComposerStepName[] {
  return tab === "song" ? songStepTrack : [];
}

export function getNextComposerStep(
  step: ComposerStepName,
  tab: ComposerTab,
): ComposerStepName {
  const track = composerStepTrack(tab);
  const index = track.indexOf(step);
  return index >= 0 && index < track.length - 1 ? track[index + 1]! : step;
}

export function getPreviousComposerStep(
  step: ComposerStepName,
  tab: ComposerTab,
): ComposerStepName {
  const track = composerStepTrack(tab);
  const index = track.indexOf(step);
  return index > 0 ? track[index - 1]! : step;
}
