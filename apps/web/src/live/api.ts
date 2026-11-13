import type {
  CommunityCapabilities as BaseCommunityCapabilities,
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
  CommunityUploadView,
  CommunityJobView,
} from "../api-contract.ts";
export type {
  CommunityClientConfig,
  CommunityFeed,
  CommunitySessionView,
  CommunityUploadView,
  CommunityJobView,
};

/** Status is available at headers; callers must not wait for an auth error body. */
export class CommunityRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function rejectAuthentication(response: Response) {
  if (response.status === 401 || response.status === 403)
    throw new CommunityRequestError(
      response.status === 401
        ? "Sign in to continue."
        : "The community is temporarily unavailable. Please try again.",
      response.status,
    );
}

export async function get<T>(
  path: string,
  options: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json", ...options.headers },
    cache: "no-store",
    ...(options.timeoutMs || options.signal
      ? {
          signal: options.timeoutMs
            ? options.signal
              ? AbortSignal.any([
                  options.signal,
                  AbortSignal.timeout(options.timeoutMs),
                ])
              : AbortSignal.timeout(options.timeoutMs)
            : options.signal,
        }
      : {}),
  });
  if (!response.ok) {
    rejectAuthentication(response);
    const error = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw new Error(
      error.error === "study_account_changed"
        ? messages.study_account_changed
        : "The community is temporarily unavailable. Please try again.",
    );
  }
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
  rejectAuthentication(response);
  const value = (await response.json()) as T & { error?: string };
  if (!response.ok)
    // The server's code stays available to callers that retry on it.
    throw new CommunityRequestError(
      messages[value.error ?? ""] ??
        "This step could not complete. Retry the same step.",
      response.status,
      value.error,
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
  study_account_changed:
    "You are signed in with a different account. Reload to continue.",
  karaoke_authorization_pending:
    "Your sign-in is still being confirmed. Try again in a moment.",
  karaoke_authorization_required: "Sign out, then sign in again to continue.",
  public_results_unavailable: "Public results settings are unavailable here.",
  reward_unmatched_outgoing:
    "Review the unmatched outgoing transfer before preparing another payment.",
  reward_audit_catching_up:
    "Wallet history is still being checked. Refresh the audit, then continue.",
  reward_payout_account_busy:
    "The payout account has an unresolved payment. Check that payment first.",
  reward_reserve_not_funded:
    "The verified payout reserve does not cover this payment yet.",
  reward_cost_matches_payment:
    "This transfer belongs to a payment. Reconcile the payment instead of recording a cost.",
  megapot_drawing_pending: "The drawing has not settled. Keep it pending.",
  megapot_collection_receipt_required:
    "Record the actual winnings collection transaction before crediting this win.",
  reward_sources_not_qualified:
    "The reward source configuration has not been qualified.",
  study_history_expired: "This private history has expired.",
  sponsor_exhausted:
    "Sponsored practice is paused because the community allowance is exhausted.",
  gas_price_above_limit:
    "Sponsored publication is waiting for the network fee to fall within the community limit.",
  speech_budget_exhausted:
    "Speech practice has reached today's community limit.",
  public_result_manifest_unavailable:
    "This song's public learning material is still being prepared.",
  account_activation_not_approved:
    "This testnet wallet needs operator activation approval before enrollment.",
  enrollment_not_active_yet:
    "Your enrollment is confirming. Try again in a moment.",
  creator_service_unavailable:
    "The creator wallet service is unavailable. Your progress is saved.",
  release_processing_unavailable:
    "Release processing is temporarily unavailable. Your saved release stays saved.",
  owner_publication_only: "Only the community owner can release songs here.",
  owner_authorization_outside_window:
    "Releasing is paused until the operator renews publishing. Your saved release stays saved.",
  owner_authorization_unavailable:
    "Release processing is temporarily unavailable. Your saved release stays saved.",
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

/** Required same-origin server projection. Absence is unavailable, never ready.
 * Upstream owns policy/limit selection; no wallet/author implies private access. */
export interface CommunityDanceCapability {
  version: "pirate.dance-capability/1";
  communityId: string;
  media: {
    version: "pirate.community-media/1";
    purpose: "private-review";
    policyVersion: "pirate.dance-private/1";
    maximumBytes: number;
  };
}
export type CommunityCapabilities = BaseCommunityCapabilities & {
  dance?: CommunityDanceCapability;
};
export function selectedDanceCapability(
  value: CommunityCapabilities | null,
  communityId: string,
): CommunityDanceCapability | null {
  const dance = value?.dance;
  return value?.schema === "pirate.community-capabilities/1" && communityId && dance?.version === "pirate.dance-capability/1" &&
    dance.communityId === communityId &&
    dance.media?.version === "pirate.community-media/1" &&
    dance.media.purpose === "private-review" &&
    dance.media.policyVersion === "pirate.dance-private/1" &&
    Number.isSafeInteger(dance.media.maximumBytes) && dance.media.maximumBytes > 0
      ? dance : null;
}

export interface DanceSessionIdentity {
  communityId: string;
  authorId: string;
  csrf: string;
}
/** Synchronous mask/notify precedes successor publication. These are session
 * correlation fields only; the reviewed producer resolves private accountId. */
export function createDanceSessionOwner() {
  let value: (DanceSessionIdentity & { generation: string }) | null = null;
  let generation = 0, changing = false, disposed = false;
  const listeners = new Set<() => void>();
  function update(next: DanceSessionIdentity | null): boolean {
    if (disposed || changing) return false;
    if (next && (!next.communityId || !next.authorId || !next.csrf)) {
      update(null);
      throw Error("dance_session_identity_required");
    }
    if ((!value && !next) || (value && next &&
      value.communityId === next.communityId &&
      value.authorId === next.authorId && value.csrf === next.csrf)) return false;
    changing = true;
    value = null;
    generation++;
    try {
      for (const notify of [...listeners]) {
        try { notify(); } catch { /* One listener cannot retain another owner. */ }
      }
      value = !disposed && next ? Object.freeze({ ...next, generation: String(generation) }) : null;
    } finally { changing = false; }
    return true;
  }
  return {
    current: () => value,
    subscribe(notify: () => void) {
      if (disposed) return () => {};
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    update,
    clear: () => update(null),
    dispose() { if (disposed) return; update(null); disposed = true; listeners.clear(); },
  };
}
