import type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
  CommunityUploadView,
  CommunityJobView,
} from "../api-contract.ts";
export type {
  CommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
  CommunityUploadView,
  CommunityJobView,
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
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...headers,
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
export async function putAudio(path: string, file: File, csrf: string) {
  const response = await fetch(path, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "audio/mpeg", "x-csrf-token": csrf },
    body: file,
  });
  const value = (await response.json()) as { error?: string };
  if (!response.ok)
    throw new Error(
      messages[value.error ?? ""] ??
        "The upload could not complete. Continue with your saved recording.",
    );
}
const messages: Record<string, string> = {
  study_history_expired: "This private history has expired.",
  sponsor_exhausted: "Sponsored practice is paused because the community allowance is exhausted.",
  gas_price_above_limit: "Sponsored publication is waiting for the network fee to fall within the community limit.",
  speech_budget_exhausted: "Speech practice has reached today's community limit.",
  public_result_manifest_unavailable: "This song's public learning material is still being prepared.",
  account_activation_not_approved: "This testnet wallet needs operator activation approval before enrollment.",
  enrollment_not_active_yet: "Your enrollment is confirming. Try again in a moment.",
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
  creator_activation_verification_required:
    "Reopen your saved creator wallet for a fresh check, then continue this release.",
  release_service_unavailable:
    "Release processing is unavailable. Your recording is saved in this browser.",
  upload_in_progress:
    "Your earlier upload is still being checked. Wait a few minutes, then continue the saved release.",
  publication_execution_profile_changed:
    "The operator configuration changed. Your saved release needs operator review.",
  submission_profile_changed:
    "The operator configuration changed. Your saved release needs operator review.",
};
