import type {
  RewardCredit,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";

export interface RewardReadLifetime {
  signal: AbortSignal;
  current(): boolean;
}
export function assertRewardReadCurrent(lifetime?: RewardReadLifetime) {
  if (lifetime && (lifetime.signal.aborted || !lifetime.current()))
    throw new DOMException("The wallet read was superseded.", "AbortError");
}

export class RewardScopeError extends Error {
  readonly code = "reward_private_scope_lost";
  constructor() {
    super(
      "Your wallet account could not be confirmed. Reopen your wallet to continue.",
    );
  }
}
/** UUID is supplied by the private authenticated producer, never derived from a public identity. */
export function rewardAccountId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
    throw new RewardScopeError();
  return value;
}
export function rewardWalletOwner(view: RewardWalletView): string {
  if (!view || typeof view !== "object") throw new RewardScopeError();
  return rewardAccountId(
    (view as RewardWalletView & { accountId?: unknown }).accountId,
  );
}
export function assertRewardCreditOwner(
  rows: readonly RewardCredit[],
  accountId: string,
) {
  rewardAccountId(accountId);
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row) => !row || typeof row !== "object" || row.account_id !== accountId,
    )
  )
    throw new RewardScopeError();
}
export function rewardAuthorityLost(error: unknown): boolean {
  if (error instanceof RewardScopeError) return true;
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}
