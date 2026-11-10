// Manual public-only V2/V3 capture or offline replay. No wallet, speech provider,
// private application API or chain write.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPublicClient, http, sha256, toHex } from "viem";
import { captureReference } from "./reference-results/capture.ts";
import { referenceResults } from "./reference-results/reduce.ts";
import { referenceProfile } from "./reference-results/profile.ts";
import type { ReferenceSnapshot } from "./reference-results/facts.ts";
const json = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? String(v) : v), 2) +
  "\n";
export async function referenceResultsMain(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      read: { type: "boolean" },
      profile: { type: "string" },
      snapshot: { type: "string" },
      head: { type: "string" },
      "evaluate-at": { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.read && !values.snapshot)
    return {
      usage:
        "--read --profile <public-profile.json> captures MegaETH6343 logs/IPFS; --snapshot <raw.json> replays offline. Optional --head, --evaluate-at (Unix seconds), --output (new directory). No key or write mode.",
    };
  if ((values.read && values.snapshot) || (values.snapshot && values.profile))
    throw Error("choose_public_capture_or_offline_snapshot");
  let snapshot: ReferenceSnapshot;
  if (values.snapshot) {
    snapshot = JSON.parse(await readFile(values.snapshot, "utf8"));
    referenceProfile(snapshot.profile);
  } else {
    if (!values.profile) throw Error("reference_public_profile_required");
    const profile = referenceProfile(
      JSON.parse(await readFile(values.profile, "utf8")),
    );
    if (profile.chainId !== 6343)
      throw Error("reference_live_chain_must_be_6343");
    const client = createPublicClient({
      transport: http("https://carrot.megaeth.com/rpc", {
        retryCount: 0,
        timeout: 30000,
        fetchOptions: { redirect: "error" },
      }),
    });
    snapshot = await captureReference(
      client,
      profile,
      values.head ? BigInt(values.head) : undefined,
      values["evaluate-at"] ? Number(values["evaluate-at"]) : undefined,
    );
  }
  const result = referenceResults(snapshot),
    raw = json(snapshot),
    reduced = json(result);
  if (values.output) {
    // Never overwrite a previous evidence package.
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
  return {
    head: snapshot.head,
    evaluationTimestamp: snapshot.evaluationTimestamp,
    rawSha256: sha256(toHex(raw)),
    referenceSha256: sha256(toHex(reduced)),
    publications: result.records.length,
    verified: result.records.filter((record) => record.verified).length,
    problems: result.records.flatMap((record) => record.problems),
    unavailableDocuments: snapshot.unavailable,
    rows: result.rows,
    days: result.days,
    scores: result.scores,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  referenceResultsMain()
    .then((result) => console.log(json(result)))
    .catch((error) => {
      console.error(
        error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message)
          ? error.message
          : "reference_capture_failed",
      );
      process.exitCode = 1;
    });
