import { encodeAbiParameters, type Hex } from "viem";
import { canonical, digest } from "../packages/protocol/index.ts";
import { insist, token } from "../packages/community/common.ts";
import {
  consentDigest,
  consentUint64,
  parsePublicationGrant,
} from "../packages/protocol/publication-consent.ts";
import type {
  BoundPublicationGrantV1,
  ConsentCommandReceiptV1,
  PreparedConsentCommandV1,
} from "../packages/protocol/publication-runtime-v1.ts";
import type { DanceFence } from "../packages/dance/contracts.ts";
import { DANCE_DB_NOW } from "../packages/dance/store.ts";
import { danceId } from "../packages/dance/validation.ts";
import {
  danceAccountCommitment,
  danceCaptureHash,
  type DanceCapture,
  type DanceDecision,
} from "../packages/dance-chain/v2/wire.ts";
import { danceShapes } from "../packages/dance-chain/v2/wire-shapes.ts";
import type { DancePublicationJournal } from "./dance-publication-reader.ts";
import { PublicationInstallation } from "./publication-installed-selection.ts";
import { PublicationReleaseCatalog } from "./publication-app-selection.ts";
import {
  PublicationRequestSession,
  publicationOriginal,
} from "./publication-app-request.ts";
import { publicationActivationHead } from "./publication-app-activation.ts";
import { publicationObservation } from "./publication-app-journal.ts";
import {
  reconcilePublicationOriginal,
  type PublicationOutbox,
} from "./publication-app-outbox.ts";
import {
  PublicationOperatorTransport,
  parsePublicationReceipt,
} from "./publication-app-transport.ts";
import {
  capturedFee,
  exact,
  parseCommand,
  record,
  signature,
  source as publicationSource,
  sourceId,
} from "./publication-command-contract.ts";
import { ownedCommand, type CommandRow } from "./publication-command-store.ts";

/** UNAPPLIED additive binding DDL. Root assigns migration selection/ordinal.
 * No command, nonce, signature or receipt is copied into a second journal.
 * Duplicate refusal also protects INSERT OR REPLACE with recursive_triggers OFF. */
export const DANCE_PUBLICATION_BINDINGS_SCHEMA_PROPOSAL = [
  "CREATE TABLE dance_publication_bindings(community_id TEXT NOT NULL,capture_id TEXT NOT NULL,capture_hash TEXT NOT NULL,account_id TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN('dance-verdict','dance-review-attribution')),command_id TEXT NOT NULL REFERENCES publication_v1_commands(command_id),value_json TEXT NOT NULL CHECK(json_valid(value_json)),PRIMARY KEY(community_id,capture_id,account_id,purpose),UNIQUE(capture_hash,account_id,purpose))",
  "CREATE TRIGGER dance_publication_binding_insert BEFORE INSERT ON dance_publication_bindings WHEN EXISTS(SELECT 1 FROM dance_publication_bindings WHERE (community_id=NEW.community_id AND capture_id=NEW.capture_id AND account_id=NEW.account_id AND purpose=NEW.purpose) OR (capture_hash=NEW.capture_hash AND account_id=NEW.account_id AND purpose=NEW.purpose)) BEGIN SELECT RAISE(ABORT,'dance_publication_binding_immutable'); END",
  "CREATE TRIGGER dance_publication_binding_update BEFORE UPDATE ON dance_publication_bindings BEGIN SELECT RAISE(ABORT,'dance_publication_binding_immutable'); END",
  "CREATE TRIGGER dance_publication_binding_delete BEFORE DELETE ON dance_publication_bindings BEGIN SELECT RAISE(ABORT,'dance_publication_binding_immutable'); END",
] as const;

