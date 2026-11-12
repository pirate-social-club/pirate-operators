// Default composer state factories and option lists, ported from the React
// post-composer-config.tsx. The attachment action icons are plain markers
// (`AttachmentActionIcon`) instead of JSX so this module stays pure; the
// toolbar/bar components map markers to icons.

import type {
  AssetLicenseState,
  AssetRoyaltySplitState,
  CharityContributionState,
  ComposerAudienceState,
  ComposerCapability,
  ComposerEventState,
  ComposerTab,
  DownloadFileComposerState,
  LiveComposerState,
  MonetizationState,
  SongComposerState,
  VideoComposerState,
} from "./types.ts";
import type { ComposerToolbarAction } from "./types.ts";

export type AttachmentActionIcon =
  | "event"
  | "file"
  | "image"
  | "link"
  | "live"
  | "song"
  | "video";

export interface AttachmentAction {
  ariaLabel?: string;
  kind: ComposerToolbarAction;
  label: string;
  icon: AttachmentActionIcon;
}

export const attachmentActions: AttachmentAction[] = [
  { kind: "link", label: "Link", icon: "link" },
  { kind: "image", label: "Image", icon: "image" },
  { kind: "video", label: "Video", icon: "video" },
  { kind: "song", label: "Song", icon: "song" },
  { kind: "live", label: "Live", icon: "live" },
  {
    ariaLabel: "Add downloadable file",
    kind: "file",
    label: "File",
    icon: "file",
  },
  {
    ariaLabel: "Add date and place",
    kind: "event",
    label: "Event",
    icon: "event",
  },
];

export const primaryMobileAttachmentActions = attachmentActions.filter(
  ({ kind }) => ["link", "image", "video", "song"].includes(kind),
);

/** The text composer follows the mobile reference's five visible tools. */
export const textMobileAttachmentActions: AttachmentAction[] = [
  { kind: "image", label: "Image", icon: "image" },
  { kind: "video", label: "Video", icon: "video" },
  { kind: "song", label: "Audio", icon: "song" },
  { kind: "link", label: "Link", icon: "link" },
  {
    ariaLabel: "Add date and place",
    kind: "event",
    label: "Calendar",
    icon: "event",
  },
];

export const overflowMobileAttachmentActions = attachmentActions.filter(
  ({ kind }) => ["file", "live", "event"].includes(kind),
);

export const defaultTabs: ComposerTab[] = [
  "text",
  "image",
  "video",
  "link",
  "song",
  "live",
  "file",
];

/** What a host that declares nothing gets: every kind the composer can render. */
export const defaultCapabilities: ComposerCapability[] = [
  ...defaultTabs,
  "event",
];
export const anonymousEligibleTabs: ComposerTab[] = [
  "text",
  "image",
  "video",
  "link",
  "song",
  "live",
  "file",
];

export const noneLanguageValue = "__none__";

export const songGenreOptions = [
  "Electronic",
  "Hip-hop",
  "Pop",
  "R&B",
  "Rock",
  "Ambient",
] as const;

export const songLanguageOptions = [
  "English",
  "Spanish",
  "French",
  "Japanese",
  "Korean",
  "Portuguese",
] as const;

export function defaultSongState(song?: SongComposerState): SongComposerState {
  return {
    title: song?.title ?? "",
    genre: song?.genre ?? "Electronic",
    geniusAnnotationsUrl: song?.geniusAnnotationsUrl ?? "",
    primaryLanguage: song?.primaryLanguage ?? "English",
    secondaryLanguage: song?.secondaryLanguage ?? "",
    primaryAudioUpload: song?.primaryAudioUpload ?? null,
    primaryAudioLabel: song?.primaryAudioLabel,
    coverUpload: song?.coverUpload ?? null,
    coverLabel: song?.coverLabel,
    coverSource: song?.coverSource,
    previewStartSeconds: song?.previewStartSeconds ?? "0",
    canvasVideoUpload: song?.canvasVideoUpload ?? null,
    canvasVideoLabel: song?.canvasVideoLabel,
    instrumentalAudioUpload: song?.instrumentalAudioUpload ?? null,
    instrumentalAudioLabel: song?.instrumentalAudioLabel,
    vocalAudioUpload: song?.vocalAudioUpload ?? null,
    vocalAudioLabel: song?.vocalAudioLabel,
  };
}

/** Every new song is published as "Remix and sell" with a 10% share of remix
 * earnings; the author adjusts the share (owner decision, 2026-09-24). */
