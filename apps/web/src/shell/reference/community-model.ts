import type { JSX } from "@solidjs/web";
import type { SongPlaybackGrant } from "../playback-access.ts";

// Presentation projection only. Absent backend facts remain absent.
export interface CommunityPost {
  readonly id: string;
  readonly kind: "song" | "text" | "video";
  readonly title: string;
  readonly body: string;
  /** Opaque commitment for lookup/recovery only; never a display identity. */
  readonly technicalAuthorId?: string;
  readonly authorHandle?: string;
  readonly authorAvatarSrc?: string;
  readonly authorPersonaId?: string;
  readonly authorHref?: string;
  readonly publishedAt?: string;
  readonly mediaSrc?: string;
  readonly mediaTitle?: string;
  readonly mediaArtist?: string;
  readonly readPlayback: (id: string) => Promise<SongPlaybackGrant>;
  readonly video?: JSX.Element;
}
export interface CommunityData {
  readonly id: string;
  readonly name: string;
  readonly handle?: string;
  readonly description?: string;
  readonly avatarSrc?: string;
  readonly bannerSrc?: string;
  readonly members?: number;
  readonly followers?: number;
  readonly posts: readonly CommunityPost[];
  readonly rules?: readonly { title: string; body: string; position: number }[];
  readonly referenceLinks?: readonly {
    label: string;
    href: string;
    position: number;
  }[];
}
export type CommunityFeed =
  | { readonly kind: "ready"; readonly posts: readonly CommunityPost[] }
  | { readonly kind: "loading" }
  | { readonly kind: "error" };
export const orderedCommunityRules = (
  items: NonNullable<CommunityData["rules"]>,
) => [...items].sort((a, b) => a.position - b.position);
export const orderedReferenceLinks = (
  items: NonNullable<CommunityData["referenceLinks"]>,
) => [...items].sort((a, b) => a.position - b.position);
export function safeCommunityHref(href: string): string | null {
  const value = href.trim();
  return (value.startsWith("/") && !value.startsWith("//")) ||
    value.startsWith("https:")
    ? value
    : null;
}
