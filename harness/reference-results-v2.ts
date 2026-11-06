// Manual public-only reference program. No keys, provider, application API or chain writes.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createPublicClient, http, sha256, toHex } from "viem";
import { firstSong } from "../services/first-song-profile.ts";
import { captureReference } from "./reference-results/capture.ts";
import { referenceResults } from "./reference-results/reduce.ts";
import type {
  ReferenceProfile,
  ReferenceSnapshot,
} from "./reference-results/facts.ts";

const { values } = parseArgs({
  options: {
    read: { type: "boolean" },
    snapshot: { type: "string" },
    head: { type: "string" },
    "evaluate-at": { type: "string" },
    output: { type: "string" },
  },
});
if (!values.read && !values.snapshot) {
  console.log(
    "--read captures MegaETH testnet public logs/IPFS; --snapshot replays raw evidence offline. Optional --head, --evaluate-at (Unix seconds), --output (new directory).",
  );
  process.exit(0);
}
if (values.read && values.snapshot)
  throw Error("choose_capture_or_offline_snapshot");
let snapshot: ReferenceSnapshot;
if (values.snapshot)
  snapshot = JSON.parse(await readFile(values.snapshot, "utf8"));
else {
  const deployed = JSON.parse(
    await readFile(
      "docs/deployments/learning-results-testnet-20261106.contract.json",
      "utf8",
    ),
  );
  const profile: ReferenceProfile = {
    chainId: 6343,
    communityId: firstSong.directoryProfile.communityId,
    registry: firstSong.directoryProfile.registry,
    directory: {
      address: firstSong.directoryProfile.directory,
      fromBlock: firstSong.directoryProfile.deploymentBlock,
      codeHash: firstSong.directoryProfile.directoryCodeHash,
    },
    posts: {
      address: firstSong.posts.address,
      fromBlock: firstSong.posts.deploymentBlock,
      codeHash: firstSong.posts.runtimeCodeHash,
    },
    results: [
      {
        address: deployed.learningResults,
        fromBlock: deployed.transactions.deploy.block,
        codeHash: deployed.codeHash,
      },
    ],
  };
  const client = createPublicClient({
    transport: http("https://carrot.megaeth.com/rpc", {
      retryCount: 0,
      timeout: 30000,
    }),
  });
  snapshot = await captureReference(
    client,
    profile,
    values.head ? BigInt(values.head) : undefined,
    values["evaluate-at"] ? Number(values["evaluate-at"]) : undefined,
  );
}
const result = referenceResults(snapshot);
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? String(v) : v),
    2,
  ) + "\n";
const raw = json(snapshot),
  reduced = json(result);
if (values.output) {
  // Never replace a previous evidence capture.
  await mkdir(values.output, { recursive: false });
  await writeFile(values.output + "/raw.json", raw, { flag: "wx" });
  await writeFile(values.output + "/reference.json", reduced, { flag: "wx" });
  await writeFile(
    values.output + "/sha256.json",
    json({
      "raw.json": sha256(toHex(raw)),
      "reference.json": sha256(toHex(reduced)),
    }),
    { flag: "wx" },
  );
}
console.log(
  json({
    head: snapshot.head,
    evaluationTimestamp: snapshot.evaluationTimestamp,
    rawSha256: sha256(toHex(raw)),
    referenceSha256: sha256(toHex(reduced)),
    publications: result.records.length,
    verified: result.records.filter((x) => x.verified).length,
    problems: result.records.flatMap((x) => x.problems),
    unavailableDocuments: snapshot.unavailable,
    rows: result.rows,
    days: result.days,
    scores: result.scores,
  }),
);
