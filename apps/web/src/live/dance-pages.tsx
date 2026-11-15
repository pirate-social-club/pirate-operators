import { createMemo, onCleanup, Show, untrack } from "solid-js";
import type { DanceReview } from "../../../../packages/dance/contracts.ts";
import { DanceProductionMount } from "../dance/production.tsx";
import type { DanceSessionProducer } from "../dance/source/production-account.ts";
import type { DanceRoute } from "../shell/routing.ts";
import { Button, Type } from "../dance/design-system.ts";
import type { CommunityDanceCapability } from "./api.ts";

/** The default App reaches this real composition. There is no producer override.
 * A missing selected server policy never constructs private feature services. */
export function DancePageMount(props: {
  communityId: string;
  route: DanceRoute;
  session: DanceSessionProducer;
  capability: CommunityDanceCapability | null;
  loading: boolean;
  onBack(): void;
  onSignIn(): void;
  onReview(review: DanceReview): void;
  onManage(reviewId: string): void;
  onAccessLost(): void;
}) {
  const snapshot = createMemo(() => {
    const route = props.route, capability = props.capability;
    const session = props.session.current();
    if (route.kind !== "dance" || !capability || props.loading ||
      capability.communityId !== props.communityId ||
      (route.communityId !== undefined && route.communityId !== props.communityId))
      return null;
    return {
      route: route.route,
      communityId: props.communityId,
      maximumBytes: capability.media.maximumBytes,
      generation: session?.generation ?? null,
    };
  });
  return <Show when={props.route.kind !== "none"}>
    <div class="live-study-overlay" data-dance-normal-entry>
      <Show when={snapshot()} fallback={
        <main class="mx-auto flex max-w-2xl flex-col gap-4 px-5 py-8">
          <Type as="h1" variant="h2">Dance</Type>
          <p role={props.loading ? "status" : "alert"} aria-busy={props.loading ? "true" : "false"}>
            {props.loading ? "Loading dances…" : props.route.kind === "invalid"
              ? "This dance link is invalid."
              : "Dance is unavailable in this community. Go back and try again."}
          </p>
          <Button variant="secondary" onClick={props.onBack}>Back to song</Button>
        </main>
      } keyed>{owner => {
        let alive = true;
        onCleanup(() => { alive = false; });
        const owns = () => alive && snapshot() === owner &&
          (props.session.current()?.generation ?? null) === owner.generation;
        // The host key owns this lifetime. Read the real session untracked
        // inside the nested mount to avoid creating a transient second owner.
        const session: DanceSessionProducer = {
          current: () => untrack(props.session.current),
          subscribe: props.session.subscribe,
        };
        return <DanceProductionMount
          session={session}
          communityId={owner.communityId}
          route={owner.route}
          maximumBytes={owner.maximumBytes}
          onBack={() => { if (owns()) props.onBack(); }}
          onSignIn={() => { if (owns()) props.onSignIn(); }}
          onReview={review => {
            if (owns() && review.capture.communityId === owner.communityId)
              props.onReview(review);
          }}
          onManage={id => { if (owns()) props.onManage(id); }}
          onAccessLost={() => {
            // Planned mask/disposal has current() === null. Its old callback
            // cannot sign out a successor. Real denial retains this generation.
            if (owns() && owner.generation !== null) props.onAccessLost();
          }}
        />;
      }}</Show>
    </div>
  </Show>;
}
