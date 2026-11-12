// Exact pure route policy from src/features/shell/application-chrome-model.ts @ c7cb87835a1858a1955c820b03d566365e6d42db; local type-only import substituted.
type ShellNavItem = "home" | "songs" | "wallet" | "profile";

export type ApplicationChromeMode = "bare" | "immersive" | "standard";
export type ApplicationChromeRoute =
  | "home"
  | "songs"
  | "wallet"
  | "profile"
  | "settings"
  | "your-communities"
  | "create-community"
  | "none";
export type ApplicationMobileItem = ShellNavItem | "none";

export interface ApplicationChromePolicy {
  readonly activeItemId: ApplicationChromeRoute;
  readonly mobileActiveItem: ApplicationMobileItem;
  readonly mobileTitle: string;
  readonly mode: ApplicationChromeMode;
  readonly hideMobileHeader?: boolean;
  /** The page owns the phone's bottom edge with its own bar; no footer tabs. */
  readonly hideMobileFooter?: boolean;
}

function pathSegments(pathname: string): readonly string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * Community management renders its own takeover shell, including its own
 * sidebar, header and exit control, on every viewport. Legacy kept the
 * equivalent routes standalone so the application sidebar never rendered
 * beside the management sidebar; classifying them as bare here is what stops
 * this application nesting one navigation column inside another.
 */
export function isCommunityManagementRoute(pathname: string): boolean {
  const segments = pathSegments(pathname);
  return segments[0] === "c" && segments[2] === "settings";
}

/**
 * The four mobile tabs are For You, Your Songs, Wallet and Profile; desktop
 * adds the shared community sections and Notifications. Search and Live
 * remain unlisted. A viewer's own public profile highlights Profile; anyone
 * else's profile highlights nothing, which is what `viewerProfilePath`
 * distinguishes.
 */
export function resolveApplicationChrome(
  pathname: string,
  viewerProfilePath?: string,
): ApplicationChromePolicy {
  const segments = pathSegments(pathname);
  const first = segments[0];
  const activity = segments.includes("activity");
  const karaoke = first === "karaoke" || segments.includes("karaoke");
  const study = first === "study" || segments.includes("study");
  const community = first === "c";
  const profile = first === "u" || (first === "p" && !karaoke && !study);
  const ownProfile =
    viewerProfilePath !== undefined && pathname === viewerProfilePath;
  // A Study or Karaoke session on a song takes over the screen, like a
  // Duolingo lesson: its own exit and footer, no app header or tabs. The
  // leaderboard and the top-level Your songs pages keep the app chrome.
  const activitySession =
    (first === "p" || first === "posts") &&
    segments.length === 3 &&
    (segments[2] === "study" || segments[2] === "karaoke");

  if (
    (first === "c" || first === "posts" || first === "post") &&
    segments.length === 3 &&
    segments[2] === "leaderboard"
  ) {
    return {
      activeItemId: first === "c" ? "your-communities" : "songs",
      mobileActiveItem: "none",
      mobileTitle: "",
      mode: "standard",
      hideMobileHeader: true,
      hideMobileFooter: true,
    };
  }
  if (isCommunityManagementRoute(pathname)) {
    return {
      activeItemId: "your-communities",
      mobileActiveItem: "none",
      mobileTitle: "Community",
      mode: "bare",
    };
  }
  if (
    first === "auth" ||
    first === "verify" ||
    first === "terms" ||
    first === "privacy"
  ) {
    return {
      activeItemId: "home",
      mobileActiveItem: "home",
      mobileTitle: "",
      mode: "bare",
    };
  }
  // One post and its comments (`/post/:id`, `/posts/:slug`). The page draws
  // its own phone header (back and the post's community) and pins its comment
  // box to the bottom edge, so the app header and the footer tabs step aside.
  if ((first === "post" || first === "posts") && segments.length === 2) {
    return {
      activeItemId: "none",
      mobileActiveItem: "none",
      mobileTitle: "",
      mode: "standard",
      hideMobileHeader: true,
      hideMobileFooter: true,
    };
  }
  if (activitySession) {
    return {
      activeItemId: "songs",
      mobileActiveItem: "songs",
      mobileTitle: segments[2] === "study" ? "Study" : "Karaoke",
      mode: "bare",
    };
  }
  if (first === "dance" && segments[2] === "songs" && segments.length === 4) {
    return {
      activeItemId: "songs",
      mobileActiveItem: "songs",
      mobileTitle: "Dance",
      mode: "bare",
    };
  }
  if (segments.length === 0) {
    return {
      activeItemId: "home",
      mobileActiveItem: "home",
      mobileTitle: "",
      mode: "immersive",
    };
  }
  if (community) {
    return {
      activeItemId: "your-communities",
      mobileActiveItem: "none",
      mobileTitle: "Community",
      mode: "standard",
      hideMobileHeader: segments.length === 2,
    };
  }
  if (first === "communities") {
    return {
      activeItemId:
        segments[1] === "new" ? "create-community" : "your-communities",
      mobileActiveItem: "none",
      mobileTitle:
        segments[1] === "new" ? "Create community" : "Your communities",
      // Creation owns its header, scrolling body and action footer, like an activity session.
      mode: segments[1] === "new" ? "bare" : "standard",
    };
  }

  if (first === "songs") {
    return {
      activeItemId: "songs",
      mobileActiveItem: "songs",
      mobileTitle: "Your songs",
      mode: "standard",
    };
  }
  // Study and Karaoke sessions belong to Your songs, whether reached from the
  // library or from a song post.
  if (karaoke) {
    return {
      activeItemId: "songs",
      mobileActiveItem: "songs",
      mobileTitle: segments.length === 1 ? "Your songs" : "Karaoke",
      mode: "standard",
    };
  }
  if (study) {
    return {
      activeItemId: "songs",
      mobileActiveItem: "songs",
      mobileTitle: segments.length === 1 ? "Your songs" : "Study",
      mode: "standard",
    };
  }
  if (first === "wallet") {
    return {
      activeItemId: "wallet",
      mobileActiveItem: "wallet",
      mobileTitle: "Wallet",
      mode: "standard",
    };
  }
  if (first === "me") {
    return {
      activeItemId: "profile",
      mobileActiveItem: "profile",
      mobileTitle: "Profile",
      mode: "standard",
    };
  }
  if (profile) {
    return {
      activeItemId: ownProfile ? "profile" : "none",
      mobileActiveItem: ownProfile ? "profile" : "none",
      mobileTitle: "Profile",
      mode: "standard",
    };
  }
  if (first === "settings") {
    return {
      activeItemId: "settings",
      mobileActiveItem: "profile",
      mobileTitle: "Settings",
      mode: "standard",
    };
  }
  if (first === "search") {
    return {
      activeItemId: "none",
      mobileActiveItem: "none",
      mobileTitle: "Search",
      mode: "standard",
    };
  }
  if (first === "live") {
    return {
      activeItemId: "none",
      mobileActiveItem: "none",
      mobileTitle: "Live",
      mode: "standard",
    };
  }
  if (activity) {
    return {
      activeItemId: "none",
      mobileActiveItem: "none",
      mobileTitle: "Notifications",
      mode: "standard",
    };
  }
  return {
    activeItemId: "home",
    mobileActiveItem: "home",
    mobileTitle: "",
    mode: "standard",
  };
}
