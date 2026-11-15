import { hashMessage } from "viem";
import { bytes32, canonical, exact, insist, object, text } from "../packages/community/common.ts";
import type { CommunityConfig } from "../packages/community/config-manifest.ts";
import { readSignInMessageV4 } from "../packages/protocol/learning-results-v4.ts";
import type { DanceCanonicalSource } from "../packages/dance-chain/reader.ts";
import { danceAccountCommitment } from "../packages/dance-chain/wire.ts";
import type { DancePrincipal, DanceFence } from "../packages/dance/contracts.ts";
import { danceId, principal, wallet } from "../packages/dance/validation.ts";
import { DanceStore, DANCE_DB_NOW } from "../packages/dance/store.ts";
import type { DanceAccountAuthorityFacts } from "./dance-production-authority.ts";
import { readDanceHostContext, hostBody, hostCount, hostRowFence, joinDanceFences,
  type DanceAccountSelection, type HostRow } from "./dance-account-facts-store.ts";

interface BindingRow { binding_id: string; account_id: string; subject: string; created_at: number }
interface AccountRow { account_id: string; author_id: string; created_at: number }
interface OriginalRow {
  authorization_id: string; account_id: string; subject: string; issued_at: number; authority_epoch: number;
  message: string; sign_in_json: string; signature: string; policy_hash: string; policy_version: number;
  state: string; tx_hash: string | null; updated_at: number;
}
/** Private IDs enter here only from the authenticated service's actor/learner
 * context. Original authorization selection is persisted, NEVER MAX(issued_at)
 * or current role state. Existing capturedDanceAuthorization still revalidates
 * the capture's own authorizationId; these current facts cannot replace it. */
