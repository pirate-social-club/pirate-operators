import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";
import { getAddress, keccak256 } from "viem";
import type { AccountSession } from "../community/accounts.ts";
import { hashJson, publicId, canonical } from "../community/common.ts";
import { MemberError, memberRequire, safeJson, decimal, epoch, memberDigest, type MemberHex, type PrepareNameInput } from "./member-api.ts";
import { ownerScope, fence, sessionFence, type MemberContext, type JoinAdmission, type NameAdmission,
  type NamePreparation, type NameObservation, type NameConsentEvidence, type AtomicMemberFence } from "./member-authorization.ts";

export interface MemberOriginal {
  kind: "join" | "name"; requestId: MemberHex; context: MemberContext;
  accountId: string; bindingId: string; recipient: string; idempotencyKey: string;
  admission: JoinAdmission; createdAtMs: number;
  joinId?: MemberHex; label?: string; preparation?: NamePreparation;
}
interface OperationRow {
  operation_id: MemberHex; kind: "join" | "name"; installation_id: MemberHex; linux_installation_id: string; community_id: MemberHex;
  origin: string; account_id: string; binding_id: string; recipient: string; idempotency_key: string;
  request_hash: MemberHex; original_digest: MemberHex; original_json: string; created_at: number;
}
export interface MemberOperation { original: MemberOriginal; digest: MemberHex; revision: number }
export interface OriginalTransaction {
  chainId: 31337 | 6343; sender: string; nonce: string; raw: MemberHex; transactionHash: MemberHex;
  gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string;
}
export interface TransactionCustodyVerifier {
  /** Actual selected successor's envelope/signature/calldata/nonce/fee verifier.
   * Must bind raw bytes to this original claim; not a readiness boolean. */
  verify(operation: MemberOperation, transaction: OriginalTransaction): Promise<void>;
}
export interface OriginalGrant {
  requestId: MemberHex; planDigest: MemberHex; sourceSha256: string; grantDigest: MemberHex;
  issuerNonce: string; nonceKey: MemberHex; expiresAtMs: number;
  // nonceKey is the selected verifier's exact source/chain/issuer/nonce-domain
  // identity; Phase1 does not guess the successor's on-chain nonce semantics.
  /** Exact lossless selected-successor grant and signature; never reconstructed. */
  envelope: { [key: string]: import("./member-api.ts").Json };
}
export interface OriginalConsent { planDigest: MemberHex; recipientSignature: MemberHex; evidence: NameConsentEvidence }
export interface JournalCustodyVerifiers {
  transaction?: TransactionCustodyVerifier;
  grant?: { verify(operation: MemberOperation, grant: OriginalGrant): Promise<void> };
}
/** Concrete D1 custody only. This class has no signer, HTTP transport or
 * broadcaster. All private writes are single primary batches with final fences.
 * Logout removes access, never the original intent/artifacts/budget reservation. */
