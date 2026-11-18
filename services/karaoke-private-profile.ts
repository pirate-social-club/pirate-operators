import type { Hex } from "viem";
import { check, digest, type Ticket } from "../packages/protocol/index.ts";
import { privateStudyV5Profile } from "./study-v5-profile.ts";
import type { Env, Store } from "./runtime.ts";

export const privateKaraokeScopeKey = "privateKaraokeScope:1";
const forbiddenPrefixes = [
  "ticket:", "attempt:", "result:", "history:", "tx:", "consent:", "publication:",
  "publicationV2:", "ticketAuthorization:", "pendingEnrollment:", "pendingAuthorization:",
];

/** A private operator owns a fresh, dedicated state namespace. Removing its
 * binding later cannot turn its retained tickets into a public operator. */
export function privateKaraokeScope(env: Env, store: Store) {
  const old = store.get<string>(privateKaraokeScopeKey);
  if (!old && env.KARAOKE_PRIVATE_PROFILE === undefined) return null;
  check(env.RECORDS_CONTRACT === undefined && env.RESULTS_V2_CONTRACT === undefined &&
    env.RESULTS_V3_CONTRACT === undefined && env.RESULTS_V4_CONTRACT === undefined,
    "private_karaoke_public_target");
  check(env.ROLE === "operator" && env.SERVICE_MODE === "internal" &&
    env.PAYMENT_CHAIN_ID === "6343" && env.SIGNATURE_CHAIN_ID === "6343" &&
    typeof env.KARAOKE_PRIVATE_PROFILE === "string" &&
    /^0x[0-9a-f]{64}$/.test(env.KARAOKE_PRIVATE_PROFILE) &&
    typeof env.KARAOKE_LOCAL_MODEL_SHA256 === "string" &&
    /^0x[0-9a-f]{64}$/.test(env.KARAOKE_LOCAL_MODEL_SHA256) &&
    env.KARAOKE_LOCAL_TRANSCRIBER &&
    env.LOCAL_ONLY === "pirate-local-skeleton" &&
    Number.isSafeInteger(Number(env.HISTORY_RETENTION_DAYS)) &&
    Number(env.HISTORY_RETENTION_DAYS) > 0 && Number(env.HISTORY_RETENTION_DAYS) <= 90,
    "private_karaoke_profile_required");
  const profile = privateStudyV5Profile(env, env.COMMUNITY_ID);
  check(digest(profile) === env.KARAOKE_PRIVATE_PROFILE, "private_karaoke_profile_changed");
  const scope = digest({
    profileHash: env.KARAOKE_PRIVATE_PROFILE,
    modelSha256: env.KARAOKE_LOCAL_MODEL_SHA256,
    issuer: env.ISSUER,
    operator: env.OPERATOR_ADDRESS,
    community: env.COMMUNITY_ADDRESS ?? null,
    retentionDays: env.HISTORY_RETENTION_DAYS,
  });
  store.transaction(() => {
    const retained = store.get<string>(privateKaraokeScopeKey);
    if (retained) check(retained === scope, "private_karaoke_profile_changed");
    else {
      check(forbiddenPrefixes.every(prefix => store.entries(prefix).length === 0),
        "private_karaoke_state_unclassified");
      store.set(privateKaraokeScopeKey, scope);
    }
  });
  return { profileHash: env.KARAOKE_PRIVATE_PROFILE as Hex, modelSha256: env.KARAOKE_LOCAL_MODEL_SHA256 as Hex };
}

export function checkKaraokeTicketScope(ticket: Ticket, scope: ReturnType<typeof privateKaraokeScope>) {
  check(ticket.privateProfileHash === scope?.profileHash &&
    (!scope || ticket.authorizationId === undefined), "private_karaoke_ticket_scope_changed");
}
