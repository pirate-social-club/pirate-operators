// Domain-aligned types ported from the React post-composer
// (post-composer.types.ts). Differences from the React source:
// - `ComposerEventPlace` aliases the B7a post-card `PostCardEventPlace`
//   instead of the React post-card types module.
// - `AnonymousIdentityScope` is not re-exported; nothing in the ported
//   surface consumes it.
// - Locale-driven copy is a typed `ComposerCopy` (see copy.ts) instead of the
//   React `@/locales` routes catalog, so stories stay deterministic and
//   offline.

import type { JSX } from "@solidjs/web";

import type { PostCardEventPlace } from "./post-card-preview-types.ts";

export type ComposerTab =
  | "text"
  | "image"
  | "video"
  | "link"
  | "song"
  | "live"
  | "file";

export type AttachmentKind =
  | "link"
  | "image"
  | "video"
  | "song"
  | "live"
  | "file";
export type ComposerToolbarAction = AttachmentKind | "event";

/**
 * What a host surface declares it supports. Every tab is a capability, and
 * `event` is one too even though it overlays the text tab rather than owning
 * a tab of its own.
 */
export type ComposerCapability = ComposerTab | "event";

export type AttachmentState =
  | { kind: "link"; url: string }
  | { kind: "image"; label: string; previewUrl?: string }
  | {
      aspectRatio?: number;
      kind: "video";
      label: string;
      posterUrl?: string;
      previewUrl?: string;
    }
  | { kind: "song"; artworkUrl?: string; label: string; previewUrl?: string }
  | { kind: "live" }
  | { kind: "file"; label: string }
  | null;

type ComposerUploadValue = { name: string; previewUrl?: string } | null;

export interface VideoDetailsState {
  posterFrameSeconds: string;
  thumbnail: ComposerUploadValue;
}

export type SongMode = "original" | "remix";

export type AssetLicensePresetId =
  | "non-commercial"
  | "commercial-use"
  | "commercial-remix";

export type LiveRoomKind = "solo" | "duet";

type LiveAccessMode = "free" | "gated" | "paid";

type LiveAudienceGateMode = "community_members" | "purchase_entitlement";

type LiveVisibility = "public" | "unlisted";

type PostAudience = "public" | "members_only";
export type AuthorAgeGatePolicy = "none" | "18_plus";

type LiveSetlistItemKind =
  | "original"
  | "cover"
  | "remix"
  | "dj_playback"
  | "unknown";

interface LivePerformerAllocation {
  userId: string;
  role: "host" | "guest";
  sharePct: number;
}

type DerivativeTrigger = "remix" | "declaration" | "uses_song";

export type IdentityMode = "public" | "anonymous";
export type AuthorMode = "human" | "agent";

interface QualifierOption {
  qualifierId: string;
  label: string;
  description?: string;
  sensitivityLevel?: "low" | "high";
  sourceProvider?: "self" | "very" | "world";
  sourceField?: string;
  redundancyKey?: string;
  suppressedByClubGate?: boolean;
  suppressionReason?: string;
}

export interface ComposerReference {
  id: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  licensePreset?: AssetLicensePresetId | null;
  upstreamRoyaltyPct?: number | null;
  parentIpId?: string | null;
  licenseTermsId?: string | null;
}

/** A person the host offers for the earnings split, named for display only. */
export interface ComposerRecipientProfile {
  personaId: string;
  displayName: string;
  handle?: string | null;
  avatarSrc?: string | null;
}

export interface LiveSetlistItemInput {
  titleText: string;
  artistText?: string;
  declaredTrackId?: string;
  performanceKind: LiveSetlistItemKind;
}

export interface LiveComposerState {
  roomKind: LiveRoomKind;
  accessMode: LiveAccessMode;
  audienceGateMode?: LiveAudienceGateMode;
  audienceGateTargetRefs?: string[];
  visibility: LiveVisibility;
  scheduleForLater?: boolean;
  scheduleAt?: string;
  description?: string;
  guestUserId?: string;
  storeUrl?: string;
  storeLabel?: string;
  coverUpload?: File | null;
  coverLabel?: string;
  recordingEnabled?: boolean;
  trackOptions?: ComposerReference[];
  setlistItems: LiveSetlistItemInput[];
  setlistStatus: "draft" | "ready" | "locked";
  performerAllocations: LivePerformerAllocation[];
}

