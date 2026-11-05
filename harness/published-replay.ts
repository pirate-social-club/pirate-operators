// Bounded same-amendment replay after publication; dry verification by default.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  hashJson,
  insist,
  object,
  CommunityError,
} from "../packages/community/common.ts";
import { curatedBase, curatedCloudContext } from "./curated-release-plan.ts";
import { qualifyRetainedState, publishedStateHash } from "./published-state.ts";
import { privateJson, durableJson } from "./private-json.ts";
import { firstSong } from "../services/first-song-profile.ts";
import { storyReadClient } from "../packages/community/registration-chain.ts";
import { configurationClient } from "./megaeth/configuration-plan.ts";

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
      options: {
        "replay-amendment": { type: "boolean" },
        "expected-state": { type: "string" },
      },
    }),
    prefix = "docs/deployments/first-song-managed-20261105.",
    state = JSON.parse(await readFile(prefix + "published-state.json", "utf8")),
    { token, accountId } = await curatedCloudContext(),
    nonces = async () => {
      const story = storyReadClient(),
        mega = configurationClient(),
        operator = "0xbf85a150114d3df8b90a7793c0ea4b2f4bb8c319",
        publisher = "0x14b90a55657d9695a727254eaec5e0e32d20d602";
      const [rootLatest, rootPending, postLatest, postPending] =
        await Promise.all([
          story.getTransactionCount({ address: operator, blockTag: "latest" }),
          story.getTransactionCount({ address: operator, blockTag: "pending" }),
          mega.getTransactionCount({ address: publisher, blockTag: "latest" }),
          mega.getTransactionCount({ address: publisher, blockTag: "pending" }),
        ]);
      insist(
        rootLatest === 1 &&
          rootPending === 1 &&
          postLatest === 178 &&
          postPending === 178,
        "published_nonce_changed",
        409,
      );
      return { rootLatest, rootPending, postLatest, postPending };
    },
    qualify = async () => {
      const summaries = {};
      for (const side of ["application", "managed"] as const)
        Object.assign(summaries, {
          [side]: await qualifyRetainedState(token, accountId, state, side),
        });
      const response = await fetch(firstSong.origin + "/api/feed", {
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        }),
        feed = object(await response.json());
      insist(
        response.ok &&
          Array.isArray(feed.posts) &&
          feed.posts.length === 1 &&
          object(object(feed.posts[0]).manifest).postId ===
            "0x2ce682013277b160a830fad5fa70734f19831edebce908ea3f8457867355b31e",
        "published_feed_changed",
        409,
      );
      return {
        summaries,
        nonces: await nonces(),
        postCount: feed.posts.length,
      };
    };
  for (const [name, origin] of [
    ["application", firstSong.origin],
    ["moderation", firstSong.managedOrigin],
  ]) {
    const plan = JSON.parse(
        await readFile(prefix + name + "-plan.json", "utf8"),
      ),
      response = await fetch(origin + "/health", {
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      }),
      health = object(await response.json());
    insist(
      response.ok &&
        hashJson(plan.profile) === plan.profileHash &&
        health.profileHash === plan.profileHash,
      "published_runtime_changed",
      409,
    );
  }
  const before = await qualify();
  if (!values["replay-amendment"]) {
    console.log(
      JSON.stringify({
        status: "verified_without_replay",
        stateSha256: publishedStateHash,
        nonces: before.nonces,
      }),
    );
    return;
  }
  insist(
    values["expected-state"] === publishedStateHash,
    "published_replay_not_reviewed",
    409,
  );
  const captured = await privateJson(
    join(
      curatedBase,
      "curated-release/amendment-c04d7bd306fa6a66da509ca4538a56237641ec347da88d65e09ab5998b679765.json",
    ),
  );
  insist(
    captured &&
      hashJson(captured) ===
        "0xd7b5606dc224e5c71e3dca9c1e3a1409d3dd8dce2ef5fc36ea4c3ad5dfac2d36",
    "published_amendment_changed",
    409,
  );
  const deadline = Date.now() + 90000;
  for (const [origin, path, body] of [
    [firstSong.managedOrigin, "/v1/curated/adopt", captured],
    [firstSong.origin, "/api/operator/owner-curated", captured.signed],
  ] as const) {
    insist(Date.now() < deadline, "published_replay_deadline", 409);
    const response = await fetch(origin + path, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
        headers: {
          origin: firstSong.origin,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      result = object(await response.json());
    insist(
      response.ok && result.adopted === true,
      "published_replay_result_unconfirmed",
      503,
    );
  }
  const after = await qualify();
  insist(
    hashJson(before) === hashJson(after),
    "published_replay_changed_journals_or_nonces",
    409,
  );
  const evidence = {
    schema: "pirate.published-replay/1",
    observedAt: new Date().toISOString(),
    stateSha256: publishedStateHash,
    amendmentSha256: hashJson(captured.signed),
    before,
    after,
    postCount: 1,
    additionalPins: 0,
    additionalRegistrations: 0,
    additionalPosts: 0,
  };
  await durableJson(
    join(curatedBase, "acceptance/published-replay.json"),
    evidence,
  );
  console.log(JSON.stringify(evidence));
}
main().catch((e) => {
  console.error(
    e instanceof CommunityError
      ? e.code
      : "published_replay_unconfirmed; inspect unchanged signed amendment and journals before replay",
  );
  process.exitCode = 1;
});
