import type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
} from "../../../../packages/community/application-api.ts";
export type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
};

export async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Sign in to continue."
        : "The community is temporarily unavailable. Please try again.",
    );
  return response.json() as Promise<T>;
}
export async function post<T>(
  path: string,
  body: unknown,
  csrf?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(
      messages[value.error ?? ""] ??
        "This step could not complete. Retry the same step.",
    );
  return value;
}
const messages: Record<string, string> = {
  creator_service_unavailable:
    "The creator wallet service is unavailable. Your progress is saved.",
  release_processing_unavailable:
    "Release processing is temporarily unavailable. Your wallet connection is saved.",
  invalid_login_signature:
    "MOSS could not verify the sign-in. Please try again.",
  expired_or_replayed_challenge:
    "The sign-in request expired. Please sign in again.",
  csrf_required: "Please reload this page, then try again.",
  creator_connection_expired: "Reopen your creator wallet to continue.",
};
