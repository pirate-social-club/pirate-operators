/** @jsxImportSource @solidjs/web */
import { createSignal, type Accessor } from "solid-js";
import { createActor, type ActorRefFrom } from "xstate";

import {
  validatePendingSubmissionEnvelope,
  type PendingSubmissionEnvelopeV1,
} from "../post-composer/pending-submission.ts";
import { type TextSubmissionTransport } from "../post-composer/text-submission-transport.ts";
import {
  createTextSubmissionMachine,
  DELAYED_AFTER_ATTEMPTS,
  type TextSubmissionMachine,
  type TextSubmissionRejection,
} from "./text-submission-machine.ts";

export interface TextSubmissionDraft {
  readonly accountId: string;
  readonly communityId: string;
  readonly title: string;
  readonly body: string;
  readonly ageGatePolicy: "none" | "18_plus";
  readonly authorHandle?: string;
  readonly authorAvatarSrc?: string | null;
}

/**
 * What the author's own pending post is doing. `sending` covers every attempt
 * the author does not need to know about; `delayed` is the same work after
 * enough attempts that saying nothing would be misleading. Neither means the
 * post failed: only `rejected` is a server answer that it was refused.
 * `sign_in_required` holds the request until its account is signed in again.
 */
export type TextSubmissionStatus =
  | "sending"
  | "delayed"
  | "sign_in_required"
  | "published"
  | "rejected";

export interface TextSubmissionItem extends TextSubmissionDraft {
  readonly id: string;
  readonly createdAt: string;
  readonly status: TextSubmissionStatus;
  readonly postHref: string | null;
  readonly postId: string | null;
  readonly rejection: TextSubmissionRejection | null;
}

export interface TextSubmissionStore {
  readonly items: Accessor<readonly TextSubmissionItem[]>;
  /** Shows the post at once and delivers it underneath. Returns its id. */
  readonly submit: (draft: TextSubmissionDraft) => string;
  /** Sends the retained request again now instead of waiting for the timer. */
  readonly retry: (id: string) => void;
  /**
   * Stops work on an item and forgets it. For an item the server has not
   * answered this does not cancel anything: a request already sent can still
   * publish. Surfaces offer it only for a published or refused post.
   */
  readonly dismiss: (id: string) => void;
  /**
   * Forgets every item that belongs to a different account. The retained
   * request is dropped without being replayed; an earlier attempt may already
   * have published.
   */
  readonly retainAccount: (accountId: string) => void;
  /**
   * The session ended without the author signing out: hold every request,
   * including one still being prepared, without sending or forgetting it.
   */
  readonly pause: () => void;
  /**
   * The author signed out: stop every retry and forget every request. A
   * request already sent may still have published; nothing is replayed.
   */
  readonly clear: () => void;
  /** This account is signed in: send the requests that were held for it. */
  readonly resume: (accountId: string) => void;
  readonly dispose: () => void;
}

