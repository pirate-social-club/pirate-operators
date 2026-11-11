import type { AppView } from "./routing.ts";
import { resolveApplicationChrome } from "./reference/application-chrome-model.ts";

/** Map fragment/query routes to the reference's route policy, not a new policy. */
export function communityChrome(
  view: AppView,
  pathname: string,
  practiceOpen: boolean,
  communityId: string,
) {
  if (pathname.startsWith("/operator"))
    return resolveApplicationChrome("/c/current/settings/rewards");
  if (practiceOpen) return resolveApplicationChrome("/posts/current/study");
  if (pathname.startsWith("/verify")) return resolveApplicationChrome(pathname);
  if (pathname === "/wallet") return resolveApplicationChrome("/wallet");
  const path =
    view === "home" || view === "publish"
      ? `/c/${communityId || "current"}`
      : view === "song"
        ? "/posts/current"
        : view === "account"
          ? "/me"
          : view === "settings"
            ? "/settings"
            : view === "songs"
              ? "/songs"
              : "/unavailable";
  return resolveApplicationChrome(path);
}
