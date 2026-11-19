import {
  BaseError, ContractFunctionRevertedError, keccak256, parseAbi, serializeTransaction,
  type Address, type Hex, type PublicClient, type TransactionSerializableLegacy, type TransactionSerializedLegacy,
} from "viem";
import { bytes32, hashJson, insist as assert, object } from "../../packages/community/common.ts";
import type { Web2CommunityConfig } from "../../packages/community/web2-config-manifest.ts";
import {
  observePublication, postsAbi, publicationData, type FirstPublication, type PostsProfile,
} from "../../packages/community/post-chain.ts";
import type { NativePostsPublicationStatus } from "../../services/native-posts-publication.ts";

const chainId = 6343;
const oracleAbi = parseAbi([
  "function getL1FeeUpperBound(uint256) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);
const oracle = "0x420000000000000000000000000000000000000f";
const implementationSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
type Anchor = Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
export type NativePostsTransaction = Readonly<TransactionSerializableLegacy & {
  type: "legacy"; chainId: 6343; nonce: number; to: Address; data: Hex; value: 0n; gas: bigint; gasPrice: bigint;
}>;
export type NativePostsTerminal = Extract<NativePostsPublicationStatus, { state: "confirmed" | "reverted" }>;

export interface NativePostsChainPolicy {
  genesisHash: Hex;
  directoryCodeHash: Hex;
  oracleProxyCodeHash: Hex;
  oracleImplementation: Address;
  oracleImplementationCodeHash: Hex;
  maximumSafeAgeSeconds: bigint;
  maximumGas: bigint;
  maximumGasPrice: bigint;
  maximumTotalFee: bigint;
  maximumOperatorFee: bigint;
}

function quantity(value: unknown) {
  assert(typeof value === "string" && /^0x(0|[1-9a-f][0-9a-f]*)(?![\s\S])/.test(value),
    "native_posts_fee_evidence_incomplete");
  return BigInt(value);
}

export function createNativePostsChain(input: {
  client: PublicClient;
  rpcUrl: string;
  config: Readonly<Web2CommunityConfig>;
  profile: Readonly<PostsProfile>;
  policy: Readonly<NativePostsChainPolicy>;
}) {
  const { client } = input;
  const config = structuredClone(input.config), profile = Object.freeze({ ...input.profile });
  const policy = Object.freeze({ ...input.policy }), url = new URL(input.rpcUrl);
  assert(url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash &&
    client.transport.type === "http" && client.transport.url === url.href &&
    config.chainId === chainId && config.postsContract === profile.address && config.configurationRevision === 1 &&
    policy.maximumSafeAgeSeconds > 0n && policy.maximumGas > 0n && policy.maximumGas <= 1_000_000n &&
    policy.maximumGasPrice > 0n && policy.maximumGasPrice <= 30_000_000n &&
    policy.maximumTotalFee > 0n && policy.maximumTotalFee <= 30_000_000_000_000n &&
    policy.maximumOperatorFee >= 0n && policy.maximumOperatorFee <= policy.maximumTotalFee,
    "native_posts_chain_selection_changed");

  const feePolicySha256 = hashJson({ schema: "pirate.native-posts-chain-fee-policy/1", chainId,
    genesisHash: policy.genesisHash, directoryCodeHash: policy.directoryCodeHash,
    oracleProxyCodeHash: policy.oracleProxyCodeHash, oracleImplementation: policy.oracleImplementation,
    oracleImplementationCodeHash: policy.oracleImplementationCodeHash,
    maximumSafeAgeSeconds: policy.maximumSafeAgeSeconds.toString(), maximumGas: policy.maximumGas.toString(),
    maximumGasPrice: policy.maximumGasPrice.toString(), maximumTotalFee: policy.maximumTotalFee.toString(),
    maximumOperatorFee: policy.maximumOperatorFee.toString() });
  const at = (hash: Hex) => ({ blockHash: hash, requireCanonical: true as const });

  function anchorDeadline(anchor: Anchor) {
    const result = Number((anchor.timestamp + policy.maximumSafeAgeSeconds) * 1000n);
    assert(Number.isSafeInteger(result) && Date.now() < result, "native_posts_safe_anchor_expired");
    return result;
  }

  async function pinnedBlock(number: bigint, hash: Hex) {
    const block = await client.getBlock({ blockNumber: number, includeTransactions: false });
    assert(block.number === number && block.hash === hash, "native_posts_chain_reorganized");
    return block;
  }

  async function safe(): Promise<Anchor> {
    const [id, genesis, head] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockNumber: 0n, includeTransactions: false }),
      client.getBlock({ blockTag: "safe", includeTransactions: false }),
    ]);
    assert(id === chainId && genesis.hash === policy.genesisHash && head.hash && head.number !== null &&
      head.number >= profile.deploymentBlock && head.timestamp * 1000n <= BigInt(Date.now()),
      "native_posts_chain_selection_changed");
    const anchor = { number: head.number, hash: head.hash, timestamp: head.timestamp };
    anchorDeadline(anchor);
    const [code, directoryCode, directory] = await Promise.all([
      client.getCode({ address: profile.address, ...at(head.hash) }),
      client.getCode({ address: config.directory, ...at(head.hash) }),
      client.readContract({ address: profile.address, abi: postsAbi, functionName: "directory", ...at(head.hash) }),
    ]);
    assert(code && keccak256(code) === profile.runtimeCodeHash &&
      directoryCode && keccak256(directoryCode) === policy.directoryCodeHash &&
      directory.toLowerCase() === config.directory, "native_posts_code_changed");
    await pinnedBlock(anchor.number, anchor.hash);
    return anchor;
  }

  async function assertOracle(hash: Hex) {
    const [proxy, slot, implementation] = await Promise.all([
      client.getCode({ address: oracle, ...at(hash) }),
      client.getStorageAt({ address: oracle, slot: implementationSlot, ...at(hash) }),
      client.getCode({ address: policy.oracleImplementation, ...at(hash) }),
    ]);
    assert(proxy && keccak256(proxy) === policy.oracleProxyCodeHash && slot &&
      slot === ("0x" + "0".repeat(24) + policy.oracleImplementation.slice(2)) &&
      implementation && keccak256(implementation) === policy.oracleImplementationCodeHash,
      "native_posts_fee_oracle_changed");
  }

  async function operatorFee(hash: Hex, gas: bigint) {
    const result = await client.readContract({
      address: oracle, abi: oracleAbi, functionName: "getOperatorFee", args: [gas], ...at(hash),
    });
    assert(typeof result === "bigint" && result >= 0n && result <= policy.maximumOperatorFee,
      "native_posts_operator_fee_refused");
    return result;
  }

  async function upperBound(hash: Hex, tx: NativePostsTransaction, raw?: TransactionSerializedLegacy) {
    await assertOracle(hash);
    // The predeploy itself adds the legacy signature allowance. Keep additional
    // RLP headroom before key entry and use the actual byte length once retained.
    const bytes = BigInt(((raw ?? serializeTransaction(tx)).length - 2) / 2 + (raw ? 0 : 80));
    const [l1, operator] = await Promise.all([
      client.readContract({ address: oracle, abi: oracleAbi, functionName: "getL1FeeUpperBound",
        args: [bytes], ...at(hash) }),
      operatorFee(hash, tx.gas),
    ]);
    assert(typeof l1 === "bigint" && l1 > 0n, "native_posts_l1_fee_refused");
    return l1 + operator;
  }

  async function assertNonce(anchor: Anchor, nonce: number) {
    const nonces = await Promise.all([
      client.getTransactionCount({ address: config.publisher, ...at(anchor.hash) }),
      client.getTransactionCount({ address: config.publisher, blockTag: "latest" }),
      client.getTransactionCount({ address: config.publisher, blockTag: "pending" }),
    ]);
    assert(nonces.every(value => value === nonce), "native_posts_nonce_unsettled");
    await pinnedBlock(anchor.number, anchor.hash);
  }

  async function requireAbsent(anchor: Anchor, publication: FirstPublication) {
    try {
      await client.readContract({ address: profile.address, abi: postsAbi, functionName: "getPost",
        args: [publication.communityId, publication.postId], ...at(anchor.hash) });
    } catch (error) {
      const cause = error instanceof BaseError
        ? error.walk(candidate => candidate instanceof ContractFunctionRevertedError) : null;
      if (cause instanceof ContractFunctionRevertedError && cause.data?.errorName === "UnknownPost") return;
      throw error;
    }
    throw Error("native_posts_post_already_exists");
  }

  async function verifyCanonical(publication: FirstPublication, hash: Hex, maximumFee: bigint,
    expected?: NativePostsTransaction): Promise<NativePostsTerminal | null> {
    const data = publicationData(publication);
    assert(publication.communityId === config.communityId && publication.configurationRevision === 1 &&
      maximumFee > 0n && maximumFee <= policy.maximumTotalFee, "native_posts_canonical_scope_changed");
    const anchor = await safe();
    const wire = await client.request({ method: "eth_getTransactionReceipt", params: [hash] });
    if (wire === null) return null;
    const raw = object(wire), blockHash = bytes32(raw.blockHash);
    const number = quantity(raw.blockNumber);
    if (number > anchor.number) return null;
    const block = await pinnedBlock(number, blockHash);
    const actual = await client.getTransaction({ hash });
    assert(number >= profile.deploymentBlock && block.transactions.includes(hash) && raw.transactionHash === hash &&
      raw.from === config.publisher && raw.to === profile.address && (raw.status === "0x0" || raw.status === "0x1") &&
      raw.type === "0x0" && actual.type === "legacy" && actual.hash === hash && actual.blockHash === blockHash &&
      actual.blockNumber === number && actual.chainId === chainId && actual.from.toLowerCase() === config.publisher &&
      actual.to?.toLowerCase() === profile.address && actual.value === 0n && actual.input === data &&
      Number.isSafeInteger(actual.nonce) && actual.nonce >= 0 && actual.gas > 0n && actual.gas <= policy.maximumGas &&
      typeof actual.gasPrice === "bigint" && actual.gasPrice > 0n && actual.gasPrice <= policy.maximumGasPrice &&
      actual.gas * actual.gasPrice < maximumFee && (!expected || (actual.nonce === expected.nonce && actual.gas === expected.gas &&
        actual.gasPrice === expected.gasPrice && expected.data === data && expected.to === profile.address)),
      "native_posts_receipt_changed");
    const used = quantity(raw.gasUsed), price = quantity(raw.effectiveGasPrice), l1Fee = quantity(raw.l1Fee);
    assert(used > 0n && used <= actual.gas && price === actual.gasPrice, "native_posts_fee_evidence_changed");
    await assertOracle(blockHash);
    const operator = await operatorFee(blockHash, used);
    if (Object.hasOwn(raw, "operatorFee")) assert(quantity(raw.operatorFee) === operator, "native_posts_fee_evidence_changed");
    const total = used * price + l1Fee + operator;
    assert(total <= maximumFee, "native_posts_fee_exceeds_reserved");
    const evidence = { transactionHash: hash, blockHash, blockNumber: number.toString(), actualFeeWei: total.toString() };

    let result: NativePostsTerminal;
    if (raw.status === "0x0") {
      assert(Array.isArray(raw.logs) && raw.logs.length === 0, "native_posts_revert_logs_changed");
      result = { state: "reverted", ...evidence };
    } else {
      const confirmed = await observePublication(client, profile, config, hash, config.publisher, publication);
      assert(confirmed && confirmed.blockHash === blockHash && confirmed.blockNumber === evidence.blockNumber &&
        confirmed.postId === publication.postId, "native_posts_event_changed");
      const post = await client.readContract({ address: profile.address, abi: postsAbi, functionName: "getPost",
        args: [publication.communityId, publication.postId], ...at(blockHash) });
      assert(post.kind === 0 && post.revision === 1n && post.configurationRevision === 1n &&
        post.authorId === publication.authorId && post.manifestSha256 === publication.manifestSha256 &&
        post.manifestURI === publication.manifestURI, "native_posts_canonical_post_changed");
      result = { state: "confirmed", ...evidence, postId: publication.postId, revision: 1 };
    }
    await Promise.all([pinnedBlock(number, blockHash), pinnedBlock(anchor.number, anchor.hash)]);
    anchorDeadline(anchor);
    return result;
  }

  return Object.freeze({
    feePolicySha256,
    publisher: config.publisher,
    target: profile.address,
    communityId: config.communityId,
    rpcUrl: url.href,
    async assertCleanNonce(nonce: number) {
      const anchor = await safe();
      await assertNonce(anchor, nonce);
      return anchorDeadline(anchor);
    },
    pendingNonce() {
      return client.getTransactionCount({ address: config.publisher, blockTag: "pending" });
    },
    async readAdditionalFeeUpperBound(quoteAnchor: { blockNumber: bigint; blockHash: Hex }, tx: NativePostsTransaction) {
      const block = await pinnedBlock(quoteAnchor.blockNumber, quoteAnchor.blockHash);
      anchorDeadline({ number: quoteAnchor.blockNumber, hash: quoteAnchor.blockHash, timestamp: block.timestamp });
      const fee = await upperBound(quoteAnchor.blockHash, tx);
      await pinnedBlock(quoteAnchor.blockNumber, quoteAnchor.blockHash);
      return fee;
    },
    async preflight(tx: NativePostsTransaction, publication: FirstPublication, maximumFee: bigint,
      quoteAnchor: { blockNumber: bigint; blockHash: Hex }, raw?: TransactionSerializedLegacy) {
      assert(tx.chainId === chainId && tx.to === profile.address && tx.data === publicationData(publication) &&
        publication.communityId === config.communityId && publication.configurationRevision === 1 &&
        tx.value === 0n && tx.gas > 0n && tx.gas <= policy.maximumGas && tx.gasPrice > 0n &&
        tx.gasPrice <= policy.maximumGasPrice && maximumFee > 0n && maximumFee <= policy.maximumTotalFee,
        "native_posts_fee_selection_changed");
      const anchor = await safe();
      assert(quoteAnchor.blockNumber <= anchor.number, "native_posts_quote_anchor_changed");
      await pinnedBlock(quoteAnchor.blockNumber, quoteAnchor.blockHash);
      const [estimate, networkPrice, extra, balance] = await Promise.all([
        client.estimateGas({ account: config.publisher, to: tx.to, data: tx.data, value: 0n,
          gasPrice: tx.gasPrice, blockNumber: anchor.number }),
        client.getGasPrice(),
        upperBound(anchor.hash, tx, raw),
        client.getBalance({ address: config.publisher, ...at(anchor.hash) }),
      ]);
      assert(estimate > 0n && estimate <= tx.gas && networkPrice <= tx.gasPrice &&
        tx.gas * tx.gasPrice + extra <= maximumFee && balance >= maximumFee,
        "native_posts_fee_or_balance_refused");
      await requireAbsent(anchor, publication);
      await assertNonce(anchor, tx.nonce);
      return anchorDeadline(anchor);
    },
    /** Compare the safe chain result with the exact retained private transaction. */
    safeOriginal(tx: NativePostsTransaction, publication: FirstPublication, hash: Hex, maximumFee: bigint) {
      return verifyCanonical(publication, hash, maximumFee, tx);
    },
    /** Receiver-side independent safe canonical read. The authenticated
     * retained proof supplies the exact hash, publication and all-in cap. */
    readCanonicalOriginal(publication: FirstPublication, hash: Hex, maximumFee: bigint) {
      return verifyCanonical(publication, hash, maximumFee);
    },
  });
}

export type NativePostsChain = ReturnType<typeof createNativePostsChain>;