type Purpose = "dance-verdict" | "dance-review-attribution";
type PrivateGrant = { accountId: string; binding: BoundPublicationGrantV1 };
interface Binding {
  schema: "pirate.dance-publication-binding/1";
  kind: "capture" | "review";
  captureId: Hex;
  captureHash: Hex;
  accountId: string;
  commandId: Hex;
  originalSha256: Hex;
  receiptSha256: Hex;
  boundAtMs: number;
  configurationRevision: string;
  ownerEpoch: string;
  actionHex: Hex | null;
  binding: BoundPublicationGrantV1;
}
interface BindingRow {
  community_id: string;
  capture_id: string;
  capture_hash: string;
  account_id: string;
  purpose: string;
  command_id: string;
  value_json: string;
}
export interface DancePublicationBindingPlan {
  readonly commandId: Hex;
  readonly captureHash: Hex;
  readonly grant: PrivateGrant;
  /** Caller joins ALL of these with canonical reader, authority/rules/media
   * fences and consumes statements in the SAME accepting DanceStore.atomic. */
  readonly fences: DanceFence[];
  readonly statements: D1PreparedStatement[];
}
type CaptureInput = {
  commandId: Hex;
  capture: DanceCapture;
  configurationRevision: string;
  ownerEpoch: string;
};
type ReviewInput = {
  commandId: Hex;
  capture: DanceCapture;
  decision: DanceDecision;
};
const eq = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const all = (parts: string[]): string =>
  parts.length === 1
    ? parts[0]!
    : "(" +
      all(parts.slice(0, Math.ceil(parts.length / 2))) +
      " AND " +
      all(parts.slice(Math.ceil(parts.length / 2))) +
      ")";
const key = (hash: string, account: string, purpose: string) =>
  JSON.stringify([hash, account, purpose]);
const columns = [
  "command_id",
  "community_id",
  "account_id",
  "source_id",
  "purpose",
  "action",
  "request_id",
  "request_hash",
  "request_json",
  "nonce_hex",
  "phase",
  "version",
  "fence_generation",
  "created_at",
  "typed_json",
  "digest",
  "signature",
  "accepted_json",
  "fence_ack_json",
  "result_state",
  "observation_hash",
] as const;
function originalHash(r: CommandRow) {
  return digest({
    commandId: r.command_id,
    community: r.community_id,
    account: r.account_id,
    sourceId: r.source_id,
    purpose: r.purpose,
    action: r.action,
    requestId: r.request_id,
    requestHash: r.request_hash,
    requestJson: r.request_json,
    nonce: r.nonce_hex,
    phase: r.phase,
    generation: r.fence_generation,
    createdAt: r.created_at,
    typedJson: r.typed_json,
    digest: r.digest,
    signature: r.signature,
    acceptedJson: r.accepted_json,
  });
}
function positive(value: string) {
  insist(consentUint64(value) > 0n, "dance_publication_context_invalid", 409);
  return value;
}
function frozen<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}

/** Request-owned adapter over the SAME app DB, installation and original
 * outbox. Does not activate a head, accept a signature, send a transaction,
 * choose a latest grant or commit a capture. Fresh prepare requires POST auth.
 * Pending preparations are exact preimages, never a memory permission cache:
 * every predicate still checks actual command/head/receipt/auth/install rows. */
