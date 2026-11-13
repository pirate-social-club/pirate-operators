import type { DanceProductionRoute } from "../dance/production.tsx";
export type AppView =
  | "home"
  | "songs"
  | "account"
  | "publish"
  | "settings"
  | "song"
  | "missing";
export type ActivityRoute =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "study"; postId: string; lessonId?: string }
  | { kind: "sing"; postId: string };

export function appView(hash: string): AppView {
  if (!hash || hash === "#/") return "home";
  if (hash.startsWith("#song-")) return "song";
  const view = hash.slice(2);
  return hash.startsWith("#/") &&
    ["songs", "account", "publish", "settings"].includes(view)
    ? (view as AppView)
    : "missing";
}

export function activityRoute(url: URL): ActivityRoute {
  const study = url.searchParams.getAll("study"),
    sing = url.searchParams.getAll("sing");
  if (danceRoute(url).kind !== "none")
    return study.length || sing.length ? { kind: "invalid" } : { kind: "none" };
  if (!study.length && !sing.length) return { kind: "none" };
  if (study.length + sing.length !== 1 || !(study[0] ?? sing[0]))
    return { kind: "invalid" };
  const lessons = url.searchParams.getAll("lesson");
  if (
    study.length &&
    (lessons.length > 1 ||
      (lessons.length === 1 &&
        (!lessons[0] ||
          lessons[0].length > 1024 ||
          /[\u0000-\u001f\u007f]/u.test(lessons[0]))))
  )
    return { kind: "invalid" };
  if (study.length)
    return {
      kind: "study",
      postId: study[0]!,
      ...(lessons.length ? { lessonId: lessons[0] } : {}),
    };
  return {
    kind: "sing",
    postId: sing[0]!,
  };
}

/** Preserve unrelated queries and the feed view; never carry a lesson to another song. */
export function activityUrl(
  current: URL,
  kind: "study" | "sing",
  postId: string,
): URL {
  const url = new URL(current);
  if (isDancePath(url.pathname)) url.pathname = "/";
  url.searchParams.delete("dance");
  if (kind !== "study" || url.searchParams.get("study") !== postId)
    url.searchParams.delete("lesson");
  url.searchParams.delete(kind === "study" ? "sing" : "study");
  url.searchParams.set(kind, postId);
  return url;
}

export function withoutActivity(current: URL): URL {
  const url = new URL(current);
  if (isDancePath(url.pathname)) url.pathname = "/";
  clearActivityQuery(url);
  return url;
}

/** Internal fragment destinations retain public URL context. This never grants
 * account authority; session/cookie guards remain independent of query data. */
export function fragmentNavigationHref(href: string, current?: URL): string {
  if (!current) return href;
  let target: URL;
  try {
    target = new URL(href, current);
  } catch {
    return href;
  }
  if (
    target.origin !== current.origin ||
    target.pathname !== current.pathname ||
    !(
      /^#\/(?:songs|account|publish|settings)?$/.test(target.hash) ||
      target.hash.startsWith("#song-") ||
      target.hash.startsWith("#profile-")
    )
  )
    return href;
  if (!target.search) target.search = current.search;
  else {
    const explicit = new Set(target.searchParams.keys());
    const inherited = current.search
      .slice(1)
      .split("&")
      .filter((part) => {
        const key = new URLSearchParams(part).keys().next().value;
        return key !== undefined && !explicit.has(key);
      });
    if (inherited.length) target.search += "&" + inherited.join("&");
  }
  return target.href;
}

export type DanceRoute =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "dance"; communityId?: string; route: DanceProductionRoute };
const digest = (value: string) =>
  /^0x[0-9a-f]{64}$/.test(value) && !/^0x0+$/.test(value);
const reviewId = (value: string) => /^[a-zA-Z0-9_:-]{1,128}$/.test(value);
const isDancePath = (path: string) => path === "/dance" || path.startsWith("/dance/");
function clearActivityQuery(url: URL) {
  // Retain exact unrelated bytes (including %20 rather than +), order and hash.
  const retained = url.search.slice(1).split("&").filter(part => {
    const key = new URLSearchParams(part).keys().next().value;
    return !["study", "sing", "lesson", "dance"].includes(key ?? "");
  });
  url.search = retained.join("&");
}
/** Path spelling follows the authored recording/result routes. Query dance is
 * a post link only; community is bound later to the actual selected bootstrap. */
export function danceRoute(url: URL): DanceRoute {
  const query = url.searchParams.getAll("dance"), path = isDancePath(url.pathname);
  if (!query.length && !path) return { kind: "none" };
  if (["study", "sing", "lesson"].some(key => url.searchParams.has(key)))
    return { kind: "invalid" };
  if (query.length) {
    if (path || url.pathname !== "/" || query.length !== 1 || !digest(query[0]!))
      return { kind: "invalid" };
    return { kind: "dance", route: { kind: "post", postId: query[0]! } };
  }
  const match = /^\/dance\/([^/]+)\/(songs|posts|reviews)\/([^/]+)(\/recording)?$/.exec(url.pathname);
  if (!match) return { kind: "invalid" };
  let community: string, id: string;
  try { community = decodeURIComponent(match[1]!); id = decodeURIComponent(match[3]!); }
  catch { return { kind: "invalid" }; }
  if (!community || community.length > 1024 || /[\u0000-\u001f\u007f]/u.test(community))
    return { kind: "invalid" };
  if (match[2] === "reviews")
    return reviewId(id) ? { kind: "dance", communityId: community,
      route: { kind: match[4] ? "review" : "result", reviewId: id } } : { kind: "invalid" };
  if (match[4] || !digest(id)) return { kind: "invalid" };
  return { kind: "dance", communityId: community, route: match[2] === "songs"
    ? { kind: "song", songKey: id } : { kind: "post", postId: id } };
}
export function danceUrl(current: URL, communityId: string, route: DanceProductionRoute): URL {
  if (!communityId || communityId.length > 1024 || /[\u0000-\u001f\u007f]/u.test(communityId))
    throw Error("dance_community_required");
  const id = route.kind === "song" ? route.songKey : route.kind === "post" ? route.postId : route.reviewId;
  if ((route.kind === "song" || route.kind === "post") ? !digest(id) : !reviewId(id))
    throw Error("dance_route_invalid");
  const url = new URL(current);
  clearActivityQuery(url);
  const collection = route.kind === "song" ? "songs" : route.kind === "post" ? "posts" : "reviews";
  url.pathname = "/dance/" + encodeURIComponent(communityId) + "/" + collection + "/" +
    encodeURIComponent(id) + (route.kind === "review" ? "/recording" : "");
  return url;
}
