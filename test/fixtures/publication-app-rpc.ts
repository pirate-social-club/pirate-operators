// Explicit scripted RPC bytes, not EVM execution or a selected deployment.
import assert from "node:assert/strict";
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  sha256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { canonical, digest } from "../../packages/protocol/index.ts";
import { hashText } from "../../packages/community/common.ts";
import { directoryInstanceId } from "../../packages/community/shared-identity.ts";
import {
  directoryV3Abi,
  directoryV3Build,
  validateWeb2Profile,
  web2Binding,
  web2ProfileDocument,
} from "../../packages/community/web2-directory.ts";
import { directoryV3Runtime } from "../../packages/community/generated/directory-v3.ts";
import {
  learningResultsV5Abi,
  learningResultsV5Build,
  learningResultsV5RuntimeTemplate,
} from "../../packages/protocol/generated/learning-results-v5.ts";
import { publicationConsentAbi } from "../../packages/protocol/generated/publication-consent-v1.ts";
import {
  publicationPurposes,
  parsePublicationGrant,
} from "../../packages/protocol/publication-consent.ts";
import {
  UNREGISTERED_OWNER_POLICY_HASH,
  UNREGISTERED_OWNER_POLICY_VERSION,
} from "../../packages/community/owner-policy.ts";
import type { PublicationAppRelease } from "../../services/publication-app-selection.ts";
import type { GrantWireV1 } from "../../packages/protocol/publication-runtime-v1.ts";
import { deferred } from "./publication-app-http.ts";

export const addr = (n: number) =>
  ("0x" + n.toString(16).padStart(40, "0")) as Address;
