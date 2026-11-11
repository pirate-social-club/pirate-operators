// Pure reference/setlist helpers ported from the React post-composer-references.tsx
// and post-composer-sections.tsx. URL builders that read app config in React
// (`buildPublicProfilePath`, Story explorer links) are replicated here as pure
// functions so stories and tests stay offline.

import type {
  ComposerReference,
  DerivativeStepState,
  LiveSetlistItemInput,
} from "./types.ts";

export function buildPublicProfilePath(handleLabel: string): string {
  return `/u/${encodeURIComponent(handleLabel)}`;
}

const STORY_IP_ID_PATTERN = /^0x[0-9a-f]{40}$/i;

const STORY_IP_EXPLORER_BASE_URL = {
  "story-aeneid": "https://aeneid.explorer.story.foundation",
  "story-mainnet": "https://explorer.story.foundation",
} as const;

export type StoryNetwork = keyof typeof STORY_IP_EXPLORER_BASE_URL;

export function buildStoryExplorerIpAssetUrl(
  storyIpId: string | null | undefined,
  storyNetwork: StoryNetwork | null | undefined,
): string | null {
  const normalizedIpId = storyIpId?.trim();
  if (
    !normalizedIpId ||
    !storyNetwork ||
    !STORY_IP_ID_PATTERN.test(normalizedIpId)
  ) {
    return null;
  }

  return `${STORY_IP_EXPLORER_BASE_URL[storyNetwork]}/ipa/${normalizedIpId}`;
}

export function referenceLicenseLabel(item: ComposerReference): string | null {
  if (item.upstreamRoyaltyPct != null) {
    return `${item.upstreamRoyaltyPct}% royalty`;
  }
  return null;
}

export function isPublicHandle(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function dedupeReferences(items: ComposerReference[]) {
  const seen = new Set<string>();

  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }

    seen.add(item.id);
    return true;
  });
}

function buildManualReference(
  item: LiveSetlistItemInput,
): ComposerReference | undefined {
  if (!item.titleText) {
    return undefined;
  }

  return {
    id:
      item.declaredTrackId ||
      `manual:${item.titleText}:${item.artistText ?? ""}`,
    title: item.titleText,
    subtitle: item.artistText,
  };
}

export function deriveDerivativeSearchResults(
  derivativeState?: DerivativeStepState,
): ComposerReference[] {
  const selectedIds = new Set(
    (derivativeState?.references ?? []).map((reference) => reference.id),
  );
  return dedupeReferences(derivativeState?.searchResults ?? []).filter(
    (reference) => !selectedIds.has(reference.id),
  );
}

// From the React live tab: setlist gate targets are public asset ids parsed
// out of track references (manual rows never qualify).
function publicAssetIdFromReferenceId(
  referenceId: string | undefined,
): string | null {
  const value = referenceId?.trim();
  if (!value) return null;
  if (value.startsWith("story:asset:")) {
    const assetRef = value.slice("story:asset:".length);
    return assetRef.startsWith("asset_") ? assetRef : `asset_${assetRef}`;
  }
  if (value.startsWith("asset_")) return value;
  return null;
}

export interface LiveGateAssetOption {
  id: string;
  label: string;
  subtitle?: string;
}

export function deriveLiveTrackOptions(live: {
  trackOptions?: ComposerReference[];
  setlistItems: LiveSetlistItemInput[];
}): ComposerReference[] {
  return dedupeReferences([
    ...(live.trackOptions ?? []),
    ...live.setlistItems.reduce<ComposerReference[]>((items, item) => {
      const manualReference = buildManualReference(item);
      if (manualReference) {
        items.push(manualReference);
      }
      return items;
    }, []),
  ]);
}

export function deriveLiveGateAssetOptions(
  trackOptions: ComposerReference[],
): LiveGateAssetOption[] {
  const seen = new Set<string>();
  return trackOptions.flatMap((reference) => {
    const assetId = publicAssetIdFromReferenceId(reference.id);
    if (!assetId || seen.has(assetId)) return [];
    seen.add(assetId);
    return [
      { id: assetId, label: reference.title, subtitle: reference.subtitle },
    ];
  });
}

// From the React live tab: datetime-local input value for a stored scheduleAt.
export function scheduleInputValue(scheduleAt: string | undefined): string {
  const value = scheduleAt?.trim();
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;

  const date = new Date(timestamp);
  const timezoneOffsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - timezoneOffsetMs).toISOString().slice(0, 16);
}
