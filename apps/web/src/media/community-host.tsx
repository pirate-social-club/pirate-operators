import { onCleanup, Show } from "solid-js";
import {
  CommunityPostComposer,
  type SongComposerPort,
} from "./community-post-composer.tsx";
import { CommunitySongComposer } from "./community-ui/post-composer.tsx";
import { PendingSongs } from "./reference/src/features/posts/song-submission/pending-songs.tsx";
import { Button, FormNote } from "./reference/src/design-system.ts";
import type { PostComposerProps } from "./reference/src/features/posts/post-composer/types.ts";
import {
  OWNER_RELEASE_POLICY,
  songCapability,
  type CommunityHostContext,
} from "./community-contracts.ts";
import { mediaClient } from "./client.ts";
import {
  createCommunityComposerScope,
  type CommunityComposerScope,
} from "./community-composer-scope.ts";
import type { CommunityComposerRuntime } from "./community-composer-runtime.ts";
export type { CommunityHostContext } from "./community-contracts.ts";

interface ViewProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  onCloseRefused?: () => void;
}
export type CommunityComposerHostProps = ViewProps &
  (
    | { scope: CommunityComposerScope; current?: never; refreshFeed?: never }
    /** Compatibility for an independently mounted host/test. Application entry
     * must construct and pass its one persistent scope instead. */
    | {
        scope?: undefined;
        current(): CommunityHostContext | null;
        refreshFeed(): Promise<void>;
      }
  );
export function CommunityComposerHost(props: CommunityComposerHostProps) {
  // Construction is outside all tracked prop getters/render callbacks.
  const scope =
    props.scope ??
    createCommunityComposerScope({
      current: props.current!,
      refreshFeed: props.refreshFeed!,
    });
  return (
    <Show when={props.open}>
      <Show
        when={scope.runtime()}
        keyed
        fallback={<FormNote>{scope.status()}</FormNote>}
      >
        {(runtime) => (
          <Show
            when={!runtime.fault()}
            fallback={<FormNote>{runtime.fault()}</FormNote>}
          >
            <CommunityHostView {...props} runtime={runtime} />
          </Show>
        )}
      </Show>
    </Show>
  );
}

/** Original card composition; no fake pending counter or public feed receipt.
 * Each action remains owned by the application scope, never by this view. */
export function CommunityPendingSongs(props: {
  scope: CommunityComposerScope;
  onOpenStatus(submissionId: string): void;
}) {
  return (
    <PendingSongs
      items={props.scope.items()}
      onCheck={props.scope.check}
      onRetry={props.scope.retry}
      onDismiss={props.scope.dismiss}
      onOpenStatus={(id) => {
        if (props.scope.openStatus(id)) props.onOpenStatus(id);
      }}
    />
  );
}

