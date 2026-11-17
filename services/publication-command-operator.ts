import type { Address, Hex } from "viem";
import { check, digest } from "../packages/protocol/index.ts";
import {
  consentAddress,
  consentDigest,
  publicationPurposes,
} from "../packages/protocol/publication-consent.ts";
import type {
  ConsentSourceV1,
  PreparedConsentCommandV1,
  ConsentCommandReceiptV1,
} from "../packages/protocol/publication-runtime-v1.ts";
import { enqueuePublicationCommand } from "./operator-tx.ts";
import { reserveSponsorship, chargeSponsorship } from "./sponsor-budget.ts";
import type { ResultStore } from "./learning-transactions.ts";
import type { PublicationIssuerV1 } from "./publication-command-auth.ts";
import {
  capturedFee,
  commandId,
  exact,
  feeLimits,
  generation,
  parseCommand,
  preparedCall,
  record,
  same,
  signature,
  source,
  sourceId,
  type CapturedPublicationFeeV1,
} from "./publication-command-contract.ts";

export type PublicationCommandKind =
  | "record_publication_grant"
  | "record_publication_withdrawal";
export interface PublicationCommandJob {
  schema: "pirate.publication-queued/1";
  command: PreparedConsentCommandV1;
  signature: Hex;
  fee: CapturedPublicationFeeV1;
  bodyHash: Hex;
  kind: PublicationCommandKind;
  ref: Hex;
  data: Hex;
}
export interface PublicationFenceV1 {
  schema: "pirate.publication-inhibition/1";
  commandId: Hex;
  accountId: string;
  requestId: string;
  source: ConsentSourceV1;
  learner: Address;
  purpose: string;
  generation: string;
  requestHash: Hex;
}
interface Head {
  generation: number;
  stopped: boolean;
  commandId: Hex | null;
}
interface AccountFence {
  schema: "pirate.publication-account-fence/1";
  witness: PublicationFenceV1;
  bodyHash: Hex;
  conflicted: boolean;
}
const headKey = (s: ConsentSourceV1, learner: Address, purpose: string) =>
  "publicationV1Head:" + digest({ sourceId: sourceId(s), learner, purpose });
const accountKey = (s: ConsentSourceV1, accountId: string, purpose: string) =>
  "publicationV1AccountFence:" +
  digest({ sourceId: sourceId(s), accountId, purpose });
const jobKey = (id: Hex) => "publicationV1Command:" + id;
export const readPublicationJob = (store: ResultStore, id: Hex) =>
  store.get<PublicationCommandJob>(jobKey(id));
function head(store: ResultStore, key: string): Head {
  const h = store.get<Head>(key) ?? {
    generation: 0,
    stopped: true,
    commandId: null,
  };
  check(
    Number.isSafeInteger(h.generation) &&
      h.generation >= 0 &&
      typeof h.stopped === "boolean",
    "publication_fence_invalid",
  );
  return h;
}
export const publicationFenceState = (
  store: ResultStore,
  s: ConsentSourceV1,
  learner: Address,
  purpose: string,
) => head(store, headKey(s, learner, purpose));
function expectedSource(value: ConsentSourceV1, expected: PublicationIssuerV1) {
  check(
    same(source(value), source(expected.source)),
    "publication_source_changed",
  );
}
function accountFence(
  store: ResultStore,
  s: ConsentSourceV1,
  accountId: string,
  purpose: string,
) {
  const saved = store.get<AccountFence>(accountKey(s, accountId, purpose));
  if (saved) {
    const w = saved.witness;
    check(
      saved.schema === "pirate.publication-account-fence/1" &&
        typeof saved.conflicted === "boolean" &&
        digest(w) === saved.bodyHash &&
        w.accountId === accountId &&
        w.purpose === purpose &&
        sourceId(source(w.source)) === sourceId(s) &&
        generation(w.generation) > 0,
      "publication_account_fence_invalid",
    );
  }
  return saved;
}
/** Called only in the actual inhibition transaction after exact ACK/body
 * validation. Old ACK backfill never changes any learner head. */
