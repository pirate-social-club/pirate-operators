// App-owned original-ticket history. No activity client, private body, audio or
// credential is retained with metadata. Cookies/server guards own authority.
import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  isLearningAuthorityLoss,
  learningRequest,
} from "./operator-learning-http.ts";

export interface KaraokeHistoryTicket {
  readonly communityId: string;
  readonly postId: string;
  readonly ticketId: string;
  readonly sessionId: string;
  readonly wallet: string;
}
export interface KaraokeHistorySession {
  communityId: string;
  wallet: string;
  authorId: string;
  accountId: string | null;
  generation: number;
  csrf: string;
}
const bytes32 = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
const wallet = (value: unknown): value is string =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);
const uuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

/** Project the canonical terminal result, never a new/recovered ticket. */
export function karaokeHistoryTicket(
  value: unknown,
  scope: { communityId: string; postId: string; wallet: string },
): KaraokeHistoryTicket | null {
  const result = value as {
    ticketId?: unknown;
    attemptId?: unknown;
    communityId?: unknown;
  } | null;
  if (
    !result ||
    !bytes32(result.ticketId) ||
    !bytes32(result.attemptId) ||
    !bytes32(scope.communityId) ||
    !bytes32(scope.postId) ||
    !wallet(scope.wallet) ||
    result.communityId !== scope.communityId
  )
    return null;
  return Object.freeze({
    communityId: scope.communityId,
    postId: scope.postId,
    ticketId: result.ticketId,
    sessionId: result.attemptId,
    wallet: scope.wallet.toLowerCase(),
  });
}
export function createSavedKaraokeHistory(
  session: () => KaraokeHistorySession | null,
) {
  const [saved, setSaved] = createSignal<{
    ticket: KaraokeHistoryTicket;
    accountId: string | null;
    authorId: string;
    generation: number;
  } | null>(null);
  let active = true,
    revision = 0;
  let pending: AbortController | undefined;
  const same = (
    value: NonNullable<ReturnType<typeof saved>>,
    auth: KaraokeHistorySession,
  ) =>
    value.generation === auth.generation &&
    value.authorId === auth.authorId &&
    value.ticket.communityId === auth.communityId &&
    value.ticket.wallet === auth.wallet.toLowerCase();
  const clear = () => {
    revision++;
    pending?.abort();
    pending = undefined;
    setSaved(null);
  };
  createEffect(
    () => ({ selected: saved(), auth: session() }),
    ({ selected, auth }) => {
      if (!selected) return;
      if (!auth || !same(selected, auth)) {
        clear();
        return;
      }
      if (!auth.accountId || !uuid(auth.accountId)) return;
      if (selected.accountId === null)
        setSaved({ ...selected, accountId: auth.accountId });
      else if (selected.accountId !== auth.accountId) clear();
    },
  );
  onCleanup(() => {
    active = false;
    clear();
  });
  const available = () => {
    const selected = saved(),
      auth = session();
    return !!(
      active &&
      selected &&
      auth &&
      same(selected, auth) &&
      selected.accountId &&
      auth.accountId &&
      uuid(auth.accountId) &&
      selected.accountId === auth.accountId
    );
  };
  return {
    available,
    clear,
    remember(ticket: KaraokeHistoryTicket, generation: number) {
      const auth = session();
      if (
        !active ||
        !auth ||
        generation !== auth.generation ||
        ticket.communityId !== auth.communityId ||
        ticket.wallet !== auth.wallet.toLowerCase() ||
        !bytes32(ticket.ticketId) ||
        !bytes32(ticket.sessionId) ||
        !bytes32(ticket.postId)
      )
        return;
      const prior = saved();
      if (
        prior &&
        same(prior, auth) &&
        prior.ticket.ticketId === ticket.ticketId &&
        prior.ticket.sessionId === ticket.sessionId &&
        prior.ticket.postId === ticket.postId
      )
        return;
      revision++;
      pending?.abort();
      // Explicit public-field copy: never capture a token, callback or body.
      setSaved({
        ticket: Object.freeze({
          communityId: ticket.communityId,
          postId: ticket.postId,
          ticketId: ticket.ticketId,
          sessionId: ticket.sessionId,
          wallet: ticket.wallet,
        }),
        authorId: auth.authorId,
        generation,
        accountId:
          auth.accountId && uuid(auth.accountId) ? auth.accountId : null,
      });
    },
    async download() {
      const selected = saved(),
        auth = session();
      const requestRevision = ++revision;
      pending?.abort();
      const controller = new AbortController();
      pending = controller;
      const current = () =>
        active &&
        revision === requestRevision &&
        saved() === selected &&
        available();
      if (!selected || !auth || !current())
        throw new Error("Private history is unavailable for this account.");
      const history = await learningRequest<{
        schema?: string;
        activity?: string;
        communityId?: string;
        sessionId?: string;
        source?: { communityId?: string; postId?: string };
      }>("/api/karaoke/history", {
        account: selected.ticket.wallet,
        csrf: auth.csrf,
        body: { ticketId: selected.ticket.ticketId },
        signal: controller.signal,
      }).catch((error: unknown) => {
        if (active && saved() === selected && isLearningAuthorityLoss(error))
          clear();
        throw error;
      });
      if (!current())
        throw new Error("Private history is unavailable for this account.");
      if (
        history?.schema !== "pirate.learner-history/1" ||
        history.activity !== "karaoke" ||
        history.communityId !== selected.ticket.communityId ||
        history.sessionId !== selected.ticket.sessionId ||
        history.source?.communityId !== selected.ticket.communityId ||
        history.source?.postId !== selected.ticket.postId
      )
        throw new Error("Private history could not be downloaded. Try again.");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(history, null, 2)], {
          type: "application/json",
        }),
      );
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = `learning-history-${selected.ticket.ticketId}.json`;
        link.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
  };
}
