import type { OwnerProfile } from "../../../../../packages/community-profile/contracts.ts";
import { createProfileClient, ProfileRequestError } from "../../shell/profiles/client.ts";
import { DanceClientError } from "../client.ts";
import type { DanceAccount, DanceAccountPort } from "./ports.ts";

/** Root's authenticated session lifetime. generation changes BEFORE publishing a
 * different session/community. Neither public authorId nor wallet is accountId. */
export interface DanceSessionProducer {
  /** authorId is correlation only; it NEVER supplies private accountId. */
  current(): { communityId: string; generation: string; csrf: string; authorId: string } | null;
  subscribe(invalidated: () => void): () => void;
}
export function createProductionDanceAccount(input: {
  session: DanceSessionProducer;
  owner?: (communityId: string, signal: AbortSignal) => Promise<OwnerProfile>;
  fetcher?: typeof fetch;
}) {
  let disposed = false, revision = 0;
  let deniedKey: string | null = null;
  let retained: { account: DanceAccount; key: string; communityId: string; csrf: string } | null = null;
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  const key = () => {
    const s = input.session.current();
    return s ? JSON.stringify([s.communityId, s.generation, s.csrf, s.authorId]) : null;
  };
  const invalidate = () => {
    revision++;
    retained = null;
    for (const request of requests) request.abort();
    for (const notify of [...listeners]) {
      try { notify(); } catch { /* A listener cannot keep another private view alive. */ }
    }
  };
  const unsubscribe = input.session.subscribe(invalidate);
  const current = () => !disposed && retained && retained.key === key() ? retained.account : null;
  const port: DanceAccountPort = {
    current,
    subscribe(notify) { listeners.add(notify); return () => { listeners.delete(notify); }; },
    async load(signal) {
      signal.throwIfAborted();
      const session = input.session.current(), original = key(), attempt = revision;
      if (disposed || !session || !original || deniedKey === original) return null;
      if (current()) return current();
      const pending = new AbortController();
      requests.add(pending);
      try {
        const owner = await (input.owner ?? ((id, s) => createProfileClient(id, input.fetcher).owner(s)))(
          session.communityId, AbortSignal.any([signal, pending.signal]),
        );
        signal.throwIfAborted();
        if (disposed || pending.signal.aborted || revision !== attempt || key() !== original)
          throw new DanceClientError("dance_account_changed");
        if (owner.schema !== "pirate.community-profile-owner/1" ||
          owner.communityId !== session.communityId || owner.profile.communityId !== session.communityId ||
          owner.profile.authorId !== session.authorId ||
          !owner.accountId || !session.generation || !session.csrf)
          throw new DanceClientError("dance_owner_account_required");
        retained = { key: original, communityId: session.communityId, csrf: session.csrf,
          account: Object.freeze({ accountId: owner.accountId, sessionKey: session.generation,
            profileLabel: owner.profile.displayName?.trim() || "Your profile" }) };
        return retained.account;
      } catch (error) {
        // An old response must never invalidate or publish into a later lifetime.
        if (!disposed && attempt === revision && key() === original &&
          error instanceof ProfileRequestError && [401, 403].includes(error.status)) {
          deniedKey = original;
          invalidate();
          throw new DanceClientError(error.code, false, error.status);
        }
        throw error;
      } finally { requests.delete(pending); }
    },
  };
  return {
    account: port,
    currentOwner: () => current() && retained ? { ...retained.account,
      communityId: retained.communityId, csrf: retained.csrf } : null,
    invalidate,
    deny() { deniedKey = key(); invalidate(); },
    dispose() { if (disposed) return; disposed = true; unsubscribe(); invalidate(); listeners.clear(); },
  };
}