export const DEFAULT_SONG_LICENSE: AssetLicenseState = {
  presetId: "commercial-remix",
  commercialRevShareBps: 1_000,
  commercialRevSharePct: 10,
};

export function defaultAssetLicenseState(
  license?: AssetLicenseState,
): AssetLicenseState {
  const presetId = license?.presetId ?? DEFAULT_SONG_LICENSE.presetId;
  return {
    presetId,
    commercialRevShareBps:
      presetId === "commercial-remix"
        ? (license?.commercialRevShareBps ??
          (license?.commercialRevSharePct === undefined
            ? 1_000
            : license.commercialRevSharePct * 100))
        : undefined,
    commercialRevSharePct:
      presetId === "commercial-remix"
        ? (license?.commercialRevSharePct ?? 10)
        : undefined,
  };
}

export function defaultAssetRoyaltySplitState(
  royaltySplit?: AssetRoyaltySplitState,
  currentPersonaId?: string,
): AssetRoyaltySplitState {
  if (royaltySplit) return royaltySplit;
  return {
    allocations: [
      {
        id: "creator",
        recipientKind: "creator",
        recipientId: currentPersonaId,
        shareBps: 10_000,
        sharePct: 100,
      },
    ],
  };
}

export function defaultVideoState(
  video?: VideoComposerState,
): VideoComposerState {
  return {
    primaryVideoAspectRatio: video?.primaryVideoAspectRatio,
    primaryVideoUpload: video?.primaryVideoUpload ?? null,
    primaryVideoLabel: video?.primaryVideoLabel,
    posterFrameSeconds: video?.posterFrameSeconds ?? "0",
  };
}

export function defaultDownloadFileState(
  file?: DownloadFileComposerState,
): DownloadFileComposerState {
  return {
    upload: file?.upload ?? null,
    label: file?.label,
  };
}

export function defaultMonetizationState(
  monetization?: MonetizationState,
): MonetizationState {
  return {
    visible: monetization?.visible ?? false,
    priceLabel: monetization?.priceLabel,
    priceUsd:
      monetization?.priceUsd ??
      monetization?.priceLabel?.replace(/[^0-9.]/g, "") ??
      "0",
    regionalPricingAvailable: monetization?.regionalPricingAvailable ?? false,
    regionalPricingEnabled: monetization?.regionalPricingEnabled ?? false,
    vinylReleaseUrl: monetization?.vinylReleaseUrl ?? "",
  };
}

export function defaultAudienceState(
  audience?: ComposerAudienceState,
): ComposerAudienceState {
  return {
    visibility: audience?.visibility ?? "public",
    publicOptionEnabled: audience?.publicOptionEnabled ?? true,
    publicOptionDisabledReason: audience?.publicOptionDisabledReason,
  };
}

export const defaultCharityContributionPct = 10;

export function defaultCharityContributionState(
  contribution?: CharityContributionState,
): CharityContributionState {
  return {
    percentagePct: contribution?.percentagePct ?? 0,
    userConfigured: contribution?.userConfigured,
  };
}

export function defaultEventState(
  event?: ComposerEventState,
): ComposerEventState {
  return {
    enabled: event?.enabled ?? Boolean(event?.startsAt),
    startsAt: event?.startsAt,
    endsAt: event?.endsAt,
    timezone:
      event?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    locationName: event?.locationName,
    address: event?.address,
    isOnline: event?.isOnline ?? false,
    eventUrl: event?.eventUrl,
    place: event?.place,
  };
}

export function defaultLiveComposerState(
  live?: LiveComposerState,
): LiveComposerState {
  return {
    roomKind: live?.roomKind ?? "solo",
    accessMode: live?.accessMode ?? "free",
    audienceGateMode: live?.audienceGateMode ?? "community_members",
    audienceGateTargetRefs: live?.audienceGateTargetRefs ?? [],
    visibility: live?.visibility ?? "public",
    scheduleForLater:
      live?.scheduleForLater ?? Boolean(live?.scheduleAt?.trim()),
    scheduleAt: live?.scheduleAt,
    description: live?.description,
    guestUserId: live?.guestUserId,
    storeUrl: live?.storeUrl,
    storeLabel: live?.storeLabel,
    coverUpload: live?.coverUpload ?? null,
    coverLabel: live?.coverLabel,
    recordingEnabled: live?.recordingEnabled ?? false,
    trackOptions: live?.trackOptions,
    setlistItems: live?.setlistItems ?? [],
    setlistStatus: live?.setlistStatus ?? "draft",
    performerAllocations: live?.performerAllocations ?? [
      { userId: "", role: "host", sharePct: 100 },
    ],
  };
}
