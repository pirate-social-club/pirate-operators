import type {
  DanceCapture,
  DanceConsentPolicy,
  DanceReview,
} from "../../../../../packages/dance/contracts.ts";
import type {
  MediaIntent,
  MediaStatus,
} from "../../../../../packages/community-media/contracts.ts";
import type { DanceClient } from "../client.ts";
import type { DanceJourneyStore } from "./journey-store.ts";
import type { BufferedGuideSource } from "./platform/buffered-guide.ts";
import { producerDigest } from "./digests.ts";
import type { DanceRecordingStorage } from "./dance-recording.ts";

/** Private accountId must be the authenticated owner producer's value. Public
 * author/wallet/profile IDs have no authority here. Session key fences awaits. */
export interface DanceAccount {
  readonly accountId: string;
  readonly sessionKey: string;
  readonly profileLabel: string;
}
export interface DanceAccountPort {
  load(signal: AbortSignal): Promise<DanceAccount | null>;
  current(): DanceAccount | null;
  subscribe(invalidated: () => void): () => void;
}
export interface DanceTarget {
  readonly communityId: string;
  readonly songKey: string;
  readonly songRevision: number;
  readonly audioSha256: string;
  readonly reference: null | { readonly id: string; readonly revision: number };
  readonly offerId: string | null;
}
export interface DanceScope extends DanceTarget, DanceAccount {}
export type DanceCaptureTarget = DanceTarget & { accountId: string };
export function captureTarget(c: DanceCapture): DanceCaptureTarget {
  return {
    accountId: c.learner.accountId,
    communityId: c.communityId,
    songKey: c.songKey,
    songRevision: c.songRevision,
    audioSha256: c.audioSha256,
    reference: c.reference
      ? { id: c.reference.id, revision: c.reference.revision }
      : null,
    offerId: c.offer?.offerId ?? null,
  };
}
/** Session lifetime is intentionally excluded from durable resource identity.
 * Same-account recovery revalidates fresh HTTP access; old command bytes stay. */
export const danceTargetKey = (s: DanceTarget & { accountId: string }) =>
  JSON.stringify([
    s.accountId,
    s.communityId,
    s.songKey,
    s.songRevision,
    s.audioSha256,
    s.reference?.id ?? null,
    s.reference?.revision ?? null,
    s.offerId,
  ]);
export const danceScopeKey = (s: DanceScope) =>
  JSON.stringify([danceTargetKey(s), s.sessionKey]);
export function assertCapture(c: DanceCapture, s: DanceCaptureTarget) {
  producerDigest(c.audioSha256);
  const durationMs = c.durationSamples / 48;
  if (
    c.version !== "pirate.dance/1" ||
    c.communityId !== s.communityId ||
    c.learner.accountId !== s.accountId ||
    c.songKey !== s.songKey ||
    c.songRevision !== s.songRevision ||
    c.audioSha256 !== s.audioSha256 ||
    (c.reference?.id ?? null) !== (s.reference?.id ?? null) ||
    (c.reference?.revision ?? null) !== (s.reference?.revision ?? null) ||
    (c.offer?.offerId ?? null) !== s.offerId ||
    c.policy !== "moderator-review-policy-v2" ||
    !Number.isSafeInteger(c.startSample) ||
    c.startSample < 0 ||
    !Number.isSafeInteger(c.durationSamples) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 6000 ||
    durationMs > 30000 ||
    !Number.isSafeInteger(c.reservedAtMs) ||
    !Number.isSafeInteger(c.expiresAtMs) ||
    c.expiresAtMs <= c.reservedAtMs ||
    !c.consent ||
    c.consent.accountId !== s.accountId ||
    c.consent.captureId !== c.captureId ||
    c.consent.captureHash !== c.captureHash ||
    c.consent.accepted !== true ||
    !Number.isSafeInteger(c.consent.acceptedAtMs) ||
    c.consent.acceptedAtMs < c.reservedAtMs ||
    c.consent.acceptedAtMs >= c.expiresAtMs
  )
    throw Error("dance_preparation_target_changed");
}
export interface DanceReferenceChoice extends DanceTarget {
  readonly title: string;
  readonly durationMs: number;
  readonly posterUrl?: string;
  readonly playback: "ready" | "pending" | "unavailable";
  readonly recordingAllowed: boolean;
}
export interface DanceCatalogue {
  options(
    input: {
      communityId: string;
      songKey: string;
      accountId: string;
      cursor?: string;
    },
    signal: AbortSignal,
  ): Promise<{
    readonly choices: readonly DanceReferenceChoice[];
    readonly consent: DanceConsentPolicy;
    readonly owner: boolean;
    readonly cursor: string | null;
  }>;
  latest(scope: DanceScope, signal: AbortSignal): Promise<DanceReview | null>;
}
/** This is the one source3 private producer, not a new renderer/uploader. Each
 * method must enforce expected account before private access and after awaits.
 * Unknown PUT recovery must read status before another conditional same-file PUT. */
export interface DancePrivateMediaPort {
  readonly version: "pirate.dance-private-media-ui/1";
  readonly maximumBytes: number;
  reserve(
    capture: DanceCapture,
    intent: MediaIntent,
    signal: AbortSignal,
  ): Promise<MediaStatus>;
  upload(
    capture: DanceCapture,
    mediaId: string,
    file: File,
    signal: AbortSignal,
  ): Promise<MediaStatus>;
  status(
    capture: DanceCapture,
    mediaId: string,
    signal: AbortSignal,
  ): Promise<MediaStatus>;
  retry(
    capture: DanceCapture,
    mediaId: string,
    signal: AbortSignal,
  ): Promise<MediaStatus>;
  /** Current same-account review permission on every GET/HEAD/range. */
  playback(
    review: DanceReview,
    signal: AbortSignal,
  ): Promise<{ url: string; expiresAtMs: number }>;
}
export interface DancePlaybackPort {
  /** Complete bytes for exact canonical audioSha256; verify before resolving. */
  guide(
    capture: DanceCapture,
    signal: AbortSignal,
  ): Promise<BufferedGuideSource>;
  reference(
    target: DanceTarget,
    signal: AbortSignal,
  ): Promise<{ url: string; expiresAt: number; renewAt: number }>;
}
export interface DanceSourcePorts {
  readonly scope: DanceScope;
  readonly currentScope: () => DanceScope | null;
  readonly client: DanceClient;
  readonly consent: DanceConsentPolicy;
  readonly media: DancePrivateMediaPort;
  readonly playback: DancePlaybackPort;
  readonly journal: DanceJourneyStore;
  readonly recordingStorage?: DanceRecordingStorage;
  /** Fresh server check of the EXACT captured authorization before accepting
   * camera/guide; concrete backend route/assembly is a coordinator proposal. */
  readonly captureAccess: (
    capture: DanceCapture,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispose?: () => void;
  readonly nowMs?: () => number;
}
export function assertCurrent(
  options: Pick<DanceSourcePorts, "scope" | "currentScope">,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const actual = options.currentScope();
  if (!actual || danceScopeKey(actual) !== danceScopeKey(options.scope))
    throw Error("dance_session_changed");
}
