import assert from "node:assert/strict";
import test from "node:test";
import { hashJson, hashText } from "../packages/community/common.ts";
import { rewardChain } from "../packages/rewards/chain.ts";
import type {
  RewardAvailableOffers,
  RewardOffer,
} from "../packages/rewards/contracts.ts";
import { publicSongViews } from "../services/community-public.ts";
import { createDanceSongResources } from "../services/dance-song-resources.ts";
import { rewardsCommunityApi } from "../services/rewards-community-api.ts";
import { danceV2ManualRewardSources } from "../services/reward-sources.ts";
import { prepareInstalledDanceOfferProjection } from "../services/web2-installed-dance-song.ts";
import {
  installedDanceOfferForSong,
  readInstalledDanceOffer,
  type InstalledDanceRewards,
} from "../services/web2-installed-dance-rewards.ts";
import { rewardDanceV2ManualFixture } from "./fixtures/reward-dance-v2-manual.ts";
import { word } from "./fixtures/reward-dance-v2.ts";

test("an earlier Directory revision song qualifies against its ordinary Dance offer and V2 verdict", async (t) => {
  // Uses production song projection, Posts evidence and manual-close logic with
  // scripted chain reads and SQLite. The native installer is qualified separately.
  const f = await rewardDanceV2ManualFixture(t);
  const origin = "https://installed-reward.invalid";
  const profile = f.input.profile;
  const source = f.chain.source;
  const context = { origin, communityId: source.domain.communityId };
  const selection: InstalledDanceRewards = {
    attachmentDigest: word(5908),
    installationId: f.input.installationId,
    configurationHash: hashJson(f.configuration),
    profile,
    offerId: f.offer.offerId,
    sourceHash: source.sourceHash,
    source,
  };
  const postId = f.post.postId;
  assert.equal(f.post.configurationRevision, 1);
  assert.equal(f.configuration.configurationRevision, 2);
  const csrf = "selected-operator-csrf";
  function seedSession(accountId: string, wallet: string, token: string) {
    f.db.sqlite
      .prepare("INSERT OR IGNORE INTO community_accounts VALUES(?,?,?)")
      .run(accountId, hashText(accountId), 1);
    f.db.sqlite
      .prepare(
        "INSERT OR IGNORE INTO credential_bindings VALUES(?,?,'moss',6343,?,?)",
      )
      .run(accountId + "_binding", accountId, wallet, 1);
    const binding = f.db.sqlite
      .prepare("SELECT binding_id FROM credential_bindings WHERE account_id=?")
      .get(accountId)!;
    f.db.sqlite
      .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
      .run(
        hashText(token),
        context.communityId,
        origin,
        accountId,
        binding.binding_id!,
        csrf,
        Date.now() + 300000,
      );
    return "__Host-community_session=" + token;
  }

  const op = seedSession(
    "33333333-3333-4333-8333-333333333333",
    profile.operatorWallet,
    "3".repeat(64),
  );
  const learner = seedSession(
    f.principal.accountId,
    f.principal.wallet,
    "4".repeat(64),
  );
  const never = async (): Promise<never> =>
    assert.fail("verification is outside selected rewards");
  const ports = {
    db: f.input.db,
    profile,
    chain: rewardChain(),
    verification: { open: never, subject: never },
    sources: danceV2ManualRewardSources(f.input),
    now: f.now,
    songs: async () => (await publicSongViews(f.input.db, f.configuration, f.input.reads))
      .map(({ manifest }) => ({
        songKey: resources.songKeyForPost(manifest.postId), title: manifest.title, postId: manifest.postId,
      })),
    installedDanceOffer: {
      offerId: selection.offerId,
      sourceHash: selection.sourceHash,
      async assertCurrent() {},
      async prepareAttachedSong(songKey: string) {
        return prepareInstalledDanceOfferProjection({
          db: f.input.db, config: f.configuration, reads: f.input.reads, selection,
          songKey, authorityFences: [], async current() {},
        });
      },
    },
  };
  const resources = createDanceSongResources({ ...f.input, config: f.configuration });
  const attach = "/api/operator/rewards/offers";
  const close = attach + "/" + f.offer.offerId + "/close";
  const discover = "/api/rewards/offers";
  const request = (
    path: string,
    cookie: string,
    body?: unknown,
    token = csrf,
    requestOrigin = origin,
  ) =>
    rewardsCommunityApi(
      new Request(
        origin + path,
        body === undefined
          ? { headers: { cookie } }
          : {
              method: "POST",
              headers: {
                cookie,
                origin: requestOrigin,
                "x-csrf-token": token,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      ports,
      context,
      new Headers(),
    );
  const loadOffers = async () => {
    const response = await request(discover, learner);
    assert.ok(response);
    assert.equal(response.headers.get("cache-control"), "no-store, private");
    return (await response.json()) as RewardAvailableOffers;
  };
  const readOffer = async (response: Response | null) => {
    assert.ok(response);
    return (await response.json()) as RewardOffer;
  };

  assert.deepEqual((await loadOffers()).offers, []);
  await assert.rejects(
    request(attach, learner, f.withoutPins),
    /reward_operator_required/,
  );
  await assert.rejects(
    request(attach, op, f.withoutPins, "wrong-csrf"),
    /csrf_required/,
  );
  await assert.rejects(
    request(attach, op, f.withoutPins, csrf, "https://unrelated.invalid"),
    /wrong_origin/,
  );
  await assert.rejects(
    request(attach, op, {
      ...f.withoutPins,
      resultSources: [source.sourceHash, word(5912)],
    }),
    /reward_manual_offer_changed/,
  );
  assert.equal(await readInstalledDanceOffer(f.store, selection), null);

  const attached = await readOffer(await request(attach, op, f.withoutPins));
  assert.deepEqual(attached.resultSources, [source.sourceHash]);
  const pinned = await f.store.offer(f.offer.offerId);
  assert.equal(pinned.input_hash, hashJson(f.offer));
  assert.deepEqual(
    await readOffer(await request(attach, op, f.withoutPins)),
    attached,
  );
  await assert.rejects(
    request(attach, op, { ...f.withoutPins, cutoffAt: f.offer.cutoffAt + 1 }),
    /reward_offer_conflict/,
  );

  assert.deepEqual((await loadOffers()).offers, [{
    offerId: f.offer.offerId, postId, eligibility: "dance-pass", drawingId: f.offer.drawingId,
    opensAt: f.offer.opensAt, cutoffAt: f.offer.cutoffAt, ticketCount: f.offer.ticketIds.length,
  }]);
  const catalogue = await installedDanceOfferForSong(
    f.input.db,
    selection,
    f.offer.songKey,
    f.offer.opensAt,
  );
  assert.equal(catalogue?.offer.inputHash, pinned.input_hash);
  assert.equal(catalogue?.offer.sourceHash, source.sourceHash);
  const projected = await resources.selected(f.offer.songKey, null, f.offer.offerId);
  assert.deepEqual(projected.song.offer, catalogue?.offer);
  assert.equal((await resources.publication(f.offer.songKey, projected.song)).title, f.post.title);
  assert.equal(
    await installedDanceOfferForSong(
      f.input.db,
      selection,
      f.offer.songKey,
      f.offer.cutoffAt,
    ),
    null,
  );
  assert.equal(
    await installedDanceOfferForSong(
      f.input.db,
      selection,
      word(5913),
      f.offer.opensAt,
    ),
    null,
  );

  const capture = f.retainCapture(pinned.input_hash);
  assert.deepEqual(capture?.offer, projected.song.offer);
  await assert.rejects(request(close, op, {}), /reward_cutoff_not_reached/);
  f.afterCutoff();
  assert.deepEqual((await loadOffers()).offers, []);
  const closed = await readOffer(await request(close, op, {}));
  assert.equal(closed.state, "closed");
  assert.equal(closed.entries?.length, 1);
  assert.equal(closed.entries?.[0]?.accountId, f.principal.accountId);
  assert.equal(closed.entries?.[0]?.wallet, f.principal.wallet);
  assert.match(closed.entries?.[0]?.evidenceHash ?? "", /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await readOffer(await request(close, op, {})), closed);
  await assert.rejects(
    request(attach + "/" + f.offer.offerId + "/settle", op, {}),
    /reward_route_not_found/,
  );
  const saved = await f.store.offer(f.offer.offerId);
  assert.equal(saved.purchase_evidence, pinned.purchase_evidence);
  assert.deepEqual(JSON.parse(saved.entries_json ?? "null"), closed.entries);
  assert.equal(f.db.count("reward_closure_snapshots"), 1);
  const snapshot = f.db.sqlite.prepare("SELECT snapshot_json FROM reward_closure_snapshots WHERE offer_id=?")
    .get(f.offer.offerId);
  assert.equal(JSON.parse(String(snapshot?.snapshot_json)).entriesHash, hashJson(closed.entries));
  assert.equal(f.db.count("reward_credits"), 0);
  assert.equal(f.db.count("reward_payments"), 0);
  assert.equal(f.db.count("reward_payment_attempts"), 0);
});
