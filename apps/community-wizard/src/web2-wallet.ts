import { hashJson, insist } from "../../../packages/community/common.ts";
import { isAddress, type Address } from "viem";
import type { Web2Wallet } from "../../../deploy/linux/web2-operator-inputs.ts";

interface Moss {
  initialise(config: {
    network: "testnet";
    logging: "error";
    debug: false;
    handshakeTimeoutMs: 45000;
  }): Promise<unknown>;
  connect(): Promise<{ address?: string; network?: string }>;
  signData(request: {
    data: unknown;
  }): Promise<{
    status: "success" | "cancelled" | "error";
    signature?: string;
    error?: string;
  }>;
}
/** Same pinned application initialization and normal SDK transport. Tests may
 * supply the SDK boundary; product code has no global fixture wallet switch. */
export function createWeb2Wallet(
  load: () => Promise<Moss> = async () =>
    (await import("@megaeth-labs/wallet-sdk")).mega,
): Web2Wallet {
  async function connect() {
    const mega = await load();
    await mega.initialise({
      network: "testnet",
      logging: "error",
      debug: false,
      handshakeTimeoutMs: 45000,
    });
    const account = await mega.connect();
    insist(
      account.network === "testnet" &&
        account.address &&
        isAddress(account.address),
      "web2_wallet_account_changed",
      409,
    );
    return {
      mega,
      address: account.address.toLowerCase() as Address,
      network: "testnet" as const,
    };
  }
  return {
    async connect() {
      const { address, network } = await connect();
      return { address, network };
    },
    async signTypedData(request) {
      try {
        const frozen = structuredClone(request),
          wire = (v: unknown) =>
            JSON.parse(
              JSON.stringify(v, (_k, x) =>
                typeof x === "bigint" ? String(x) : x,
              ),
            );
        insist(
          hashJson(wire(frozen.data)) === frozen.requestDigest,
          "web2_wallet_request_changed",
          409,
        );
        const before = await connect();
        insist(
          before.address === frozen.expectedController.toLowerCase(),
          "web2_wallet_account_changed",
          409,
        );
        const result = await before.mega.signData({ data: frozen.data });
        const after = await before.mega.connect();
        insist(
          after.address?.toLowerCase() === before.address &&
            after.network === "testnet",
          "web2_wallet_account_changed",
          409,
        );
        if (result.status === "cancelled") return { status: "cancelled" };
        if (result.status !== "success")
          return { status: "error", code: "web2_wallet_signing_unavailable" };
        insist(
          typeof result.signature === "string" &&
            /^0x(?:[a-fA-F0-9]{2}){1,16384}(?![\s\S])/.test(result.signature),
          "web2_wallet_signature_invalid",
        );
        return {
          status: "success",
          signature: result.signature as `0x${string}`,
        };
      } catch (error) {
        return {
          status: "error",
          code:
            error instanceof Error && error.message.startsWith("web2_wallet_")
              ? error.message
              : "web2_wallet_unavailable",
        };
      }
    },
  };
}