export function createDanceAccountFacts(input: {
  db: D1Database; source: DanceCanonicalSource; config: CommunityConfig;
}) {
  const { db, source, config } = input, store = new DanceStore(db);
  async function binding(accountId: string, selectedBindingId?: string, selectedWallet?: string) {
    const account = await db.prepare("SELECT account_id,author_id,created_at FROM community_accounts WHERE account_id=?")
      .bind(danceId(accountId)).first<AccountRow>();
    insist(account, "dance_private_account_missing", 403);
    bytes32(account.author_id); hostCount(account.created_at);
    const rows = await db.prepare(`SELECT binding_id,account_id,subject,created_at FROM credential_bindings
      WHERE account_id=? AND namespace='moss' AND network=6343 ORDER BY binding_id LIMIT 129`)
      .bind(accountId).all<BindingRow>();
    insist(rows.results.length > 0 && rows.results.length <= 128, "dance_account_binding_missing", 403);
    const selected = selectedBindingId ? rows.results.filter(b => b.binding_id === selectedBindingId) :
      rows.results.filter(b => wallet(b.subject) === selectedWallet);
    insist(selected.length === 1, "dance_account_binding_ambiguous", 403);
    const b = selected[0];
    danceId(b.binding_id); hostCount(b.created_at);
    insist(b.subject === wallet(b.subject) && b.account_id === accountId, "dance_account_binding_changed", 403);
    const conflicts = await db.prepare(`SELECT account_id FROM credential_bindings
      WHERE namespace='moss' AND network=6343 AND subject=? COLLATE NOCASE LIMIT 2`)
      .bind(b.subject).all<{ account_id: string }>();
    insist(conflicts.results.length === 1 && conflicts.results[0].account_id === accountId,
      "dance_account_binding_ambiguous", 403);
    return { account, binding: b, fence: {
      sql: `(((EXISTS(SELECT 1 FROM community_accounts WHERE (((account_id=?)
        AND (author_id=?))
        AND (created_at=?))))
        AND (EXISTS(SELECT 1 FROM credential_bindings WHERE ((((binding_id=?)
        AND (account_id=?))
        AND ((subject=?)
        AND (namespace='moss')))
        AND ((network=6343)
        AND (created_at=?))))))
        AND (((SELECT count(*) FROM credential_bindings WHERE (((namespace='moss')
        AND (network=6343))
        AND (subject=? COLLATE NOCASE)))=1)
        AND ((SELECT count(*) FROM credential_bindings WHERE (((account_id=?)
        AND (namespace='moss'))
        AND (network=6343)))=?)))`,
      values: [accountId, account.author_id, account.created_at, b.binding_id, accountId, b.subject,
        b.created_at, b.subject, accountId, rows.results.length],
    } satisfies DanceFence };
  }
  async function selectedAccount(communityId: string, accountId: string) {
    const row = await db.prepare("SELECT revision,body_json FROM dance_host_accounts WHERE community_id=? AND account_id=?")
      .bind(communityId, danceId(accountId)).first<HostRow>();
    insist(row, "dance_account_selection_missing", 403);
    const body = hostBody(row);
    exact(body, ["version", "sourceHash", "bindingId", "authorizationId", "identityEpoch", "groupId", "groupEpoch", "knownAliases", "active"]);
    const selected = body as unknown as DanceAccountSelection;
    insist(selected.version === "pirate.dance-account-selection/1" && selected.sourceHash === source.sourceHash &&
      typeof selected.active === "boolean", "dance_account_selection_changed", 403);
    danceId(selected.bindingId); bytes32(selected.authorizationId); bytes32(selected.groupId);
    hostCount(selected.identityEpoch, 1); hostCount(selected.groupEpoch, 1);
    insist(Array.isArray(selected.knownAliases) && selected.knownAliases.length > 0 && selected.knownAliases.length <= 128 &&
      selected.knownAliases.includes(accountId) && new Set(selected.knownAliases).size === selected.knownAliases.length &&
      canonical([...selected.knownAliases].sort()) === canonical(selected.knownAliases), "dance_alias_context_unavailable", 403);
    selected.knownAliases.forEach(danceId);
    const aliasFences: DanceFence[] = [];
    for (const alias of selected.knownAliases) {
      const exists = await db.prepare("SELECT account_id FROM community_accounts WHERE account_id=?")
        .bind(alias).first<{ account_id: string }>();
      insist(exists, "dance_alias_account_missing", 403);
      aliasFences.push({ sql: "EXISTS(SELECT 1 FROM community_accounts WHERE account_id=?)", values: [alias] });
    }
    const bound = await binding(accountId, selected.bindingId);
    const a = await db.prepare(`SELECT authorization_id,account_id,subject,issued_at,authority_epoch,message,sign_in_json,
      signature,policy_hash,policy_version,state,tx_hash,updated_at FROM learning_authorizations WHERE authorization_id=? AND account_id=?`)
      .bind(selected.authorizationId, accountId).first<OriginalRow>();
    insist(a && a.state === "recorded" && a.subject === bound.binding.subject && a.policy_version === 4,
      "dance_original_authorization_missing", 403);
    hostCount(a.issued_at, 1); hostCount(a.authority_epoch); hostCount(a.updated_at);
    insist(Number.isSafeInteger(a.issued_at * 1000), "dance_original_authorization_invalid", 403);
    bytes32(a.tx_hash);
    text(a.message, 32768); text(a.sign_in_json, 4096);
    const read = readSignInMessageV4(a.message), compact = object(JSON.parse(a.sign_in_json));
    exact(compact, ["learner", "nonce", "issuedAt"]);
    insist(read && hashMessage(a.message) === a.authorization_id && read.context.chainId === 6343 &&
      read.context.communityId === communityId && read.context.origin === config.app.origin &&
      read.context.contract === source.pin.v4 && read.context.publicationPolicy === a.policy_hash &&
      read.signIn.learner.toLowerCase() === a.subject && read.signIn.issuedAt === BigInt(a.issued_at) &&
      compact.learner === read.signIn.learner && compact.nonce === read.signIn.nonce && compact.issuedAt === String(a.issued_at) &&
      typeof a.signature === "string" && /^0x[0-9a-fA-F]+$/.test(a.signature) && a.signature.length % 2 === 0 && a.signature.length <= 32768,
      "dance_original_authorization_invalid", 403);
    const readiness = await db.prepare(`SELECT COALESCE(h.revision,0) revision,COALESCE(h.permission_revision,0) permission_revision,
      h.pending_operation,s.public_results_withdrawn_at,s.last_withdrawn_at,
      COALESCE((SELECT revision FROM learning_authority_original_heads WHERE account_id=?1),0) original_revision,
      COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?1),0) credential_revision,
      EXISTS(SELECT 1 FROM learning_authority_dirty d WHERE d.account_id=?1) dirty
      FROM (SELECT ?1 account_id) a LEFT JOIN learning_authority_heads h ON h.account_id=a.account_id
      LEFT JOIN learning_settings s ON s.account_id=a.account_id`).bind(accountId)
      .first<{ revision: number; permission_revision: number; pending_operation: string | null;
        public_results_withdrawn_at: number | null; last_withdrawn_at: number | null; dirty: number;
        original_revision: number; credential_revision: number }>();
    insist(readiness && readiness.pending_operation === null && readiness.dirty === 0 && readiness.public_results_withdrawn_at === null &&
      a.authority_epoch === readiness.revision && a.issued_at * 1000 > (readiness.last_withdrawn_at ?? -1),
      "dance_authority_pending_or_withdrawn", 403);
    hostCount(readiness.revision); hostCount(readiness.permission_revision);
    hostCount(readiness.original_revision); hostCount(readiness.credential_revision);
    if (readiness.last_withdrawn_at !== null) hostCount(readiness.last_withdrawn_at);
    const originalFence: DanceFence = {
      sql: `(((((EXISTS(SELECT 1 FROM learning_authorizations WHERE (((((authorization_id=?)
        AND (account_id=?))
        AND ((subject=?)
        AND (issued_at=?)))
        AND (((authority_epoch=?)
        AND (message=?))
        AND ((sign_in_json=?)
        AND (signature=?))))
        AND ((((policy_hash=?)
        AND (policy_version=4))
        AND ((state='recorded')
        AND (tx_hash=?)))
        AND ((updated_at=?)
        AND (issued_at*1000<=${DANCE_DB_NOW}))))))
        AND (NOT EXISTS(SELECT 1 FROM learning_authority_dirty WHERE (account_id=?))))
        AND ((NOT EXISTS(SELECT 1 FROM learning_authority_heads WHERE ((account_id=?)
        AND (pending_operation IS NOT NULL))))
        AND (COALESCE((SELECT revision FROM learning_authority_heads WHERE account_id=?),0)=?)))
        AND (((COALESCE((SELECT permission_revision FROM learning_authority_heads WHERE account_id=?),0)=?)
        AND (COALESCE((SELECT revision FROM learning_authority_original_heads WHERE account_id=?),0)=?))
        AND ((COALESCE((SELECT revision FROM learning_authority_credentials WHERE account_id=?),0)=?)
        AND (NOT EXISTS(SELECT 1 FROM learning_settings WHERE ((account_id=?)
        AND (public_results_withdrawn_at IS NOT NULL)))))))
        AND (COALESCE((SELECT last_withdrawn_at FROM learning_settings WHERE account_id=?),-1)=?))`,
      values: [a.authorization_id, accountId, a.subject, a.issued_at, a.authority_epoch, a.message, a.sign_in_json,
        a.signature, a.policy_hash, a.tx_hash, a.updated_at, accountId, accountId, accountId, readiness.revision,
        accountId, readiness.permission_revision, accountId, readiness.original_revision, accountId, readiness.credential_revision,
        accountId, accountId, readiness.last_withdrawn_at ?? -1],
    };
    const facts: DancePrincipal = { accountId, wallet: bound.binding.subject, active: selected.active,
      identityEpoch: selected.identityEpoch, groupId: selected.groupId, groupEpoch: selected.groupEpoch,
      knownAliases: selected.knownAliases, authorizationId: a.authorization_id,
      accountCommitment: danceAccountCommitment(source.domain, accountId, wallet(bound.binding.subject) as `0x${string}`) };
    principal(facts, false);
    return { principal: facts, fence: joinDanceFences(bound.fence, originalFence,
      hostRowFence("dance_host_accounts", "community_id=? AND account_id=?", [communityId, accountId], row), ...aliasFences) };
  }
  return async (communityId: string, actorId: string, learnerId: string): Promise<DanceAccountAuthorityFacts> => {
    insist(communityId === source.domain.communityId, "dance_wrong_community", 403);
    const host = await readDanceHostContext(input);
    const actor = await selectedAccount(communityId, actorId), learner = actorId === learnerId ? actor : await selectedAccount(communityId, learnerId);
    principal(actor.principal);
    const owner = await binding(host.context.owner.accountId, undefined, wallet(host.context.owner.wallet));
    const fence = joinDanceFences(host.fence, actor.fence, learner.fence, owner.fence);
    await store.assert([fence]);
    return { actor: actor.principal, learner: learner.principal,
      owner: { accountId: owner.account.account_id, wallet: owner.binding.subject, assignmentId: host.context.owner.assignmentId },
      mediaEpoch: host.context.mediaEpoch, fence };
  };
}
