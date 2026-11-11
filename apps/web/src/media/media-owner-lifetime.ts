/** Presentation callback custody only; no service or state-machine substitute. */
export function createMediaOwnerLifetime(
  accountId: string,
  communityId: string,
  currentOwner: () => {
    readonly accountId: string;
    readonly communityId: string;
  },
) {
  let generation = 0;
  let disposed = false;
  const current = () => {
    const owner = currentOwner();
    if (owner.accountId !== accountId || owner.communityId !== communityId) {
      disposed = true;
      generation++;
    }
    return (
      !disposed &&
      owner.accountId === accountId &&
      owner.communityId === communityId
    );
  };
  return {
    current,
    capture() {
      const captured = generation;
      return () => captured === generation && current();
    },
    queue(notificationCurrent: () => boolean, work: () => void) {
      const captured = generation;
      queueMicrotask(() => {
        if (captured === generation && current() && notificationCurrent())
          work();
      });
    },
    dispose() {
      disposed = true;
      generation++;
    },
  };
}
