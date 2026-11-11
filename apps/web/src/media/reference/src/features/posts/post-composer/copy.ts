// Static English copy for the post composer. The React version reads
// `getLocaleMessages(locale, "routes").createPost`; the Solid locale catalogs
// do not carry the createPost namespace, so the composer owns its copy here
// (values lifted from web/src/locales/en/routes.json). Callers may override
// individual groups via `PostComposerProps.copy` later if a localized catalog
// lands; stories always use these defaults so they stay deterministic.

export interface ComposerCopy {
  actions: {
    back: string;
    continue: string;
    post: string;
    publish: string;
  };
  audience: {
    community: string;
    public: string;
  };
  access: {
    paidUnlock: string;
    payToAccess: string;
    useRegionalPricing: string;
  };
  assetLicense: {
    song: Record<string, string>;
    video: Record<string, string>;
  };
  buttons: {
    chooseFile: string;
    clear: string;
    replace: string;
  };
  common: {
    loading: string;
  };
  derivative: {
    acceptSourceTerms: string;
    chooseSource: string;
    licenseNewRemixTerms: string;
    noMatches: string;
    searchSongs: string;
  };
  empty: {
    noOptionalQualifiers: string;
    noQualifiers: string;
    noSongs: string;
  };
  fields: Record<string, string>;
  identitySheet: {
    agentRowDescription: string;
    anonymousRowDescription: string;
    publicRowDescription: string;
    qualifierCount: (count: number) => string;
    qualifiersApply: string;
    qualifiersTitle: string;
    title: string;
  };
  publishChips: {
    accessRightsTitle: string;
    ageGate: string;
    ageGateTitle: string;
    ageGateConfirm: string;
    ageGateConfirmCancel: string;
    ageGateConfirmTitle: string;
    audienceTitle: string;
    audienceMembersOnly: string;
    audiencePublic: string;
    noAgeGate: string;
    visibilityTitle: string;
  };
  identity: {
    addQualifiers: string;
  };
  labels: {
    source: string;
  };
  live: Record<string, string>;
  none: string;
  placeholders: Record<string, string>;
  requiredFieldsLegend: string;
  review: {
    change: string;
    earnings: string;
    lyrics: string;
    noLyrics: string;
    permissions: string;
    rights: string;
    song: string;
    sources: string;
    you: string;
  };
  rights: {
    addCollaborator: string;
    addProfile: string;
    collaboratorScope: string;
    earningsTitle: string;
    everyProfileHasShare: string;
    fullTerms: string;
    includeCreator: string;
    invalidShare: string;
    license: string;
    missingRecipient: string;
    noMatchingProfiles: string;
    overRemaining: string;
    permissionsTitle: string;
    positiveShares: string;
    allYours: string;
    revShare: string;
    searchProfiles: string;
    share: string;
    songKind: string;
    totalExact: string;
    uniqueRecipients: string;
    yourShare: string;
  };
  sections: Record<string, string>;
  setlist: {
    cannotFindTrack: string;
    hideManualDetails: string;
    searchSongs: string;
  };
  songModes: {
    original: string;
    remix: string;
  };
  steps: {
    lyrics: string;
    review: string;
    rights: string;
    song: string;
  };
  tabs: Record<"text" | "image" | "video" | "link" | "song" | "live", string>;
  upload: {
    artworkHelp: string;
    cover: string;
    noFileSelected: string;
    squareArtwork: string;
  };
}

