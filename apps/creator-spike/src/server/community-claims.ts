import { insist } from "./store.ts";

/** A native approval cannot consume a credential already accepted for another
 * private account in this community. Other communities have independent claims. */
export async function claimCommunityCredential(
  db: D1Database,
  communityId: string,
  accountRef: string,
  credentialId: string,
) {
  await db
    .prepare(
      "INSERT INTO scoped_creator_claims(community_id,account_ref,credential_id,claimed_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(communityId, accountRef, credentialId, Date.now())
    .run();
  const claimed = await db
    .prepare(
      "SELECT credential_id FROM scoped_creator_claims WHERE community_id=? AND account_ref=?",
    )
    .bind(communityId, accountRef)
    .first<{ credential_id: string }>();
  insist(
    claimed?.credential_id === credentialId,
    "creator_credential_claimed",
    409,
  );
}
