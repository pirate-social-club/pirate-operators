// Local login verification for fixtures: the SIWE text, plain or V4, checked
// offline for local keys, or through a local chain client so a smart account
// verifies as it would on MegaETH.
import { verifyMessage, type PublicClient } from "viem";
import type { VerifyLogin } from "../packages/community/accounts.ts";

export const verifyLoginOffline: VerifyLogin = (address, proof, signature) =>
  verifyMessage({ address, message: proof, signature });

export const verifyLoginOnChain =
  (client: Pick<PublicClient, "verifyMessage">): VerifyLogin =>
  (address, proof, signature) =>
    client.verifyMessage({ address, message: proof, signature });
