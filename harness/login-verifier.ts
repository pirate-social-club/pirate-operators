// Local login verification for fixtures: SIWE text or the V4 SignIn typed
// data, checked offline for local keys, or through a local chain client so a
// smart account verifies as it would on MegaETH.
import { verifyMessage, verifyTypedData, type PublicClient } from "viem";
import type { VerifyLogin } from "../packages/community/accounts.ts";

export const verifyLoginOffline: VerifyLogin = (address, proof, signature) =>
  typeof proof === "string"
    ? verifyMessage({ address, message: proof, signature })
    : verifyTypedData({
        address,
        domain: proof.domain,
        types: proof.types,
        primaryType: proof.primaryType,
        message: { ...proof.message },
        signature,
      });

export const verifyLoginOnChain =
  (client: Pick<PublicClient, "verifyMessage" | "verifyTypedData">): VerifyLogin =>
  (address, proof, signature) =>
    typeof proof === "string"
      ? client.verifyMessage({ address, message: proof, signature })
      : client.verifyTypedData({
          address,
          domain: proof.domain,
          types: proof.types,
          primaryType: proof.primaryType,
          message: { ...proof.message },
          signature,
        });
