import { fragmentNavigationHref } from "../routing.ts";
import { CommunityAccountSettings } from "./settings.tsx";
export { CommunityAccountSettings } from "./settings.tsx";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { isServer, type JSX } from "@solidjs/web";
import type { PublicProfile } from "../../../../../packages/community-profile/contracts.ts";
import { Button, Type, buttonVariants } from "../design-system.ts";
import { ProfileLayout } from "../reference/profile-layout.tsx";
import {
  ProfileActivity,
  type ProfileActivityDependencies,
} from "../reference/profile-activity.tsx";
import { publicPlaybackAccess } from "../playback-access.ts";
import { ProfileRequestError, type ProfileClient } from "./client.ts";
import type { CommunityProfileIntegration } from "./integration.ts";

export interface ProfileSettingsServices {
  /** Render only real owner services. No central deletion/Telegram fallback. */
  privateHistory?: () => Promise<void>;
  publicResults?: () => JSX.Element;
  recordings?: () => JSX.Element;
  telegram?: () => JSX.Element;
}
export interface CommunityAccountProps {
  integration: CommunityProfileIntegration;
  navigate: (href: string) => void;
  signIn: () => Promise<void>;
  logout: () => Promise<void>;
  canSignIn: boolean;
  /** Existing authenticated session can log out while profile/config reads fail. */
  canSignOut?: boolean;
  walletAvailable: boolean;
  services?: ProfileSettingsServices;
}
const publicHref = (id: string) => `/#profile-${id}`;
export const publicProfileAuthor = (hash: string): string | undefined =>
  /^#profile-(0x[0-9a-f]{64})$/.exec(hash)?.[1];

