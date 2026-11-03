import { randomBytes } from "node:crypto";
import { boundSubject } from "./proof.ts";
import type { Provider, Session } from "./transport.ts";

// Diagnostic labels and scopes only. No authenticated wallets or pool addresses.
export const CASES = [
  { label: "Participant A, scope A", participant: "A", scope: "1000001" },
  { label: "Participant A, scope A again", participant: "A", scope: "1000001" },
  { label: "Participant B, scope A", participant: "B", scope: "1000001" },
  { label: "Participant A, scope B", participant: "A", scope: "1000002" },
] as const;
export const TTL_MS = 300_000;
type Active = {
  index: number;
  key: Buffer;
  binding: string;
  expires: number;
  session?: Session;
};
type Check = { case: number; label: string; hostedVerifier: "valid" };
type Comparisons = {
  repeatStable: boolean;
  changedBindingStable: boolean;
  changedScopeSeparated: boolean;
};

function failureCode(error: unknown): string {
  const codes = new Set([
    "provider_unavailable_or_invalid",
    "invalid_session",
    "bridge_failed",
    "invalid_envelope",
    "invalid_shape",
    "invalid_field",
    "invalid_protocol",
    "proof_too_large",
    "proof_binding_mismatch",
    "verifier_rejected",
  ]);
  return error instanceof Error && codes.has(error.message)
    ? error.message
    : "unexpected_failure";
}

export class Probe {
  private epoch = 0;
  private busy = false;
  private active?: Active;
  private subjects: string[] = [];
  private checks: Check[] = [];
  private comparisons?: Comparisons;
  private state = "ready";
  private error?: string;
  private readonly provider: Provider;
  private readonly appId: string;
  readonly mode: "live" | "fixture";
  private readonly now: () => number;

  constructor(
    provider: Provider,
    appId: string,
    mode: "live" | "fixture",
    now: () => number = Date.now,
  ) {
    this.provider = provider;
    this.appId = appId;
    this.mode = mode;
    this.now = now;
  }

  private clearActive() {
    this.active?.key.fill(0);
    this.active = undefined;
  }

  reset() {
    this.epoch++;
    this.clearActive();
    this.subjects = [];
    this.checks = [];
    this.comparisons = undefined;
    this.busy = false;
    this.state = "ready";
    this.error = undefined;
  }

  private current(epoch: number, active: Active): boolean {
    if (this.epoch !== epoch || this.active !== active) return false;
    if (this.now() >= active.expires) {
      this.clearActive();
      this.state = "expired";
      this.error = "Request expired. Start this case again.";
      return false;
    }
    return true;
  }

  async start() {
    if (this.busy || this.active || this.checks.length === CASES.length) return;
    this.busy = true;
    this.error = undefined;
    this.state = "starting";
    const epoch = this.epoch;
    const active: Active = {
      index: this.checks.length,
      key: randomBytes(32),
      binding: BigInt(`0x${randomBytes(16).toString("hex")}`).toString(),
      expires: this.now() + TTL_MS,
    };
    this.active = active;
    try {
      active.session = await this.provider.open(
        this.appId,
        CASES[active.index].scope,
        active.binding,
        active.key,
      );
      if (this.current(epoch, active)) this.state = "waiting";
    } catch (error) {
      if (this.current(epoch, active)) {
        this.clearActive();
        this.state = "failed";
        this.error = `Could not open the Very request (${failureCode(error)}). No observation recorded.`;
      }
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }

  async poll() {
    const active = this.active;
    const epoch = this.epoch;
    if (!active || !this.current(epoch, active) || this.busy || !active.session)
      return;
    this.busy = true;
    let stage = "bridge response";
    try {
      const raw = await this.provider.poll(active.session, active.key);
      if (!this.current(epoch, active) || raw === null) return;
      stage = "proof shape or request binding";
      const subject = boundSubject(
        raw,
        CASES[active.index].scope,
        active.binding,
      );
      this.state = "verifying";
      stage = "hosted verification";
      await this.provider.verify(raw);
      if (!this.current(epoch, active)) return;
      this.subjects.push(subject);
      this.checks.push({
        case: active.index + 1,
        label: CASES[active.index].label,
        hostedVerifier: "valid",
      });
      this.clearActive();
      this.state = "ready";
      if (this.checks.length === CASES.length) {
        const [a, repeat, otherBinding, otherScope] = this.subjects;
        this.comparisons = {
          repeatStable: a === repeat,
          changedBindingStable: a === otherBinding,
          changedScopeSeparated: a !== otherScope,
        };
        this.subjects = [];
        this.state = "complete";
      }
    } catch (error) {
      if (this.current(epoch, active)) {
        this.clearActive();
        this.state = "failed";
        this.error = `Failed at ${stage} (${failureCode(error)}). No observation recorded. Retry this case; earlier results are preserved.`;
      }
    } finally {
      if (epoch === this.epoch) this.busy = false;
    }
  }

  report() {
    return {
      schema: "pirate-very-diagnostic-v1",
      mode: this.mode,
      complete: this.state === "complete",
      observations: structuredClone(this.checks),
      comparisons: this.comparisons ? { ...this.comparisons } : null,
      limits: [
        "One enrolled credential, as asserted by the operator; not one-human assurance.",
        "Participant labels with fresh 128-bit challenges; no wallet authentication or literal wallet pseudonym test.",
        "Diagnostic scopes only; production pool scope derivation remains unimplemented.",
        "Hosted verifier trusted; no Very-specific Base verifier established.",
        "Timestamp format probe, not fresh liveness, revocation or re-enrollment testing.",
        "No reward attestation issued and no funds moved.",
      ],
    };
  }

  view() {
    const active = this.active;
    if (active) this.current(this.epoch, active);
    let launch: string | null = null;
    if (this.active?.session && this.state === "waiting") {
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
      error: this.error ?? null,
      next: CASES[this.checks.length]?.label ?? null,
      launch,
      report: this.report(),
    };
  }
}
