import type { SongPlaybackGrant } from "../playback-access.ts";

export type PlaybackAccessReader = (
  postId: string,
) => Promise<SongPlaybackGrant>;

/**
 * A reader is an immutable access context. A changed account/access authority
 * must supply a different reader. Weak ownership avoids retaining that context
 * once its mounts and outstanding requests are gone. Never key bearer access
 * solely by a public post identifier.
 */
export function createPlaybackAccessCache() {
  type Listener = (grant: SongPlaybackGrant) => void;
  const contexts = new WeakMap<
    PlaybackAccessReader,
    {
      grants: Map<string, SongPlaybackGrant>;
      listeners: Map<string, Set<Listener>>;
    }
  >();
  const context = (reader: PlaybackAccessReader) => {
    let value = contexts.get(reader);
    if (!value) {
      value = { grants: new Map(), listeners: new Map() };
      contexts.set(reader, value);
    }
    return value;
  };
  return {
    read(reader: PlaybackAccessReader, postId: string, nowSeconds: number) {
      const grant = context(reader).grants.get(postId);
      return grant &&
        (grant.renew_after === undefined || grant.renew_after > nowSeconds)
        ? grant
        : undefined;
    },
    publish(
      reader: PlaybackAccessReader,
      postId: string,
      grant: SongPlaybackGrant,
    ) {
      const { grants, listeners } = context(reader);
      grants.delete(postId);
      grants.set(postId, grant);
      while (grants.size > 32) {
        const oldest = grants.keys().next().value;
        if (oldest === undefined) break;
        grants.delete(oldest);
      }
      // Late access can reach a replacement only within the captured reader.
      for (const listener of listeners.get(postId) ?? []) listener(grant);
    },
    subscribe(
      reader: PlaybackAccessReader,
      postId: string,
      listener: Listener,
    ) {
      const { listeners } = context(reader);
      const current = listeners.get(postId) ?? new Set<Listener>();
      current.add(listener);
      listeners.set(postId, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(postId);
      };
    },
  };
}
