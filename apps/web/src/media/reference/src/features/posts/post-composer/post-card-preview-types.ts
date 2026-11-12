// Narrow preview contracts used by the composer. The active rewrite does not
// yet carry the historical post-card feature, so the composer keeps this
// type-only seam local until the shared card contract is introduced.

export type PlaybackState =
  | "idle"
  | "playing"
  | "paused"
  | "buffering"
  | "ended";

export type StemKind = "instrumental" | "vocals" | "drums" | "bass" | "other";

export type LiveRoomParticipant = {
  role: "host" | "guest";
  label: string;
  href?: string;
  avatarSrc?: string;
};

export interface PostCardEventPlace {
  label: string;
  address?: string;
  lat: number;
  lon: number;
  source: "geoapify" | "manual";
  providerPlaceId?: string;
  countryCode?: string;
  city?: string;
}

export type PostCardContent =
  | { type: "text"; body: string }
  | { type: "image"; src: string; alt: string; caption?: string }
  | {
      type: "video";
      src: string;
      aspectRatio?: number;
      posterSrc?: string;
      title: string;
      caption?: string;
      accessMode: "public" | "locked";
      listingMode: "listed" | "not_listed";
      listingStatus?: "active";
      priceLabel?: string;
      hasEntitlement: boolean;
      onBuy?: () => void;
      playbackState: PlaybackState;
      rightsBasis?: "derivative";
      upstreamAttributions?: object[];
    }
  | {
      type: "link";
      href: string;
      body?: string;
      linkLabel: string;
      previewTitle?: string;
      previewImageSrc?: string;
    }
  | {
      type: "embed";
      body?: string;
      canonicalUrl: string;
      originalUrl: string;
      preview: object;
      oembedHtml?: string | null;
      provider: "x" | "youtube";
      renderMode: "official" | "preview";
      state: "embed" | "preview" | "unavailable";
    }
  | {
      type: "song";
      title: string;
      caption?: string;
      artworkSrc?: string;
      accessMode: "public" | "locked";
      listingMode: "listed" | "not_listed";
      listingStatus?: "active";
      priceLabel?: string;
      hasEntitlement: boolean;
      karaoke?: object | null;
      study?: object | null;
      downloadPolicy?: "free_download" | "purchased_download";
      onBuy?: () => void;
      onDownload?: () => void;
      stems?: object[];
      entitledStems?: StemKind[];
      vinylRelease?: object;
      onPause?: () => void;
      onPlay?: () => void;
      onSeek?: (progressMs: number) => void;
      playbackState: PlaybackState;
      progressMs?: number;
      durationMs?: number;
    }
  | {
      type: "generic_asset";
      assetId: string;
      assetKind: "download_file";
      communityId: string;
      title: string;
      filename?: string | null;
      mimeType?: string | null;
      sizeBytes?: number | null;
      accessMode: "public" | "locked";
      listingMode: "listed" | "not_listed";
      listingStatus?: "active";
      priceLabel?: string;
      hasEntitlement: boolean;
      onBuy?: () => void;
      onDownload?: () => void;
    }
  | {
      type: "live_room";
      liveRoomId: string;
      title: string;
      description?: string;
      coverSrc?: string;
      roomKind: "solo" | "duet";
      status: "scheduled" | "live" | "ended" | "canceled";
      accessMode: "free" | "gated" | "paid";
      visibility: "public" | "unlisted";
      accessState?: "purchase_required" | "waiting";
      concertHref: string;
      onWatch?: () => void;
      startsAtLabel?: string;
      setlistPreview?: object[];
      listingMode: "listed" | "not_listed";
      listingStatus?: "active";
      onBuy?: () => void;
      priceLabel?: string;
      hasEntitlement: boolean;
      participants?: LiveRoomParticipant[];
    };

export interface PostCardProps {
  event?: {
    address?: string;
    endsAt?: string;
    eventUrl?: string;
    isOnline?: boolean;
    locationName?: string;
    startsAt: string;
    status: "scheduled" | "canceled" | "postponed" | "ended";
    timezone: string;
    place?: PostCardEventPlace;
  };
}