export interface TextSubmissionStoreOptions {
  readonly transport: TextSubmissionTransport;
  /** Pure encoding/signing seam; must not send a post. The real transport is separate. */
  readonly prepareEnvelope: (
    draft: TextSubmissionDraft,
    idempotencyKey: string,
    pendingId: string,
    createdAt: string,
  ) => Promise<PendingSubmissionEnvelopeV1>;
  readonly createId?: () => string;
  readonly now?: () => string;
  /** A post was just held for lack of a session. */
  readonly onSignInRequired?: () => void;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The one owner of text posts in flight. It lives at the application shell, so
 * a post keeps sending after its composer closes and after the author leaves
 * the community. Requests are held in memory only: a reload drops them.
 */
export function createTextSubmissionStore(
  options: TextSubmissionStoreOptions,
): TextSubmissionStore {
  const transport = options.transport;
  let machine: TextSubmissionMachine | undefined;
  const createId = options.createId ?? randomId;
  const now = options.now ?? (() => new Date().toISOString());
  // Written from actor subscriptions and from event handlers inside owned
  // scopes, so the owned-write guard does not apply.
  const [items, setItems] = createSignal<readonly TextSubmissionItem[]>([], {
    ownedWrite: true,
  });
  const actors = new Map<string, ActorRefFrom<TextSubmissionMachine>>();
  let disposed = false;
  // True from the moment the session is known to have ended until an account
  // is signed in again. Read after every await in `start`.
  let paused = false;
  // Ids that still exist, kept apart from the signal so a removal is visible
  // to `start` immediately, before the signal's own write has flushed.
  const live = new Set<string>();

  const patch = (id: string, change: Partial<TextSubmissionItem>) => {
    if (disposed) return;
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...change } : item)),
    );
  };

  const stop = (id: string) => {
    actors.get(id)?.stop();
    actors.delete(id);
  };

  const start = async (id: string, draft: TextSubmissionDraft) => {
    let envelope;
    try {
      const key = createId();
      envelope = await validatePendingSubmissionEnvelope(
        await options.prepareEnvelope(draft, key, id, now()),
      );
      if (
        envelope.idempotency_key !== key ||
        envelope.pending_request_id !== id
      )
        throw new Error("Text envelope identity changed");
    } catch {
      patch(id, { status: "rejected", rejection: "invalid" });
      return;
    }
    // Preparation is asynchronous. The post may have been cleared, or the
    // session may have ended, while it ran; neither may be overridden here.
    if (disposed || !live.has(id)) return;
    machine ??= createTextSubmissionMachine(transport);
    const actor = createActor(machine, { input: { envelope, held: paused } });
    actors.set(id, actor);
    actor.subscribe((snapshot) => {
      if (snapshot.matches("published")) {
        patch(id, {
          status: "published",
          postHref: snapshot.context.postHref,
          postId: snapshot.context.postId,
        });
      } else if (snapshot.matches("rejected")) {
        patch(id, {
          status: "rejected",
          rejection: snapshot.context.rejection,
        });
      } else if (snapshot.matches("signInRequired")) {
        const already =
          items().find((item) => item.id === id)?.status === "sign_in_required";
        patch(id, { status: "sign_in_required" });
        if (!already && !paused) options.onSignInRequired?.();
      } else {
        patch(id, {
          status:
            snapshot.context.attempts >= DELAYED_AFTER_ATTEMPTS
              ? "delayed"
              : "sending",
        });
      }
    });
    actor.start();
  };

  return {
    items,
    submit(draft) {
      const id = createId();
      live.add(id);
      setItems((current) => [
        {
          ...draft,
          id,
          createdAt: now(),
          status: "sending",
          postHref: null,
          postId: null,
          rejection: null,
        },
        ...current,
      ]);
      void start(id, draft);
      return id;
    },
    retry(id) {
      actors.get(id)?.send({ type: "RETRY" });
    },
    dismiss(id) {
      stop(id);
      live.delete(id);
      setItems((current) => current.filter((item) => item.id !== id));
    },
    retainAccount(accountId) {
      for (const item of items()) {
        if (item.accountId === accountId) continue;
        stop(item.id);
        live.delete(item.id);
      }
      setItems((current) =>
        current.some((item) => item.accountId !== accountId)
          ? current.filter((item) => item.accountId === accountId)
          : current,
      );
    },
    pause() {
      // The shell already knows the session ended, so this does not prompt.
      paused = true;
      for (const actor of actors.values()) actor.send({ type: "PAUSE" });
      // A post still being prepared has no actor yet; it shows as held now
      // and `start` begins it held.
      setItems((current) =>
        current.map((item) =>
          item.status === "sending" || item.status === "delayed"
            ? { ...item, status: "sign_in_required" }
            : item,
        ),
      );
    },
    clear() {
      for (const id of [...actors.keys()]) stop(id);
      live.clear();
      setItems((current) => (current.length === 0 ? current : []));
    },
    resume(accountId) {
      paused = false;
      for (const item of items()) {
        if (item.accountId === accountId)
          actors.get(item.id)?.send({ type: "RESUME" });
      }
    },
    dispose() {
      disposed = true;
      live.clear();
      for (const id of [...actors.keys()]) stop(id);
    },
  };
}
