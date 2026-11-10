// Self-contained copy in the reviewed Alchemy package. Owner publishing binds
// only the reviewed owner grant and controller-signed authorization; a
// registered deployment binds only its registered release values. Never both.
const registered = [
  "CREATOR_PROFILE_HASH",
  "RELEASE_GRANT_HASH",
  "REGISTRATION_OPERATOR_ADDRESS",
  "POSTING_EXPIRES_AT",
] as const;
export function applicationPublishingBindings(
  env: Readonly<Record<string, string | undefined>>,
) {
  const grant = env.OWNER_GRANT_JSON,
    authorization = env.OWNER_AUTHORIZATION_JSON;
  if (grant === undefined && authorization === undefined)
    return Object.fromEntries(registered.map((name) => [name, env[name]!]));
  if (!grant || !authorization) throw Error("owner_publishing_binding_missing");
  if (registered.some((name) => env[name] !== undefined))
    throw Error("owner_publishing_binding_mixed");
  const g = JSON.parse(grant),
    signed = JSON.parse(authorization),
    a = signed?.authorization;
  if (
    g?.schema !== "pirate.owner-publishing-grant/1" ||
    g.policy?.version !== "pirate-owner-curated/2026-11-08/1" ||
    a?.schema !== "pirate.owner-publishing-authorization/1" ||
    a.communityId !== g.communityId ||
    a.ownerWallet !== g.ownerWallet ||
    a.policy?.version !== g.policy.version ||
    a.policy?.sha256 !== g.policy.sha256 ||
    typeof signed.signature !== "string" ||
    !/^0x[0-9a-f]{130}$/.test(signed.signature)
  )
    throw Error("owner_publishing_binding_invalid");
  return { OWNER_GRANT_JSON: grant, OWNER_AUTHORIZATION_JSON: authorization };
}