export type ComposerEventPlace = PostCardEventPlace;

export interface ComposerEventState {
  enabled?: boolean;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  locationName?: string;
  address?: string;
  isOnline?: boolean;
  eventUrl?: string;
  place?: ComposerEventPlace;
}

interface DerivativeLicenseSummary {
  sourceLicense?: string;
  upstreamRoyaltyPct?: number;
  parentIpId?: string;
  licenseTermsId?: string;
  newRemixTerms?: string;
}

export interface DerivativeStepState {
  visible: boolean;
  required?: boolean;
  trigger: DerivativeTrigger;
  query?: string;
  references?: ComposerReference[];
  searchResults?: ComposerReference[];
  searchError?: string;
  searchLoading?: boolean;
  requirementLabel?: string;
  licenseSummary?: DerivativeLicenseSummary;
  sourceTermsAccepted?: boolean;
}

export interface LinkPreviewState {
  domain: string;
  description?: string;
  title?: string;
  imageSrc?: string;
  provider?: "x" | "youtube" | "kalshi" | "polymarket" | null;
  canonicalUrl?: string;
  originalUrl?: string;
  state?: "embed" | "preview" | "unavailable";
  embedPreview?: {
    authorName?: string | null;
    authorUrl?: string | null;
    text?: string | null;
    hasMedia?: boolean | null;
    mediaUrl?: string | null;
    thumbnailUrl?: string | null;
    thumbnailWidth?: number | null;
    thumbnailHeight?: number | null;
  };
  oembedHtml?: string | null;
}

export interface SongComposerState {
  title?: string;
  lyricsEditorState?: "hidden" | "ready" | "no_lyrics";
  detectedLanguage?: string;
  detectedExplicitness?:
    | "not_explicit"
    | "explicit"
    | "no_lyrics"
    | "uncertain"
    | "unavailable";
  genre?: string;
  geniusAnnotationsUrl?: string;
  primaryLanguage?: string;
  secondaryLanguage?: string;
  primaryAudioUpload?: File | null;
  primaryAudioLabel?: string;
  coverUpload?: File | null;
  coverLabel?: string;
  coverSource?: "embedded" | "upload";
  previewStartSeconds?: string;
  canvasVideoUpload?: File | null;
  canvasVideoLabel?: string;
  instrumentalAudioUpload?: File | null;
  instrumentalAudioLabel?: string;
  vocalAudioUpload?: File | null;
  vocalAudioLabel?: string;
}

export interface AssetLicenseState {
  presetId: AssetLicensePresetId;
  commercialRevShareBps?: number;
  /** @deprecated Story fixture compatibility only; never serialized. */
  commercialRevSharePct?: number;
}

export interface AssetRoyaltyAllocation {
  id: string;
  recipientKind: "creator" | "collaborator";
  recipientId?: string;
  shareBps?: number;
  /** @deprecated Story fixture compatibility only; never serialized. */
  walletAddress?: string;
  /** @deprecated Story fixture compatibility only; never serialized. */
  sharePct: number;
}

export interface AssetRoyaltySplitState {
  allocations: AssetRoyaltyAllocation[];
}

export interface VideoComposerState {
  primaryVideoAspectRatio?: number;
  primaryVideoUpload?: File | null;
  primaryVideoLabel?: string;
  posterFrameSeconds?: string;
}

export interface DownloadFileComposerState {
  upload: File | null;
  label?: string;
}

export interface MonetizationState {
  visible: boolean;
  priceLabel?: string;
  priceUsd?: string;
  regionalPricingAvailable?: boolean;
  regionalPricingEnabled?: boolean;
  vinylReleaseUrl?: string;
}

export interface RegionalPricingTierPreview {
  tierKey: string;
  displayName: string;
  adjustmentType: "multiplier";
  adjustmentValue: number;
  countryCodes: string[];
}

