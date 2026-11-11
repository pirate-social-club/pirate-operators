import { isServer } from "@solidjs/web";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { createProfileClient, type ProfileClient } from "./client.ts";
import {
  createProfileController,
  type ProfileControllerState,
  type ProfileIdentity,
} from "./controller.ts";

/** Call inside App's existing Solid owner. No effects before real bootstrap. */
export function createCommunityProfileIntegration(options: {
  communityId: () => string;
  identity: () => ProfileIdentity | null;
  ready: () => boolean;
  client?: (communityId: string) => ProfileClient;
}) {
  const [state, setState] = createSignal<ProfileControllerState>({
    view: { kind: "loading" },
    mutation: "idle",
  });
  const key = () => {
    const value = options.identity();
    return `${options.communityId()}:${value ? `${value.scopeKey}:${value.authorId}:${value.csrf}` : "anonymous"}`;
  };
  const [stateKey, setStateKey] = createSignal("");
  const publish = (value: ProfileControllerState) => {
    setStateKey(key());
    setState(value);
  };
  const safeState = (): ProfileControllerState =>
    options.ready() && stateKey() === key()
      ? state()
      : { view: { kind: "loading" }, mutation: "idle" };
  let active: ReturnType<typeof createProfileController> | undefined;
  const [client, setClient] = createSignal<ProfileClient | undefined>(
    undefined,
  );
  let community = "";
  createEffect(
    () =>
      [
        options.ready(),
        options.communityId(),
        options.identity()?.scopeKey,
        options.identity()?.authorId,
        options.identity()?.csrf,
      ] as const,
    ([ready, id]) => {
      if (!ready || !id) {
        active?.dispose();
        active = undefined;
        setClient(undefined);
        community = "";
        setState({ view: { kind: "loading" }, mutation: "idle" });
        return;
      }
      if (community !== id || !active) {
        active?.dispose();
        community = id;
        const created = (options.client ?? createProfileClient)(id);
        setClient(created);
        active = createProfileController({
          client: created,
          identity: options.identity,
          changed: publish,
        });
      }
      if (isServer) return;
      active.sync();
      void active.load();
    },
  );
  onCleanup(() => {
    active?.dispose();
    active = undefined;
    setClient(undefined);
  });
  return {
    state: safeState,
    client,
    authorityKey: () => {
      const value = options.identity();
      return value ? `${value.scopeKey}:${value.authorId}` : "anonymous";
    },
    controller: () => active,
    ownerAccountId: () => {
      const current = safeState();
      return current.view.kind === "ready" &&
        options.identity()?.authorId === current.view.owner.profile.authorId
        ? current.view.owner.accountId
        : undefined;
    },
  };
}
export type CommunityProfileIntegration = ReturnType<
  typeof createCommunityProfileIntegration
>;
