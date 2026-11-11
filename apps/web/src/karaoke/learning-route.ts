/** Shared with the shell. Route state contains identities only; the server
 * supplies account-scoped tickets/proofs after every refresh. */
export type LearningRoute = {
  activity: "study" | "karaoke";
  postId: string;
  lessonId?: string;
} | null;
const postId = (value: string | null): value is string =>
  !!value && /^0x[0-9a-f]{64}$/.test(value);
export function learningRoute(url: URL): LearningRoute {
  const study = url.searchParams.get("study"),
    sing = url.searchParams.get("sing");
  if (study && sing) return null;
  if (postId(sing)) return { activity: "karaoke", postId: sing };
  if (postId(study))
    return {
      activity: "study",
      postId: study,
      ...(url.searchParams.get("lesson")
        ? { lessonId: url.searchParams.get("lesson")! }
        : {}),
    };
  return null;
}
export function learningRouteUrl(current: URL, next: LearningRoute): URL {
  const url = new URL(current);
  for (const key of ["study", "sing", "lesson"]) url.searchParams.delete(key);
  if (next) {
    if (!postId(next.postId)) throw Error("invalid_learning_song");
    url.searchParams.set(
      next.activity === "karaoke" ? "sing" : "study",
      next.postId,
    );
    if (next.activity === "study" && next.lessonId)
      url.searchParams.set("lesson", next.lessonId);
  }
  return url;
}