export interface RegionalPricingPreview {
  defaultTierKey?: string | null;
  tiers: RegionalPricingTierPreview[];
}

export interface CharityContributionState {
  percentagePct: number;
  userConfigured?: boolean;
}

export interface CommunityCharityPartner {
  partnerId: string;
  displayName: string;
  imageUrl?: string | null;
}

export interface ComposerAudienceState {
  visibility: PostAudience;
  publicOptionEnabled?: boolean;
  publicOptionDisabledReason?: string;
}

/** One active public persona the author may post as. */
export interface ComposerPublicPersona {
  personaId: string;
  handle?: string;
  displayName?: string;
  avatarSrc?: string | null;
}

export interface ComposerIdentityState {
  visible?: boolean;
  allowAnonymousIdentity?: boolean;
  allowQualifiersOnAnonymousPosts?: boolean;
  identityMode?: IdentityMode;
  authorMode?: AuthorMode;
  /** Active public personas; absent means the single `publicHandle` identity. */
  publicPersonas?: readonly ComposerPublicPersona[];
  publicHandle?: string;
  publicAvatarSrc?: string | null;
  publicAvatarSeed?: string | null;
  realNameLabel?: string;
  reputationLabel?: string;
  anonymousLabel?: string;
  anonymousDescription?: string;
  agentLabel?: string;
  availableQualifiers?: QualifierOption[];
  selectedQualifierIds?: string[];
  helpText?: string;
}

interface PostComposerDraftState {
  mode: ComposerTab;
  titleValue?: string;
  titleCountLabel?: string;
  textBodyValue?: string;
  captionValue?: string;
  imageUpload?: File | null;
  imageUploadLabel?: string;
  video?: VideoComposerState;
  lyricsValue?: string;
  linkUrlValue?: string;
  linkPreview?: LinkPreviewState;
  songMode?: SongMode;
  song?: SongComposerState;
  license?: AssetLicenseState;
  royaltySplit?: AssetRoyaltySplitState;
  derivativeStep?: DerivativeStepState;
  monetization?: MonetizationState;
  charityPartner?: CommunityCharityPartner | null;
  charityContribution?: CharityContributionState;
  audience?: ComposerAudienceState;
  ageGatePolicy?: AuthorAgeGatePolicy;
  identity?: ComposerIdentityState;
  live?: LiveComposerState;
  event?: ComposerEventState;
  file?: DownloadFileComposerState;
  regionalPricingPreview?: RegionalPricingPreview | null;
}

interface PostComposerDraftActions {
  onCaptionValueChange?: (value: string) => void;
  onImageUploadChange?: (file: File | null) => void;
  onTextBodyValueChange?: (value: string) => void;
  onTitleValueChange?: (value: string) => void;
  onLyricsValueChange?: (value: string) => void;
  onLinkUrlValueChange?: (value: string) => void;
  onLinkPreviewChange?: (value: LinkPreviewState | undefined) => void;
  onSongChange?: (value: SongComposerState) => void;
  onLicenseChange?: (value: AssetLicenseState) => void;
  onRoyaltySplitChange?: (value: AssetRoyaltySplitState) => void;
  onVideoChange?: (value: VideoComposerState) => void;
  onSongModeChange?: (value: SongMode) => void;
  onModeChange?: (value: ComposerTab) => void;
  onPersonaChange?: (personaId: string) => void;
  onDerivativeStepChange?: (value: DerivativeStepState | undefined) => void;
  onMonetizationChange?: (value: MonetizationState) => void;
  onCharityContributionChange?: (value: CharityContributionState) => void;
  onAudienceChange?: (value: ComposerAudienceState) => void;
  onAgeGatePolicyChange?: (value: AuthorAgeGatePolicy) => void;
  onAuthorModeChange?: (value: AuthorMode) => void;
  onIdentityModeChange?: (value: IdentityMode) => void;
  onSelectedQualifierIdsChange?: (value: string[]) => void;
  onLiveChange?: (value: LiveComposerState) => void;
  onEventChange?: (value: ComposerEventState) => void;
  onFileChange?: (value: DownloadFileComposerState) => void;
}

