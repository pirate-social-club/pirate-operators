// The application's V4 sign-in text must be the deployed contract's own
// rendering: for random inputs signInMessage equals the shared builder and
// signInDigest equals viem hashMessage, an EOA personal-sign and an
// IthacaAccount-style ERC-1271 account both authorize, and any text naming
// another host, contract, chain, community or policy does not.
import test from "node:test";
import assert from "node:assert/strict";
import { chain } from "../harness/chain.ts";
import { stopChain } from "./payments-fixture.ts";
import { accounts } from "../harness/runtime.ts";
import { digest } from "../packages/protocol/index.ts";
import {
  SIGN_IN_STATEMENT_V4,
  canonicalOriginV4,
  resultsV4Abi,
  resultsV4Domain,
  signInIdV4,
  signInMessageV4,
  type SignIn,
  type SignInV4Context,
} from "../packages/protocol/learning-results-v4.ts";
import { learningV4PublicityPolicy } from "../services/learning-policy-v4.ts";
import {
  readPublicResults,
  readPublicResultsV3,
} from "../packages/records/results-v3.ts";
import { getAddress, hashMessage, keccak256, toHex, type Address, type Hex } from "viem";
import { createSiweMessage } from "viem/siwe";

const random = (bytes: number) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)));

test(
  "the contract renders the builder's sign-in text and authorizes its personal-sign signature",
  { timeout: 180000 },
  async () => {
    const evm = await chain(19960);
    try {
      const communityId = digest("v4-community");
      const origin = "https://community.example";
      const contract = await evm.deploy("LearningResultsV4", [
        accounts[3].address,
        communityId,
        learningV4PublicityPolicy,
        origin,
      ]);
      const chainId = await evm.publicClient.getChainId();
      const ctx: SignInV4Context = {
        origin,
        chainId,
        contract: contract.toLowerCase() as Address,
        communityId,
        publicationPolicy: learningV4PublicityPolicy,
      };
      const read = (address: Address, functionName: string, args: unknown[]) =>
        evm.publicClient.readContract({
          address,
          abi: resultsV4Abi,
          functionName,
          args,
        } as never);
      // Random learners, nonces and times, on three origins.
      const others: SignInV4Context[] = [];
      for (const o of ["https://study.example:8443", "https://pirate-first-song-20261105.piratesocialclub.workers.dev"])
        others.push({
          ...ctx,
          origin: o,
          contract: (
            await evm.deploy("LearningResultsV4", [accounts[3].address, communityId, learningV4PublicityPolicy, o])
          ).toLowerCase() as Address,
        });
      const contexts = [ctx, ...others];
      for (let batch = 0; batch < 10; batch++)
        await Promise.all(
          Array.from({ length: 20 }, async (_, i) => {
            const c = contexts[(batch * 20 + i) % contexts.length]!;
            const s: SignIn = {
              learner: random(20) as Address,
              nonce: random(32) as Hex,
              issuedAt: BigInt(Math.floor(Math.random() * 253402300800)),
            };
            if (BigInt(s.nonce) === 0n) return;
            const text = signInMessageV4(c, s);
            assert.equal(await read(c.contract, "signInMessage", [s]), text);
            assert.equal(await read(c.contract, "signInDigest", [s]), hashMessage(text));
            assert.equal(signInIdV4(c, s), hashMessage(text));
          }),
        );
      assert.equal(await read(contract, "VERSION", []), 4);
      assert.equal(await read(contract, "communityOrigin", []), origin);
      assert.equal(await read(contract, "SIGN_IN_STATEMENT", []), SIGN_IN_STATEMENT_V4);
      const now = BigInt((await evm.publicClient.getBlock()).timestamp);
      const learner = accounts[5];
      const message: SignIn = {
        learner: learner.address,
        nonce: digest("login-nonce"),
        issuedAt: now,
      };
      const text = signInMessageV4(ctx, message);
      const signature = await learner.signMessage({ message: text });
      const id = signInIdV4(ctx, message);
      assert.equal(await read(contract, "signInDigest", [message]), id);
      await evm.write(contract, "LearningResultsV4", "authorize", [message, signature], 2);
      assert.equal(
        String(await read(contract, "authorizationLearner", [id])).toLowerCase(),
        learner.address.toLowerCase(),
      );
      assert.equal(await read(contract, "authorizedSince", [learner.address]), now);
      // A text that differs from the contract's in one rendered field.
      const next = (n: string): SignIn => ({ ...message, nonce: digest(n) });
      for (const [name, changed] of [
        ["host", { ...ctx, origin: "https://phish.example" }],
        ["contract", { ...ctx, contract: others[0]!.contract }],
        ["chain", { ...ctx, chainId: 6343 }],
        ["community", { ...ctx, communityId: digest("elsewhere") }],
        ["policy", { ...ctx, publicationPolicy: digest("old policy") }],
      ] as const) {
        const s = next(name);
        const wrong = await learner.signMessage({ message: signInMessageV4(changed, s) });
        await assert.rejects(
          evm.write(contract, "LearningResultsV4", "authorize", [s, wrong], 2),
          /invalid_consent/,
          name,
        );
      }
      // The plain deployed login text and the former typed SignIn.
      const plain = next("plain");
      const login = createSiweMessage({
        address: learner.address,
        chainId: 6343,
        domain: "community.example",
        uri: origin,
        version: "1",
        nonce: plain.nonce.slice(2),
        issuedAt: new Date(Number(now) * 1000),
        expirationTime: new Date(Number(now) * 1000 + 300_000),
        statement:
          "Sign in to this community. This does not join, create a creator wallet or authorize spending.",
      });
      await assert.rejects(
        evm.write(contract, "LearningResultsV4", "authorize", [plain, await learner.signMessage({ message: login })], 2),
        /invalid_consent/,
      );
      const typed = await learner.signTypedData({
        domain: resultsV4Domain(chainId, contract),
        types: {
          SignIn: [
            { name: "learner", type: "address" },
            { name: "communityId", type: "bytes32" },
            { name: "origin", type: "string" },
            { name: "publicationPolicy", type: "bytes32" },
            { name: "nonce", type: "bytes32" },
            { name: "issuedAt", type: "uint64" },
            { name: "expiresAt", type: "uint64" },
          ],
        },
        primaryType: "SignIn",
        message: { ...plain, communityId, origin, publicationPolicy: learningV4PublicityPolicy, expiresAt: now + 300n },
      });
      await assert.rejects(
        evm.write(contract, "LearningResultsV4", "authorize", [plain, typed], 2),
        /invalid_consent/,
      );
      // An IthacaAccount-style account: its key signs the ERC1271Sign
      // wrapper of hashMessage(text), as the MOSS SDK's signMessage does.
      const key = accounts[6];
      const account = await evm.deploy("ReplaySafeAccount", [key.address]);
      const smart: SignIn = { learner: account, nonce: digest("smart"), issuedAt: now };
      const smartId = signInIdV4(ctx, smart);
      const wrap = (verifyingContract: Address) =>
        key.signTypedData({
          domain: { name: "IthacaAccount", version: "0.5.12", chainId, verifyingContract },
          types: { ERC1271Sign: [{ name: "digest", type: "bytes32" }] },
          primaryType: "ERC1271Sign",
          message: { digest: smartId },
        });
      await assert.rejects(
        evm.write(contract, "LearningResultsV4", "authorize", [smart, await key.signMessage({ message: signInMessageV4(ctx, smart) })], 2),
        /invalid_consent/,
      );
      await evm.write(contract, "LearningResultsV4", "authorize", [smart, await wrap(account)], 2);
      assert.equal(getAddress(String(await read(contract, "authorizationLearner", [smartId]))), getAddress(account));
      // For these origins the constructor and canonicalOriginV4 agree.
      // canonicalOriginV4 also refuses some origins the constructor accepts
      // but signInMessageV4 cannot render (learning-v4-release-observation).
      for (const o of [
        "https://community.example",
        "https://localhost:8787",
        "https://127.0.0.1:8443",
        "https://community.example/",
        "https://Community.example",
        "http://community.example",
        "https://community.example:443",
        "https://community.example:0080",
        "https://community..example",
        "https://-community.example",
        "https://community",
        "https://community.example:65536",
      ]) {
        const deployed = await evm
          .deploy("LearningResultsV4", [accounts[3].address, communityId, learningV4PublicityPolicy, o])
          .then(() => true, () => false);
        assert.equal(deployed, canonicalOriginV4(o), o);
      }
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
