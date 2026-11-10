import type { RewardWalletView } from "../../../../packages/rewards/contracts.ts";
import { guardedRewardCall } from "../../../../packages/rewards/guard-call.ts";
import type { WalletSendIntentV1, WalletSendQuoteV1 } from "./contracts.ts";
import { hostedSendKey } from "./hosted-send.ts";

const atomic = (value: string) => {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 2n ** 256n)
    throw Error("Invalid quoted amount.");
  return BigInt(value);
};
export function sendRecipient(value: string, view: RewardWalletView) {
  const recipient = value.trim().toLowerCase();
  if (
    !/^0x[0-9a-f]{40}$/.test(recipient) ||
    BigInt(recipient) === 0n ||
    [view.address.toLowerCase(), view.token.toLowerCase()].includes(recipient)
  )
    throw Error(
      "Enter the recipient's wallet address, different from your own and the token contract.",
    );
  return recipient;
}
export function validateSendQuote(
  view: RewardWalletView,
  quote: WalletSendQuoteV1,
  now: number | null = Date.now(),
) {
  hostedSendKey(view);
  if (
    quote.schema !== "pirate.wallet-send-quote/1" ||
    quote.chainId !== 6343 ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(quote.quoteId) ||
    quote.sender.toLowerCase() !== view.address.toLowerCase() ||
    quote.token.toLowerCase() !== view.token.toLowerCase() ||
    quote.decimals !== view.decimals ||
    !Number.isInteger(quote.decimals) ||
    quote.decimals < 0 ||
    quote.decimals > 18 ||
    !Number.isInteger(quote.fee.decimals) ||
    quote.fee.decimals < 0 ||
    quote.fee.decimals > 18 ||
    !/^0x[0-9a-fA-F]{40}$/.test(quote.fee.token) ||
    !Number.isSafeInteger(quote.expiresAt) ||
    (now !== null && (quote.expiresAt <= now || quote.expiresAt - now > 600000))
  )
    throw Error("This Send quote changed or expired. Request a fresh quote.");
  sendRecipient(quote.recipient, view);
  const amount = atomic(quote.amountAtomic),
    balance = atomic(quote.balanceAtomic),
    reserve = atomic(quote.fee.reserveAtomic);
  if (atomic(quote.maxGasAllowanceWei) === 0n)
    throw Error("The quoted fee allowance is invalid.");
  if (
    amount === 0n ||
    amount > balance ||
    (quote.fee.token.toLowerCase() === quote.token.toLowerCase() &&
      (quote.fee.decimals !== quote.decimals || amount + reserve > balance)) ||
    (quote.fee.estimatedAtomic !== null &&
      atomic(quote.fee.estimatedAtomic) > reserve)
  )
    throw Error("This balance cannot cover the Send and its reserved fee.");
  return quote;
}
export function validateSendIntent(
  view: RewardWalletView,
  intent: WalletSendIntentV1,
) {
  validateSendQuote(view, intent.quote, null);
  const { payment: p, quote: q } = intent;
  if (
    intent.schema !== "pirate.wallet-send-intent/1" ||
    p.chainId !== q.chainId ||
    p.sender.toLowerCase() !== q.sender.toLowerCase() ||
    p.recipient.toLowerCase() !== q.recipient.toLowerCase() ||
    p.token.toLowerCase() !== q.token.toLowerCase() ||
    p.decimals !== q.decimals ||
    p.amountAtomic !== q.amountAtomic
  )
    throw Error("The prepared Send changed. Check its status.");
  guardedRewardCall(p, "pay");
  return intent;
}
export function sameSendIntent(
  view: RewardWalletView,
  before: WalletSendIntentV1,
  after: WalletSendIntentV1,
) {
  validateSendIntent(view, after);
  if (
    !sameSendQuote(before.quote, after.quote) ||
    before.payment.paymentId !== after.payment.paymentId ||
    before.payment.guardNonce !== after.payment.guardNonce
  )
    throw Error("The prepared Send changed. Check its status.");
  return after;
}
export function sameSendQuote(a: WalletSendQuoteV1, b: WalletSendQuoteV1) {
  const fields = (q: WalletSendQuoteV1) => [
    q.schema,
    q.quoteId,
    q.chainId,
    q.sender,
    q.recipient,
    q.token,
    q.decimals,
    q.amountAtomic,
    q.balanceAtomic,
    q.expiresAt,
    q.maxGasAllowanceWei,
    q.fee.token,
    q.fee.decimals,
    q.fee.symbol,
    q.fee.reserveAtomic,
    q.fee.estimatedAtomic,
  ];
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