export type SubmitProgressPhase =
  | "validating"
  | "preparing_media"
  | "uploading_media"
  | "processing_media"
  | "checking_rights"
  | "publishing_post"
  | "creating_listing"
  | "checking_registration"
  | "done";

// How the submit progress bar computes its 0→1 fill (see submitProgressFraction):
// - "pipeline": a multi-stage flow (song, video) — fill by completed steps, with a
//   byte-% interpolated within the current step.
// - "activity": a flow dominated by a single upload (image/text/link, live cover,
//   and song posts that reuse a pre-uploaded bundle) — fill directly by the upload's
//   byte-%. Either way the button label is a constant "Posting…".
export type SubmitProgressDisplay = "pipeline" | "activity";

export interface SubmitProgress {
  phase: SubmitProgressPhase;
  label: string;
  detail?: string;
  currentIndex: number;
  totalSteps: number;
  display: SubmitProgressDisplay;
}

interface PostComposerSubmitState {
  canPost?: boolean;
  disabled?: boolean;
  error?: string | null;
  label?: string;
  loading?: boolean;
  onSubmit?: () => void;
  progress?: SubmitProgress | null;
}

export interface SongFlowRuntime {
  readonly personaId?: string;
  readonly prepare: () => Promise<boolean>;
  readonly prepared: boolean;
  readonly audioPrepared?: boolean;
  readonly stems?: { readonly instrumental: boolean; readonly vocals: boolean };
  readonly pendingStems?: {
    readonly instrumental: boolean;
    readonly vocals: boolean;
  };
  readonly retained: boolean;
  readonly locked: boolean;
}

export interface PostComposerProps
  extends Partial<PostComposerDraftState>,
    PostComposerDraftActions {
  /** A community host keeps the song form and navigation in its main column. */
  presentation?: "inline" | "fullscreen";
  /** Where the mobile attachment bar belongs.
   *
   * It defaults to `fixed`: on a page the bar is a viewport-level bottom bar,
   * rendered through a portal so page scrolling does not move it. A host that
   * already owns the viewport — a full-screen dialog — must ask for `inline`
   * instead, because a portalled bar leaves that host's stacking context and
   * lands behind its overlay, where it cannot be tapped. */
  attachmentBarPlacement?: "fixed" | "inline";
  songFlowRuntime?: SongFlowRuntime;
  onVideoEntry?: () => void;
  onClose?: () => void;
  // Community policy: enabling 18+ requires an explicit confirmation step.
  ageGateConfirmationRequired?: boolean;
  // A retained request owns its audience and rating until it is resolved.
  audienceEditingDisabled?: boolean;
  // A retained request or pending dispatch owns authorship until resolved.
  personaSelectionDisabled?: boolean;
  availableCapabilities?: readonly ComposerCapability[];
  canCreateSongPost?: boolean;
  currentPersonaId?: string;
  currentUserWalletAddress?: string;
  draft?: PostComposerDraftState;
  actions?: PostComposerDraftActions;
  submit?: PostComposerSubmitState;
  regionalPricingPreview?: RegionalPricingPreview | null;
  onSearchEventPlaces?: (query: string) => Promise<ComposerEventPlace[]>;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  submitError?: string | null;
  submitLabel?: string;
  submitLoading?: boolean;
  // Set false when a production boundary retains its own validation and error copy.
  validateDraftBeforeSubmit?: boolean;
  // Supports restoring a draft at a known step and focused Storybook review.
  initialSongStep?: 1 | 2 | 3;
  // Named profiles for the earnings split and source-song results. The
  // composer never resolves identities itself; the host supplies display data.
  recipientProfiles?: readonly ComposerRecipientProfile[];
  // Host-owned outcome panels rendered inside the single composer surface.
  // Accessors, not elements: an eagerly-evaluated JSX descriptor held in props
  // keeps live children getters that diagnostics tooling must not execute.
  mediaStatus?: () => JSX.Element;
}