function CommunityHostView(
  props: ViewProps & { runtime: CommunityComposerRuntime },
) {
  const r = props.runtime,
    owner = r.owner;
  const context = owner.current;
  const lease = r.acquireView();
  onCleanup(lease.close);
  const capability = () =>
    r.active()
      ? songCapability(owner.current)
      : {
          allowed: false,
          reason: "Reconnect your private community profile before continuing.",
        };
  const policy = () =>
    r.record()?.body.acceptedPolicy ??
    (r.active()
      ? owner.current.capabilities.policyVersion
      : context.capabilities.policyVersion);
  const issue = () =>
    !capability().allowed
      ? capability().reason
      : !r.consent()
        ? "Accept the community release policy before uploading."
        : policy() === OWNER_RELEASE_POLICY && !r.rating()
          ? "Declare the release rating before uploading."
          : "";
  const flow = {
    get prepared() {
      return (
        !!r.record()?.master &&
        !!r.record()?.stems.instrumental &&
        !!r.record()?.stems.vocals
      );
    },
    get retained() {
      return !!r.record();
    },
    get locked() {
      return r.busy() || !!r.record()?.jobId;
    },
    get audioPrepared() {
      return !!r.record()?.master;
    },
    get stems() {
      return {
        instrumental: !!r.record()?.stems.instrumental,
        vocals: !!r.record()?.stems.vocals,
      };
    },
    get pendingStems() {
      return {
        instrumental: !!r.record() && !r.record()?.stems.instrumental,
        vocals: !!r.record() && !r.record()?.stems.vocals,
      };
    },
    prepare: async () => {
      if (!lease.active()) return false;
      try {
        await r.prepare({
          title: r.song().title ?? "",
          lyrics: r.lyrics(),
          language: owner.current.language,
          file: r.song().primaryAudioUpload!,
          instrumental: r.song().instrumentalAudioUpload!,
          vocals: r.song().vocalAudioUpload!,
          originalConsent: r.consent(),
          rating: r.rating(),
        });
        return lease.active();
      } catch {
        return false;
      }
    },
  };
  const composer: PostComposerProps & { songFlowRuntime: typeof flow } = {
    mode: "song",
    presentation: "inline",
    attachmentBarPlacement: "inline",
    availableCapabilities: ["song"],
    get canCreateSongPost() {
      return capability().allowed;
    },
    get song() {
      return r.song();
    },
    onSongChange: (next) => {
      if (lease.active()) r.setSong(next);
    },
    get titleValue() {
      return r.song().title ?? "";
    },
    get lyricsValue() {
      return r.lyrics();
    },
    onLyricsValueChange: (next) => {
      if (lease.active()) r.setLyrics(next);
    },
    songFlowRuntime: flow,
    get initialSongStep() {
      return flow.prepared ? 3 : r.record() ? 2 : 1;
    },
    get submit() {
      return {
        label: "Post",
        disabled: r.busy() || !flow.prepared || !!issue(),
        loading: r.busy(),
        error: r.error(),
      };
    },
    mediaStatus: () => (
      <>
        <Show when={r.error()}>
          {(message) => <FormNote tone="warning">{message()}</FormNote>}
        </Show>
        <Show when={r.busy()}>
          <Button variant="outline" onClick={r.stopUpload}>
            Stop upload
          </Button>
        </Show>
      </>
    ),
  };
  const port: SongComposerPort = {
    owner: r.observer,
    get capability() {
      return capability();
    },
    composer,
    chooseFile: (file) => {
      if (r.record()) {
        r.setError(
          "Continue the saved release before choosing another recording.",
        );
        return;
      }
      r.setSong({
        primaryAudioUpload: file,
        primaryAudioLabel: file.name,
        title: file.name.replace(/\.mp3$/i, ""),
      });
    },
    unresolved: () => r.busy(), // The close callback pauses; it never discards this obligation.
    publish: r.publish,
    render: (events) => (
      <CommunitySongComposer
        {...composer}
        onClose={events.close}
        release={{
          authorized: () => capability().allowed,
          policy,
          consent: r.consent,
          onConsent: r.setConsent,
          rating: r.rating,
          onRating: r.setRating,
          language: () =>
            r.record()?.body.language ??
            (r.active() ? owner.current.language : context.language),
          issue,
        }}
        submit={{
          get disabled() {
            return composer.submit?.disabled || events.busy();
          },
          get loading() {
            return r.busy() || events.busy();
          },
          get error() {
            return events.error() ?? r.error();
          },
          label: "Post",
          onSubmit: events.publish,
        }}
      />
    ),
  };
  const close = (open: boolean) => {
    const current = lease.active();
    if (!open) lease.close();
    if (current) props.onOpenChange(open);
  };
  return (
    <>
      <CommunityPostComposer
        open={props.open}
        onOpenChange={close}
        community={context.community}
        accountId={owner.accountId}
        client={mediaClient(() => {
          owner.assert();
          return owner.current.session.csrf;
        })}
        song={port}
        initialMode="song"
        isCurrent={lease.active}
        initialSongSubmissionId={r.selectedId()}
        draftVersion={r.draftVersion()}
        onCloseRefused={() => {
          const current = lease.active();
          lease.close();
          if (current) props.onOpenChange(false);
        }}
      />
      <FormNote>
        Text, image processing, collaborator splits and public video posting are
        unavailable here.
      </FormNote>
      <Show
        when={
          r.record()?.job?.phase === "uncertain" && r.record()?.job?.resumable
        }
      >
        <Button
          disabled={r.busy()}
          variant="outline"
          onClick={() => {
            const id = r.record()?.submissionId;
            if (id) void r.resume(id).catch(() => {});
          }}
        >
          Check and resume
        </Button>
      </Show>
      <Show
        when={
          r.record()?.job &&
          ["held", "failed", "published"].includes(r.record()!.job!.phase) &&
          !r.record()?.pending &&
          capability().allowed
        }
      >
        <Button
          disabled={r.busy()}
          variant="outline"
          onClick={() => {
            void r.closeSaved().catch(() => {});
          }}
        >
          Start another release
        </Button>
      </Show>
    </>
  );
}
