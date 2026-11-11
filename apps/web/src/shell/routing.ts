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
  | { kind: "study" | "sing"; postId: string };

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
  return {
    kind: study.length ? "study" : "sing",
    postId: (study[0] ?? sing[0])!,
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