export class CommunityMemberJournal {
  constructor(readonly db: D1Database, readonly verifiers?: JournalCustodyVerifiers) {}
  #snapshotOperation(value: MemberOperation): MemberOperation {
    const snapshot=structuredClone(value);safeJson(snapshot.original);
    memberRequire(hashJson(snapshot.original)===snapshot.digest,"request_conflict");return snapshot;
  }
  #statement(sql: string, values: (string | number | null)[] = []) { return this.db.prepare(sql).bind(...values); }
  #guard(id: string, f: AtomicMemberFence) {
    const checked = fence(f);
    return this.#statement(`INSERT INTO transaction_guards(guard_id,valid) SELECT ?,CASE WHEN (${checked.sql}) THEN 1 ELSE 0 END`, [id, ...checked.values]);
  }
  async #batch(statements: D1PreparedStatement[]) {
    try { await this.db.batch(statements); }
    catch { throw new MemberError("service_unavailable", 503); }
  }
  #decode(row: OperationRow): MemberOriginal {
    const original = JSON.parse(row.original_json) as MemberOriginal;
    memberRequire(hashJson(original) === row.original_digest && original.requestId === row.operation_id && original.kind === row.kind &&
      original.context.installationId === row.installation_id && original.context.linuxInstallationId===row.linux_installation_id && original.context.communityId === row.community_id && original.context.origin === row.origin &&
      original.accountId === row.account_id && original.bindingId === row.binding_id && original.recipient === row.recipient && original.idempotencyKey === row.idempotency_key, "service_unavailable", 503);
    return original;
  }
  async #operation(row: OperationRow): Promise<MemberOperation> {
    const counts = await this.#statement(`SELECT (SELECT count(*) FROM community_member_artifacts WHERE operation_id=?)+
      (SELECT count(*) FROM community_member_observations WHERE operation_id=?) AS n`, [row.operation_id, row.operation_id]).first<{ n: number }>();
    return { original: this.#decode(row), digest: row.original_digest, revision: 1 + (counts?.n ?? 0) };
  }
  #owner(c: MemberContext, s: AccountSession, row: OperationRow) {
    memberRequire(row.installation_id === c.installationId && row.linux_installation_id===c.linuxInstallationId && row.community_id === c.communityId && row.origin === c.origin &&
      row.account_id === s.account_id && row.binding_id === s.binding_id && row.recipient === getAddress(s.wallet), "request_conflict", 404);
  }
  async byId(c: MemberContext, s: AccountSession, id: string): Promise<MemberOperation | null> {
    const row = await this.#statement("SELECT * FROM community_member_operations WHERE operation_id=? AND installation_id=? AND linux_installation_id=? AND community_id=? AND account_id=?", [id,c.installationId,c.linuxInstallationId,c.communityId,s.account_id]).first<OperationRow>();
    if (!row) return null; this.#owner(c,s,row); return this.#operation(row);
  }
  async byKey(c: MemberContext, s: AccountSession, kind: "join" | "name", key: string): Promise<MemberOperation | null> {
    const row = await this.#statement(`SELECT * FROM community_member_operations WHERE kind=? AND installation_id=? AND linux_installation_id=? AND community_id=? AND account_id=? AND idempotency_key=?`, [kind,c.installationId,c.linuxInstallationId,c.communityId,s.account_id,key]).first<OperationRow>();
    if (!row) return null; this.#owner(c,s,row); return this.#operation(row);
  }
  async current(c: MemberContext, s: AccountSession, kind: "join" | "name"): Promise<MemberOperation | null> {
    const row = await this.#statement(`SELECT * FROM community_member_operations WHERE kind=? AND installation_id=? AND linux_installation_id=? AND community_id=? AND account_id=? ORDER BY created_at DESC,operation_id DESC LIMIT 1`, [kind,c.installationId,c.linuxInstallationId,c.communityId,s.account_id]).first<OperationRow>();
    if (!row) return null; this.#owner(c,s,row); return this.#operation(row);
  }
  #insert(original: MemberOriginal, requestHash: MemberHex) {
    return this.#statement(`INSERT INTO community_member_operations(operation_id,kind,installation_id,linux_installation_id,community_id,origin,account_id,binding_id,recipient,
      idempotency_key,request_hash,original_digest,original_json,join_id,namespace_id,label,policy_revision,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM community_member_operations o WHERE
        (o.kind=? AND o.installation_id=? AND o.community_id=? AND o.account_id=?) OR
        (?='name' AND o.kind='name' AND o.installation_id=? AND o.namespace_id=? AND o.label=?))`,
      [original.requestId,original.kind,original.context.installationId,original.context.linuxInstallationId,original.context.communityId,original.context.origin,original.accountId,original.bindingId,
        original.recipient,original.idempotencyKey,requestHash,hashJson(original),safeJson(original),original.joinId ?? null,
        original.kind === "name" ? original.context.name!.namespaceId : null,original.label ?? null,original.admission.revision,original.createdAtMs,
        original.kind,original.context.installationId,original.context.communityId,original.accountId,original.kind,
        original.context.installationId,original.context.name?.namespaceId??null,original.label??null]);
  }
  async acceptJoin(c: MemberContext, s: AccountSession, key: string, admission: JoinAdmission, now: number) {
    c=structuredClone(c);s=structuredClone(s);admission=structuredClone(admission);
    const existing = await this.current(c,s,"join"); if (existing) return existing;
    const id = publicId(), g1 = publicId(), g2 = publicId(), g3 = publicId();
    const original: MemberOriginal = { kind:"join",requestId:id,context:structuredClone(c),accountId:s.account_id,bindingId:s.binding_id,
      recipient:getAddress(s.wallet),idempotencyKey:key,admission:structuredClone(admission),createdAtMs:epoch(now) };
    await this.#batch([this.#guard(g1,sessionFence(c,s,now)),this.#guard(g2,c.fence),this.#guard(g3,admission.fence),
      this.#insert(original,hashJson(["join",ownerScope(c,s)])),
      this.#statement("DELETE FROM transaction_guards WHERE guard_id IN (?,?,?)",[g1,g2,g3])]);
    const accepted = await this.current(c,s,"join"); memberRequire(accepted,"service_unavailable",503); return accepted;
  }
  async prepareName(c: MemberContext, s: AccountSession, input: PrepareNameInput, join: MemberOperation,
    admission: NameAdmission, preparation: NamePreparation, now: number) {
    c=structuredClone(c);s=structuredClone(s);input=structuredClone(input);join=structuredClone(join);
    admission=structuredClone(admission);preparation=structuredClone(preparation);
    const existing = await this.byKey(c,s,"name",input.idempotencyKey);
    if (existing) { memberRequire(existing.original.label === input.label,"request_conflict"); return existing; }
    const id = preparation.requestId, original: MemberOriginal = { kind:"name",requestId:id,context:structuredClone(c),accountId:s.account_id,
      bindingId:s.binding_id,recipient:getAddress(s.wallet),idempotencyKey:input.idempotencyKey,admission:structuredClone(admission),createdAtMs:epoch(now),
      joinId:join.original.requestId,label:input.label,preparation:structuredClone(preparation) };
    const originalDigest=hashJson(original),guards = [publicId(),publicId(),publicId(),publicId()];
    const statements: D1PreparedStatement[] = [this.#guard(guards[0],sessionFence(c,s,now)),this.#guard(guards[1],c.fence),this.#guard(guards[2],admission.fence),
      this.#guard(guards[3],{sql:"EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND kind='join' AND original_digest=?)",values:[join.original.requestId,join.digest]}),
      this.#insert(original,hashJson(["name",ownerScope(c,s),input.label]))];
    const amount = BigInt(decimal(preparation.terms.gas.maxTotalWei));
    memberRequire(amount > 0n && admission.budgets.length === 2 && new Set(admission.budgets.map(b=>b.bucket)).size === 2 &&
      new Set(admission.budgets.map(b=>b.role)).size===2 && admission.budgets.every(b=>b.role==="community"||b.role==="subject"),"budget_exhausted");
    // Lossless decimal arithmetic outside SQLite; exact CAS predicates keep
    // the operation plus all eligibility/community reservations atomic.
    for (const grant of admission.budgets) {
      memberDigest(grant.bucket);
      const limit = BigInt(decimal(grant.limitWei));
      const previous = await this.#statement("SELECT limit_wei,reserved_wei,revision FROM community_member_budgets WHERE bucket=?",[grant.bucket]).first<{limit_wei:string;reserved_wei:string;revision:number}>();
      memberRequire(!previous || previous.limit_wei === grant.limitWei,"authority_changed");
      const used = previous?.reserved_wei ?? "0", revision = previous?.revision ?? 0, next = BigInt(used)+amount;
      memberRequire(next <= limit,"budget_exhausted");
      statements.push(this.#statement(`INSERT INTO community_member_budgets(bucket,limit_wei,reserved_wei,revision)
        SELECT ?,?,'0',0 WHERE EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?)
        AND NOT EXISTS(SELECT 1 FROM community_member_budgets WHERE bucket=?)`,[grant.bucket,grant.limitWei,id,originalDigest,grant.bucket]));
      statements.push(this.#statement(`UPDATE community_member_budgets SET reserved_wei=?,revision=revision+1,last_operation_id=?
        WHERE bucket=? AND revision=? AND reserved_wei=? AND limit_wei=? AND EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?)`,[next.toString(),id,grant.bucket,revision,used,grant.limitWei,id,originalDigest]));
      const guard = publicId(); guards.push(guard);
      statements.push(this.#guard(guard,{sql:`NOT EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?) OR
        EXISTS(SELECT 1 FROM community_member_budgets WHERE bucket=? AND revision=? AND reserved_wei=? AND last_operation_id=?)`,values:[id,originalDigest,grant.bucket,revision+1,next.toString(),id]}));
    }
    statements.push(this.#statement(`INSERT INTO community_member_artifacts(operation_id,kind,payload_json,payload_digest,created_at)
      SELECT ?,'prepared',?,?,? WHERE EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?)`,[id,safeJson(preparation),hashJson(preparation),now,id,originalDigest]));
    statements.push(this.#statement(`DELETE FROM transaction_guards WHERE guard_id IN (${guards.map(()=>"?").join(",")})`,guards));
    await this.#batch(statements);
    const saved = await this.byKey(c,s,"name",input.idempotencyKey);
    memberRequire(saved,"request_conflict"); memberRequire(saved.original.label === input.label,"request_conflict"); return saved;
  }
  async artifacts(operation: MemberOperation): Promise<Record<string,string>> {
    const rows = (await this.#statement("SELECT kind,payload_json,payload_digest FROM community_member_artifacts WHERE operation_id=? ORDER BY kind",[operation.original.requestId]).all<{kind:string;payload_json:string;payload_digest:string}>()).results;
    const result: Record<string,string> = {};
    for (const row of rows) { memberRequire(hashJson(JSON.parse(row.payload_json))===row.payload_digest,"service_unavailable",503); result[row.kind]=row.payload_json; }
    return result;
  }
  async #artifact(op: MemberOperation, kind: "consent"|"grant"|"transaction"|"broadcast", payload: unknown, guard: AtomicMemberFence, now: number,
    tx?: OriginalTransaction, grant?: OriginalGrant) {
    op=this.#snapshotOperation(op);payload=structuredClone(payload);guard=fence(structuredClone(guard));now=epoch(now);
    tx=tx?structuredClone(tx):undefined;grant=grant?structuredClone(grant):undefined;
    const json = canonical(JSON.parse(safeJson(payload,131072))), digest = hashJson(payload), id=op.original.requestId, g=publicId(), g2=publicId();
    const prerequisite = kind === "consent" ? "prepared" : kind === "grant" ? "consent" : kind === "transaction" ? "grant" : "transaction";
    const statements=[this.#guard(g,guard),this.#guard(g2,{sql:`EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?) AND
      EXISTS(SELECT 1 FROM community_member_artifacts WHERE operation_id=? AND kind=?)`,values:[id,op.digest,id,prerequisite]}),
      this.#statement(`INSERT INTO community_member_artifacts(operation_id,kind,payload_json,payload_digest,chain_id,sender,nonce,nonce_key,transaction_hash,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM community_member_artifacts WHERE operation_id=? AND kind=?)`,
      [id,kind,json,digest,tx?.chainId ?? null,tx?.sender.toLowerCase() ?? null,tx?.nonce ?? null,grant?.nonceKey ?? null,tx?.transactionHash??null,now,id,kind]),
      this.#statement("DELETE FROM transaction_guards WHERE guard_id IN (?,?)",[g,g2])];
    await this.#batch(statements);
    const saved = await this.artifacts(op); memberRequire(saved[kind] === json,"request_conflict");
  }
  /** Not HTTP mounts. Root's Phase2 signer/sender must supply its actual final
   * authorization/lease fence. None of these methods performs an effect. */
  recordConsent(op: MemberOperation, payload: OriginalConsent, guard: AtomicMemberFence, now: number) {
    op=this.#snapshotOperation(op);payload=structuredClone(payload);guard=fence(structuredClone(guard));
    const p=op.original.preparation,e=payload.evidence;
    memberRequire(p && payload.planDigest===op.digest && e.planDigest===op.digest && e.requestId===op.original.requestId &&
      getAddress(e.recipient)===getAddress(op.original.recipient) && e.consentDigest===p.consent.digest &&
      epoch(e.validUntilMs)>now && p.consent.expiresAtMs>now,"authority_changed"); memberDigest(e.evidenceDigest);
    memberRequire(payload.recipientSignature.length<=32770 && payload.recipientSignature.length%2===0 &&
      /^0x[0-9a-fA-F]+$/.test(payload.recipientSignature) && !/[^0-9a-fA-F]/.test(payload.recipientSignature.slice(2)),"recipient_unsupported",422);
    return this.#artifact(op,"consent",payload,guard,now);
  }
  async recordGrant(op: MemberOperation, payload: OriginalGrant, guard: AtomicMemberFence, now: number) {
    op=this.#snapshotOperation(op);payload=structuredClone(payload);guard=fence(structuredClone(guard));now=epoch(now);
    const verifier=this.verifiers?.grant;memberRequire(verifier,"issuer_unavailable",503);
    memberRequire(payload.requestId===op.original.requestId && payload.planDigest===op.digest &&
      payload.sourceSha256===op.original.preparation?.sourceSha256 && epoch(payload.expiresAtMs)>now,"authority_changed");
    memberDigest(payload.grantDigest); memberDigest(payload.nonceKey); decimal(payload.issuerNonce);
    const delegated=structuredClone({operation:op,grant:payload}),expected=hashJson(delegated);
    await verifier.verify(delegated.operation,delegated.grant);
    memberRequire(hashJson(delegated)===expected,"authority_changed");
    return this.#artifact(op,"grant",payload,guard,now,undefined,payload);
  }
  async persistTransaction(op: MemberOperation, input: OriginalTransaction, guard: AtomicMemberFence, now: number) {
    op=this.#snapshotOperation(op);input=structuredClone(input);guard=fence(structuredClone(guard));now=epoch(now);
    const verifier=this.verifiers?.transaction;memberRequire(verifier,"issuer_unavailable",503);
    const delegated=structuredClone({operation:op,transaction:input}),expected=hashJson(delegated);
    await verifier.verify(delegated.operation,delegated.transaction);
    memberRequire(hashJson(delegated)===expected,"authority_changed");
    memberRequire((input.chainId===31337||input.chainId===6343) && /^0x[0-9a-fA-F]+$/.test(input.raw) && input.raw.length%2===0 &&
      keccak256(input.raw)===input.transactionHash,"request_conflict");
    decimal(input.nonce); memberRequire(input.nonce.length<=20,"request_conflict"); getAddress(input.sender);
    const gas=BigInt(decimal(input.gasLimit)), fee=BigInt(decimal(input.maxFeePerGas)), priority=BigInt(decimal(input.maxPriorityFeePerGas));
    memberRequire(gas>0n && fee>0n && priority<=fee && gas*fee<=BigInt(op.original.preparation!.terms.gas.maxTotalWei),"budget_exhausted");
    return this.#artifact(op,"transaction",{...input,sender:getAddress(input.sender)},guard,now,{...input,sender:getAddress(input.sender)});
  }
  async recordBroadcast(op: MemberOperation, payload: { transactionHash: MemberHex; state:"acknowledged"|"unknown" }, guard: AtomicMemberFence, now: number) {
    op=this.#snapshotOperation(op);payload=structuredClone(payload);guard=fence(structuredClone(guard));now=epoch(now);
    const transaction=(await this.artifacts(op)).transaction;
    memberRequire(transaction && JSON.parse(transaction).transactionHash===payload.transactionHash &&
      (payload.state==="acknowledged" || payload.state==="unknown"),"request_conflict");
    return this.#artifact(op,"broadcast",payload,guard,now);
  }
  async recordObservation(op: MemberOperation, observation: NameObservation, guard: AtomicMemberFence, now: number) {
    op=this.#snapshotOperation(op);observation=structuredClone(observation);guard=fence(structuredClone(guard));now=epoch(now);
    const g=publicId(), digest=hashJson(observation), id=op.original.requestId;
    await this.#batch([this.#guard(g,guard),this.#statement(`INSERT INTO community_member_observations(operation_id,observation_digest,observation_json,created_at)
      SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM community_member_operations WHERE operation_id=? AND original_digest=?)
      AND NOT EXISTS(SELECT 1 FROM community_member_observations WHERE operation_id=? AND observation_digest=?)`,[id,digest,safeJson(observation),now,id,op.digest,id,digest]),
      this.#statement("DELETE FROM transaction_guards WHERE guard_id=?",[g])]);
  }
}
