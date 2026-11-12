import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import {
  CommunityAccountSettings,
  CommunityProfilePage,
  ProfileAuthorProvider,
  publicProfileAuthor,
  type CommunityAccountProps,
} from "./pages.tsx";
import type { ShellIntegrations } from "../interfaces.ts";

/** Actual App route boundary. Protected entry proposal mounts this export. */
export function MountedCommunityProfiles(
  props: CommunityAccountProps & {
    view: string;
    hash: string;
    communityId: string;
    authorityKey: string;
    authorIds: readonly string[];
    privateDance?: () => JSX.Element;
    children: (authors: ShellIntegrations["postAuthors"]) => JSX.Element;
  },
) {
  const publicAuthor = () => publicProfileAuthor(props.hash);
  return (
    <ProfileAuthorProvider
      client={props.integration.client()}
      communityId={props.communityId}
      authorityKey={props.authorityKey}
      authorIds={props.authorIds}
    >
      {(authors) => (
        <Show
          when={
            props.view === "account" ||
            props.view === "settings" ||
            publicAuthor()
          }
          fallback={props.children(authors)}
        >
          <Show
            when={props.view === "settings"}
            fallback={
              <>
                <CommunityProfilePage {...props} authorId={publicAuthor()} />
                <Show
                  when={
                    props.view === "account" &&
                    props.integration.state().view.kind === "ready"
                  }
                >
                  {props.privateDance?.()}
                </Show>
              </>
            }
          >
            <CommunityAccountSettings {...props} />
          </Show>
        </Show>
      )}
    </ProfileAuthorProvider>
  );
}
