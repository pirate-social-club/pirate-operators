import { randomBytes } from "node:crypto";
import type { PrivateKeyAccount } from "viem/accounts";
import type { Provider, Session } from "../../packages/very/transport.ts";
import {
  authentication,
  configurationHash,
  context,
  type AttesterConfig,
  type Challenge,
  type Permit,
} from "../../services/very-attester/policy.ts";

export interface CeremonyDependencies {
  config: AttesterConfig;
  claimant: PrivateKeyAccount;
  provider: Pick<Provider, "open" | "poll">;
  call(path: string, input: unknown): Promise<unknown>;
  registered(): Promise<boolean>;
  register(permit: Permit): Promise<void>;
  now?: () => number;
}
type Active = {
  key: Buffer;
  challenge: Challenge;
  authorization: string;
  session?: Session;
};
function failureCode(error: unknown) {
  const allowed = new Set([
    "provider_unavailable_or_invalid",
    "bridge_failed",
    "invalid_envelope",
    "invalid_session",
    "invalid_proof_binding",
    "invalid_authorization",
    "challenge_expired",
    "registration_closed",
    "pool_code_mismatch",
    "pool_binding_mismatch",
    "immutable_pool_configuration_changed",
    "verifier_rejected",
    "attester_dependency_failed",
    "verification_in_progress",
    "verification_superseded",
    "chain_clock_skew",
  ]);
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : "request_failed";
}
export class RewardCeremony {
  private readonly deps: CeremonyDependencies;
  private active?: Active;
  private busy = false;
  private state = "ready";
  private error: string | null = null;
  private epoch = 0;
  private pending = 0;
  private drained: Array<() => void> = [];
  constructor(deps: CeremonyDependencies) {
    this.deps = deps;
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private clear() {
    this.active?.key.fill(0);
    this.active = undefined;
  }
  private finished() {
    if (--this.pending === 0) {
      for (const done of this.drained) done();
      this.drained = [];
    }
  }
  async drain() {
    if (this.pending)
      await new Promise<void>((done) => this.drained.push(done));
  }
  reset() {
    this.epoch++;
    this.clear();
    this.busy = false;
    if (this.state !== "complete" && this.state !== "registration_unknown")
      this.state = "ready";
    this.error = null;
  }
  async start() {
    if (
      this.busy ||
      this.active ||
      ["complete", "registration_unknown"].includes(this.state)
    )
      return;
    this.busy = true;
    this.state = "starting";
    this.error = null;
    this.pending++;
    const epoch = this.epoch;
    try {
      if (await this.deps.registered()) {
        if (epoch === this.epoch) this.state = "complete";
        return;
      }
      const challenge = (await this.deps.call("/challenge", {
        claimant: this.deps.claimant.address,
      })) as Challenge;
      if (epoch !== this.epoch) return;
      const derived = context(this.deps.config);
      if (
        challenge.claimant !== this.deps.claimant.address ||
        challenge.scope !== derived.scope ||
        challenge.configHash !== configurationHash(this.deps.config) ||
        challenge.expiresAt * 1000 <= this.now()
      )
        throw new Error("challenge_refused");
      const authorization = await this.deps.claimant.signTypedData(
        authentication(this.deps.config, challenge),
      );
      if (epoch !== this.epoch) return;
      const active: Active = { challenge, authorization, key: randomBytes(32) };
      this.active = active;
      active.session = await this.deps.provider.open(
        this.deps.config.appId,
        derived.externalNullifier,
        challenge.binding,
        active.key,
      );
      if (epoch === this.epoch) this.state = "waiting";
    } catch (error) {
      if (epoch === this.epoch) {
        this.clear();
        this.state = "failed";
        this.error = `Could not start the bound request (${failureCode(error)}). No registration was submitted.`;
      }
    } finally {
      if (epoch === this.epoch) this.busy = false;
      this.finished();
    }
  }
  async poll() {
    if (this.busy) return;
    const epoch = this.epoch;
    if (this.state === "registration_unknown") {
      this.busy = true;
      this.pending++;
      try {
        if ((await this.deps.registered()) && epoch === this.epoch) {
          this.state = "complete";
          this.error = null;
        }
      } catch {
        /* Read-only reconciliation; never resubmit an unknown transaction. */
      } finally {
        if (epoch === this.epoch) this.busy = false;
        this.finished();
      }
      return;
    }
    const active = this.active;
    if (!active?.session) return;
    if (this.now() >= active.challenge.expiresAt * 1000) {
      this.clear();
      this.state = "expired";
      this.error = "Request expired. Start a new request.";
      return;
    }
    this.busy = true;
    this.pending++;
    let stage = "bridge response";
    try {
      const raw = await this.deps.provider.poll(active.session, active.key);
      if (epoch !== this.epoch || raw === null) return;
      this.state = "verifying";
      stage = "attester verification";
      const permit = (await this.deps.call("/issue", {
        id: active.challenge.id,
        authorization: active.authorization,
        proof: raw,
      })) as Permit;
      if (epoch !== this.epoch) return;
      this.clear();
      // The transaction may be accepted even if its response is lost. From this
      // point only observe the chain after an error; never automatically resend.
      this.state = "registration_unknown";
      await this.deps.register(permit);
      if (epoch === this.epoch) {
        this.state = "complete";
        this.error = null;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        if (this.state === "registration_unknown")
          this.error =
            "Registration outcome is uncertain. Checking the chain without sending another transaction.";
        else {
          this.clear();
          this.state = "failed";
          this.error = `Failed at ${stage} (${failureCode(error)}). No registration was submitted. Retry the request.`;
        }
      }
    } finally {
      if (epoch === this.epoch) this.busy = false;
      this.finished();
    }
  }
  view() {
    if (
      this.active &&
      this.now() >= this.active.challenge.expiresAt * 1000 &&
      !this.busy
    ) {
      this.clear();
      this.state = "expired";
      this.error = "Request expired. Start a new request.";
    }
    let launch: string | null = null;
    if (this.state === "waiting" && this.active?.session) {
      const query = new URLSearchParams({
        sessionId: this.active.session.id,
        key: this.active.key.toString("base64"),
        action: "verify",
      });
      launch = `veros://verify?${query}`;
    }
    return {
      state: this.state,
      busy: this.busy,
      error: this.error,
      launch,
      report: {
        schema: "pirate-very-reward-ceremony/1",
        complete: this.state === "complete",
        chainId: this.deps.config.chainId,
        pool: this.deps.config.pool,
        claimant: this.deps.claimant.address,
        limits: [
          "Testnet and synthetic qualification; mock Jackpot and test token.",
          "Hosted verifier trusted; app-origin binding, freshness and enrollment deduplication unproven.",
          "The registration transaction publicly exposes the scoped reward identifier and test-wallet address.",
        ],
      },
    };
  }
}
