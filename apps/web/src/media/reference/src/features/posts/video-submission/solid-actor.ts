import { createSignal, onCleanup } from "solid-js";
import { isServer } from "@solidjs/web";
import type { AnyActorRef, EventFrom, SnapshotFrom } from "xstate";

/** One actor belongs to one Solid owner. Sends are deferred because XState
 * subscriptions can run in the same stack as send, including inside a Solid
 * effect. Solid 2 does not permit that subscription to write its signal there. */
export function useOwnedActor<TActor extends AnyActorRef>(actor: TActor) {
  // SAFETY: SnapshotFrom is derived from this exact actor's logic; getSnapshot
  // returns that logic's current snapshot before and after start.
  const [snapshot, setSnapshot] = createSignal<SnapshotFrom<TActor>>(
    actor.getSnapshot() as SnapshotFrom<TActor>,
    {
      equals: false,
      ownedWrite: true,
    },
  );
  let disposed = false;
  const subscription = actor.subscribe((next) => {
    if (!disposed) {
      // SAFETY: XState emits snapshots from the same actor subscribed above.
      setSnapshot(() => next as SnapshotFrom<TActor>);
    }
  });
  if (!isServer) actor.start();
  onCleanup(() => {
    disposed = true;
    subscription.unsubscribe();
    actor.stop();
  });
  const send = (event: EventFrom<TActor>) => {
    queueMicrotask(() => {
      if (!disposed) actor.send(event);
    });
  };
  return { snapshot, send };
}
