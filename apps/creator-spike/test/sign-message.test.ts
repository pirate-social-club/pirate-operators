import test from "node:test";
import assert from "node:assert/strict";
import { b64, unb64, utf8, walletOrigin } from "../src/shared.ts";
import {
  fixedSignMessage,
  validateFixedSignMessage,
} from "../src/sign-message.ts";

const id = "A".repeat(43),
  address = "0x1111111111111111111111111111111111111111";
test("fixed wallet proof is reconstructed from the verified wallet and pinned origin", () => {
  const body = `Pirate creator test\nOrigin: ${walletOrigin}\nNetwork: Sui / Ika testnet\nWallet: ${address}\nChallenge: ${id}\nThis proves I reopened my creator wallet. It does not authorize a transfer.`;
  const expected = new Uint8Array([
    ...utf8.encode(`\x19Ethereum Signed Message:\n${utf8.encode(body).length}`),
    ...utf8.encode(body),
  ]);
  assert.deepEqual(
    validateFixedSignMessage(id, address, b64(expected)),
    expected,
  );
});
test("a malicious operator cannot replace the fixed proof with a transaction or another intent", () => {
  const expected = unb64(fixedSignMessage(id, address));
  const changedPrefix = expected.slice();
  changedPrefix[0] = 0;
  for (const supplied of [
    b64(new Uint8Array([2, 248, 1, 5])),
    b64(utf8.encode("Approve an arbitrary EVM transfer")),
    b64(changedPrefix),
    b64(
      utf8.encode(
        new TextDecoder()
          .decode(expected)
          .replace(walletOrigin, "https://attacker.example"),
      ),
    ),
    fixedSignMessage("B".repeat(43), address),
    fixedSignMessage(id, "0x2222222222222222222222222222222222222222"),
  ])
    assert.throws(() => validateFixedSignMessage(id, address, supplied));
  assert.throws(() => fixedSignMessage(id + "\nTransfer:", address));
  assert.throws(() => fixedSignMessage(id, "not-a-wallet"));
});