function attributeAccountFence(
  store: ResultStore,
  witness: PublicationFenceV1,
  bodyHash: Hex,
) {
  const key = accountKey(witness.source, witness.accountId, witness.purpose),
    old = accountFence(
      store,
      witness.source,
      witness.accountId,
      witness.purpose,
    ),
    g = generation(witness.generation);
  if (old && generation(old.witness.generation) > g) return;
  if (old && generation(old.witness.generation) === g) {
    if (old.bodyHash !== bodyHash && !old.conflicted)
      store.set(key, { ...old, conflicted: true });
    return;
  }
  const current = head(
    store,
    headKey(witness.source, witness.learner, witness.purpose),
  );
  // A larger remote head is NOT an account generation to infer/adopt.
  if (current.generation !== g || current.commandId !== witness.commandId)
    return;
  store.set(key, {
    schema: "pirate.publication-account-fence/1",
    witness,
    bodyHash,
    conflicted: false,
  } satisfies AccountFence);
}
/** Fresh grant only. The exact original-job replay shortcut stays before
 * this gate. Monotonic alignment inhibits a new learner; it never opens one. */
function alignGrantSubject(store: ResultStore, c: PreparedConsentCommandV1) {
  const g = generation(c.localFenceGeneration),
    key = headKey(c.source, c.message.learner, c.message.purpose),
    target = head(store, key),
    account = accountFence(store, c.source, c.accountId, c.message.purpose);
  if (g === 0) {
    check(
      !account && target.generation === 0,
      "publication_account_generation_unacknowledged",
    );
    return target;
  }
  check(
    account &&
      !account.conflicted &&
      generation(account.witness.generation) === g,
    "publication_account_generation_unacknowledged",
  );
  const w = account.witness,
    ack = store.get<{
      bodyHash: Hex;
      ack: { commandId: Hex; generation: number; requestHash: Hex };
    }>("publicationV1Fence:" + w.commandId),
    witnessHead = head(store, headKey(w.source, w.learner, w.purpose));
  check(
    ack &&
      ack.bodyHash === account.bodyHash &&
      ack.ack.commandId === w.commandId &&
      ack.ack.generation === g &&
      ack.ack.requestHash === w.requestHash &&
      witnessHead.generation === g &&
      witnessHead.commandId === w.commandId,
    "publication_account_fence_unacknowledged",
  );
  check(target.generation <= g, "publication_subject_generation_ahead");
  if (target.generation < g) {
    const aligned = {
      generation: g,
      stopped: true,
      commandId: w.commandId,
    } satisfies Head;
    store.set(key, aligned);
    return aligned;
  }
  return target; // Equality must not restop a later opened cohort.
}
/** Inhibits only. It never grants, clears a stop, allocates a nonce or sends. */
export function inhibitPublication(
  store: ResultStore,
  value: unknown,
  expected: PublicationIssuerV1,
) {
  const v = record(value);
  exact(v, [
    "schema",
    "commandId",
    "accountId",
    "requestId",
    "source",
    "learner",
    "purpose",
    "generation",
    "requestHash",
  ]);
  const s = source(v.source);
  expectedSource(s, expected);
  const learner = consentAddress(v.learner),
    g = generation(v.generation);
  check(
    v.schema === "pirate.publication-inhibition/1" &&
      g > 0 &&
      typeof v.purpose === "string" &&
      publicationPurposes.some((p) => p === v.purpose) &&
      typeof v.accountId === "string" &&
      /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(v.accountId) &&
      typeof v.requestId === "string" &&
      /^[a-zA-Z0-9:_-]{1,160}(?![\s\S])/.test(v.requestId),
    "publication_fence_invalid",
  );
  const id = consentDigest(v.commandId),
    hash = consentDigest(v.requestHash);
  check(
    id ===
      commandId({
        source: s,
        accountId: v.accountId,
        requestId: v.requestId,
        action: "withdraw",
        purpose: v.purpose,
      }),
    "publication_fence_identity_changed",
  );
  const bodyHash = digest(v),
    ackKey = "publicationV1Fence:" + id;
  return store.transaction(() => {
    const old = store.get<{
      bodyHash: Hex;
      ack: { commandId: Hex; generation: number; requestHash: Hex };
    }>(ackKey);
    if (old) {
      check(old.bodyHash === bodyHash, "publication_fence_changed");
      attributeAccountFence(
        store,
        v as unknown as PublicationFenceV1,
        bodyHash,
      );
      return old.ack; // Old replay never inhibits a newer cohort again.
    }
    const key = headKey(s, learner, v.purpose as string),
      h = head(store, key);
    check(g > h.generation, "publication_fence_generation_stale");
    const ack = { commandId: id, generation: g, requestHash: hash };
    store.set(key, {
      generation: g,
      stopped: true,
      commandId: id,
    } satisfies Head);
    store.set(ackKey, { bodyHash, ack });
    attributeAccountFence(store, v as unknown as PublicationFenceV1, bodyHash);
    return ack;
  });
}
/** Queue-only first slice. A queued response is not wallet-signature or
 * on-chain grant acceptance. The sender remains explicitly unqualified. */