export class DancePublicationBindingJournal implements DancePublicationJournal {
  readonly db: D1Database;
  private readonly p: PublicationOutbox;
  private readonly session: PublicationRequestSession;
  private readonly observeOnly: boolean;
  private readonly pending = new Map<string, string>();
  constructor(p: PublicationOutbox, session: PublicationRequestSession, observeOnly = false) {
    insist(
      p.installation instanceof PublicationInstallation &&
        p.installation.db === p.db &&
        p.catalog instanceof PublicationReleaseCatalog &&
        p.catalog === p.installation.catalog &&
        p.transport instanceof PublicationOperatorTransport &&
        session instanceof PublicationRequestSession &&
        session.db === p.db &&
        session.installation === p.installation &&
        session.context.communityId === p.installation.expected.communityId,
      "dance_publication_journal_context_required",
      503,
    );
    this.p = Object.freeze({ ...p });
    this.db = p.db;
    this.session = session;
    this.observeOnly = observeOnly;
  }
  private async read(id: Hex, accountId: string) {
    consentDigest(id);
    danceId(accountId);
    await this.session.check();
    const row = await ownedCommand(this.db, id, {
      communityId: this.session.context.communityId,
      accountId,
    });
    const original = publicationOriginal(row, this.p.catalog);
    insist(row.typed_json, "dance_publication_original_missing", 409);
    const command = parseCommand(JSON.parse(row.typed_json));
    insist(
      eq(command, JSON.parse(row.typed_json)) &&
        canonical(command) === row.typed_json &&
        command.commandId === row.command_id &&
        command.accountId === row.account_id &&
        command.requestId === row.request_id &&
        sourceId(command.source) === row.source_id &&
        eq(command.source, original.source) &&
        command.digest === row.digest &&
        command.message.purpose === row.purpose &&
        command.message.nonce === row.nonce_hex &&
        command.localFenceGeneration === String(row.fence_generation),
      "dance_publication_original_changed",
      409,
    );
    if (row.phase === "accepted") {
      insist(
        row.accepted_json && row.signature,
        "dance_publication_original_missing",
        409,
      );
      const accepted = record(JSON.parse(row.accepted_json));
      exact(accepted, ["command", "signature", "fee"]);
      insist(
        canonical(accepted) === row.accepted_json &&
          eq(accepted.command, command) &&
          signature(accepted.signature) === row.signature &&
          eq(capturedFee(accepted.fee), original.release.fee),
        "dance_publication_original_changed",
        409,
      );
    }
    await this.session.check();
    return { row, command, original };
  }
  async reconcileOriginal(
    value: PreparedConsentCommandV1,
  ): Promise<ConsentCommandReceiptV1> {
    const command = parseCommand(structuredClone(value));
    insist(
      command.accountId === this.session.original.account_id &&
        command.source.communityId === this.session.context.communityId,
      "dance_publication_command_not_owned",
      403,
    );
    let current = await this.read(command.commandId, command.accountId);
    insist(
      eq(current.command, command),
      "dance_publication_original_changed",
      409,
    );
    if (current.row.phase === "prepared")
      return {
        schema: "pirate.publication-command-receipt/1",
        commandId: command.commandId,
        digest: command.digest,
        action: command.action,
        purpose: command.message.purpose,
        source: structuredClone(command.source),
        transactionHash: null,
        state: "prepared",
      };
    insist(
      current.row.phase === "accepted",
      "dance_publication_original_missing",
      409,
    );
    if (!this.observeOnly) await reconcilePublicationOriginal(this.p, current.row);
    await this.session.check();
    current = await this.read(command.commandId, command.accountId);
    insist(
      eq(current.command, command),
      "dance_publication_original_changed",
      409,
    );
    const observed = await publicationObservation(this.db, current.row);
    insist(observed, "dance_publication_original_missing", 503);
    const receipt = structuredClone(parsePublicationReceipt(observed, command));
    await this.session.check();
    return receipt;
  }
  private stored(row: BindingRow): Binding {
    const d = record(JSON.parse(row.value_json));
    exact(d, [
      "schema",
      "kind",
      "captureId",
      "captureHash",
      "accountId",
      "commandId",
      "originalSha256",
      "receiptSha256",
      "boundAtMs",
      "configurationRevision",
      "ownerEpoch",
      "actionHex",
      "binding",
    ]);
    const b = record(d.binding);
    exact(b, [
      "schema",
      "source",
      "grantId",
      "grant",
      "recordedAtS",
      "boundAtS",
      "localFenceGeneration",
    ]);
    const command = parsePublicationGrant(b.grant),
      selectedSource = publicationSource(b.source);
    danceId(d.accountId);
    insist(
      canonical(d) === row.value_json &&
        d.schema === "pirate.dance-publication-binding/1" &&
        (d.kind === "capture" || d.kind === "review") &&
        b.schema === "pirate.bound-publication-grant/1" &&
        d.captureId === row.capture_id &&
        d.captureHash === row.capture_hash &&
        d.accountId === row.account_id &&
        d.commandId === row.command_id &&
        command.communityId === row.community_id &&
        selectedSource.communityId === row.community_id &&
        command.purpose === row.purpose &&
        (d.kind === "capture"
          ? command.purpose === "dance-verdict" && d.actionHex === null
          : command.purpose === "dance-review-attribution" &&
            typeof d.actionHex === "string" &&
            /^0x(?:[0-9a-f]{2})+$/.test(d.actionHex)),
      "dance_publication_binding_changed",
      409,
    );
    for (const v of [
      d.captureId,
      d.captureHash,
      d.commandId,
      d.originalSha256,
      d.receiptSha256,
      b.grantId,
    ])
      consentDigest(v);
    positive(d.configurationRevision as string);
    positive(d.ownerEpoch as string);
    insist(
      typeof d.boundAtMs === "number" &&
        Number.isSafeInteger(d.boundAtMs) &&
        d.boundAtMs > 0 &&
        consentUint64(b.boundAtS) === BigInt(d.boundAtMs) / 1000n,
      "dance_publication_binding_changed",
      409,
    );
    consentUint64(b.recordedAtS);
    consentUint64(b.localFenceGeneration);
    return d as unknown as Binding;
  }
  private async lookup(captureHash: Hex, account: string, purpose: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM dance_publication_bindings WHERE capture_hash=? AND account_id=? AND purpose=?",
      )
      .bind(captureHash, account, purpose)
      .first<BindingRow>();
    return row ? this.stored(row) : null;
  }
  private bindingFence(d: Binding, allowAbsent: boolean): DanceFence {
    const scope = [
      d.binding.source.communityId,
      d.captureId,
      d.accountId,
      d.binding.grant.purpose,
    ];
    const exact =
      "EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND account_id=? AND purpose=? AND capture_hash=? AND command_id=? AND value_json=?)";
    const values: (string | number | null)[] = [
      ...scope,
      d.captureHash,
      d.commandId,
      canonical(d),
    ];
    if (!allowAbsent) return { sql: exact, values };
    return {
      sql:
        "(" +
        exact +
        " OR (NOT EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND account_id=? AND purpose=?) AND NOT EXISTS(SELECT 1 FROM dance_publication_bindings WHERE capture_hash=? AND account_id=? AND purpose=?)))",
      values: [
        ...values,
        ...scope,
        d.captureHash,
        d.accountId,
        d.binding.grant.purpose,
      ],
    };
  }
  private async guards(
    d: Binding,
    allowAbsent: boolean,
  ): Promise<DanceFence[]> {
    const current = await this.read(d.commandId, d.accountId),
      { row, command, original } = current;
    insist(
      command.action === "grant" && row.phase === "accepted",
      "dance_publication_not_recorded",
      403,
    );
    const observed = await publicationObservation(this.db, row);
    insist(observed, "dance_publication_not_recorded", 403);
    const receipt = parsePublicationReceipt(observed, command);
    insist(
      receipt.state === "recorded" &&
        row.result_state === "recorded" &&
        d.originalSha256 === originalHash(row) &&
        row.observation_hash === d.receiptSha256 &&
        digest(receipt) === d.receiptSha256 &&
        command.digest === d.binding.grantId &&
        eq(command.source, d.binding.source) &&
        eq(command.message, d.binding.grant) &&
        receipt.observed.timestampS === d.binding.recordedAtS &&
        command.localFenceGeneration === d.binding.localFenceGeneration,
      "dance_publication_binding_changed",
      409,
    );
    const g = parsePublicationGrant(command.message),
      start =
        BigInt(receipt.observed.timestampS) > g.validAfter
          ? BigInt(receipt.observed.timestampS)
          : g.validAfter,
      end = g.expiresAt,
      bound = consentUint64(d.binding.boundAtS);
    const now = this.p.nowMs();
    insist(
      start > 0n &&
        start <= bound &&
        bound < end &&
        end * 1000n <= BigInt(Number.MAX_SAFE_INTEGER) &&
        Number.isSafeInteger(now) &&
        now >= d.boundAtMs &&
        BigInt(now) >= start * 1000n &&
        BigInt(now) < end * 1000n,
      "dance_publication_lease_expired",
      403,
    );
    const head = await publicationActivationHead(this.db, row);
    insist(
      head.generation === row.fence_generation &&
        String(head.generation) === d.binding.localFenceGeneration &&
        head.stopped === 0 &&
        head.pending === 0,
      "dance_publication_local_changed",
      403,
    );
    const c = original.capture;
    if (d.accountId === this.session.original.account_id)
      this.session.assertOriginal(c);
    const credential = await this.db
      .prepare(
        "SELECT a.author_id,a.created_at AS account_created,b.binding_id,b.subject,b.namespace,b.network,b.created_at AS binding_created FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND b.binding_id=?",
      )
      .bind(d.accountId, c.bindingId)
      .first<{
        author_id: string;
        account_created: number;
        binding_id: string;
        subject: string;
        namespace: string;
        network: number;
        binding_created: number;
      }>();
    insist(
      credential &&
        credential.author_id === c.authorId &&
        credential.subject === c.learner &&
        credential.subject === g.learner &&
        credential.namespace === "moss" &&
        credential.network === 6343 &&
        [credential.account_created, credential.binding_created].every(
          (n) => Number.isSafeInteger(n) && n > 0,
        ),
      "dance_publication_private_account_changed",
      403,
    );
    const archive = await this.db
      .prepare(
        "SELECT release_json,transport_ref,admitted_binding_sha256 FROM publication_v1_release_archive WHERE community_id=? AND release_sha256=?",
      )
      .bind(command.source.communityId, command.source.releaseSelectionSha256)
      .first<{
        release_json: string;
        transport_ref: string;
        admitted_binding_sha256: string;
      }>();
    insist(
      archive &&
        archive.release_json === canonical(original.release) &&
        archive.transport_ref ===
          this.p.installation!.transportFor(
            command.source.releaseSelectionSha256,
          ),
      "dance_publication_archive_changed",
      503,
    );
    consentDigest(archive.admitted_binding_sha256);
    await this.session.check();
    const auth = this.session.observationFence({
      db: this.db,
      accountId: this.session.original.account_id,
      communityId: command.source.communityId,
      source: command.source,
      active: true,
    });
    const fences: DanceFence[] = [
      {
        sql:
          "EXISTS(SELECT 1 FROM publication_v1_commands c WHERE " +
          all(columns.map((k) => "c." + k + " IS ?")) +
          ")",
        values: columns.map((k) => row[k]),
      },
      {
        sql: "EXISTS(SELECT 1 FROM publication_v1_observations WHERE command_id=? AND proof_hash=? AND value_json=?)",
        values: [row.command_id, row.observation_hash, canonical(receipt)],
      },
      {
        sql: "EXISTS(SELECT 1 FROM publication_v1_heads h WHERE h.community_id=? AND h.account_id=? AND h.source_id=? AND h.purpose=? AND h.generation=? AND h.stopped=0 AND h.stop_command_id IS ? AND NOT EXISTS(SELECT 1 FROM publication_v1_commands w WHERE w.community_id=h.community_id AND w.account_id=h.account_id AND w.source_id=h.source_id AND w.purpose=h.purpose AND w.action='withdraw' AND (w.fence_generation IS NULL OR w.fence_ack_json IS NULL OR COALESCE(w.result_state,'') NOT IN ('recorded','reverted','withheld'))))",
        values: [
          row.community_id,
          row.account_id,
          row.source_id,
          row.purpose,
          head.generation,
          head.stop_command_id,
        ],
      },
      {
        sql: "EXISTS(SELECT 1 FROM community_accounts a JOIN credential_bindings b ON b.account_id=a.account_id WHERE a.account_id=? AND a.author_id=? AND a.created_at=? AND b.binding_id=? AND b.subject=? AND b.namespace=? AND b.network=? AND b.created_at=?)",
        values: [
          d.accountId,
          credential.author_id,
          credential.account_created,
          credential.binding_id,
          credential.subject,
          credential.namespace,
          credential.network,
          credential.binding_created,
        ],
      },
      {
        sql: "EXISTS(SELECT 1 FROM application_identity WHERE id=1 AND community_id=? AND community_origin=?)",
        values: [row.community_id, c.origin],
      },
      {
        sql: "EXISTS(SELECT 1 FROM publication_v1_release_archive WHERE community_id=? AND release_sha256=? AND release_json=? AND transport_ref=? AND admitted_binding_sha256=?)",
        values: [
          row.community_id,
          command.source.releaseSelectionSha256,
          archive.release_json,
          archive.transport_ref,
          archive.admitted_binding_sha256,
        ],
      },
      auth,
      this.p.installation!.fence(
        "active",
        command.source.releaseSelectionSha256,
      ),
      {
        sql: DANCE_DB_NOW + ">=? AND " + DANCE_DB_NOW + "<?",
        values: [Number(start * 1000n), Number(end * 1000n)],
      },
      this.bindingFence(d, allowAbsent),
    ];
    const finalNow = this.p.nowMs();
    insist(
      Number.isSafeInteger(finalNow) &&
        finalNow >= now &&
        finalNow >= d.boundAtMs &&
        BigInt(finalNow) >= start * 1000n &&
        BigInt(finalNow) < end * 1000n,
      "dance_publication_lease_expired",
      403,
    );
    return fences;
  }
  private writes(d: Binding): D1PreparedStatement[] {
    const b = d.binding,
      guard = this.bindingFence(d, false);
    return [
      this.db
        .prepare(
          "INSERT INTO dance_publication_bindings(community_id,capture_id,capture_hash,account_id,purpose,command_id,value_json) SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND account_id=? AND purpose=?) AND NOT EXISTS(SELECT 1 FROM dance_publication_bindings WHERE capture_hash=? AND account_id=? AND purpose=?)",
        )
        .bind(
          b.source.communityId,
          d.captureId,
          d.captureHash,
          d.accountId,
          b.grant.purpose,
          d.commandId,
          canonical(d),
          b.source.communityId,
          d.captureId,
          d.accountId,
          b.grant.purpose,
          d.captureHash,
          d.accountId,
          b.grant.purpose,
        ),
      this.db
        .prepare(
          "INSERT INTO dance_transaction_guards SELECT ?,CASE WHEN (" +
            guard.sql +
            ") THEN 1 ELSE 0 END",
        )
        .bind(token(), ...guard.values),
    ];
  }
  async prepareCapture(
    input: CaptureInput,
  ): Promise<DancePublicationBindingPlan> {
    return this.prepare({ kind: "capture", ...structuredClone(input) });
  }
  async prepareReview(
    input: ReviewInput,
  ): Promise<DancePublicationBindingPlan> {
    return this.prepare({ kind: "review", ...structuredClone(input) });
  }
  private async prepare(
    input:
      | ({ kind: "capture" } & CaptureInput)
      | ({ kind: "review" } & ReviewInput),
  ) {
    const original = await this.read(
        input.commandId,
        this.session.original.account_id,
      ),
      command = original.command;
    insist(command.action === "grant", "dance_publication_not_recorded", 403);
    const g = parsePublicationGrant(command.message),
      account = this.session.original.account_id;
    this.session.assertOriginal(original.original.capture);
    const purpose: Purpose =
      input.kind === "capture" ? "dance-verdict" : "dance-review-attribution";
    insist(g.purpose === purpose, "dance_publication_binding_changed", 409);
    const c = input.capture,
      domain = {
        chainId: BigInt(command.source.chainId),
        communityId: command.source.communityId,
        verifier: g.publicationTarget,
      },
      hash = danceCaptureHash(domain, c);
    const atMs =
      input.kind === "capture"
        ? c.reservedAtMs
        : input.decision.intentAcceptedAtMs;
    insist(
      atMs > 0n && atMs <= BigInt(Number.MAX_SAFE_INTEGER),
      "dance_publication_binding_changed",
      409,
    );
    if (input.kind === "capture")
      insist(
        c.publicationGrantId === command.digest &&
          c.learner.toLowerCase() === g.learner &&
          c.accountCommitment ===
            danceAccountCommitment(domain, account, g.learner),
        "dance_publication_binding_changed",
        409,
      );
    else
      insist(
        input.decision.reviewerPublicationGrantId === command.digest &&
          input.decision.reviewerWallet.toLowerCase() === g.learner &&
          input.decision.reviewerAccountCommitment ===
            danceAccountCommitment(domain, account, g.learner) &&
          c.learner.toLowerCase() !== g.learner,
        "dance_publication_binding_changed",
        409,
      );
    let learner: Binding | null = null;
    if (input.kind === "review") {
      const rows = await this.db
        .prepare(
          "SELECT * FROM dance_publication_bindings WHERE capture_hash=? AND purpose='dance-verdict' LIMIT 2",
        )
        .bind(hash)
        .all<BindingRow>();
      insist(
        rows.results.length === 1,
        "dance_publication_binding_changed",
        409,
      );
      learner = this.stored(rows.results[0]!);
      insist(
        learner.captureId === c.captureId &&
          learner.binding.grantId === c.publicationGrantId &&
          eq(learner.binding.source, command.source) &&
          learner.accountId !== account &&
          learner.binding.grant.learner === c.learner.toLowerCase() &&
          danceAccountCommitment(domain, learner.accountId, c.learner) ===
            c.accountCommitment,
        "dance_publication_binding_changed",
        409,
      );
    }
    const configurationRevision = positive(
      input.kind === "capture"
        ? input.configurationRevision
        : String(input.decision.expectedConfigurationRevision),
    );
    const ownerEpoch = positive(
      input.kind === "capture"
        ? input.ownerEpoch
        : String(input.decision.expectedOwnerEpoch),
    );
    const previous = await this.db
      .prepare(
        "SELECT * FROM dance_publication_bindings WHERE community_id=? AND capture_id=? AND account_id=? AND purpose=?",
      )
      .bind(command.source.communityId, c.captureId, account, purpose)
      .first<BindingRow>();
    if (previous)
      insist(
        this.stored(previous).commandId === command.commandId,
        "dance_publication_binding_changed",
        409,
      );
    const receipt = await this.reconcileOriginal(command);
    insist(receipt.state === "recorded", "dance_publication_not_recorded", 403);
    const current = await this.read(command.commandId, account);
    const binding: BoundPublicationGrantV1 = {
      schema: "pirate.bound-publication-grant/1",
      source: structuredClone(command.source),
      grantId: command.digest,
      grant: structuredClone(command.message),
      recordedAtS: receipt.observed.timestampS,
      boundAtS: String(atMs / 1000n),
      localFenceGeneration: command.localFenceGeneration,
    };
    const d: Binding = {
      schema: "pirate.dance-publication-binding/1",
      kind: input.kind,
      captureId: c.captureId,
      captureHash: hash,
      accountId: account,
      commandId: command.commandId,
      originalSha256: originalHash(current.row),
      receiptSha256: digest(receipt),
      boundAtMs: Number(atMs),
      configurationRevision,
      ownerEpoch,
      actionHex:
        input.kind === "review"
          ? encodeAbiParameters([danceShapes.decision], [input.decision])
          : null,
      binding,
    };
    const bytes = canonical(d),
      pending = this.pending.get(key(hash, account, purpose));
    insist(
      (!previous || eq(this.stored(previous), d)) &&
        (!pending || pending === bytes),
      "dance_publication_binding_changed",
      409,
    );
    const writeAuth = this.session.mutationFence({
      db: this.db,
      accountId: account,
      communityId: command.source.communityId,
      source: command.source,
      active: true,
    });
    // Epochs are immutable join keys; Root's canonical owner/rules/media
    // predicates remain independently REQUIRED in the same accepting batch.
    insist(
      !learner ||
        (learner.configurationRevision === configurationRevision &&
          learner.ownerEpoch === ownerEpoch),
      "dance_publication_binding_changed",
      409,
    );
    const fences = [
      ...(await this.guards(d, !previous)),
      ...(learner ? await this.guards(learner, false) : []),
      writeAuth,
    ];
    this.pending.set(key(hash, account, purpose), bytes);
    return {
      commandId: command.commandId,
      captureHash: hash,
      grant: frozen(structuredClone({ accountId: account, binding })),
      fences,
      statements: this.writes(d),
    };
  }
  async acceptanceFences(
    input: Parameters<DancePublicationJournal["acceptanceFences"]>[0],
  ): Promise<readonly DanceFence[]> {
    const request = structuredClone(input);
    consentDigest(request.captureHash);
    positive(request.configurationRevision);
    positive(request.ownerEpoch);
    insist(
      request.grants.length > 0 && request.grants.length <= 2,
      "dance_publication_subjects_changed",
      409,
    );
    insist(
      request.grants[0]!.binding.grant.purpose === "dance-verdict" &&
        (request.grants.length === 1 ||
          (request.grants[1]!.binding.grant.purpose ===
            "dance-review-attribution" &&
            request.grants[0]!.accountId !== request.grants[1]!.accountId &&
            request.grants[0]!.binding.grant.learner !==
              request.grants[1]!.binding.grant.learner)),
      "dance_publication_subjects_changed",
      409,
    );
    const seen = new Set<string>(),
      result: DanceFence[] = [];
    for (const item of request.grants) {
      danceId(item.accountId);
      const purpose = item.binding.grant.purpose,
        id = key(request.captureHash, item.accountId, purpose);
      insist(!seen.has(id), "dance_publication_subjects_changed", 409);
      seen.add(id);
      const saved = await this.lookup(
          request.captureHash,
          item.accountId,
          purpose,
        ),
        pending = this.pending.get(id);
      const d = saved ?? (pending ? (JSON.parse(pending) as Binding) : null);
      insist(
        d &&
          eq(d.binding, item.binding) &&
          d.accountId === item.accountId &&
          d.configurationRevision === request.configurationRevision &&
          d.ownerEpoch === request.ownerEpoch,
        "dance_publication_binding_changed",
        409,
      );
      // Reconcile this retained original, not an account's newest permission.
      const row = await this.read(d.commandId, d.accountId);
      if (!this.observeOnly) await reconcilePublicationOriginal(this.p, row.row);
      await this.session.check();
      result.push(...(await this.guards(d, !saved && pending !== undefined)));
    }
    return result;
  }
}
export const createDancePublicationJournal = (
  p: PublicationOutbox,
  session: PublicationRequestSession,
  observeOnly = false,
) => new DancePublicationBindingJournal(p, session, observeOnly);
