// Pure wire encoder shared by the owned browser and backend. Selectors are checked against viem in tests.
export const REWARD_EXECUTE_MODE =
  "0x0100000000000000000000000000000000000000000000000000000000000000";
const word = (n: bigint) => {
  if (n < 0n || n >= 2n ** 256n) throw Error("invalid_reward_guard_word");
  return n.toString(16).padStart(64, "0");
};
const bytes = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex))
    throw Error("invalid_reward_guard_bytes");
  return (
    word(BigInt(hex.length / 2)) +
    hex.padEnd(Math.ceil(hex.length / 64) * 64, "0")
  );
};
const address = (s: string) => {
  if (!/^0x[0-9a-f]{40}$/.test(s) || BigInt(s) === 0n)
    throw Error("invalid_reward_guard_address");
  return s.slice(2).padStart(64, "0");
};
export function guardedRewardCall(
  payment: {
    sender: string;
    recipient: string;
    token: string;
    amountAtomic: string;
    guardNonce: string;
  },
  action: "pay" | "cancel",
) {
  if (!/^(0|[1-9][0-9]*)$/.test(payment.guardNonce))
    throw Error("invalid_reward_guard_nonce");
  const nonce = BigInt(payment.guardNonce),
    key = nonce >> 64n;
  if (nonce % 2n ** 64n !== 0n || key >> 176n !== 0x5052n)
    throw Error("invalid_reward_guard_namespace");
  const tuple = (to: string, data: string) =>
    address(to) + word(0n) + word(96n) + bytes(data);
  const calls = [tuple(payment.sender, "b70e36f0" + word(nonce))];
  if (action === "pay") {
    if (
      !/^[1-9][0-9]*$/.test(payment.amountAtomic) ||
      payment.recipient === payment.sender ||
      payment.recipient === payment.token
    )
      throw Error("invalid_reward_guard_payment");
    calls.push(
      tuple(
        payment.token,
        "a9059cbb" +
          address(payment.recipient) +
          word(BigInt(payment.amountAtomic)),
      ),
    );
  } else if (action !== "cancel") throw Error("invalid_reward_guard_action");
  let offset = BigInt(calls.length * 32);
  const offsets = calls.map((c) => {
    const v = word(offset);
    offset += BigInt(c.length / 2);
    return v;
  });
  const execution =
    word(32n) + word(BigInt(calls.length)) + offsets.join("") + calls.join("");
  return {
    address: payment.sender as `0x${string}`,
    data: ("0xe9ae5c53" +
      REWARD_EXECUTE_MODE.slice(2) +
      word(64n) +
      bytes(execution)) as `0x${string}`,
  };
}
