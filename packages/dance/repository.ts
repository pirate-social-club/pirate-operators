import type {
  DanceCapture,
  DanceControlIntent,
  DanceDecisionIntent,
  DanceFence,
  DanceMediaBinding,
  DanceMediaPort,
  DanceMediaWitness,
  DanceCanonicalEvidence,
  DanceOutbox,
  DanceReceipt,
  DanceReview,
  DanceStoredGrant,
  DanceAttempt,
} from "./contracts.ts";
export interface DanceRepository {
  now(): Promise<number>;
  assert(fences: DanceFence[]): Promise<void>;
  assertAccess(review: DanceReview, fences: DanceFence[]): Promise<void>;
  capture(id: string): Promise<DanceCapture>;
  findCapture(
    community: string,
    actor: string,
    command: string,
    hash: string,
  ): Promise<DanceCapture | null>;
  reserveCapture(
    c: DanceCapture,
    actor: string,
    command: string,
    hash: string,
    fences: DanceFence[],
  ): Promise<void>;
  acceptConsent(
    c: DanceCapture,
    acceptance: import("./contracts.ts").DanceConsentAcceptance,
    commandId: string,
    fences: DanceFence[],
  ): Promise<DanceCapture>;
  ensureSubmissionOutbox(review: DanceReview, commandId: string): Promise<void>;
  receipt(
    community: string,
    actor: string,
    command: string,
    hash: string,
  ): Promise<DanceReceipt | null>;
  acceptSubmission(input: {
    capture: DanceCapture;
    media: DanceMediaBinding;
    witness: DanceMediaWitness;
    commandId: string;
    requestHash: string;
    bindingCommitment: string;
    fences: DanceFence[];
    mediaPort: DanceMediaPort;
  }): Promise<DanceReceipt>;
  review(id: string): Promise<DanceReview>;
  scan(
    community: string,
    after: string | null,
    limit: number,
  ): Promise<{ ids: string[]; hasMore: boolean }>;
  stageDecision(input: {
    review: DanceReview;
    actor: string;
    requestHash: string;
    intent: DanceDecisionIntent;
    fences: DanceFence[];
  }): Promise<DanceReceipt>;
  stageWithdrawal(input: {
    review: DanceReview;
    actor: string;
    commandId: string;
    requestHash: string;
    fences: DanceFence[];
  }): Promise<DanceReceipt>;
  grant(id: string): Promise<DanceStoredGrant>;
  control(
    intent: DanceControlIntent,
    fences: DanceFence[],
  ): Promise<DanceControlIntent>;
  locallyRevoked(
    community: string,
    account: string,
    wallet: string,
  ): Promise<boolean>;
  observe(
    reviewId: string,
    intent: DanceDecisionIntent,
    evidence: DanceCanonicalEvidence,
  ): Promise<void>;
  outbox(commandId: string): Promise<DanceOutbox>;
  attempt(value: DanceAttempt): Promise<void>;
}
