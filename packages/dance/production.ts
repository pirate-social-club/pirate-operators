import type { DanceConsentPolicy } from "./contracts.ts";

/** Same-origin production DTOs. Selection is supplied by the selected canonical
 * song/rules producer, never reconstructed from public profile metadata. */
export interface DanceProductionTarget {
  communityId: string;
  songKey: string;
  songRevision: number;
  audioSha256: string;
  reference: { id: string; revision: number } | null;
  offerId: string | null;
}
export interface DanceProductionChoice extends DanceProductionTarget {
  title: string;
  durationMs: number;
  posterUrl?: string;
  playback: "ready" | "pending" | "unavailable";
  recordingAllowed: boolean;
}
export interface DanceCataloguePage {
  version: "pirate.dance-catalogue/1";
  communityId: string;
  accountId: string;
  choices: readonly DanceProductionChoice[];
  consent: DanceConsentPolicy;
  owner: boolean;
  cursor: string | null;
}
export type DanceGuideAccess =
  | { access: "public"; playback_url: string; expires_at?: never }
  | { access?: "lease"; playback_url: string; expires_at: number };
export type DanceGuideGrant = Pick<
  DanceProductionTarget,
  "communityId" | "songKey" | "songRevision" | "audioSha256"
> & DanceGuideAccess;
export interface DanceReferenceGrant {
  target: DanceProductionTarget;
  url: string;
  expiresAt: number;
  renewAt: number;
}
export function sameDanceTarget(a: DanceProductionTarget, b: DanceProductionTarget) {
  return a.communityId === b.communityId && a.songKey === b.songKey &&
    a.songRevision === b.songRevision && a.audioSha256 === b.audioSha256 &&
    (a.reference?.id ?? null) === (b.reference?.id ?? null) &&
    (a.reference?.revision ?? null) === (b.reference?.revision ?? null) &&
    a.offerId === b.offerId;
}
export function validDanceTarget(value: unknown): value is DanceProductionTarget {
  if (!value || typeof value !== "object") return false;
  const v = value as DanceProductionTarget;
  const digest = (s: unknown) => typeof s === "string" && /^0x[0-9a-f]{64}$/.test(s) && !/^0x0+$/.test(s);
  const id = (s: unknown) => typeof s === "string" && /^[a-zA-Z0-9_:-]{1,128}$/.test(s);
  return digest(v.communityId) && digest(v.songKey) && digest(v.audioSha256) &&
    Number.isSafeInteger(v.songRevision) && v.songRevision > 0 &&
    (v.offerId === null || id(v.offerId)) &&
    (v.reference === null || (!!v.reference && id(v.reference.id) &&
      Number.isSafeInteger(v.reference.revision) && v.reference.revision > 0));
}
