import type {
  RewardPayment,
  RewardWalletView,
} from "../../../../packages/rewards/contracts.ts";

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
/** One explicit ERC-20 transfer. No grantPermissions, session spending or sponsorship. */
export async function signRewardPayment(
  payment: RewardPayment,
  beforeCall: () => Promise<RewardPayment>,
  load: () => Promise<RewardMoss> = wallet,
): Promise<string> {
  if (
    payment.chainId !== 6343 ||
    payment.state !== "prepared" ||
    !/^0x[0-9a-f]{40}$/.test(payment.recipient) ||
    !/^0x[0-9a-f]{40}$/.test(payment.token) ||
    BigInt(payment.recipient) === 0n ||
    payment.recipient === payment.sender ||
    payment.recipient === payment.token ||
    !/^[1-9][0-9]*$/.test(payment.amountAtomic) ||
    BigInt(payment.amountAtomic) >= 2n ** 256n
  )
    throw Error("This payment is not ready for signing.");
  const moss = await connect(payment.sender, load);
  const dispatched = await beforeCall();
  if (
    dispatched.state !== "awaiting_signature" ||
    dispatched.paymentId !== payment.paymentId ||
    dispatched.sender !== payment.sender ||
    dispatched.recipient !== payment.recipient ||
    dispatched.token !== payment.token ||
    dispatched.chainId !== payment.chainId ||
    dispatched.amountAtomic !== payment.amountAtomic
  )
    throw Error("The prepared payment changed. Check its status.");
  const data =
    `0xa9059cbb${payment.recipient.slice(2).padStart(64, "0")}${BigInt(payment.amountAtomic).toString(16).padStart(64, "0")}` as `0x${string}`;
  const result = await moss.callContract({
    address: payment.token as `0x${string}`,
    data,
    silent: false,
    silentUIApproveFallback: false,
    sponsor: false,
  });
  const hash = result.receipt?.transactionHash ?? result.receipt?.hash;
  if (
    result.status !== "approved" ||
    result.receipt?.chainId !== 6343 ||
    !hash ||
    !/^0x[0-9a-f]{64}$/i.test(hash)
  )
    throw Error(
      "The payment is awaiting reconciliation. Check its status before trying anything else.",
    );
  return hash.toLowerCase();
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
