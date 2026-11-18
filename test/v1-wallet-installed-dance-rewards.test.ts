import assert from "node:assert/strict";
import test from "node:test";
import {
  CommunityError,
  hashJson,
  hashText,
} from "../packages/community/common.ts";
import { mediaSubmissionReceipt } from "../packages/community-media/submission.ts";
import { PRIVATE_RETENTION_MS } from "../packages/community-media/validation.ts";
import { RewardClaims } from "../packages/rewards/claims.ts";
import { RewardOffers } from "../packages/rewards/offers.ts";
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
import { accountB, word } from "./fixtures/reward-dance-v2.ts";

test("an earlier Directory revision Dance verdict survives video expiry, close, settlement and unpaid claim", async (t) => {
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
    assert.fail("external verification or payment chain is outside this test");
  const ports = {
    db: f.input.db,
    profile,
    chain: {
      guard: never,
      balance: never,
      position: never,
      confirmedPosition: never,
      transfer: never,
      incoming: never,
      outgoing: never,
    },
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

  const sourceVideo = "synthetic private Dance source";
  const accepted = {
    id: "11111111-1111-4111-8111-111111111120",
    recordingSha256: hashText(sourceVideo),
    revision: 4,
  };
  const capture = f.retainCapture(pinned.input_hash, undefined, accepted);
  assert.ok(capture);
  assert.deepEqual(capture.offer, projected.song.offer);
  const canonical = f.chain.events.at(-1)!;
  assert.equal(canonical.capture.captureId, capture.captureId);
  assert.equal(canonical.verdict.withinFrozenOfferWindow, true);
  const media = f.seedAcceptedMedia(capture, accepted, sourceVideo);
  const receipt = await mediaSubmissionReceipt(
    media.repository,
    capture.captureId,
  );
  const deadline = receipt.trustedSubmittedAtMs + PRIVATE_RETENTION_MS;
  assert.equal(receipt.reviewDeadlineMs, deadline);
  assert.equal(canonical.submission.reviewDeadlineMs, BigInt(deadline));
  assert.equal(canonical.submission.mediaExpiresAtMs, BigInt(deadline));
  assert.equal(
    receipt.bindingCommitment,
    canonical.submission.mediaBindingHash,
  );

  const proof = () =>
    f.db.sqlite
      .prepare(
        `SELECT c.capture_json, k.consent_json,
    b.value_json AS binding, j.typed_json AS command, o.value_json AS observation
    FROM dance_captures c JOIN dance_consents k ON k.capture_id=c.capture_id
    JOIN dance_publication_bindings b ON b.capture_id=c.capture_id
    JOIN publication_v1_commands j ON j.command_id=b.command_id
    JOIN publication_v1_observations o ON o.command_id=j.command_id
      AND o.proof_hash=json_extract(b.value_json,'$.receiptSha256')
    WHERE c.capture_id=?`,
      )
      .get(capture.captureId);
  const originalProof = proof();
  assert.ok(originalProof);
  await assert.rejects(request(close, op, {}), /reward_cutoff_not_reached/);

  f.afterCutoff(deadline - 1);
  assert.equal((await media.head())?.status, 200);
  await media.service.recover();
  assert.equal((await media.repository.get(accepted.id)).state, "ready");
  assert.equal(media.objects.size, 2);

  f.afterCutoff(deadline);
  assert.equal((await media.head())?.status, 410);
  await media.service.recover();
  const tombstone = await media.repository.get(accepted.id);
  assert.equal(tombstone.state, "expired");
  assert.equal(tombstone.expiresAt, deadline);
  assert.equal(tombstone.erasePending, false);
  assert.equal(tombstone.sourceKey, undefined);
  assert.equal(tombstone.renditionKey, undefined);
  assert.equal(media.objects.size, 0);
  assert.equal((await media.head())?.status, 410);
  assert.deepEqual(
    await mediaSubmissionReceipt(media.repository, capture.captureId),
    receipt,
  );
  assert.deepEqual(proof(), originalProof);

  f.afterCutoff(deadline + 1);
  assert.deepEqual((await loadOffers()).offers, []);
  const closed = await readOffer(await request(close, op, {}));
  assert.equal(closed.state, "closed");
  assert.equal(closed.entries?.length, 1);
  assert.equal(closed.entries?.[0]?.accountId, f.principal.accountId);
  assert.equal(closed.entries?.[0]?.wallet, f.principal.wallet);
  assert.equal(
    closed.entries?.[0]?.completedAt,
    Number(canonical.verdict.committedAtSeconds * 1000n),
  );
  assert.deepEqual(proof(), originalProof);
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
  const snapshot = f.db.sqlite.prepare("SELECT snapshot_json,snapshot_hash FROM reward_closure_snapshots WHERE offer_id=?")
    .get(f.offer.offerId);
  assert.equal(JSON.parse(String(snapshot?.snapshot_json)).entriesHash, hashJson(closed.entries));
  assert.equal(f.db.count("reward_credits"), 0);
  assert.equal(f.db.count("reward_payments"), 0);
  assert.equal(f.db.count("reward_payment_attempts"), 0);
  // The selected HTTP mount remains close-only. Exercise the already
  // established manual settlement service on the same disposable ledger.
  const offers = new RewardOffers(f.store, ports.sources, f.now);
  const settled = await offers.settle(f.offer.offerId);
  assert.equal(settled.state, "settled");
  assert.equal(settled.evidenceMode, "simulated");
  assert.deepEqual(settled.entries, closed.entries);
  assert.equal(settled.payoutAtomic, "30000000000000000");
  assert.deepEqual(await offers.settle(f.offer.offerId), settled);
  assert.deepEqual(proof(), originalProof);
  const [credit] = await f.store.credits(f.principal.accountId);
  assert.ok(credit);
  assert.equal(credit.offer_id, f.offer.offerId);
  assert.equal(credit.amount_atomic, "30000000000000000");
  assert.equal(credit.paid_atomic, "0");
  assert.equal(credit.payment_id, null);
  assert.equal(credit.claim_state, "unclaimed");

  // Fixture-only original verified binding. Neither claim call opens Very
  // or prepares a payment, and the accepted credit still has its owner.
  f.db.sqlite
    .prepare(
      "INSERT INTO reward_subjects(program_id,account_id,wallet,subject_hash,verified_at) VALUES(?,?,?,?,?)",
    )
    .run(
      f.store.program,
      f.principal.accountId,
      f.principal.wallet,
      word(5914),
      f.now(),
    );
  const claims = new RewardClaims(f.store, ports.verification, f.now);
  await assert.rejects(
    claims.claim({ ...f.principal, accountId: accountB }, credit.credit_id),
    /reward_credit_not_found/,
  );
  const acceptedClaim = await claims.claim(f.principal, credit.credit_id);
  assert.equal(acceptedClaim.outcome, "accepted");

  f.afterCutoff(deadline + PRIVATE_RETENTION_MS);
  await media.service.recover();
  assert.deepEqual(
    await claims.claim(f.principal, credit.credit_id),
    acceptedClaim,
  );
  const [unpaid] = await f.store.credits(f.principal.accountId);
  assert.ok(unpaid);
  assert.equal(unpaid.credit_id, credit.credit_id);
  assert.equal(unpaid.offer_id, credit.offer_id);
  assert.equal(unpaid.claim_state, "accepted");
  assert.equal(unpaid.paid_atomic, "0");
  assert.equal(unpaid.payment_id, null);
  assert.deepEqual(proof(), originalProof);
  assert.deepEqual(
    await mediaSubmissionReceipt(media.repository, capture.captureId),
    receipt,
  );
  assert.equal(media.objects.size, 0);
  assert.equal(f.db.count("reward_credits"), 1);
  assert.equal(f.db.count("reward_subjects"), 1);
  assert.equal(f.db.count("reward_funding"), 0);
  assert.equal(f.db.count("reward_verification_intents"), 0);
  assert.equal(f.db.count("reward_payments"), 0);
  assert.equal(f.db.count("reward_payment_attempts"), 0);

  t.diagnostic(
    JSON.stringify({
      schema: "pirate.synthetic-dance-qualification-receipt/1",
      publishedRevision: f.post.configurationRevision,
      activeRevision: f.configuration.configurationRevision,
      offerId: closed.offerId,
      inputHash: saved.input_hash,
      qualifier: closed.entries?.[0],
      closureSnapshotHash: snapshot?.snapshot_hash,
      expiredBeforeClose: true,
      settledWithUnpaidAcceptedCredit: true,
      newPayments: 0,
    }),
  );
});

test("an active V2 verdict without its retained capture refuses whole-offer close", async (t) => {
  const f = await rewardDanceV2ManualFixture(t);
  const offers = new RewardOffers(
    f.store,
    danceV2ManualRewardSources(f.input),
    f.now,
  );
  const attached = await offers.attach(f.withoutPins);
  const original = await f.store.offer(attached.offerId);
  f.retainCapture(original.input_hash, "missing-capture");
  f.afterCutoff();
  await assert.rejects(
    offers.close(attached.offerId, {
      offerId: attached.offerId,
      inputHash: original.input_hash,
      sourceHash: f.chain.source.sourceHash,
    }),
    (error: unknown) =>
      error instanceof CommunityError &&
      error.status === 503 &&
      error.code === "dance_v2_retained_capture_unverified",
  );
  assert.deepEqual(await f.store.offer(attached.offerId), original);
  assert.equal(f.db.count("reward_closure_snapshots"), 0);
  assert.equal(f.db.count("reward_credits"), 0);
  assert.equal(f.db.count("reward_payments"), 0);
});