const quantity = (n: bigint) => ("0x" + n.toString(16)) as Hex;
const zero = ("0x" + "0".repeat(64)) as Hex;
export function scriptedPublicationAuthority(
  baseUrl: string,
  nowS: bigint,
  identities: { issuer: Address; operator: Address },
) {
  const docs = new Map<string, string>(),
    policies: PublicationAppRelease["policies"] = {};
  const registry = addr(10),
    registryCode = learningResultsV5RuntimeTemplate;
  for (const purpose of publicationPurposes) {
    const text = {
      terms: "Public fixture terms.\n",
      disclosure: "Public fixture disclosure.\n",
      privacy: "Public fixture privacy.\n",
      retention: "Public fixture retention.\n",
    };
    const h = (v: string) => sha256(new TextEncoder().encode(v));
    const dance = purpose.startsWith("dance-")
      ? keccak256(stringToHex("fixture-dance-publicity"))
      : zero;
    const manifest = {
      schema: "pirate.publication-policy/1",
      purpose,
      termsSha256: h(text.terms),
      disclosureSha256: h(text.disclosure),
      privacySha256: h(text.privacy),
      retentionSha256: h(text.retention),
      maxGrantDurationSeconds: "3600",
      maxSubmissionDelaySeconds: "1800",
      dancePublicityPolicyHash: dance,
    };
    const documents = {
      manifest: baseUrl + "/docs/" + purpose + "/manifest",
      terms: baseUrl + "/docs/" + purpose + "/terms",
      disclosure: baseUrl + "/docs/" + purpose + "/disclosure",
      privacy: baseUrl + "/docs/" + purpose + "/privacy",
      retention: baseUrl + "/docs/" + purpose + "/retention",
    };
    docs.set(new URL(documents.manifest).pathname, canonical(manifest));
    for (const [key, value] of Object.entries(text))
      docs.set("/docs/" + purpose + "/" + key, value);
    policies[purpose] = {
      target: purpose.startsWith("dance-") ? addr(12) : registry,
      runtimeHash: purpose.startsWith("dance-")
        ? keccak256("0x6000")
        : keccak256(registryCode),
      permissionRevision: "1",
      policyHash: h(canonical(manifest)),
      maxGrantDurationSeconds: "3600",
      maxSubmissionDelaySeconds: "1800",
      dancePublicityPolicyHash: dance,
      documents,
    };
  }
  const communityKey = digest("app-test-community"),
    communityId = directoryInstanceId(31337, communityKey),
    installationId = digest("app-test-installation");
  const profile = validateWeb2Profile({
    schema: "pirate.web2-directory/3",
    chainId: 31337,
    directory: addr(1),
    directoryCodeHash: directoryV3Build.runtimeCodeHash,
    directoryAbiSha256: directoryV3Build.abiSha256,
    sourceCommit: "1".repeat(40),
    deploymentBlock: 1n,
    communityKey,
    communityId,
    installationId,
  });
  const configuration = {
    schema: "pirate.community-config/4" as const,
    chainId: 31337 as const,
    directory: profile.directory,
    communityKey,
    communityId,
    installationId,
    configurationRevision: 1,
    postsContract: addr(4),
    controller: addr(5),
    publisher: addr(6),
    operatorPayments: addr(9),
    learningRecords: registry,
    app: {
      label: "Scripted publication app fixture",
      origin: "https://publication-app.invalid",
    },
    feed: {
      endpoint: "https://publication-app.invalid/api/feed",
      signingKeyId: "fixture",
    },
    policies: {
      admission: {
        version: UNREGISTERED_OWNER_POLICY_VERSION,
        sha256: UNREGISTERED_OWNER_POLICY_HASH,
      },
      moderationSigner: addr(11),
    },
    publisherRevocations: [],
  };
  const release: PublicationAppRelease = {
    schema: "pirate.publication-app-release/1",
    source: {
      schema: "pirate.publication-source/1",
      resultsVersion: 5,
      chainId: 31337,
      communityId,
      installationId,
      directory: profile.directory,
      directoryRuntimeHash: profile.directoryCodeHash,
      registry,
      registryRuntimeHash: keccak256(registryCode),
    },
    registryAbiSha256: learningResultsV5Build.abiSha256,
    profile: web2ProfileDocument(profile),
    configuration,
    ...identities,
    fee: {
      schema: "pirate.publication-fee/1",
      chainId: 31337,
      payer: identities.operator,
      policyHash: digest("fixture-fee-policy"),
      cap: "1000000",
      gas: "100000",
      gasPrice: "1",
      dataFee: "0",
    },
    grantDurationSeconds: "3600",
    submitWindowSeconds: "1800",
    withdrawalWindowSeconds: "1800",
    policies,
  };
  const state = {
    safe: { number: 1000n, hash: digest("app-safe-1000"), timestamp: nowS },
    calls: [] as string[],
    simulations: [] as { to: string; from: string; data: Hex; at: unknown }[],
    offline: false,
    wrongCode: false,
    simulationError: null as Hex | null,
    grant: null as GrantWireV1 | null,
    recordedAt: 0n,
    transactions: new Map<Hex, unknown>(),
    receipts: new Map<Hex, unknown>(),
    blocks: new Map<bigint, unknown>(),
  };
  let held: {
    entered: ReturnType<typeof deferred>;
    gate: ReturnType<typeof deferred>;
    method: string;
  } | null = null;
  const block = (
    number: bigint,
    hash: Hex,
    timestamp: bigint,
    transactions: Hex[] = [],
  ) => ({
    number: quantity(number),
    hash,
    timestamp: quantity(timestamp),
    parentHash: digest("parent"),
    transactions,
  });
  const result = (
    abi: typeof publicationConsentAbi,
    functionName: string,
    value: unknown,
  ) => encodeFunctionResult({ abi, functionName, result: value } as never);
  async function rpc(call: { id: number; method: string; params: unknown[] }) {
    state.calls.push(call.method);
    if (held?.method === call.method) {
      const h = held;
      held = null;
      h.entered.resolve();
      await h.gate.promise;
    }
    const [first, at] = call.params ?? [];
    if (call.method === "eth_chainId") return "0x7a69";
    if (call.method === "eth_getBlockByNumber") {
      if (first === "safe")
        return block(state.safe.number, state.safe.hash, state.safe.timestamp);
      const n = BigInt(first as string);
      return (
        state.blocks.get(n) ??
        (n === state.safe.number
          ? block(n, state.safe.hash, state.safe.timestamp)
          : null)
      );
    }
    if (call.method === "eth_getTransactionReceipt")
      return state.receipts.get(first as Hex) ?? null;
    if (call.method === "eth_getTransactionByHash")
      return state.transactions.get(first as Hex) ?? null;
    if (call.method === "eth_getCode") {
      const anchor = at as { blockHash: Hex; requireCanonical: boolean };
      assert.equal(anchor.requireCanonical, true);
      assert.ok(
        anchor.blockHash === state.safe.hash ||
          [...state.blocks.values()].some(
            (b) => (b as { hash: Hex }).hash === anchor.blockHash,
          ),
        "known exact canonical code hash required",
      );
      return state.wrongCode
        ? "0x6001"
        : String(first).toLowerCase() === profile.directory
          ? directoryV3Runtime
          : String(first).toLowerCase() === registry
            ? registryCode
            : "0x6000";
    }
    assert.deepEqual(
      at,
      { blockHash: state.safe.hash, requireCanonical: true },
      "fixed canonical state hash required",
    );
    assert.equal(
      call.method,
      "eth_call",
      "no send, estimate or wallet RPC is implemented",
    );
    const tx = first as { to: string; from?: string; data: Hex };
    if (tx.to.toLowerCase() === profile.directory) {
      const decoded = decodeFunctionData({
        abi: directoryV3Abi,
        data: tx.data,
      });
      const values: Record<string, unknown> = {
        getBinding: web2Binding(profile),
        getOrigin: {
          sha256Digest: hashText(configuration.app.origin),
          revision: 1n,
          controllerRevision: 1n,
        },
        getCommunity: {
          registry: addr(15),
          tldHash: digest("tld"),
          configurationRevision: 1n,
          configuration: {
            controller: configuration.controller,
            publisher: configuration.publisher,
            operatorPayments: configuration.operatorPayments,
            learningRecords: configuration.learningRecords,
            sha256Digest: hashText(canonical(configuration)),
            uri: "ipfs://scripted-config",
          },
          verificationRevision: 0n,
          verification: {
            configurationRevision: 0n,
            hnsHeight: 0n,
            hnsBlockHash: zero,
            observedAt: 0n,
            validUntil: 0n,
            evidenceSha256: zero,
          },
          listingRevision: 0n,
          listed: false,
        },
      };
      assert.ok(decoded.functionName in values);
      return encodeFunctionResult({
        abi: directoryV3Abi,
        functionName: decoded.functionName,
        result: values[decoded.functionName],
      } as never);
    }
    const decoded = decodeFunctionData({
      abi: learningResultsV5Abi,
      data: tx.data,
    });
    if (
      decoded.functionName === "grant" ||
      decoded.functionName === "withdraw"
    ) {
      state.simulations.push({
        to: tx.to,
        from: tx.from ?? "",
        data: tx.data,
        at,
      });
      // Fixed scenario response, not a second signature/window validator.
      if (state.simulationError)
        throw {
          code: -32000,
          message: "execution reverted",
          data: state.simulationError,
        };
      return "0x";
    }
    const identity: Record<string, unknown> = {
      VERSION: 5,
      consentVersion: 1,
      communityId,
      directory: profile.directory,
      directoryRuntimeHash: profile.directoryCodeHash,
      withdrawalEpoch: 0n,
    };
    if (decoded.functionName in identity)
      return encodeFunctionResult({
        abi: learningResultsV5Abi,
        functionName: decoded.functionName,
        result: identity[decoded.functionName],
      } as never);
    if (decoded.functionName === "purpose") {
      const selected = Object.entries(policies).find(
        ([purpose]) => keccak256(stringToHex(purpose)) === decoded.args[0],
      )?.[1];
      assert.ok(selected);
      return result(publicationConsentAbi, "purpose", [
        1n,
        {
          target: selected.target,
          runtimeHash: selected.runtimeHash,
          policyHash: selected.policyHash,
          maxGrantDurationSeconds: 3600n,
          maxSubmissionDelaySeconds: 1800n,
          enabled: true,
        },
      ]);
    }
    if (decoded.functionName === "grantOf") {
      assert.ok(state.grant);
      return result(publicationConsentAbi, "grantOf", [
        parsePublicationGrant(state.grant),
        state.recordedAt,
      ]);
    }
    if (decoded.functionName === "checkGrant")
      return result(publicationConsentAbi, "checkGrant", [true, 0]);
    assert.fail("unplanned scripted ABI read: " + decoded.functionName);
  }
  return {
    release,
    state,
    docs,
    block,
    holdRpc(method: string) {
      assert.equal(held, null);
      const entered = deferred(),
        gate = deferred();
      held = { method, entered, gate };
      return { entered: entered.promise, release: gate.resolve };
    },
    advanceSafe(timestamp: bigint) {
      state.safe = {
        number: state.safe.number + 1n,
        hash: digest({ fixtureSafeNumber: String(state.safe.number + 1n) }),
        timestamp,
      };
    },
    async handle(request: Request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/docs/"))
        return docs.has(url.pathname)
          ? new Response(docs.get(url.pathname), {
              headers: { "content-type": "text/plain;charset=utf-8" },
            })
          : new Response("missing", { status: 404 });
      assert.equal(url.pathname, "/rpc");
      if (state.offline)
        return new Response("explicit RPC outage", { status: 503 });
      const call = (await request.json()) as {
        jsonrpc: string;
        id: number;
        method: string;
        params: unknown[];
      };
      try {
        return Response.json({
          jsonrpc: "2.0",
          id: call.id,
          result: await rpc(call),
        });
      } catch (error) {
        const e = error as { code?: number; message?: string; data?: Hex };
        return Response.json({
          jsonrpc: "2.0",
          id: call.id,
          error: {
            code: e.code ?? -32000,
            message: e.message ?? "scripted RPC fault",
            data: e.data,
          },
        });
      }
    },
  };
}
