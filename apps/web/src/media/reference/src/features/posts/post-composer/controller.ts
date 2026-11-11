// Post composer controller: the React use-post-composer-controller.ts hook
// ported to a Solid `create*` factory. The controlled/uncontrolled draft
// resolution, derivative/remix coupling, identity invariants, and live room
// kind transitions all live here so the step components stay thin views.
//
// Differences from the React source:
// - `createIsMobile`/`createUiLocale` became injected options (`isMobile` accessor);
//   copy comes from ./copy (the Solid locale catalogs have no createPost
//   namespace).
// - Uncontrolled draft slices are signals; controlled slices read props
//   directly, matching React's `controlled ?? uncontrolled` resolution.

import {
  createEffect,
  createMemo,
  createSignal,
  type Accessor,
} from "solid-js";

import {
  buildComposerTabLabels,
  defaultComposerCopy,
  type ComposerCopy,
} from "./copy.ts";
import {
  defaultAssetLicenseState,
  defaultAssetRoyaltySplitState,
  defaultAudienceState,
  defaultCharityContributionState,
  defaultCharityContributionPct,
  defaultDownloadFileState,
  defaultEventState,
  defaultLiveComposerState,
  defaultMonetizationState,
  defaultSongState,
  defaultCapabilities,
  defaultVideoState,
} from "./defaults.ts";
import { createComposerCapabilitySet } from "./capability.ts";
import {
  deriveLiveStateForRoomKindChange,
  shouldClearSelectedQualifiers,
  shouldForcePublicIdentityForAuthor,
  shouldForcePublicIdentityForTab,
} from "./invariants.ts";
import { canAdvanceComposerWriteStep } from "./utils.ts";
import { deriveDerivativeSearchResults } from "./reference-model.ts";
import type {
  AssetLicenseState,
  AssetRoyaltySplitState,
  AuthorAgeGatePolicy,
  AuthorMode,
  CharityContributionState,
  ComposerAudienceState,
  ComposerCapability,
  ComposerEventState,
  ComposerIdentityState,
  ComposerTab,
  ComposerToolbarAction,
  DerivativeStepState,
  DownloadFileComposerState,
  IdentityMode,
  LinkPreviewState,
  LiveComposerState,
  LiveRoomKind,
  MonetizationState,
  PostComposerProps,
  SongComposerState,
  SongMode,
  VideoComposerState,
} from "./types.ts";

export interface PostComposerControllerOptions {
  isMobile: Accessor<boolean>;
  copy?: ComposerCopy;
}

function deriveSelectedQualifierIds(identity: ComposerIdentityState): string[] {
  return identity.selectedQualifierIds ?? [];
}

