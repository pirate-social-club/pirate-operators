// Explicit offline source-composition inputs, never default product metadata.
import { createSignal } from "solid-js";
import { createCommunityProfileIntegration } from "../src/shell/profiles/integration.ts";
import {
  CommunityAccountSettings,
  CommunityProfilePage,
} from "../src/shell/profiles/pages.tsx";
import {
  ProfileRequestError,
  type ProfileClient,
} from "../src/shell/profiles/client.ts";
import type { OwnerProfile } from "../../../packages/community-profile/contracts.ts";
export function ProfileCompositionInput(props: {
  scenario:
    | "empty"
    | "populated"
    | "read-error"
    | "logout-error"
    | "activity-error"
    | "signed-out"
    | "loading"
    | "settings-unavailable";
}) {
  const [action, setAction] = createSignal("");
  const communityId = "0x" + "1".repeat(64),
    authorId = "0x" + "2".repeat(64);
  const owner: OwnerProfile = {
    schema: "pirate.community-profile-owner/1",
    communityId,
    accountId: "private-fixture-account",
    profile: {
      schema: "pirate.community-profile/1",
      communityId,
      authorId,
      revision: 0,
      displayName: props.scenario === "populated" ? "Fixture profile" : null,
      bio: null,
      avatarRef: null,
      coverRef: null,
    },
    capabilities: { metadata: true, publicMedia: false, handles: false },
  };
  let reads = 0,
    activityReads = 0;
  const client: ProfileClient = {
    owner: async (signal) => {
      if (props.scenario === "loading")
        return new Promise<OwnerProfile>((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      if (props.scenario === "signed-out")
        throw new ProfileRequestError(401, "session_required");
      if (props.scenario === "settings-unavailable")
        throw new ProfileRequestError(503, "fixture unavailable");
      if (props.scenario === "read-error" && reads++ === 0)
        throw new ProfileRequestError(503, "fixture unavailable");
      return owner;
    },
    public: async () => owner.profile,
    authors: async () => [owner.profile],
    activity: async () => {
      if (props.scenario === "activity-error" && activityReads++ === 0)
        throw new ProfileRequestError(503, "fixture activity unavailable");
      return {
        schema: "pirate.community-profile-activity/1",
        communityId,
        authorId,
        profile: owner.profile,
        items: [],
        nextCursor: null,
        window: "current-public-catalogue",
      };
    },
    receipt: async () => null,
    save: async () => {
      throw new Error("no fixture content write");
    },
  };
  const integration = createCommunityProfileIntegration({
    communityId: () => communityId,
    identity: () => ({
      authorId,
      csrf: "fixture",
      scopeKey: "fixture-session",
    }),
    ready: () => true,
    client: () => client,
  });
  const shared = {
    integration,
    navigate: setAction,
    signIn: async () => {
      setAction("sign-in");
    },
    logout: async () => {
      if (props.scenario === "logout-error") throw new Error("fixture failure");
      setAction("logout");
    },
    canSignIn: true,
    canSignOut: props.scenario !== "signed-out",
    walletAvailable: true,
  };
  return (
    <div data-profile-fixture={props.scenario} data-last-action={action()}>
      {props.scenario === "logout-error" ||
      props.scenario === "settings-unavailable" ? (
        <CommunityAccountSettings {...shared} />
      ) : (
        <CommunityProfilePage
          {...shared}
          communityId={communityId}
          authorityKey="fixture-session"
        />
      )}
    </div>
  );
}
