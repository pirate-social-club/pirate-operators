// Cross-field composer invariants, ported verbatim from the React
// post-composer-invariants.ts.

import type {
  AuthorMode,
  ComposerIdentityState,
  ComposerTab,
  IdentityMode,
  LiveComposerState,
  LiveRoomKind,
} from "./types.ts";
import { anonymousEligibleTabs } from "./defaults.ts";

export function shouldForcePublicIdentityForTab({
  activeTab,
  identityMode,
}: {
  activeTab: ComposerTab;
  identityMode: IdentityMode;
  monetizationVisible: boolean;
}) {
  return (
    identityMode === "anonymous" && !anonymousEligibleTabs.includes(activeTab)
  );
}

export function shouldForcePublicIdentityForAuthor({
  authorMode,
  identityMode,
}: {
  authorMode: AuthorMode;
  identityMode: IdentityMode;
}) {
  return authorMode === "agent" && identityMode !== "public";
}

export function shouldClearSelectedQualifiers({
  authorMode,
  identity,
  identityMode,
  selectedQualifierCount,
}: {
  authorMode: AuthorMode;
  identity?: ComposerIdentityState;
  identityMode: IdentityMode;
  selectedQualifierCount: number;
}) {
  return (
    selectedQualifierCount > 0 &&
    (authorMode === "agent" ||
      identityMode !== "anonymous" ||
      (identityMode === "anonymous" &&
        identity?.allowQualifiersOnAnonymousPosts === false))
  );
}

export function deriveLiveStateForRoomKindChange({
  current,
  previousRoomKind,
}: {
  current: LiveComposerState;
  previousRoomKind: LiveRoomKind;
}): LiveComposerState | null {
  if (current.roomKind === previousRoomKind) {
    return null;
  }

  const hostAlloc = current.performerAllocations.find(
    (allocation) => allocation.role === "host",
  );
  if (!hostAlloc) {
    return null;
  }

  if (current.roomKind === "solo") {
    return {
      ...current,
      performerAllocations: [{ ...hostAlloc, sharePct: 100 }],
      guestUserId: undefined,
    };
  }

  if (current.roomKind === "duet") {
    return {
      ...current,
      performerAllocations: [
        { ...hostAlloc, sharePct: 50 },
        { userId: "", role: "guest", sharePct: 50 },
      ],
    };
  }

  return null;
}

export function isLiveVisibilityAllowedForAccess(
  current: Pick<LiveComposerState, "accessMode" | "visibility">,
): boolean {
  return current.accessMode !== "paid" || current.visibility === "public";
}