export function createPostComposerController(
  props: PostComposerProps,
  options: PostComposerControllerOptions,
) {
  const copy = options.copy ?? defaultComposerCopy;
  const isMobile = options.isMobile;
  const actions = () => props.actions;
  const draft = () => props.draft;
  const submit = () => props.submit;

  const canCreateSongPost = () => props.canCreateSongPost ?? false;
  // The one capability boundary. Tabs, toolbar actions, file inputs, drag and
  // drop, and programmatic tab changes all resolve through this set, so an
  // undeclared kind has no entrance left open.
  const capabilities = () =>
    createComposerCapabilitySet(
      props.availableCapabilities ?? defaultCapabilities,
      { canCreateSongPost: canCreateSongPost() },
    );
  const mode = () => draft()?.mode ?? props.mode ?? "text";
  const providedTitleValue = () =>
    draft()?.titleValue ?? props.titleValue ?? "";
  const providedTextBodyValue = () =>
    draft()?.textBodyValue ?? props.textBodyValue ?? "";
  const providedCaptionValue = () =>
    draft()?.captionValue ?? props.captionValue ?? "";
  const imageUpload = () =>
    draft()?.imageUpload !== undefined
      ? draft()?.imageUpload
      : props.imageUpload;
  const imageUploadLabel = () =>
    draft()?.imageUploadLabel ?? props.imageUploadLabel;
  const providedLyricsValue = () =>
    draft()?.lyricsValue ?? props.lyricsValue ?? "";
  const providedLinkUrlValue = () =>
    draft()?.linkUrlValue ?? props.linkUrlValue ?? "";
  const providedLinkPreview = () => draft()?.linkPreview ?? props.linkPreview;
  const songMode = () => draft()?.songMode ?? props.songMode;
  const song = () => draft()?.song ?? props.song;
  const license = () => draft()?.license ?? props.license;
  const royaltySplit = () => draft()?.royaltySplit ?? props.royaltySplit;
  const video = () => draft()?.video ?? props.video;
  const derivativeStep = () => draft()?.derivativeStep ?? props.derivativeStep;
  const monetization = () => draft()?.monetization ?? props.monetization;
  const regionalPricingPreview = () =>
    draft()?.regionalPricingPreview ?? props.regionalPricingPreview;
  const charityPartner = () => draft()?.charityPartner ?? props.charityPartner;
  const charityContribution = () =>
    draft()?.charityContribution ?? props.charityContribution;
  const audience = () => draft()?.audience ?? props.audience;
  const ageGatePolicy = () => draft()?.ageGatePolicy ?? props.ageGatePolicy;
  const identity = () => draft()?.identity ?? props.identity;
  const live = () => draft()?.live ?? props.live;
  const event = () => draft()?.event ?? props.event;
  const fileProp = () => draft()?.file ?? props.file;

  const onTitleValueChange = () =>
    actions()?.onTitleValueChange ?? props.onTitleValueChange;
  const onTextBodyValueChange = () =>
    actions()?.onTextBodyValueChange ?? props.onTextBodyValueChange;
  const onCaptionValueChange = () =>
    actions()?.onCaptionValueChange ?? props.onCaptionValueChange;
  const onImageUploadChange = () =>
    actions()?.onImageUploadChange ?? props.onImageUploadChange;
  const onLyricsValueChange = () =>
    actions()?.onLyricsValueChange ?? props.onLyricsValueChange;
  const onLinkUrlValueChange = () =>
    actions()?.onLinkUrlValueChange ?? props.onLinkUrlValueChange;
  const onLinkPreviewChange = () =>
    actions()?.onLinkPreviewChange ?? props.onLinkPreviewChange;
  const onSongChange = () => actions()?.onSongChange ?? props.onSongChange;
  const onLicenseChange = () =>
    actions()?.onLicenseChange ?? props.onLicenseChange;
  const onRoyaltySplitChange = () =>
    actions()?.onRoyaltySplitChange ?? props.onRoyaltySplitChange;
  const onVideoChange = () => actions()?.onVideoChange ?? props.onVideoChange;
  const onSongModeChange = () =>
    actions()?.onSongModeChange ?? props.onSongModeChange;
  const onModeChange = () => actions()?.onModeChange ?? props.onModeChange;
  const onPersonaChange = () =>
    actions()?.onPersonaChange ?? props.onPersonaChange;
  const onDerivativeStepChange = () =>
    actions()?.onDerivativeStepChange ?? props.onDerivativeStepChange;
  const onMonetizationChange = () =>
    actions()?.onMonetizationChange ?? props.onMonetizationChange;
  const onCharityContributionChange = () =>
    actions()?.onCharityContributionChange ?? props.onCharityContributionChange;
  const onAudienceChange = () =>
    actions()?.onAudienceChange ?? props.onAudienceChange;
  const onAgeGatePolicyChange = () =>
    actions()?.onAgeGatePolicyChange ?? props.onAgeGatePolicyChange;
  const onAuthorModeChange = () =>
    actions()?.onAuthorModeChange ?? props.onAuthorModeChange;
  const onIdentityModeChange = () =>
    actions()?.onIdentityModeChange ?? props.onIdentityModeChange;
  const onSelectedQualifierIdsChange = () =>
    actions()?.onSelectedQualifierIdsChange ??
    props.onSelectedQualifierIdsChange;
  const onLiveChange = () => actions()?.onLiveChange ?? props.onLiveChange;
  const onEventChange = () => actions()?.onEventChange ?? props.onEventChange;
  const onFileChange = () => actions()?.onFileChange ?? props.onFileChange;

  const onSubmit = () => submit()?.onSubmit ?? props.onSubmit;
  const baseSubmitDisabled = () =>
    submit()?.disabled ?? props.submitDisabled ?? false;
  const basePostDisabled = () =>
    submit()?.canPost === undefined ? baseSubmitDisabled() : !submit()?.canPost;
  const submitError = () => submit()?.error ?? props.submitError ?? null;
  const submitLabel = () => submit()?.label ?? props.submitLabel;
  const submitLoading = () => submit()?.loading ?? props.submitLoading ?? false;
  const submitProgress = () => submit()?.progress ?? null;

  const visibleTabs = () => capabilities().tabs;

  // These signals synchronize controlled props from effect apply phases.
  const [activeTab, setActiveTab] = createSignal<ComposerTab>(
    visibleTabs()[0] ?? "text",
    { ownedWrite: true },
  );
  const [uncontrolledTitleValue, setUncontrolledTitleValue] = createSignal(
    providedTitleValue(),
    { ownedWrite: true },
  );
  const [uncontrolledTextBodyValue, setUncontrolledTextBodyValue] =
    createSignal(providedTextBodyValue(), { ownedWrite: true });
  const [uncontrolledCaptionValue, setUncontrolledCaptionValue] = createSignal(
    providedCaptionValue(),
    { ownedWrite: true },
  );
  const [uncontrolledLyricsValue, setUncontrolledLyricsValue] = createSignal(
    providedLyricsValue(),
    { ownedWrite: true },
  );
  const [uncontrolledLinkUrlValue, setUncontrolledLinkUrlValue] = createSignal(
    providedLinkUrlValue(),
    { ownedWrite: true },
  );
  const [uncontrolledLinkPreview, setUncontrolledLinkPreview] = createSignal(
    props.linkPreview,
    { ownedWrite: true },
  );
  const [uncontrolledSongMode, setUncontrolledSongMode] =
    createSignal<SongMode>(songMode() ?? "original");
  const [uncontrolledSongState, setUncontrolledSongState] =
    createSignal<SongComposerState>(defaultSongState(song()));
  const [uncontrolledLicenseState, setUncontrolledLicenseState] =
    createSignal<AssetLicenseState>(defaultAssetLicenseState(license()));
  const [uncontrolledRoyaltySplitState, setUncontrolledRoyaltySplitState] =
    createSignal<AssetRoyaltySplitState>(
      defaultAssetRoyaltySplitState(royaltySplit(), props.currentPersonaId),
      { ownedWrite: true },
    );
  const [uncontrolledVideoState, setUncontrolledVideoState] =
    createSignal<VideoComposerState>(defaultVideoState(video()));
  const [uncontrolledImageUpload, setUncontrolledImageUpload] =
    createSignal<File | null>(imageUpload() ?? null);
  const [identityMode, setIdentityMode] = createSignal<IdentityMode>(
    identity()?.identityMode ?? "public",
    { ownedWrite: true },
  );
  const [authorMode, setAuthorMode] = createSignal<AuthorMode>(
    identity()?.authorMode ?? "human",
    { ownedWrite: true },
  );
  const [selectedQualifierIds, setSelectedQualifierIds] = createSignal<
    string[]
  >(identity() ? deriveSelectedQualifierIds(identity()!) : [], {
    ownedWrite: true,
  });
  const [uncontrolledMonetizationState, setUncontrolledMonetizationState] =
    createSignal<MonetizationState>(defaultMonetizationState(monetization()));
  const [uncontrolledCharityContribution, setUncontrolledCharityContribution] =
    createSignal<CharityContributionState>(
      defaultCharityContributionState(charityContribution()),
      { ownedWrite: true },
    );
  const [uncontrolledAudienceState, setUncontrolledAudienceState] =
    createSignal<ComposerAudienceState>(defaultAudienceState(audience()));
  const [uncontrolledAgeGatePolicy, setUncontrolledAgeGatePolicy] =
    createSignal<AuthorAgeGatePolicy>(ageGatePolicy() ?? "none");
  const [uncontrolledDerivativeState, setUncontrolledDerivativeState] =
    createSignal<DerivativeStepState | undefined>(derivativeStep());
  const [derivativePickerKey, setDerivativePickerKey] = createSignal(0, {
    ownedWrite: true,
  });
  const [liveState, setLiveState] = createSignal<LiveComposerState>(
    defaultLiveComposerState(live()),
    { ownedWrite: true },
  );
  const [eventState, setEventState] = createSignal<ComposerEventState>(
    defaultEventState(event()),
    { ownedWrite: true },
  );
  const [prevRoomKind, setPrevRoomKind] = createSignal<LiveRoomKind>(
    liveState().roomKind,
    { ownedWrite: true },
  );
  const [uncontrolledFileState, setUncontrolledFileState] =
    createSignal<DownloadFileComposerState>(
      defaultDownloadFileState(fileProp()),
    );

  const titleValue = () =>
    onTitleValueChange() ? providedTitleValue() : uncontrolledTitleValue();
  const textBodyValue = () =>
    onTextBodyValueChange()
      ? providedTextBodyValue()
      : uncontrolledTextBodyValue();
  const captionValue = () =>
    onCaptionValueChange()
      ? providedCaptionValue()
      : uncontrolledCaptionValue();
  const lyricsValue = () =>
    onLyricsValueChange() ? providedLyricsValue() : uncontrolledLyricsValue();
  const linkUrlValue = () =>
    onLinkUrlValueChange()
      ? providedLinkUrlValue()
      : uncontrolledLinkUrlValue();
  const linkPreview = () =>
    onLinkPreviewChange() ? providedLinkPreview() : uncontrolledLinkPreview();
  const activeSongMode = () => songMode() ?? uncontrolledSongMode();
  const activeImageUpload = () =>
    imageUpload() === undefined ? uncontrolledImageUpload() : imageUpload();
  const songState = () => song() ?? uncontrolledSongState();
  const licenseState = () => license() ?? uncontrolledLicenseState();
  const royaltySplitState = () =>
    royaltySplit() ?? uncontrolledRoyaltySplitState();
  const videoState = () => video() ?? uncontrolledVideoState();
  const monetizationState = () =>
    monetization() ?? uncontrolledMonetizationState();
  const charityContributionState = () =>
    charityContribution() ?? uncontrolledCharityContribution();
  const audienceState = () => audience() ?? uncontrolledAudienceState();
  const ageGatePolicyState = () =>
    ageGatePolicy() ?? uncontrolledAgeGatePolicy();
  const derivativeState = () =>
    derivativeStep() ?? uncontrolledDerivativeState();
  const fileState = () => fileProp() ?? uncontrolledFileState();

  const setSongModeWithCallback = (next: SongMode) => {
    if (songMode() === undefined) {
      setUncontrolledSongMode(next);
    }
    onSongModeChange()?.(next);
  };

  const setIdentityModeWithCallback = (next: IdentityMode) => {
    setIdentityMode(next);
    onIdentityModeChange()?.(next);
  };

  const setAuthorModeWithCallback = (next: AuthorMode) => {
    setAuthorMode(next);
    onAuthorModeChange()?.(next);
  };

  // Selecting a public persona row sets the real operation persona id, which
  // the host feeds into request envelopes, retained drafts, and royalty
  // defaults. It is an authorship choice, not a cosmetic identity mode.
  const selectPublicPersona = (personaId: string) => {
    setAuthorMode("human");
    setIdentityMode("public");
    onPersonaChange()?.(personaId);
  };

  const setSelectedQualifierIdsWithCallback = (next: string[]) => {
    setSelectedQualifierIds(next);
    onSelectedQualifierIdsChange()?.(next);
  };

  const updateSongState = (
    updater: (current: SongComposerState) => SongComposerState,
  ) => {
    const next = updater(songState());
    if (song() === undefined) {
      setUncontrolledSongState(next);
    }
    onSongChange()?.(next);
  };

  const updateLicenseState = (
    updater: (current: AssetLicenseState) => AssetLicenseState,
  ) => {
    const next = updater(licenseState());
    if (license() === undefined) {
      setUncontrolledLicenseState(next);
    }
    onLicenseChange()?.(next);
  };

  const updateRoyaltySplitState = (
    updater: (current: AssetRoyaltySplitState) => AssetRoyaltySplitState,
  ) => {
    const next = updater(royaltySplitState());
    if (royaltySplit() === undefined) {
      setUncontrolledRoyaltySplitState(next);
    }
    onRoyaltySplitChange()?.(next);
  };

  const updateVideoState = (
    updater: (current: VideoComposerState) => VideoComposerState,
  ) => {
    const next = updater(videoState());
    if (video() === undefined) {
      setUncontrolledVideoState(next);
    }
    onVideoChange()?.(next);
  };

  const setImageUploadWithCallback = (next: File | null) => {
    if (imageUpload() === undefined) {
      setUncontrolledImageUpload(next);
    }
    onImageUploadChange()?.(next);
  };

  const setTitleValueWithCallback = (next: string) => {
    if (!onTitleValueChange()) {
      setUncontrolledTitleValue(next);
    }
    onTitleValueChange()?.(next);
  };

  const setTextBodyValueWithCallback = (next: string) => {
    if (!onTextBodyValueChange()) {
      setUncontrolledTextBodyValue(next);
    }
    onTextBodyValueChange()?.(next);
  };

  const setCaptionValueWithCallback = (next: string) => {
    if (!onCaptionValueChange()) {
      setUncontrolledCaptionValue(next);
    }
    onCaptionValueChange()?.(next);
  };

  const setLyricsValueWithCallback = (next: string) => {
    if (!onLyricsValueChange()) {
      setUncontrolledLyricsValue(next);
    }
    onLyricsValueChange()?.(next);
  };

  const setLinkUrlValueWithCallback = (next: string) => {
    if (!onLinkUrlValueChange()) {
      setUncontrolledLinkUrlValue(next);
    }
    onLinkUrlValueChange()?.(next);
  };

  const setLinkPreviewWithCallback = (next: LinkPreviewState | undefined) => {
    if (!onLinkPreviewChange()) {
      setUncontrolledLinkPreview(next);
    }
    onLinkPreviewChange()?.(next);
  };

  const updateDerivativeState = (
    updater: (
      current: DerivativeStepState | undefined,
    ) => DerivativeStepState | undefined,
  ) => {
    const next = updater(derivativeState());
    setUncontrolledDerivativeState(next);
    onDerivativeStepChange()?.(next);
  };

  const handleSongModeChange = (next: SongMode) => {
    setSongModeWithCallback(next);
    if (next === "remix") {
      updateDerivativeState((current) => {
        if (current && current.trigger !== "remix") return current;
        return {
          visible: true,
          required: true,
          trigger: "remix",
          searchResults: current?.searchResults ?? [],
          searchError: undefined,
          references: current?.references ?? [],
          sourceTermsAccepted: current?.sourceTermsAccepted === true,
        };
      });
    } else {
      updateDerivativeState((current) => {
        if (current?.trigger === "remix") return undefined;
        return current;
      });
    }
  };

  const activeVideoSourceMode = (): "original" | "uses_song" =>
    activeTab() === "video" &&
    derivativeState()?.visible &&
    derivativeState()?.trigger === "uses_song"
      ? "uses_song"
      : "original";

  const handleVideoSourceModeChange = (next: "original" | "uses_song") => {
    if (next === "uses_song") {
      updateDerivativeState((current) => ({
        visible: true,
        required: true,
        trigger: "uses_song",
        requirementLabel: current?.requirementLabel,
        searchResults: current?.searchResults ?? [],
        searchError: undefined,
        references: current?.references ?? [],
        licenseSummary: current?.licenseSummary,
        sourceTermsAccepted: current?.sourceTermsAccepted === true,
      }));
      return;
    }

    updateDerivativeState((current) => {
      if (current?.trigger === "uses_song") return undefined;
      return current?.visible ? undefined : current;
    });
  };

  const derivativeRequiresRefs = () =>
    Boolean(
      derivativeState()?.visible &&
        (derivativeState()?.required ||
          (activeTab() === "video" &&
            derivativeState()?.trigger === "uses_song")),
    );
  const derivativeMissingRefs = () =>
    Boolean(derivativeRequiresRefs() && !derivativeState()?.references?.length);
  const derivativeHasReferences = () =>
    (derivativeState()?.references?.length ?? 0) > 0;
  const derivativeMissingSourceTermsAcceptance = () =>
    Boolean(
      derivativeState()?.visible &&
        (derivativeRequiresRefs() || derivativeHasReferences()) &&
        derivativeHasReferences() &&
        derivativeState()?.sourceTermsAccepted !== true,
    );
  const contentBlocked = () =>
    derivativeMissingRefs() || derivativeMissingSourceTermsAcceptance();
  const draftCanSubmit = () =>
    canAdvanceComposerWriteStep({
      body: textBodyValue(),
      imageUploadPresent: Boolean(activeImageUpload()),
      linkUrl: linkUrlValue(),
      liveState: liveState(),
      mode: activeTab(),
      songAudioUploadPresent: Boolean(songState().primaryAudioUpload),
      title: titleValue(),
      videoUploadPresent: Boolean(
        videoState().primaryVideoUpload ||
          videoState().primaryVideoLabel?.trim(),
      ),
      fileUploadPresent: Boolean(fileState().upload),
    });
  const songTitleMissing = () =>
    activeTab() === "song" && !songState().title?.trim();
  const songGenreMissing = () => false;
  const songLanguageMissing = () => false;
  const songAudioMissing = () =>
    activeTab() === "song" &&
    props.songFlowRuntime?.prepared !== true &&
    !songState().primaryAudioUpload &&
    !songState().primaryAudioLabel?.trim();
  const ageGateConfirmationPending = () =>
    props.ageGateConfirmationRequired === true &&
    ageGatePolicyState() !== "18_plus";
  const requiresPostSheet = () =>
    Boolean(ageGateConfirmationPending() || songTitleMissing());
  const postDisabled = () =>
    basePostDisabled() ||
    (props.validateDraftBeforeSubmit !== false &&
      (contentBlocked() ||
        songAudioMissing() ||
        (activeTab() !== "song" &&
          activeTab() !== "live" &&
          !draftCanSubmit()) ||
        (activeTab() === "live" && !draftCanSubmit())));

  const updateMonetizationState = (
    updater: (current: MonetizationState) => MonetizationState,
  ) => {
    const next = updater(monetizationState());
    if (monetization() === undefined) {
      setUncontrolledMonetizationState(next);
    }
    onMonetizationChange()?.(next);
  };

  const updateCharityContributionState = (
    updater: (current: CharityContributionState) => CharityContributionState,
  ) => {
    const next = {
      ...updater(charityContributionState()),
      userConfigured: true,
    };
    if (charityContribution() === undefined) {
      setUncontrolledCharityContribution(next);
    }
    onCharityContributionChange()?.(next);
  };

  const updateAudienceState = (
    updater: (current: ComposerAudienceState) => ComposerAudienceState,
  ) => {
    if (props.audienceEditingDisabled === true) return;
    const next = updater(audienceState());
    if (audience() === undefined) {
      setUncontrolledAudienceState(next);
    }
    onAudienceChange()?.(next);
  };

  const setAgeGatePolicyWithCallback = (next: AuthorAgeGatePolicy) => {
    if (props.audienceEditingDisabled === true) return;
    if (ageGatePolicy() === undefined) {
      setUncontrolledAgeGatePolicy(next);
    }
    onAgeGatePolicyChange()?.(next);
  };

  const setLiveStateWithCallback = (next: LiveComposerState) => {
    setLiveState(next);
    onLiveChange()?.(next);
  };

  // The single read of event state, so nothing reaches a surface that cannot
  // submit it. This covers the entrances a write guard cannot: an initial
  // `event: { enabled: true }` prop, a controlled update pushed by the host,
  // and a declaration that later stops granting `event`.
  const grantedEventState = createMemo(() => {
    const next = eventState();
    return next.enabled && !capabilities().allows("event")
      ? { ...next, enabled: false }
      : next;
  });

  const setEventStateWithCallback = (next: ComposerEventState) => {
    // A surface that never declared `event` must not be able to hold event
    // data: the text submission contract does not carry it, so accepting the
    // state here would publish a post with the date and place dropped.
    if (next.enabled && !capabilities().allows("event")) return;
    setEventState(next);
    onEventChange()?.(next);
  };

  const setFileWithCallback = (next: DownloadFileComposerState) => {
    if (fileProp() === undefined) {
      setUncontrolledFileState(next);
    }
    onFileChange()?.(next);
  };

  // --- Effects (prop sync + invariants), ported from the React useEffects. ---

  // The public persona id may arrive after mount. Keep the untouched creator
  // allocation bound to recipient identity; payout wallets are never input.
  createEffect(
    () => [props.currentPersonaId, royaltySplit()] as const,
    ([personaId, controlledSplit]) => {
      if (controlledSplit !== undefined) return;
      const current = uncontrolledRoyaltySplitState();
      if (current.allocations.length !== 1) return;
      const [creator] = current.allocations;
      if (!creator || creator.recipientKind !== "creator") return;
      if ((creator.recipientId ?? "") === (personaId ?? "")) return;
      setUncontrolledRoyaltySplitState({
        allocations: [{ ...creator, recipientId: personaId }],
      });
    },
  );

  // Default the charity contribution when a partner appears and the user has
  // not configured one yet.
  createEffect(
    () => [charityPartner(), charityContributionState()] as const,
    ([partner, contribution]) => {
      if (
        !partner ||
        contribution.userConfigured ||
        contribution.percentagePct > 0
      ) {
        return;
      }
      const next = {
        ...contribution,
        percentagePct: defaultCharityContributionPct,
      };
      if (charityContribution() === undefined) {
        setUncontrolledCharityContribution(next);
      }
      onCharityContributionChange()?.(next);
    },
  );

  // Room-kind transitions rebalance performer allocations.
  createEffect(
    () => [liveState(), prevRoomKind()] as const,
    ([currentLive, previous]) => {
      const nextLiveState = deriveLiveStateForRoomKindChange({
        current: currentLive,
        previousRoomKind: previous,
      });
      if (nextLiveState) {
        setLiveStateWithCallback(nextLiveState);
        setPrevRoomKind(currentLive.roomKind);
      }
    },
  );

  // The requested mode becomes the active tab when it is visible.
  createEffect(
    () => [mode(), visibleTabs()] as const,
    ([requestedMode, tabs]) => {
      if (tabs.includes(requestedMode)) {
        setActiveTab(requestedMode);
        return;
      }
      setActiveTab(tabs[0] ?? "text");
    },
  );

  createEffect(
    () => [onTitleValueChange(), providedTitleValue()] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledTitleValue(value);
    },
  );

  createEffect(
    () => [onTextBodyValueChange(), providedTextBodyValue()] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledTextBodyValue(value);
    },
  );

  createEffect(
    () => [onCaptionValueChange(), providedCaptionValue()] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledCaptionValue(value);
    },
  );

  createEffect(
    () => [onLyricsValueChange(), providedLyricsValue()] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledLyricsValue(value);
    },
  );

  createEffect(
    () => [onLinkUrlValueChange(), providedLinkUrlValue()] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledLinkUrlValue(value);
    },
  );

  createEffect(
    () => [onLinkPreviewChange(), props.linkPreview] as const,
    ([handler, value]) => {
      if (!handler) setUncontrolledLinkPreview(value);
    },
  );

  createEffect(
    () => derivativeStep(),
    () => {
      setDerivativePickerKey(0);
    },
  );

  createEffect(
    () => identity()?.authorMode,
    (next) => {
      setAuthorMode(next ?? "human");
    },
  );

  createEffect(
    () => live(),
    (next) => {
      if (next) setLiveState(next);
    },
  );

  createEffect(
    () => event(),
    (next) => {
      if (next) setEventState(defaultEventState(next));
    },
  );

  createEffect(
    () => identity(),
    (next) => {
      if (!next) return;
      setIdentityMode(next.identityMode ?? "public");
      setSelectedQualifierIds(deriveSelectedQualifierIds(next));
    },
  );

  // Identity invariants: agents and anonymous-ineligible tabs force public.
  createEffect(
    () => [activeTab(), identityMode(), monetizationState().visible] as const,
    ([tab, modeValue, monetizationVisible]) => {
      if (
        shouldForcePublicIdentityForTab({
          activeTab: tab,
          identityMode: modeValue,
          monetizationVisible,
        })
      ) {
        setIdentityModeWithCallback("public");
      }
    },
  );

  createEffect(
    () => [authorMode(), identityMode()] as const,
    ([author, modeValue]) => {
      if (
        shouldForcePublicIdentityForAuthor({
          authorMode: author,
          identityMode: modeValue,
        })
      ) {
        setIdentityModeWithCallback("public");
      }
    },
  );

  createEffect(
    () =>
      [
        authorMode(),
        identity(),
        identityMode(),
        selectedQualifierIds().length,
      ] as const,
    ([author, identityState, modeValue, qualifierCount]) => {
      if (
        shouldClearSelectedQualifiers({
          authorMode: author,
          identity: identityState,
          identityMode: modeValue,
          selectedQualifierCount: qualifierCount,
        })
      ) {
        setSelectedQualifierIdsWithCallback([]);
      }
    },
  );

  const derivativeSearchResults = () =>
    deriveDerivativeSearchResults(derivativeState());
  const shouldShowAssetLicense = () =>
    activeTab() === "song" ||
    (activeTab() === "video" && monetizationState().visible);
  const assetLicenseCopy = () => {
    const tab = activeTab();
    return tab === "song" || tab === "video" ? copy.assetLicense[tab] : null;
  };
  const tabLabels = buildComposerTabLabels(copy);

  return {
    audience: {
      get ageGateConfirmationRequired() {
        return props.ageGateConfirmationRequired === true;
      },
      get editingDisabled() {
        return props.audienceEditingDisabled === true;
      },
      get ageGatePolicy() {
        return ageGatePolicyState();
      },
      setAgeGatePolicy: setAgeGatePolicyWithCallback,
      get state() {
        return audienceState();
      },
      update: updateAudienceState,
    },
    charity: {
      get partner() {
        return charityPartner();
      },
      get state() {
        return charityContributionState();
      },
      update: updateCharityContributionState,
    },
    commerce: {
      get monetizationState() {
        return monetizationState();
      },
      get regionalPricingPreview() {
        return regionalPricingPreview();
      },
      updateMonetizationState,
    },
    copy,
    fields: {
      get captionValue() {
        return captionValue();
      },
      get linkPreview() {
        return linkPreview();
      },
      get linkUrlValue() {
        return linkUrlValue();
      },
      get lyricsValue() {
        return lyricsValue();
      },
      onCaptionValueChange: setCaptionValueWithCallback,
      onLinkPreviewChange: setLinkPreviewWithCallback,
      onLinkUrlValueChange: setLinkUrlValueWithCallback,
      onLyricsValueChange: setLyricsValueWithCallback,
      onTextBodyValueChange: setTextBodyValueWithCallback,
      onTitleValueChange: setTitleValueWithCallback,
      get textBodyValue() {
        return textBodyValue();
      },
      get titleValue() {
        return titleValue();
      },
    },
    identity: {
      get authorMode() {
        return authorMode();
      },
      get identity() {
        return identity();
      },
      get identityMode() {
        return identityMode();
      },
      get personaSelectionDisabled() {
        return props.personaSelectionDisabled === true;
      },
      get publicAvatarSrc() {
        return identity()?.publicAvatarSrc;
      },
      get publicAvatarSeed() {
        return identity()?.publicAvatarSeed;
      },
      get publicPersonaId() {
        return props.currentPersonaId;
      },
      get publicPersonas() {
        return identity()?.publicPersonas;
      },
      get selectedQualifierIds() {
        return selectedQualifierIds();
      },
      selectPublicPersona,
      setAuthorMode: setAuthorModeWithCallback,
      setIdentityMode: setIdentityModeWithCallback,
      setSelectedQualifierIds: setSelectedQualifierIdsWithCallback,
    },
    isMobile,
    license: {
      get assetLicenseCopy() {
        return assetLicenseCopy();
      },
      get shouldShowAssetLicense() {
        return shouldShowAssetLicense();
      },
      get state() {
        return licenseState();
      },
      update: updateLicenseState,
    },
    royaltySplit: {
      get state() {
        return royaltySplitState();
      },
      update: updateRoyaltySplitState,
    },
    media: {
      get activeImageUpload() {
        return activeImageUpload();
      },
      get imageUploadLabel() {
        return imageUploadLabel();
      },
      setImageUpload: setImageUploadWithCallback,
      get videoState() {
        return videoState();
      },
      updateVideoState,
    },
    primary: {
      get activeSongMode() {
        return activeSongMode();
      },
      get activeVideoSourceMode() {
        return activeVideoSourceMode();
      },
      get derivativePickerKey() {
        return derivativePickerKey();
      },
      get derivativeSearchResults() {
        return derivativeSearchResults();
      },
      get derivativeState() {
        return derivativeState();
      },
      handleSongModeChange,
      handleVideoSourceModeChange,
      get liveState() {
        return liveState();
      },
      setLiveState: setLiveStateWithCallback,
      updateDerivativeState,
    },
    event: {
      get searchPlaces() {
        return props.onSearchEventPlaces;
      },
      get state() {
        return grantedEventState();
      },
      update: setEventStateWithCallback,
    },
    generic: {
      get file() {
        return fileState();
      },
      setFile: setFileWithCallback,
    },
    song: {
      get state() {
        return songState();
      },
      update: updateSongState,
    },
    submit: {
      get disabled() {
        return postDisabled();
      },
      get error() {
        return submitError();
      },
      get label() {
        return submitLabel() ?? copy.actions.post;
      },
      get loading() {
        return submitLoading();
      },
      get mobileEnabled() {
        return Boolean(submit());
      },
      get onSubmit() {
        return onSubmit();
      },
      get postDisabled() {
        return postDisabled();
      },
      get progress() {
        return submitProgress();
      },
    },
    requirements: {
      get ageGateConfirmationPending() {
        return ageGateConfirmationPending();
      },
      get draftCanSubmit() {
        return draftCanSubmit();
      },
      get requiresPostSheet() {
        return requiresPostSheet();
      },
      get songAudioMissing() {
        return songAudioMissing();
      },
      get songGenreMissing() {
        return songGenreMissing();
      },
      get songLanguageMissing() {
        return songLanguageMissing();
      },
      get songTitleMissing() {
        return songTitleMissing();
      },
    },
    tabs: {
      get activeTab() {
        return activeTab();
      },
      labels: tabLabels,
      onTabChange: (nextTab: ComposerTab) => {
        // Fail closed, including for programmatic callers: an undeclared tab
        // must not become the active tab nor be reported to the host as the
        // requested mode.
        if (!capabilities().allows(nextTab)) return;
        setActiveTab(nextTab);
        onModeChange()?.(nextTab);
      },
      get visibleTabs() {
        return visibleTabs();
      },
      allows: (capability: ComposerCapability) =>
        capabilities().allows(capability),
      permitted: <T extends { readonly kind: ComposerToolbarAction }>(
        actions: readonly T[],
      ) => capabilities().permitted(actions),
    },
    advanceDerivativePicker: () =>
      setDerivativePickerKey((current) => current + 1),
  };
}

export type PostComposerController = ReturnType<
  typeof createPostComposerController
>;
