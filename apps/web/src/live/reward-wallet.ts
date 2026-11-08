import type {
  RewardPayment,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";

import { guardedRewardCall } from "../../../../packages/rewards/guard-call.ts";
export interface RewardWalletOutcome {
  outcome: "approved" | "cancelled" | "error" | "unknown";
  hash?: string;
}

export interface RewardMoss {
  initialise(config: {
    network: "testnet";
    logging: "error";
    sponsorMode: "explicit";
  }): Promise<unknown>;
  connect(): Promise<{ address?: string; network: string }>;
  open(): Promise<void>;
  callContract(request: {
    address: `0x${string}`;
    data: `0x${string}`;
    silent: false;
    silentUIApproveFallback: false;
    sponsor: false;
  }): Promise<{
    status: string;
    receipt?: { transactionHash?: string; hash?: string; chainId: number };
  }>;
}
async function wallet() {
  return (await import("@megaeth-labs/wallet-sdk")).mega;
}
async function connect(expected: string, load: () => Promise<RewardMoss>) {
  const moss = await load();
  await moss.initialise({
    network: "testnet",
    logging: "error",
    sponsorMode: "explicit",
  });
  const account = await moss.connect();
  if (
    account.network !== "testnet" ||
    account.address?.toLowerCase() !== expected.toLowerCase()
  )
    throw Error("Open the account used for this payment.");
  return moss;
}
/** Opening the hosted wallet requests no standing token allowance. */
export async function openRewardWallet(
  view: RewardWalletView,
  load: () => Promise<RewardMoss> = wallet,
) {
  const moss = await connect(view.address, load);
  await moss.open();
}
/** One explicit account batch: consume the frozen guard, then pay (or only consume it to cancel). */
export async function signRewardPayment(
  payment: RewardPayment,
  action: "pay" | "cancel",
  attemptId: string,
  beforeCall: () => Promise<RewardPayment>,
  load: () => Promise<RewardMoss> = wallet,
): Promise<RewardWalletOutcome> {
  if (
    payment.chainId !== 6343 ||
    ![
      "prepared",
      "awaiting_signature",
      "submitted",
      "review_required",
    ].includes(payment.state)
  )
    throw Error("This payment is not ready for signing.");
  const request = guardedRewardCall(payment, action);
  const moss = await connect(payment.sender, load);
  const dispatched = await beforeCall(),
    attempt = dispatched.attempts.find((a) => a.attemptId === attemptId);
  if (
    dispatched.state !== "awaiting_signature" ||
    dispatched.latestAttemptId !== attemptId ||
    !attempt ||
    attempt.action !== action ||
    attempt.outcome !== "opening" ||
    dispatched.paymentId !== payment.paymentId ||
    dispatched.sender !== payment.sender ||
    dispatched.recipient !== payment.recipient ||
    dispatched.token !== payment.token ||
    dispatched.chainId !== payment.chainId ||
    dispatched.amountAtomic !== payment.amountAtomic ||
    dispatched.guardNonce !== payment.guardNonce
  )
    throw Error("The prepared payment changed. Check its status.");
  let result: Awaited<ReturnType<RewardMoss["callContract"]>>;
  try {
    result = await moss.callContract({
      ...request,
      silent: false,
      silentUIApproveFallback: false,
      sponsor: false,
    });
  } catch {
    return { outcome: "unknown" };
  }
  const raw = result.receipt?.transactionHash ?? result.receipt?.hash;
  const hash =
    result.receipt?.chainId === 6343 && raw && /^0x[0-9a-f]{64}$/i.test(raw)
      ? raw.toLowerCase()
      : undefined;
  if (result.status === "approved" && hash)
    return { outcome: "approved", hash };
  if (result.status === "cancelled")
    return { outcome: "cancelled", ...(hash ? { hash } : {}) };
  if (result.status === "error")
    return { outcome: "error", ...(hash ? { hash } : {}) };
  return { outcome: "unknown", ...(hash ? { hash } : {}) };
}
export function dollars(atomic: string, decimals: number): string {
  if (
    !/^(0|[1-9][0-9]*)$/.test(atomic) ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18
  )
    throw Error("Invalid dollar balance.");
  const n = BigInt(atomic),
    base = 10n ** BigInt(decimals),
    whole = (n / base).toString(),
    fraction = decimals
      ? (n % base).toString().padStart(decimals, "0").replace(/0+$/, "")
      : "";
  return `$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
}

export function dollarInput(value: string, decimals: number): string {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 18 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    throw Error("Enter a dollar amount, such as 1.11.");
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals)
    throw Error("The amount has too many decimal places.");
  const amount =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0");
  if (amount >= 2n ** 256n) throw Error("The amount is too large.");
  return amount.toString();
}
