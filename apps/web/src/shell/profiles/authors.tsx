import { createEffect, createSignal, onCleanup } from "solid-js";
import { isServer, type JSX } from "@solidjs/web";
import type { PublicProfile } from "../../../../../packages/community-profile/contracts.ts";
import type { ProfileClient } from "./client.ts";
const publicProfileHref = (id: string) => "/#profile-" + id;
/** Actual public lookup for feed names. Clears at community/session/target change. */
export function ProfileAuthorProvider(props: {
  client: ProfileClient | undefined;
  communityId: string;
  authorityKey: string;
  authorIds: readonly string[];
  children: (
    projection:
      | {
          communityId: string;
          rows: {
            authorId: string;
            displayName?: string;
            avatarRef?: string;
            profileHref: string;
          }[];
        }
      | undefined,
  ) => JSX.Element;
}) {
  const [profiles, setProfiles] = createSignal<PublicProfile[] | undefined>();
  const key = () =>
    `${props.communityId}:${props.authorityKey}:${[...new Set(props.authorIds)].join(",")}`;
  const [loadedKey, setLoadedKey] = createSignal("");
  let request: AbortController | undefined,
    generation = 0;
  createEffect(
    () =>
      [
        props.client,
        props.communityId,
        props.authorityKey,
        [...new Set(props.authorIds)].join(","),
      ] as const,
    ([client, , , ids]) => {
      const revision = ++generation;
      const capturedKey = key();
      request?.abort();
      setProfiles(undefined);
      if (isServer || !client || !ids) return;
      const abort = new AbortController();
      request = abort;
      void (async () => {
        const result: PublicProfile[] = [],
          values = ids.split(",");
        if (values.length > 100)
          throw new Error("profile_author_list_unavailable");
        for (let start = 0; start < values.length; start += 32)
          result.push(
            ...(await client.authors(
              values.slice(start, start + 32),
              abort.signal,
            )),
          );
        if (!abort.signal.aborted && revision === generation) {
          setLoadedKey(capturedKey);
          setProfiles(result);
        }
      })().catch(() => {
        if (revision === generation) setProfiles(undefined);
      });
    },
  );
  onCleanup(() => {
    generation++;
    request?.abort();
  });
  return (
    <>
      {props.children(
        profiles() && loadedKey() === key()
          ? {
              communityId: props.communityId,
              rows: profiles()!.map((profile) => ({
                authorId: profile.authorId,
                displayName: profile.displayName ?? undefined,
                avatarRef: profile.avatarRef ?? undefined,
                profileHref: publicProfileHref(profile.authorId),
              })),
            }
          : undefined,
      )}
    </>
  );
}
