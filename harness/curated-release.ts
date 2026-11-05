// Operator-only exact-job adoption. No generic SQL mutation or new wallet flow.
import { readFile, writeFile, open, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  hashJson,
  hashText,
  insist,
  canonical,
  CommunityError,
  object,
} from "../packages/community/common.ts";
import { validateCuratedAmendment } from "../packages/community/curated-amendment.ts";
import { fetchWorkerModuleDigests } from "./worker-modules.ts";
import { readOnlyRemoteDb, curatedDatabases } from "./curated-state.ts";
import {
  curatedReleasePlan,
  curatedReleaseDirectory,
  curatedBase,
  curatedCloudContext,
} from "./curated-release-plan.ts";
import { durableJson, privateJson } from "./private-json.ts";
import { readConfiguration } from "../packages/community/directory-reader.ts";
import { configurationClient } from "./megaeth/configuration-plan.ts";
import { firstSong } from "../services/first-song-profile.ts";

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: {
      execute: { type: "boolean" },
      "write-plan": { type: "boolean" },
      "expected-profile": { type: "string" },
    },
  });
  let planned: Awaited<ReturnType<typeof curatedReleasePlan>>;
  if (values.execute) {
    const saved = JSON.parse(
      await readFile(
        "docs/deployments/first-song-managed-20261105.curated-adoption-plan.json",
        "utf8",
      ),
    );
    insist(
      saved.profileHash === hashJson(saved.profile),
      "curated_adoption_plan_changed",
      409,
    );
    for (const [path, expected] of Object.entries(saved.profile.sourceHashes))
      insist(
        hashText(await readFile(path, "utf8")) === expected,
        "curated_adoption_source_changed",
        409,
      );
    const privatePlan = join(
        curatedReleaseDirectory,
        `amendment-${String(saved.profile.amendmentSha256).slice(2)}.json`,
      ),
      captured = await privateJson(privatePlan);
    insist(
      captured && hashJson(captured) === saved.profile.privatePlanSha256,
      "curated_adoption_authorization_changed",
      409,
    );
    planned = { ...saved, privatePlan, ...captured } as Awaited<
      ReturnType<typeof curatedReleasePlan>
    >;
  } else planned = await curatedReleasePlan();
  const { profile, profileHash, signed, result } = planned;
  if (values["write-plan"])
    await writeFile(
      "docs/deployments/first-song-managed-20261105.curated-adoption-plan.json",
      JSON.stringify({ profileHash, profile }, null, 2) + "\n",
    );
  if (!values.execute) {
    console.log(
      JSON.stringify({
        profileHash,
        amendmentSha256: profile.amendmentSha256,
        stems: profile.stems,
        bounds: profile.bounds,
        execution: "not_started",
      }),
    );
    return;
  }
  insist(
    values["expected-profile"] === profileHash,
    "curated_adoption_not_reviewed",
    409,
  );
  const config = await readConfiguration(configurationClient(), {
    ...firstSong.directoryProfile,
    deploymentBlock: BigInt(firstSong.directoryProfile.deploymentBlock),
  });
  await validateCuratedAmendment(signed, config);
  const { token, accountId } = await curatedCloudContext(),
    appDb = readOnlyRemoteDb(token, accountId, curatedDatabases.application);
  const stems = (
    await appDb
      .prepare(
        "SELECT slot,sha256,byte_length,state FROM media_stems WHERE submission_id=?",
      )
      .bind(signed.amendment.submissionId)
      .all<Record<string, unknown>>()
  ).results;
  insist(
    stems.length === 2 &&
      stems.every((s) => {
        const expected = profile.stems[String(s.slot)];
        return (
          expected &&
          s.state === "sealed" &&
          s.sha256 === expected.sha256 &&
          s.byte_length === expected.byteLength
        );
      }),
    "curated_creator_stems_required",
    409,
  );
  for (const [scope, expected] of [
    ["creator-service", profile.nativeProfileHash],
    ["managed-service", profile.managedProfileHash],
    ["application-service", profile.applicationProfileHash],
  ]) {
    const saved = await privateJson(
      join(curatedBase, scope!, "deployment-result.json"),
    );
    insist(
      saved?.profileHash === expected,
      "curated_runtime_update_unconfirmed",
      409,
    );
  }
  const peers = [
    {
      name: "pirate-wallet-test",
      origin: "https://pirate-wallet-test.piratesocialclub.workers.dev",
      health: "/api/health",
      profile: profile.nativeProfileHash,
      modules: {
        "index.js": profile.nativeBundleSha256,
        "ika.wasm": profile.nativeWasmSha256,
      },
    },
    {
      name: "pirate-creator-spike",
      origin: "https://pirate-creator-spike.piratesocialclub.workers.dev",
      health: "/api/health",
      profile: profile.nativeProfileHash,
      modules: {
        "index.js": profile.nativeBundleSha256,
        "ika.wasm": profile.nativeWasmSha256,
      },
    },
    {
      name: "pirate-managed-firstsong-20261105",
      origin: firstSong.managedOrigin,
      health: "/health",
      profile: profile.managedProfileHash,
      modules: { "worker.mjs": profile.managedBundleSha256 },
    },
    {
      name: "pirate-first-song-20261105",
      origin: firstSong.origin,
      health: "/health",
      profile: profile.applicationProfileHash,
      modules: { "worker.mjs": profile.applicationBundleSha256 },
    },
  ];
  for (const peer of peers) {
    const response = await fetch(peer.origin + peer.health, {
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      }),
      health = object(await response.json()),
      modules = await fetchWorkerModuleDigests(
        token,
        accountId,
        peer.name,
        Object.keys(peer.modules),
      );
    insist(
      response.ok &&
        health.profileHash === peer.profile &&
        Object.keys(modules).length === Object.keys(peer.modules).length &&
        Object.entries(peer.modules).every(
          ([name, hash]) => modules[name] === hash,
        ),
      "curated_live_runtime_changed",
      409,
    );
  }
  const lockPath = join(curatedReleaseDirectory, "adoption.lock"),
    lock = await open(lockPath, "wx", 0o600),
    identity = canonical({ profileHash, pid: process.pid }),
    deadline = Date.now() + profile.bounds.executionSeconds * 1000;
  await lock.writeFile(identity);
  await lock.sync();
  try {
    const executionPath = join(
      curatedReleaseDirectory,
      `execution-${profileHash.slice(2)}-${Date.now()}.json`,
    );
    await durableJson(executionPath, {
      profileHash,
      startedAt: new Date().toISOString(),
      deadlineAt: new Date(deadline).toISOString(),
    });
    // Both operations are controller-signed, durable and idempotent. An unknown
    // response stops this invocation; reconciliation precedes a later replay.
    for (const [name, url, body] of [
      [
        "managed",
        firstSong.managedOrigin + "/v1/curated/adopt",
        { signed, result },
      ],
      ["application", firstSong.origin + "/api/operator/owner-curated", signed],
    ] as const) {
      insist(Date.now() < deadline, "curated_adoption_deadline_reached", 409);
      const response = await fetch(url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: {
            origin: firstSong.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        value = object(await response.json());
      insist(
        response.ok && value.adopted === true,
        "curated_adoption_result_unconfirmed",
        503,
      );
      await durableJson(
        join(curatedReleaseDirectory, `${name}-${profileHash.slice(2)}.json`),
        {
          profileHash,
          amendmentSha256: profile.amendmentSha256,
          adopted: true,
        },
      );
    }
    console.log(
      JSON.stringify({
        profileHash,
        amendmentSha256: profile.amendmentSha256,
        status: "adopted_same_release",
        queue: "captured_bounded_publication",
      }),
    );
  } finally {
    await lock.close();
    insist(
      (await readFile(lockPath, "utf8")) === identity,
      "curated_adoption_lock_changed",
      409,
    );
    await unlink(lockPath);
  }
}
main().catch((e) => {
  console.error(
    e instanceof CommunityError
      ? e.code
      : "curated_adoption_uncertain; reconcile the same signed amendment before retry",
  );
  process.exitCode = 1;
});
