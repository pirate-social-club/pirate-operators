// Read-only estimates on testnet, with synthetic EOA consent and ephemeral state overrides.
// No performance is published and no transaction is broadcast. MOSS remains a separate gate.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  keccak256,
  pad,
  toHex,
  zeroHash,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  resultsAbi,
  enrollmentTypes,
  resultsDomain,
  enrollmentIdOf,
  revocationTypes,
  orderedExercisesHash,
  packOutcomes,
  resultCommitment,
  type TerminalResult,
} from "../../packages/protocol/learning-results.ts";
import { firstSong } from "../../services/first-song-profile.ts";
import { check, digest } from "../../packages/protocol/index.ts";

const client = createPublicClient({
  transport: http("https://carrot.megaeth.com/rpc", {
    retryCount: 0,
    timeout: 30000,
  }),
});
check((await client.getChainId()) === 6343, "wrong_chain");
const deployment = JSON.parse(
  await readFile(
    "docs/deployments/learning-results-testnet-20261106.contract.json",
    "utf8",
  ),
);
const contract = deployment.learningResults as Address;
const head = await client.getBlock();
const fixture = privateKeyToAccount(`0x${"29".repeat(32)}`);
const grader = deployment.grader as Address;
const publicityPolicy = await client.readContract({
  address: contract,
  abi: resultsAbi,
  functionName: "publicityPolicy",
});
const enrollment = {
  learner: fixture.address,
  communityId: firstSong.directoryProfile.communityId,
  activities: 1n,
  publicityPolicy,
  expiresAt: head.timestamp + 86400n,
  nonce: 0n,
};
const grantId = enrollmentIdOf(6343, contract, enrollment);
const domain = resultsDomain(6343, contract);
const enrollmentSignature = await fixture.signTypedData({
  domain,
  types: enrollmentTypes,
  primaryType: "Enrollment",
  message: enrollment,
});
const mapSlot = (key: Address | Hex, index: bigint, type = "address") =>
  keccak256(
    encodeAbiParameters(
      [{ type }, { type: "uint256" }] as never,
      [key, index] as never,
    ),
  );
const grant = BigInt(mapSlot(fixture.address, 2n));
const slots = [
  { slot: toHex(grant, { size: 32 }), value: grantId },
  { slot: toHex(grant + 1n, { size: 32 }), value: toHex(1n, { size: 32 }) },
  {
    slot: toHex(grant + 2n, { size: 32 }),
    value: toHex((enrollment.expiresAt << 64n) | (head.timestamp - 120n), {
      size: 32,
    }),
  },
];
const price = await client.getGasPrice();
const rows: Record<string, unknown>[] = [];
async function measure(
  label: string,
  account: Address,
  data: Hex,
  stateDiff = slots,
) {
  const stateOverride = [
    { address: contract, stateDiff },
    { address: account, balance: 10n ** 20n },
  ];
  const gas = await client.estimateGas({
    account,
    to: contract,
    data,
    gasPrice: price,
    blockNumber: head.number,
    stateOverride,
  });
  const call = await client.call({
    account,
    to: contract,
    data,
    gas,
    gasPrice: price,
    blockNumber: head.number,
    stateOverride,
  });
  const raw = await fixture.signTransaction({
    chainId: 6343,
    nonce: 0,
    to: contract,
    data,
    gas,
    gasPrice: price,
    type: "legacy",
  });
  const dataFee = await client.readContract({
    address: "0x420000000000000000000000000000000000000F",
    abi: [
      {
        type: "function",
        name: "getL1Fee",
        stateMutability: "view",
        inputs: [{ type: "bytes", name: "data" }],
        outputs: [{ type: "uint256" }],
      },
    ],
    functionName: "getL1Fee",
    args: [raw],
    blockNumber: head.number,
  });
  rows.push({
    label,
    gas: String(gas),
    estimatedDataFeeWei: String(dataFee),
    estimatedTotalWei: String(gas * price + dataFee),
    callReturnBytes: ((call.data ?? "0x").length - 2) / 2,
  });
}
await measure(
  "enroll-EOA",
  fixture.address,
  encodeFunctionData({
    abi: resultsAbi,
    functionName: "enroll",
    args: [enrollment, enrollmentSignature],
  }),
  [{ slot: mapSlot(fixture.address, 1n), value: zeroHash }],
);
for (const count of [23, 40]) {
  const completedAt = head.timestamp - 10n;
  const result: TerminalResult = {
    sessionId: digest(`synthetic-read-only-${count}`),
    learner: fixture.address,
    enrollmentId: grantId,
    song: {
      chainId: 6343n,
      posts: firstSong.posts.address,
      communityId: firstSong.directoryProfile.communityId,
      postId: digest("synthetic-song"),
    },
    contentRevision: digest(`synthetic-manifest-${count}`),
    exercisesHash: orderedExercisesHash(count),
    linesTotal: count,
    activity: 1,
    grader,
    scoringPolicy: digest("synthetic-policy"),
    qualificationPolicy: await client.readContract({
      address: contract,
      abi: resultsAbi,
      functionName: "policyFor",
      args: [(completedAt - 1793552400n) / 86400n],
      blockNumber: head.number,
    }),
    startedAt: head.timestamp - 60n,
    completedAt,
    status: 1,
    revision: 1,
    supersedes: zeroHash,
  };
  const outcomes = packOutcomes(
    Array.from({ length: count }, () => ({
      status: "assessed" as const,
      scoreBps: 7500,
    })),
  );
  await measure(
    `publish-${count}`,
    grader,
    encodeFunctionData({
      abi: resultsAbi,
      functionName: "publish",
      args: [result, outcomes],
    }),
  );
  const commitment = resultCommitment(result, outcomes);
  await measure(
    `correct-${count}`,
    grader,
    encodeFunctionData({
      abi: resultsAbi,
      functionName: "correct",
      args: [
        result,
        outcomes,
        packOutcomes(
          Array.from({ length: count }, () => ({
            status: "assessed" as const,
            scoreBps: 7000,
          })),
        ),
        1,
      ],
    }),
    [
      ...slots,
      { slot: mapSlot(result.sessionId, 4n, "bytes32"), value: commitment },
    ],
  );
}
const revocation = { learner: fixture.address, nonce: 1n };
const signature = await fixture.signTypedData({
  domain,
  types: revocationTypes,
  primaryType: "Revocation",
  message: revocation,
});
await measure(
  "revoke-EOA",
  fixture.address,
  encodeFunctionData({
    abi: resultsAbi,
    functionName: "revoke",
    args: [fixture.address, 1n, signature],
  }),
  [
    ...slots,
    { slot: mapSlot(fixture.address, 1n), value: pad("0x01", { size: 32 }) },
  ],
);
const output = {
  chainId: 6343,
  contract,
  block: String(head.number),
  blockHash: head.hash,
  gasPriceWei: String(price),
  scope:
    "complete deployed contract; synthetic EOA consent and result data; state overrides; successful read-only calls; estimated L1 data fees",
  moss: "not measured",
  publicTransactions: 0,
  rows,
};
await mkdir(".local/learning-testnet", { recursive: true });
await writeFile(
  ".local/learning-testnet/costs.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(JSON.stringify(output, null, 2));
