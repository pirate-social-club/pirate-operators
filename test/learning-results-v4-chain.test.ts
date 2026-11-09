// The application's V4 typed data must match the deployed contract exactly:
// a viem signTypedData over SignIn authorizes on chain, and its digest is the
// contract's own signInDigest and the recorded authorization id.
import test from "node:test";
import assert from "node:assert/strict";
import { chain } from "../harness/chain.ts";
import { stopChain } from "./payments-fixture.ts";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  resultsV4Abi,
  resultsV4Domain,
  signInIdV4,
  signInTypes,
  type SignIn,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  readPublicResults,
  readPublicResultsV3,
} from "../packages/records/results-v3.ts";
import { keccak256 } from "viem";

test(
  "a V4 sign-in signed with the application's typed data authorizes on chain",
  { timeout: 120000 },
  async () => {
    const evm = await chain(19960);
    try {
      const communityId = digest("v4-community");
      const contract = await evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
      ]);
      const chainId = await evm.publicClient.getChainId();
      const now = BigInt((await evm.publicClient.getBlock()).timestamp);
      const learner = accounts[5];
      const message: SignIn = {
        learner: learner.address,
        communityId,
        origin: "https://community.example",
        publicationPolicy: learningV4PublicityPolicy,
        nonce: digest("login-nonce"),
        issuedAt: now,
        expiresAt: now + 300n,
      };
      const signature = await learner.signTypedData({
        domain: resultsV4Domain(chainId, contract),
        types: signInTypes,
        primaryType: "SignIn",
        message,
      });
      const id = signInIdV4(chainId, contract, message);
      const read = (functionName: string, args: unknown[]) =>
        evm.publicClient.readContract({
          address: contract,
          abi: resultsV4Abi,
          functionName,
          args,
        } as never);
      assert.equal(await read("signInDigest", [message]), id);
      assert.equal(await read("VERSION", []), 4);
      await evm.write(contract, "LearningResultsV4", "authorize", [message, signature], 2);
      assert.equal(
        String(await read("authorizationLearner", [id])).toLowerCase(),
        learner.address.toLowerCase(),
      );
      assert.equal(await read("authorizedSince", [learner.address]), now);
      // A SIWE-style personal signature over the same digest is not permission.
      const other = { ...message, nonce: digest("login-nonce-2") };
      const personal = await learner.signMessage({
        message: { raw: signInIdV4(chainId, contract, other) },
      });
      await assert.rejects(
        evm.write(contract, "LearningResultsV4", "authorize", [other, personal], 2),
        /invalid_consent/,
      );
      // The public reader accepts this contract only as version 4.
      const head = await evm.publicClient.getBlockNumber();
      const source = {
        rpcUrl: evm.rpcUrl,
        chainId: chainId as 31337,
        contract,
        runtimeCodeHash: keccak256(
          (await evm.publicClient.getCode({ address: contract }))!,
        ),
        fromBlock: 0n,
        toBlock: head,
        communityId,
        readSource: async () => {
          throw new Error("no results to resolve");
        },
      } as unknown as Parameters<typeof readPublicResultsV3>[0];
      await assert.rejects(readPublicResultsV3(source), /wrong_result_contract/);
      const read4 = await readPublicResultsV3({ ...source, version: 4 });
      assert.deepEqual(read4, []);
      assert.deepEqual(
        await readPublicResults(
          { contract, codeHash: source.runtimeCodeHash, version: 4 },
          source,
        ),
        [],
      );
      await assert.rejects(
        readPublicResults(
          { contract, codeHash: source.runtimeCodeHash, version: 3 },
          source,
        ),
        /wrong_result_contract/,
      );
    } finally {
      await stopChain(evm);
    }
  },
);
