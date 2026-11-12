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
  if (kind !== "study" || url.searchParams.get("study") !== postId)
    url.searchParams.delete("lesson");
  url.searchParams.delete(kind === "study" ? "sing" : "study");
  url.searchParams.set(kind, postId);
  return url;
}

export function withoutActivity(current: URL): URL {
  const url = new URL(current);
  for (const key of ["study", "sing", "lesson"]) url.searchParams.delete(key);
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