export function acceptPublicationCommand(
  store: ResultStore,
  value: unknown,
  expected: PublicationIssuerV1,
  selectedFee?: CapturedPublicationFeeV1,
) {
  const v = record(value);
  exact(v, ["command", "signature", "fee"]);
  const c = parseCommand(v.command),
    sig = signature(v.signature),
    fee = capturedFee(v.fee);
  expectedSource(c.source, expected);
  const prepared = preparedCall(c, sig);
  check(prepared.digest === c.digest, "publication_command_digest_changed");
  const kind: PublicationCommandKind =
    c.action === "grant"
      ? "record_publication_grant"
      : "record_publication_withdrawal";
  const bodyHash = digest(v),
    g = generation(c.localFenceGeneration);
  return store.transaction(() => {
    const old = readPublicationJob(store, c.commandId);
    if (old) {
      check(old.bodyHash === bodyHash, "publication_command_changed");
      return queuedReceipt(old); // Receipt reconciliation is a separate read-only call.
    }
    check(
      selectedFee &&
        same(fee, capturedFee(selectedFee)) &&
        fee.chainId === c.source.chainId &&
        fee.payer === expected.operator,
      "publication_fee_selection_changed",
    );
    const h =
      c.action === "grant"
        ? alignGrantSubject(store, c)
        : head(store, headKey(c.source, c.message.learner, c.message.purpose));
    check(h.generation === g, "publication_fence_unacknowledged");
    if (c.action === "withdraw")
      check(
        store.get("publicationV1Fence:" + c.commandId),
        "publication_fence_unacknowledged",
      );
    const job: PublicationCommandJob = {
      schema: "pirate.publication-queued/1",
      command: c,
      signature: sig,
      fee,
      bodyHash,
      kind,
      ref: c.commandId,
      data: prepared.data,
    };
    const limits = feeLimits(fee),
      reservation = `${kind}:${c.commandId}`;
    store.set(jobKey(c.commandId), job);
    reserveSponsorship(store, limits, reservation);
    enqueuePublicationCommand(
      store,
      kind,
      c.commandId,
      c.source.registry,
      prepared.data,
      fee,
    );
    chargeSponsorship(store, limits, reservation);
    return queuedReceipt(job);
  });
}
export function queuedReceipt(
  job: PublicationCommandJob,
): ConsentCommandReceiptV1 {
  const c = job.command;
  return {
    schema: "pirate.publication-command-receipt/1",
    commandId: c.commandId,
    digest: c.digest,
    action: c.action,
    purpose: c.message.purpose,
    source: c.source,
    transactionHash: null,
    state: "queued",
  };
}
