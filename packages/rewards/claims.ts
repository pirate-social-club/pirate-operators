import { bytes32, insist, token } from "../community/common.ts";
import type {
  ClaimOutcome,
  RewardPrincipal,
  RewardVerificationProvider,
  VerificationIntent,
} from "./contracts.ts";
import { RewardStore, type CreditRow } from "./store.ts";
import { rewardId, rewardProgramScope, rewardSubject } from "./validation.ts";

interface IntentRow {
  intent_id: string;
  account_id: string;
  wallet: string;
  challenge: string;
  key_hex: string;
  provider_id: string;
  launch_url: string;
  state: VerificationIntent["state"];
  expires_at: number;
}
export class RewardClaims {
  readonly store: RewardStore;
  readonly provider: RewardVerificationProvider;
  readonly now: () => number;
  constructor(
    store: RewardStore,
    provider: RewardVerificationProvider,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.provider = provider;
    this.now = now;
  }
  private async owned(principal: RewardPrincipal, id: string) {
    const row = await this.store
      .statement(
        `SELECT c.*,p.state AS payment_state FROM reward_credits c LEFT JOIN reward_payments p ON p.payment_id=c.payment_id WHERE c.program_id=? AND c.credit_id=? AND c.account_id=? AND c.wallet=?`,
        this.store.program,
        rewardId(id),
        principal.accountId,
        principal.wallet,
      )
      .first<CreditRow>();
    insist(row, "reward_credit_not_found", 404);
    return row;
  }
  async claim(principal: RewardPrincipal, id: string) {
    const outcome = await this.store.atomic(async () => {
      const row = await this.owned(principal, id);
      if (row.claim_state !== "unclaimed")
        return {
          value:
            row.claim_state === "accepted"
              ? ("accepted" as const)
              : ("subject_conflict" as const),
          statements: [],
        };
      const binding = await this.store
        .statement(
          "SELECT wallet FROM reward_subjects WHERE program_id=? AND account_id=?",
          this.store.program,
          principal.accountId,
        )
        .first<{ wallet: string }>();
      if (!binding)
        return { value: "verification_missing" as const, statements: [] };
      insist(
        binding.wallet === principal.wallet,
        "reward_claim_wallet_changed",
        409,
      );
      return {
        value: "accepted" as ClaimOutcome,
        statements: [
          this.store.statement(
            "UPDATE reward_credits SET claim_state='accepted' WHERE program_id=? AND credit_id=? AND account_id=?",
            this.store.program,
            id,
            principal.accountId,
          ),
        ],
      };
    });
    return {
      outcome,
      credit: this.store.creditView(await this.owned(principal, id)),
    };
  }
  async intent(principal: RewardPrincipal): Promise<VerificationIntent> {
    await this.expire();
    const eligible = await this.store
      .statement(
        "SELECT 1 AS present FROM reward_credits WHERE program_id=? AND account_id=? AND wallet=? AND claim_state='unclaimed' LIMIT 1",
        this.store.program,
        principal.accountId,
        principal.wallet,
      )
      .first();
    insist(eligible, "reward_claim_not_available", 409);
    const intentId = crypto.randomUUID(),
      key = token(),
      challenge = BigInt(`0x${token().slice(0, 32)}`).toString(),
      expires = this.now() + 300000;
    const selected = await this.store.atomic(async () => {
      const open = await this.store
        .statement(
          "SELECT * FROM reward_verification_intents WHERE program_id=? AND account_id=? AND wallet=? AND state IN ('opening','pending') AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
          this.store.program,
          principal.accountId,
          principal.wallet,
          this.now(),
        )
        .first<IntentRow>();
      if (open) return { value: { row: open, create: false }, statements: [] };
      const row: IntentRow = {
        intent_id: intentId,
        account_id: principal.accountId,
        wallet: principal.wallet,
        challenge,
        key_hex: key,
        provider_id: "",
        launch_url: "",
        state: "opening",
        expires_at: expires,
      };
      return {
        value: { row, create: true },
        statements: [
          this.store.statement(
            "INSERT INTO reward_verification_intents(intent_id,program_id,account_id,wallet,challenge,key_hex,provider_id,launch_url,state,expires_at) VALUES(?,?,?,?,?,?,'','','opening',?)",
            intentId,
            this.store.program,
            principal.accountId,
            principal.wallet,
            challenge,
            key,
            expires,
          ),
        ],
      };
    });
    if (selected.create) {
      const { externalNullifier } = rewardProgramScope(this.store.program);
      // Durable opening intent precedes provider dispatch. An unknown response is not replayed.
      const opened = await this.provider.open(
        this.store.profile.veryAppId,
        externalNullifier,
        challenge,
        Uint8Array.from(Buffer.from(key, "hex")),
        expires,
      );
      insist(
        /^[a-zA-Z0-9_-]{1,256}$/.test(opened.id) &&
          opened.launchUrl.startsWith("veros://verify?"),
        "invalid_reward_verification_session",
        503,
      );
      await this.store.atomic(async () => ({
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_verification_intents SET provider_id=?,launch_url=?,state='pending' WHERE intent_id=? AND program_id=? AND state='opening'",
            opened.id,
            opened.launchUrl,
            intentId,
            this.store.program,
          ),
        ],
      }));
    }
    return this.readIntent(principal, selected.row.intent_id, false);
  }
  async expire() {
    await this.store.atomic(async () => ({
      value: null,
      statements: [
        this.store.statement(
          "UPDATE reward_verification_intents SET state='expired',key_hex='',launch_url='' WHERE program_id=? AND state IN ('opening','pending') AND expires_at<=?",
          this.store.program,
          this.now(),
        ),
      ],
    }));
  }
  async readIntent(
    principal: RewardPrincipal,
    id: string,
    poll = true,
  ): Promise<VerificationIntent> {
    let row = await this.store
      .statement(
        "SELECT * FROM reward_verification_intents WHERE program_id=? AND intent_id=? AND account_id=? AND wallet=?",
        this.store.program,
        rewardId(id),
        principal.accountId,
        principal.wallet,
      )
      .first<IntentRow>();
    insist(row, "reward_intent_not_found", 404);
    if (
      ["opening", "pending"].includes(row.state) &&
      row.expires_at <= this.now()
    ) {
      await this.store.atomic(async () => ({
        value: null,
        statements: [
          this.store.statement(
            "UPDATE reward_verification_intents SET state='expired',key_hex='',launch_url='' WHERE intent_id=? AND state IN ('opening','pending')",
            id,
          ),
        ],
      }));
      row = { ...row, state: "expired", launch_url: "" };
    }
    if (poll && row.state === "pending") {
      const { scope, externalNullifier } = rewardProgramScope(
        this.store.program,
      );
      const subject = await this.provider.subject(
        row.provider_id,
        Uint8Array.from(Buffer.from(row.key_hex, "hex")),
        externalNullifier,
        row.challenge,
        row.expires_at,
      );
      if (subject !== null) {
        const subjectHash = rewardSubject(scope, subject),
          current = row;
        const state = await this.store.atomic(async () => {
          const saved = await this.store
            .statement(
              "SELECT state,expires_at FROM reward_verification_intents WHERE intent_id=?",
              id,
            )
            .first<{ state: IntentRow["state"]; expires_at: number }>();
          insist(saved, "reward_intent_not_found", 404);
          if (saved.state !== "pending")
            return { value: saved.state, statements: [] };
          insist(
            saved.expires_at > this.now(),
            "reward_verification_expired",
            409,
          );
          const bindings = await this.store
            .statement(
              "SELECT account_id,subject_hash,wallet FROM reward_subjects WHERE program_id=? AND (account_id=? OR subject_hash=?)",
              this.store.program,
              principal.accountId,
              subjectHash,
            )
            .all<{
              account_id: string;
              subject_hash: string;
              wallet: string;
            }>();
          const conflict = bindings.results.some(
            (b) =>
              b.account_id !== principal.accountId ||
              b.subject_hash !== subjectHash ||
              b.wallet !== principal.wallet,
          );
          const state = conflict
            ? ("subject_conflict" as const)
            : ("verified" as const);
          return {
            value: state,
            statements: [
              ...(conflict
                ? []
                : [
                    this.store.statement(
                      "INSERT INTO reward_subjects(program_id,account_id,wallet,subject_hash,verified_at) VALUES(?,?,?,?,?) ON CONFLICT(program_id,account_id) DO NOTHING",
                      this.store.program,
                      principal.accountId,
                      principal.wallet,
                      subjectHash,
                      this.now(),
                    ),
                  ]),
              this.store.statement(
                "UPDATE reward_verification_intents SET state=?,key_hex='',launch_url='' WHERE intent_id=?",
                state,
                id,
              ),
              ...(conflict
                ? [
                    this.store.statement(
                      "UPDATE reward_credits SET claim_state='subject_conflict' WHERE program_id=? AND account_id=? AND claim_state='unclaimed'",
                      this.store.program,
                      principal.accountId,
                    ),
                  ]
                : []),
            ],
          };
        });
        row = { ...current, state, launch_url: "" };
      }
    }
    return {
      intent_id: id,
      state: row.state,
      expires_at: row.expires_at,
      launch_url: row.state === "pending" ? row.launch_url : null,
    };
  }
}
