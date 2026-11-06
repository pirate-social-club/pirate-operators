// Public-only reference reconstruction at a confirmed canonical head. No community API or database.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createPublicClient, http, zeroHash, type Hex } from "viem";
import { firstSong } from "../services/first-song-profile.ts";
import { readConfigurationHistory } from "../packages/community/directory-reader.ts";
import { sourceAuthenticator } from "../packages/records/source-authentication.ts";
import { readPublicResults } from "../packages/records/results-v2.ts";
import {
  learningBoard,
  type LearningPolicy,
} from "../packages/records/learning-board.ts";
import {
  resultsAbi,
  resultPeriod,
} from "../packages/protocol/learning-results.ts";
import { fetchPublicIpfs } from "../packages/community/ipfs.ts";
import { check } from "../packages/protocol/index.ts";
const client = createPublicClient({
  transport: http("https://carrot.megaeth.com/rpc", {
    timeout: 30000,
    retryCount: 0,
  }),
});
check((await client.getChainId()) === 6343, "wrong_chain");
const deployment = JSON.parse(
  await readFile(
    "docs/deployments/learning-results-testnet-20261106.contract.json",
    "utf8",
  ),
);
const head = (await client.getBlockNumber({ cacheTime: 0 })) - 12n;
const block = await client.getBlock({ blockNumber: head });
const history = await readConfigurationHistory(client, {
  ...firstSong.directoryProfile,
  deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
});
const authenticateSource = sourceAuthenticator({
  client,
  head,
  history,
  posts: {
    ...firstSong.posts,
    deploymentBlock: BigInt(firstSong.posts.deploymentBlock),
  },
});
const results = await readPublicResults({
  rpcUrl: "https://carrot.megaeth.com/rpc",
  contract: deployment.learningResults,
  fromBlock: BigInt(deployment.transactions.deploy.block),
  toBlock: head,
  authenticateSource,
});
const policies = new Map<Hex, LearningPolicy>();
const activations = await client.getContractEvents({
  address: deployment.learningResults,
  abi: resultsAbi,
  eventName: "PolicyActivated",
  fromBlock: BigInt(deployment.transactions.deploy.block),
  toBlock: head,
  strict: true,
});
for (const event of activations) {
  const { bytes } = await fetchPublicIpfs(
    event.args.policyURI,
    event.args.policyHash,
    65536,
  );
  const policy = JSON.parse(new TextDecoder().decode(bytes));
  check(
    policy.schema === "pirate.learning-policy/2" &&
      policy.clockVersion === 1 &&
      policy.activity === 1 &&
      policy.rewards === false,
    "unsupported_learning_policy",
  );
  policies.set(event.args.policyHash, policy);
}
const events = await client.getContractEvents({
  address: deployment.learningResults,
  abi: resultsAbi,
  eventName: "EligibilityChanged",
  fromBlock: BigInt(deployment.transactions.deploy.block),
  toBlock: head,
  strict: true,
});
const eligibility = new Map<string, { at: bigint; eligible: boolean }>();
for (const event of events) {
  const e = event.args,
    key = e.learner.toLowerCase(),
    prior = eligibility.get(key);
  if (e.effectiveAt <= block.timestamp && (!prior || e.effectiveAt >= prior.at))
    eligibility.set(key, { at: e.effectiveAt, eligible: e.eligible });
}
const ineligible = new Set(
  [...eligibility].filter(([, v]) => !v.eligible).map(([k]) => k),
);
const board = learningBoard(
  results,
  resultPeriod(block.timestamp),
  policies,
  ineligible,
);
check(
  (await client.getBlock({ blockNumber: head })).hash === block.hash,
  "canonical_head_changed_retry",
);
const output = {
  chainId: 6343,
  contract: deployment.learningResults,
  head: String(head),
  blockHash: block.hash,
  evaluationTime: String(block.timestamp),
  evaluationPeriod: String(resultPeriod(block.timestamp)),
  source:
    "canonical result/policy/eligibility events and public IPFS manifests only",
  results: results.map((r) => ({
    ...r,
    result: {
      ...r.result,
      song: { ...r.result.song, chainId: String(r.result.song.chainId) },
      startedAt: String(r.result.startedAt),
      completedAt: String(r.result.completedAt),
    },
    period: String(r.period),
    qualification:
      r.result.qualificationPolicy === zeroHash
        ? "no policy for original learning day"
        : "policy pinned",
  })),
  board,
};
await mkdir(".local/learning-testnet", { recursive: true });
await writeFile(
  ".local/learning-testnet/public-reconstruction.json",
  JSON.stringify(output, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    head: String(head),
    records: results.length,
    verified: results.filter((r) => r.verified).length,
    board,
  }),
);
