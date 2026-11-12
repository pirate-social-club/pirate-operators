import { decodePublicPostSlug } from "../public-post/public-post-route.model.ts";

/** Turning a pasted song link into the post it names.
 *
 * A link is the temporary way to choose a song, because no catalogue operation
 * exists yet: the community reads expose text and video surfaces and there is
 * no song listing to browse. When one lands, this becomes one of two ways in
 * rather than the only one.
 *
 * A song post's ordinary `/posts/<slug>` link is resolvable through the public
 * post read, which answers with the post id the playback access takes. A
 * `/p/<postId>` link and a bare id resolve directly. Anything else is reported
 * as unsupported rather than guessed at, because guessing would produce a
 * confident failure later.
 */
export type SongLinkResult =
  | { readonly kind: "post"; readonly postId: string }
  | { readonly kind: "slug"; readonly slug: string }
  | { readonly kind: "unsupported"; readonly reason: string };

const POST_ID = /^[A-Za-z0-9_-]{6,64}$/u;

function fromPathname(pathname: string): SongLinkResult | null {
  const segments = pathname.split("/").filter(Boolean);
  const legacy = segments.indexOf("p");
  if (
    legacy >= 0 &&
    segments[legacy + 1] &&
    POST_ID.test(segments[legacy + 1])
  ) {
    return { kind: "post", postId: segments[legacy + 1] };
  }
  const posts = segments.indexOf("posts");
  const rawSlug = posts >= 0 ? segments[posts + 1] : undefined;
  if (rawSlug) {
    // A pasted link may carry the post's own activity path; only the first
    // segment after `posts` names the post, so the activity is ignored.
    const decoded = decodePublicPostSlug(rawSlug);
    if (decoded) return { kind: "slug", slug: decoded.logical };
  }
  if (posts >= 0) {
    return {
      kind: "unsupported",
      reason: "That post link doesn’t name a post this composer can read.",
    };
  }
  return null;
}

export function parseSongLink(value: string): SongLinkResult {
  const trimmed = value.trim();
  if (!trimmed)
    return { kind: "unsupported", reason: "Paste a song link or post id." };
  if (POST_ID.test(trimmed) && !trimmed.includes("/")) {
    return { kind: "post", postId: trimmed };
  }
  // A bare path has no host to borrow, so it is read as a path directly rather
  // than being forced through a URL with an empty authority.
  if (trimmed.startsWith("/")) {
    return (
      fromPathname(trimmed) ?? {
        kind: "unsupported",
        reason:
          "No post id in that path. Paste a song link or the post id itself.",
      }
    );
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let pathname: string;
  try {
    pathname = new URL(withScheme).pathname;
  } catch {
    return {
      kind: "unsupported",
      reason: "That does not look like a link or a post id.",
    };
  }
  return (
    fromPathname(pathname) ?? {
      kind: "unsupported",
      reason:
        "No post id in that link. Paste a song link or the post id itself.",
    }
  );
}

const LINK_SHAPE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/iu;

/** Whether text typed into a search field is a pasted link rather than a
 * search. A scheme or a leading slash says so outright, and an unsupported one
 * still goes to the composer, which says why it cannot be used. Any other text
 * that contains a slash counts only when the parser reads it as a post or a
 * slug, so a title such as "AC/DC" stays a search. A bare word never counts:
 * the parser reads any six to sixty-four letter word as a post id. */
export function looksLikeSongLink(value: string): boolean {
  const trimmed = value.trim();
  if (LINK_SHAPE.test(trimmed)) return true;
  return trimmed.includes("/") && parseSongLink(trimmed).kind !== "unsupported";
}
