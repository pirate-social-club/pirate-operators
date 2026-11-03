import { recoverTypedDataAddress, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { attestationTypes } from "../../packages/protocol/index.ts";
import { veryRewardNullifier } from "../../packages/protocol/very-reward-scope.ts";
import { boundSubject } from "../../packages/very/proof.ts";
import {
  address,
  authentication,
  bytes32,
  configuration,
  configurationHash,
  context,
  exactObject,
  requireValue,
  AttesterError,
  type AttesterConfig,
  type Challenge,
  type Permit,
} from "./policy.ts";

export interface SavedStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}
export interface PoolSnapshot {
  deadline: number;
  timestamp: number;
}
export interface Dependencies {
  store: SavedStore;
  now(): number;
  random(size: number): Hex;
  inspect(claimant: Address): Promise<PoolSnapshot>;
  verify(raw: string): Promise<void>;
  privateKey: Hex;
}
type Saved = {
  challenge: Challenge;
  lease?: { token: Hex; until: number };
  permit?: Permit;
};

export class RewardAttester {
  readonly config: AttesterConfig;
  readonly pin: Hex;
  readonly derived: ReturnType<typeof context>;
  private readonly deps: Dependencies;
  constructor(config: unknown, deps: Dependencies) {
    this.config = configuration(config);
    this.pin = configurationHash(this.config);
    this.derived = context(this.config);
    this.deps = deps;
    requireValue(
      privateKeyToAccount(deps.privateKey).address === this.config.attester,
      "wrong_attester_key",
    );
    requireValue(
      this.config.chainId !== 84532 || BigInt(deps.privateKey) > 9n,
      "public_fixture_key_refused",
    );
    const prior = deps.store.get<Hex>("pool-pin");
    requireValue(
      !prior || prior === this.pin,
      "immutable_pool_configuration_changed",
    );
    if (!prior) deps.store.set("pool-pin", this.pin);
  }
  private currentPin() {
    requireValue(
      this.deps.store.get<Hex>("pool-pin") === this.pin,
      "immutable_pool_configuration_changed",
    );
  }
  private validTime(snapshot: PoolSnapshot) {
    const now = this.deps.now();
    requireValue(
      Number.isSafeInteger(now) && Math.abs(snapshot.timestamp - now) <= 60,
      "chain_clock_skew",
    );
    requireValue(
      now < snapshot.deadline && snapshot.timestamp < snapshot.deadline,
      "registration_closed",
    );
    return now;
  }
  async challenge(input: unknown): Promise<Challenge> {
    this.currentPin();
    const claimant = address(exactObject(input, ["claimant"]).claimant);
    const snapshot = await this.deps.inspect(claimant);
    const now = this.validTime(snapshot);
    this.currentPin();
    const activeId = this.deps.store.get<Hex>(`active:${claimant}`);
    const active =
      activeId && this.deps.store.get<Saved>(`challenge:${activeId}`);
    if (active && active.challenge.expiresAt > now) return active.challenge;
    const count = this.deps.store.get<number>("challenge-count") ?? 0;
    requireValue(count < 256, "experiment_challenge_cap");
    const id = bytes32(this.deps.random(32));
    requireValue(!this.deps.store.get(`challenge:${id}`), "nonce_collision");
    const binding = BigInt(this.deps.random(16)).toString();
    requireValue(
      BigInt(binding) > 0n && BigInt(binding) < 1n << 128n,
      "invalid_random_binding",
    );
    const challenge: Challenge = {
      id,
      claimant,
      binding,
      expiresAt: Math.min(now + 300, snapshot.deadline),
      scope: this.derived.scope,
      configHash: this.pin,
    };
    // Synchronous writes, no await between related durable state changes.
    this.deps.store.set(`challenge:${id}`, { challenge });
    this.deps.store.set(`active:${claimant}`, id);
    this.deps.store.set("challenge-count", count + 1);
    return challenge;
  }
  async issue(input: unknown): Promise<Permit> {
    this.currentPin();
    const v = exactObject(input, ["id", "authorization", "proof"]);
    const id = bytes32(v.id);
    requireValue(
      typeof v.authorization === "string" &&
        /^0x[0-9a-fA-F]{130}$/.test(v.authorization),
      "invalid_authorization",
    );
    const saved = this.deps.store.get<Saved>(`challenge:${id}`);
    requireValue(saved, "unknown_challenge");
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        ...authentication(this.config, saved.challenge),
        signature: v.authorization as Hex,
      });
    } catch {
      throw new AttesterError("invalid_authorization");
    }
    requireValue(
      signer.toLowerCase() === saved.challenge.claimant.toLowerCase(),
      "invalid_authorization",
    );
    // Re-read after signature work: another request may already have issued.
    const current = this.deps.store.get<Saved>(`challenge:${id}`)!;
    if (current.permit) return current.permit;
    requireValue(
      this.deps.now() < current.challenge.expiresAt,
      "challenge_expired",
    );
    requireValue(
      !current.lease || current.lease.until <= this.deps.now(),
      "verification_in_progress",
    );
    requireValue(typeof v.proof === "string", "invalid_proof_binding");
    let subject: string;
    try {
      subject = boundSubject(
        v.proof,
        this.derived.externalNullifier,
        current.challenge.binding,
      );
    } catch {
      throw new AttesterError("invalid_proof_binding");
    }
    const token = this.deps.random(32);
    this.deps.store.set(`challenge:${id}`, {
      ...current,
      lease: { token, until: this.deps.now() + 60 },
    });
    try {
      await this.deps.verify(v.proof);
      const snapshot = await this.deps.inspect(current.challenge.claimant);
      const now = this.validTime(snapshot);
      requireValue(now < current.challenge.expiresAt, "challenge_expired");
      this.currentPin();
      const owned = () =>
        this.deps.store.get<Saved>(`challenge:${id}`)?.lease?.token === token;
      requireValue(owned(), "verification_superseded");
      const nullifier = veryRewardNullifier(current.challenge.scope, subject);
      const expiresAt = BigInt(
        Math.min(current.challenge.expiresAt, snapshot.deadline),
      );
      const signature = await privateKeyToAccount(
        this.deps.privateKey,
      ).signTypedData({
        domain: {
          name: "Pirate Reward Pool",
          version: "1",
          chainId: this.config.chainId,
          verifyingContract: this.config.pool,
        },
        types: attestationTypes,
        primaryType: "RewardAttestation",
        message: {
          scope: current.challenge.scope,
          nullifier,
          claimant: current.challenge.claimant,
          expiresAt,
        },
      });
      requireValue(
        owned() && this.deps.now() < Number(expiresAt),
        "verification_superseded",
      );
      const permit = { nullifier, expiresAt: expiresAt.toString(), signature };
      // Persist before returning. A lost response returns the exact same permit.
      this.deps.store.set(`challenge:${id}`, {
        challenge: current.challenge,
        permit,
      });
      return permit;
    } catch (error) {
      if (this.deps.store.get<Saved>(`challenge:${id}`)?.lease?.token === token)
        this.deps.store.set(`challenge:${id}`, {
          challenge: current.challenge,
        });
      throw error;
    }
  }
}
