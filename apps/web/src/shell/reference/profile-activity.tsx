// Independently owned source copy @ c7cb87835a1858a1955c820b03d566365e6d42db
// Exact source and dependency differences: docs/v1-shell-owner-correction-20261111.md.
import { getRequestEvent, type JSX } from "@solidjs/web";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onSettled,
} from "solid-js";
import { Button, Type } from "../design-system.ts";
import { CommunityPostCard } from "./community-post-card.tsx";
import type { CommunityPost } from "./community-model.ts";
import type { ContentAction } from "./content-overflow-menu.tsx";

/** Already authorized profile projection; no central session/client fallback. */
export interface ProfileActivityItem {
  readonly kind: "post";
  readonly activity_id: string;
  readonly community_id: string;
  readonly post: CommunityPost;
  readonly href?: string;
  readonly actions?: JSX.Element;
  readonly menuActions?: readonly ContentAction[];
}
type Item = ProfileActivityItem;
export interface ProfileActivityDependencies {
  readonly loadPage: (input: {
    profileId: string;
    cursor: string | null;
    signal: AbortSignal;
  }) => Promise<{ items: readonly Item[]; next_cursor: string | null }>;
  readonly subscribeSession?: (reload: () => void) => () => void;
}
/** Same shared PostCard as the community feed; engagement is an authorized port,
 * with no fabricated zero counts or central client hidden behind a default. */
function ActivityItem(props: { readonly item: Item }) {
  return (
    <CommunityPostCard
      post={props.item.post}
      titleHref={props.item.href}
      actions={props.item.actions}
      menuActions={props.item.menuActions}
    />
  );
}
/** Viewer-authorized activity is loaded only after hydration and session resolution. */
export function ProfileActivity(props: {
  readonly profileId: string;
  readonly dependencies: ProfileActivityDependencies;
}) {
  const event = getRequestEvent();
  // SAFETY: entry-server supplies this presentation-only flag for static handle hosts.
  const disabled =
    (
      event?.locals as
        | { profileActivityHydrationDisabled?: boolean }
        | undefined
    )?.profileActivityHydrationDisabled === true;
  const [mounted, setMounted] = createSignal(false);
  const [items, setItems] = createSignal<readonly Item[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [state, setState] = createSignal<"loading" | "ready" | "error">(
    "loading",
  );
  const [loadingMore, setLoadingMore] = createSignal(false);
  let generation = 0;
  let disposed = false;
  let abort: AbortController | undefined;
  const load = async (more = false) => {
    if (!mounted() || (more && (loadingMore() || !cursor()))) return;
    const request = ++generation;
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const personaId = props.profileId;
    const previousCursor = more ? cursor() : null;
    if (more) setLoadingMore(true);
    else {
      setItems([]);
      setCursor(null);
      setState("loading");
      setLoadingMore(false);
    }
    try {
      const page = await props.dependencies.loadPage({
        profileId: personaId,
        cursor: previousCursor,
        signal,
      });
      if (disposed || request !== generation) return;
      if (page.next_cursor !== null && page.next_cursor === previousCursor)
        throw new Error("non_advancing_activity_cursor");
      setItems((prior) => {
        const base = more ? prior : [];
        const seen = new Set(
          base.map((item) => `${item.kind}:${item.activity_id}`),
        );
        return [
          ...base,
          ...page.items.filter((item) => {
            const key = `${item.kind}:${item.activity_id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        ];
      });
      setCursor(page.next_cursor);
      setState("ready");
    } catch {
      if (!disposed && request === generation) setState("error");
    } finally {
      if (!disposed && request === generation) setLoadingMore(false);
    }
  };
  onSettled(() => {
    if (typeof window === "undefined") return;
    queueMicrotask(() => {
      if (!disposed) setMounted(true);
    });
    const unsubscribe = props.dependencies.subscribeSession?.(() => {
      void load();
    });
    return unsubscribe;
  });
  createEffect(
    () => [mounted(), props.profileId, props.dependencies] as const,
    ([ready]) => {
      const revision = ++generation;
      abort?.abort();
      queueMicrotask(() => {
        if (ready && !disposed && revision === generation) void load();
      });
    },
  );
  onCleanup(() => {
    disposed = true;
    generation++;
    abort?.abort();
  });
  return (
    <Show when={!disabled}>
      <section aria-label="Posts" data-profile-activity>
        <Show
          when={mounted() && state() !== "loading"}
          fallback={
            <Type class="block py-5" role="status" variant="body">
              Loading posts…
            </Type>
          }
        >
          <div class="flex flex-col">
            <For each={items()}>{(item) => <ActivityItem item={item} />}</For>
          </div>
          <Show when={state() === "ready" && items().length === 0}>
            <Type as="p" class="py-5" variant="body">
              No posts to show.
            </Type>
          </Show>
          <Show when={state() === "error"}>
            <div class="flex flex-col items-start gap-3 py-5">
              <Type role="alert" variant="body">
                Posts could not be loaded.
              </Type>
              <Button
                variant="secondary"
                onClick={() => {
                  void load(items().length > 0);
                }}
              >
                Try again
              </Button>
            </div>
          </Show>
          <Show when={state() === "ready" && cursor()}>
            <div class="py-5">
              <Button
                variant="secondary"
                disabled={loadingMore()}
                onClick={() => {
                  void load(true);
                }}
              >
                {loadingMore() ? "Loading…" : "Load more"}
              </Button>
            </div>
          </Show>
        </Show>
      </section>
    </Show>
  );
}
