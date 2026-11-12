import type {
  DanceCapture,
  DanceConsentPolicy,
} from "../../../../../packages/dance/contracts.ts";
import { createDanceClient } from "../client.ts";
import {
  createBrowserDanceJourneyStore,
  type DanceJourneyStore,
} from "./journey-store.ts";
import {
  danceScopeKey,
  type DanceAccount,
  type DanceTarget,
  type DancePrivateMediaPort,
  type DancePlaybackPort,
  type DanceSourcePorts,
} from "./ports.ts";

/** Real same-origin Dance API + existing one private media producer. Required
 * ports have no fixture/default-success implementation in production. Construct
 * once per mounted account/session/target; dispose on any lifetime change. */
export function createDanceSourceServices(input: {
  readonly account: DanceAccount;
  readonly target: DanceTarget;
  readonly current: () => (DanceAccount & DanceTarget) | null;
  readonly consent: DanceConsentPolicy;
  readonly csrf: string;
  readonly media: DancePrivateMediaPort;
  readonly playback: DancePlaybackPort;
  readonly captureAccess: (
    capture: DanceCapture,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly journal?: DanceJourneyStore;
  readonly fetcher?: typeof fetch;
}): DanceSourcePorts {
  const scope = Object.freeze({
    ...input.target,
    ...input.account,
    reference: input.target.reference
      ? Object.freeze({ ...input.target.reference })
      : null,
  });
  if (
    !scope.accountId ||
    !scope.sessionKey ||
    !input.csrf ||
    input.media.version !== "pirate.dance-private-media-ui/1" ||
    typeof input.captureAccess !== "function" ||
    typeof input.playback.guide !== "function" ||
    typeof input.playback.reference !== "function"
  )
    throw Error("dance_source_port_unavailable");
  let disposed = false;
  const currentScope = () => {
    const value = input.current();
    return !disposed && value && danceScopeKey(value) === danceScopeKey(scope)
      ? value
      : null;
  };
  const client = createDanceClient({
    communityId: scope.communityId,
    accountId: scope.accountId,
    csrf: input.csrf,
    isCurrent: () => !!currentScope(),
    fetcher: input.fetcher,
  });
  return {
    scope,
    currentScope,
    client,
    consent: Object.freeze({ ...input.consent }),
    media: input.media,
    playback: input.playback,
    journal: input.journal ?? createBrowserDanceJourneyStore(),
    captureAccess: input.captureAccess,
    dispose: () => {
      disposed = true;
      client.dispose();
    },
  };
}