function activityDependencies(
  client: ProfileClient,
  profile: PublicProfile,
  invalidate: () => void,
): ProfileActivityDependencies {
  return {
    loadPage: async ({ profileId, cursor, signal }) => {
      if (profileId !== profile.authorId)
        throw new Error("profile_authority_changed");
      let page: Awaited<ReturnType<ProfileClient["activity"]>>;
      try {
        page = await client.activity(profileId, cursor, signal);
      } catch (error) {
        if (
          !signal.aborted &&
          error instanceof ProfileRequestError &&
          ["profile_activity_changed", "profile_cursor_expired"].includes(
            error.code,
          )
        )
          invalidate();
        throw error;
      }
      return {
        next_cursor: page.nextCursor,
        items: page.items.map((song) => ({
          kind: "post" as const,
          activity_id: song.manifest.postId,
          community_id: profile.communityId,
          href: song.postUrl,
          post: {
            id: song.manifest.postId,
            kind: "song" as const,
            title: song.manifest.title,
            mediaTitle: song.manifest.title,
            body: "",
            technicalAuthorId: song.manifest.authorId,
            authorHandle: page.profile.displayName ?? undefined,
            authorAvatarSrc: page.profile.avatarRef ?? undefined,
            authorHref: publicHref(profileId),
            readPlayback: async () => publicPlaybackAccess(song.audioUrl),
          },
        })),
      };
    },
  };
}
/** Layout/activity are the existing c7 copies, with real producer dependencies. */
export function CommunityProfilePage(
  props: CommunityAccountProps & {
    authorId?: string;
    communityId: string;
    authorityKey: string;
  },
) {
  const [publicState, setPublicState] = createSignal<
    | { kind: "loading" | "unavailable" }
    | { kind: "ready"; profile: PublicProfile }
  >({ kind: "loading" });
  const [retry, setRetry] = createSignal(0);
  const [activityEpoch, setActivityEpoch] = createSignal(0);
  const targetKey = () =>
    `${props.communityId}:${props.authorId ?? "owner"}:${props.authorityKey}`;
  const [publicKey, setPublicKey] = createSignal("");
  let request: AbortController | undefined,
    generation = 0;
  createEffect(
    () =>
      [
        props.authorId,
        props.communityId,
        props.authorityKey,
        props.integration.client(),
        retry(),
      ] as const,
    ([id, , , client]) => {
      const current = ++generation;
      setPublicKey(targetKey());
      request?.abort();
      request = undefined;
      setPublicState({ kind: "loading" });
      if (isServer || !id || !client) return;
      const abort = new AbortController();
      request = abort;
      void client.public(id, abort.signal).then(
        (profile) => {
          if (!abort.signal.aborted && current === generation)
            setPublicState({ kind: "ready", profile });
        },
        () => {
          if (!abort.signal.aborted && current === generation)
            setPublicState({ kind: "unavailable" });
        },
      );
    },
  );
  onCleanup(() => {
    generation++;
    request?.abort();
  });
  const view = () =>
    props.authorId
      ? publicKey() === targetKey()
        ? publicState()
        : { kind: "loading" as const }
      : props.integration.state().view;
  const profile = () => {
    const current = view();
    return current.kind === "ready"
      ? "profile" in current
        ? current.profile
        : current.owner.profile
      : undefined;
  };
  const dependencies = createMemo(() => {
    activityEpoch();
    const value = profile(),
      client = props.integration.client();
    return value && client
      ? activityDependencies(client, value, () =>
          setActivityEpoch((epoch) => epoch + 1),
        )
      : undefined;
  });
  const owns = () => {
    const state = props.integration.state();
    return (
      state.view.kind === "ready" &&
      state.view.owner.profile.authorId === profile()?.authorId
    );
  };
  return (
    <Show
      when={profile()}
      fallback={
        <Show
          when={view().kind !== "anonymous"}
          fallback={<CommunityAccountSettings {...props} profile />}
        >
          <main
            class="mx-auto w-full max-w-5xl px-4 py-8 md:px-8"
            data-persona-profile-state={view().kind}
          >
            <Type as="h1" variant="h1">
              {view().kind === "loading"
                ? "Loading profile"
                : "Profile unavailable"}
            </Type>
            <Show when={view().kind === "unavailable"}>
              <p role="alert">The profile could not be loaded.</p>
              <Button
                variant="secondary"
                onClick={() =>
                  props.authorId
                    ? setRetry((value) => value + 1)
                    : void props.integration.controller()?.load()
                }
              >
                Try again
              </Button>
            </Show>
            <Show when={!props.authorId && props.canSignOut}>
              <a
                class={buttonVariants({
                  variant: "outline",
                  class: "w-full rounded-lg bg-transparent",
                })}
                href={fragmentNavigationHref(
                  "/#/settings",
                  typeof location === "undefined"
                    ? undefined
                    : new URL(location.href),
                )}
              >
                Settings
              </a>
            </Show>
          </main>
        </Show>
      }
    >
      {(value) => (
        <main
          class="mx-auto w-full max-w-[65.5rem] pb-24 md:pb-12"
          data-persona-profile-state="success"
        >
          <ProfileLayout
            name={value().displayName ?? "Profile"}
            avatarRef={value().avatarRef}
            coverRef={value().coverRef}
            bio={value().bio}
            servingOrigin={
              typeof location === "undefined" ? undefined : location.origin
            }
            settingsControl={
              <Show when={owns()}>
                <a
                  class={buttonVariants({
                    variant: "outline",
                    class: "w-full rounded-lg bg-transparent",
                  })}
                  href={fragmentNavigationHref(
                    "/#/settings",
                    typeof location === "undefined"
                      ? undefined
                      : new URL(location.href),
                  )}
                >
                  Settings
                </a>
              </Show>
            }
          >
            <Show when={dependencies()} keyed>
              {(source) => (
                <ProfileActivity
                  profileId={value().authorId}
                  dependencies={source}
                />
              )}
            </Show>
            <Type as="p" variant="caption" class="py-5 text-muted-foreground">
              This feed is limited to the current public catalogue.
            </Type>
          </ProfileLayout>
        </main>
      )}
    </Show>
  );
}

export { ProfileAuthorProvider } from "./authors.tsx";