export const defaultComposerCopy: ComposerCopy = {
  actions: {
    back: "Back",
    // Ruling 2026-10-16: Next moves forward, Post publishes. The key stays.
    continue: "Next",
    post: "Post",
    publish: "Publish",
  },
  audience: {
    community: "Community",
    public: "Public",
  },
  access: {
    paidUnlock: "Paid unlock",
    payToAccess: "Pay to access",
    useRegionalPricing: "Use community regional pricing",
  },
  assetLicense: {
    song: {
      "non-commercial": "Remix, not for profit",
      "non-commercialDescription":
        "Anyone can remix it with credit, but not sell it.",
      "commercial-use": "Use as is, including for profit",
      "commercial-useDescription":
        "Anyone can use it in paid work with credit. No remixes.",
      "commercial-remix": "Remix and sell",
      "commercial-remixDescription":
        "Anyone can remix and sell it with credit. You get a share of their earnings.",
      "non-commercialTerms":
        "Others can publish non-commercial remixes with attribution; commercial releases are prohibited.",
      "commercial-useTerms":
        "Others can monetize the original song with attribution; remixes are prohibited.",
      "commercial-remixTerms":
        "Others can monetize and publish remixes with attribution. You keep a share of their earnings.",
      revenueShare: "Revenue share",
    },
    video: {
      "non-commercial": "Non-commercial remixing",
      "non-commercialDescription":
        "Others can publish non-commercial derivatives with attribution; commercial releases are prohibited.",
      "commercial-use": "Commercial use",
      "commercial-useDescription":
        "Others can monetize with the original video with attribution; derivatives are prohibited.",
      "commercial-remix": "Commercial derivatives",
      "commercial-remixDescription":
        "Others can monetize and publish derivative videos with attribution.",
      revenueShare: "Revenue share",
    },
  },
  buttons: {
    chooseFile: "Choose file",
    clear: "Clear",
    replace: "Replace",
  },
  common: {
    loading: "Loading...",
  },
  derivative: {
    acceptSourceTerms: "I accept these remix terms.",
    chooseSource: "Choose the song you remixed.",
    licenseNewRemixTerms: "New remix terms",
    noMatches: "No matching songs.",
    searchSongs: "Search songs",
  },
  empty: {
    noOptionalQualifiers:
      "No optional qualifiers are available for this community.",
    noQualifiers: "No qualifiers found.",
    noSongs: "No songs found.",
  },
  fields: {
    addLyrics: "Add lyrics",
    canvasVideo: "Canvas video (9:16)",
    coverArt: "Cover art",
    coverFrame: "Cover frame",
    genre: "Genre",
    geniusAnnotations: "Genius annotations",
    hideLyrics: "Hide lyrics",
    instrumentalStem: "Instrumental stem",
    lyrics: "Lyrics",
    price: "Price",
    primaryLanguage: "Primary language",
    secondaryLanguage: "Secondary language",
    song: "Song",
    unlockPriceUsd: "Unlock price (USD)",
    vocalStem: "Vocal stem",
    previewStartSeconds: "30-second preview starts at",
    vinylReleaseUrl: "ElasticStage vinyl URL",
  },
  identity: {
    addQualifiers: "Add qualifiers",
  },
  identitySheet: {
    agentRowDescription: "Post from your agent identity",
    anonymousRowDescription: "Same identity across this community",
    publicRowDescription: "Your public profile",
    qualifierCount: (count) =>
      `${count} ${count === 1 ? "qualifier" : "qualifiers"}`,
    qualifiersApply: "Applies to this post only.",
    qualifiersTitle: "Qualifiers",
    title: "Post as",
  },
  publishChips: {
    accessRightsTitle: "Access & rights",
    ageGate: "18+",
    ageGateTitle: "Age gate",
    ageGateConfirm: "Mark 18+",
    ageGateConfirmCancel: "Cancel",
    ageGateConfirmTitle:
      "This community requires confirmation to mark posts 18+.",
    audienceTitle: "Who can see this?",
    audienceMembersOnly: "Members only",
    audiencePublic: "Public",
    noAgeGate: "No age gate",
    visibilityTitle: "Visibility",
  },
  labels: {
    source: "Source",
  },
  live: {
    roomKind: "Room kind",
    access: "Access",
    visibility: "Visibility",
    guestPerformer: "Guest performer",
    collaboratorPlaceholder: "Search for a collaborator",
    collaboratorNote: "Invite a collaborator for this duet session.",
    performerAllocations: "Performer allocations",
    soloProceedsDescription:
      "The host receives 100% of performer-side proceeds.",
    duetProceedsDescription:
      "Split performer-side proceeds between host and collaborator.",
    hostLabel: "Host",
    guestLabel: "Guest",
    youLabel: "You",
    collaboratorLabel: "Collaborator",
    allocationsError: "Allocations must sum to 100%",
    setlistTitle: "Setlist",
    addSong: "Add song",
    emptySetlist: "No songs yet. Add at least one song before going live.",
    roomKindSolo: "Solo",
    roomKindDuet: "Duet",
    accessFree: "Free",
    accessGated: "Gated",
    accessPaid: "Paid",
    audienceGate: "Audience gate",
    audienceGateCommunityMembers: "Community members",
    audienceGatePurchaseEntitlement: "Buyers of selected songs",
    audienceGatePurchaseEntitlementEmpty:
      "Select catalog songs in the setlist before using buyer access.",
    visibilityPublic: "Public",
    visibilityUnlisted: "Unlisted",
    paidVisibilityNote:
      "Paid livestreams must be public. Select Public to continue.",
    scheduleForLater: "Schedule for later",
    startTime: "Start time",
    startTimeNote: "Required for scheduled live events.",
    recordThisLivestream: "Record this livestream",
    recordThisLivestreamNote:
      "Creates a private replay draft after the stream ends.",
    eventCover: "Event cover",
    eventCoverUpload: "Upload event cover",
    eventCoverHelp:
      "Upload a 16:9 event cover. Feed, preview, and event page show it wide.",
    storeUrl: "Store URL",
    storeUrlPlaceholder: "https://store.example.com",
    storeLabel: "Store label",
    storeLabelPlaceholder: "Event merch",
  },
  none: "None",
  placeholders: {
    artist: "Artist",
    body: "Write your post",
    geniusAnnotationsUrl: "https://genius.com/...",
    lyrics: "Paste lyrics",
    optional: "Optional",
    selectGenre: "Select genre",
    selectLanguage: "Select language",
    songSearch: "Search your uploaded songs",
    songTitle: "Song title",
    sourceTrackSearch: "Search songs",
    title: "Title",
    unlockPrice: "0",
    previewStartSeconds: "0",
    vinylReleaseUrl:
      "https://elasticstage.com/artist/releases/release-singleep",
  },
  requiredFieldsLegend: "Required fields are marked with *",
  review: {
    change: "Change",
    earnings: "Earnings split",
    lyrics: "Lyrics",
    noLyrics: "No lyrics added",
    permissions: "Remix earnings",
    rights: "Royalties",
    song: "Song",
    sources: "Remix source",
    you: "You",
  },
  rights: {
    addCollaborator: "Add collaborator",
    addProfile: "Add",
    collaboratorScope:
      "Only your profiles bound to this community can be added for now.",
    earningsTitle: "Earnings split",
    everyProfileHasShare: "No one to add yet.",
    fullTerms: "Full terms",
    includeCreator: "The split must include you.",
    invalidShare: "Enter a share between 0.01% and 100%.",
    license: "License",
    missingRecipient: "Every recipient needs a profile.",
    noMatchingProfiles: "No matches.",
    overRemaining: "That share leaves no room for your share.",
    permissionsTitle: "What others may do with this song",
    positiveShares: "Each share must be more than 0%.",
    allYours: "All earnings go to you",
    revShare: "Your cut of remix sales",
    searchProfiles: "Search profiles",
    share: "Share",
    songKind: "Is this your own song?",
    totalExact: "Shares must add up to 100%.",
    uniqueRecipients: "Each collaborator can appear only once.",
    yourShare: "Your share",
  },
  sections: {
    postAs: "Post as",
    sourceTrack: "Remix source",
    license: "License",
  },
  setlist: {
    cannotFindTrack: "Can't find the song?",
    hideManualDetails: "Hide manual details",
    searchSongs: "Search songs for setlist item",
  },
  songModes: {
    original: "My original",
    remix: "A remix of another song",
  },
  steps: {
    lyrics: "Lyrics",
    review: "Review",
    rights: "Royalties",
    song: "Song",
  },
  tabs: {
    image: "Image",
    link: "Link",
    live: "Live",
    song: "Song",
    text: "Text",
    video: "Video",
  },
  upload: {
    artworkHelp: "Shows in feed, release, and player surfaces.",
    cover: "Cover",
    noFileSelected: "No file selected",
    squareArtwork: "Upload square artwork",
  },
};

interface ComposerTabLabels {
  file: string;
  image: string;
  link: string;
  live: string;
  song: string;
  text: string;
  video: string;
}

export function buildComposerTabLabels(copy: ComposerCopy): ComposerTabLabels {
  return { ...copy.tabs, file: "File" };
}
