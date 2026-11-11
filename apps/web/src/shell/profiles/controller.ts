import type {
  OwnerProfile,
  ProfileMutation,
  ProfileMutationReceipt,
} from "../../../../../packages/community-profile/contracts.ts";
import { ProfileRequestError, type ProfileClient } from "./client.ts";
export interface ProfileIdentity {
  authorId: string;
  csrf: string;
  scopeKey: string;
}
export type OwnerProfileState =
  | { kind: "loading" | "anonymous" | "unavailable" }
  | { kind: "ready"; owner: OwnerProfile };
export interface ProfileControllerState {
  view: OwnerProfileState;
  mutation: "idle" | "saving" | "unknown" | "conflict";
}

/** Private memory belongs to one captured authenticated session, never storage. */
export function createProfileController(options: {
  client: ProfileClient;
  identity: () => ProfileIdentity | null;
  changed: (state: ProfileControllerState) => void;
}) {
  let state: ProfileControllerState = {
    view: { kind: "loading" },
    mutation: "idle",
  };
  let scope = "",
    generation = 0,
    alive = true,
    request: AbortController | undefined;
  let pending: Readonly<ProfileMutation> | null = null;
  const key = () => {
    const value = options.identity();
    return value
      ? `${value.scopeKey}:${value.authorId}:${value.csrf}`
      : "anonymous";
  };
  const emit = (next: ProfileControllerState) => {
    state = next;
    options.changed(next);
  };
  const reset = () => {
    generation++;
    request?.abort();
    request = undefined;
    pending = null;
    emit({ view: { kind: "loading" }, mutation: "idle" });
  };
  const sync = () => {
    const next = key();
    if (next !== scope) {
      scope = next;
      reset();
    }
  };
  const start = () => {
    sync();
    request?.abort();
    request = new AbortController();
    const captured = key(),
      revision = ++generation;
    return {
      signal: request.signal,
      current: () =>
        alive &&
        revision === generation &&
        captured === key() &&
        !request?.signal.aborted,
    };
  };
  const apply = (receipt: ProfileMutationReceipt) => {
    const identity = options.identity();
    if (
      !identity ||
      receipt.mutationId !== pending?.mutationId ||
      receipt.profile.authorId !== identity.authorId ||
      state.view.kind !== "ready" ||
      receipt.profile.communityId !== state.view.owner.communityId
    )
      throw new ProfileRequestError(503, "profile_authority_changed");
    const owner = {
      ...state.view.owner,
      profile:
        receipt.profile.revision < state.view.owner.profile.revision
          ? state.view.owner.profile
          : receipt.profile,
    };
    pending = null;
    emit({ view: { kind: "ready", owner }, mutation: "idle" });
  };
  const load = async () => {
    const task = start(),
      identity = options.identity();
    emit({ ...state, view: { kind: "loading" } });
    try {
      const owner = await options.client.owner(task.signal);
      if (!task.current()) return;
      if (!identity || owner.profile.authorId !== identity.authorId)
        throw new ProfileRequestError(503, "profile_authority_changed");
      emit({ ...state, view: { kind: "ready", owner } });
    } catch (error) {
      if (task.current())
        emit({
          ...state,
          view: {
            kind:
              error instanceof ProfileRequestError && error.status === 401
                ? "anonymous"
                : "unavailable",
          },
        });
    }
  };
  const send = async () => {
    sync();
    if (!pending || state.mutation === "saving" || state.view.kind !== "ready")
      return;
    const identity = options.identity(),
      body = pending;
    if (!identity) return;
    const task = start();
    emit({ ...state, mutation: "saving" });
    try {
      // Always reconcile an ambiguous command before replaying its exact bytes.
      const known = await options.client.receipt(body.mutationId, task.signal);
      if (!task.current()) return;
      const result =
        known ?? (await options.client.save(body, identity.csrf, task.signal));
      if (task.current()) apply(result);
    } catch (error) {
      if (!task.current()) return;
      const definite =
        error instanceof ProfileRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 403;
      if (definite) pending = null;
      const authorityLost =
        error instanceof ProfileRequestError &&
        (error.status === 401 || error.status === 403);
      emit({
        ...state,
        ...(authorityLost ? { view: { kind: "unavailable" as const } } : {}),
        mutation: definite ? "conflict" : "unknown",
      });
    }
  };
  return {
    get state() {
      return key() === scope
        ? state
        : { view: { kind: "loading" as const }, mutation: "idle" as const };
    },
    get hasPending() {
      return key() === scope && pending !== null;
    },
    sync,
    load,
    async save(
      fields: Omit<ProfileMutation, "mutationId" | "expectedRevision">,
    ) {
      sync();
      if (pending || state.view.kind !== "ready" || !options.identity())
        throw new Error("profile_save_unavailable");
      pending = Object.freeze({
        ...fields,
        mutationId: crypto.randomUUID(),
        expectedRevision: state.view.owner.profile.revision,
      });
      await send();
    },
    retry: send,
    clear() {
      reset();
    },
    dispose() {
      alive = false;
      reset();
    },
  };
}
