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
    !["pirate-owner-curated/2026-11-08/1","pirate-owner-catalog/2026-11-13/1"].includes(g.policy?.version) ||
    !["pirate.owner-publishing-authorization/1","pirate.owner-publishing-authorization/2"].includes(a?.schema) ||
    a.communityId !== g.communityId ||
    a.ownerWallet !== g.ownerWallet ||
    a.policy?.version !== g.policy.version ||
    a.policy?.sha256 !== g.policy.sha256 ||
    typeof signed.signature !== "string" ||
    !(a.schema === "pirate.owner-publishing-authorization/1" ? /^0x[0-9a-f]{130}(?![\s\S])/.test(signed.signature) : /^0x(?:[0-9a-fA-F]{2}){1,16384}(?![\s\S])/.test(signed.signature)) ||
    (a.schema === "pirate.owner-publishing-authorization/2" && (a.validFrom !== g.validFrom || a.expiresAt !== g.expiresAt))
  )
    throw Error("owner_publishing_binding_invalid");
  if(a.schema === "pirate.owner-publishing-authorization/2") {
    const attachment=env.WEB2_PUBLISHING_ATTACHMENT_SHA256, attachmentJSON=env.WEB2_PUBLISHING_ATTACHMENT_JSON, selection=env.WEB2_PUBLISHING_SELECTION_SHA256, admission=env.OWNER_GRANT_ADMISSION_REFERENCE;
    if(!/^0x[0-9a-f]{64}$/.test(attachment ?? "") || !/^0x[0-9a-f]{64}$/.test(selection ?? "") || !admission || !attachmentJSON)
      throw Error("web2_publishing_authority_unavailable");
    return {OWNER_GRANT_JSON:grant,OWNER_AUTHORIZATION_JSON:authorization,WEB2_PUBLISHING_ATTACHMENT_SHA256:attachment!,
      WEB2_PUBLISHING_ATTACHMENT_JSON:attachmentJSON,WEB2_PUBLISHING_SELECTION_SHA256:selection!,OWNER_GRANT_ADMISSION_REFERENCE:admission};
  }
  return { OWNER_GRANT_JSON: grant, OWNER_AUTHORIZATION_JSON: authorization };
}
