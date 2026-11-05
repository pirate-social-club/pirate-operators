import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { communityRuntime } from "./community-runtime.ts";
import type { AccountSession } from "../packages/community/accounts.ts";
import { hashText, publicId } from "../packages/community/common.ts";
import {
  reserveSubmission,
  sealSubmission,
  ownedSubmission,
  type SubmissionProfile,
} from "../packages/community/submissions.ts";
import { uploadAudio } from "../packages/community/uploads.ts";

const profile: SubmissionProfile = {
  chainId: 6343,
  communityId: publicId(),
  postsContract: "0x1111111111111111111111111111111111111111",
  configurationRevision: 1,
  publisher: "0x2222222222222222222222222222222222222222",
  moderationSigner: "0x3333333333333333333333333333333333333333",
};
const audio = new TextEncoder().encode(
  "fixture MP3 bytes; no real media/moderation claim",
);
const input = {
  title: "Upload fixture",
  lyrics: "Chorus\nVerse\nChorus",
  language: "en",
  original: true,
  acceptedPolicy: "pirate-release/2026-08-29",
  audioSha256: sha256(audio),
  audioBytes: audio.length,
};
const request = (bytes = audio) =>
  new Request("https://community.example/api/uploads/fixture", {
    method: "PUT",
    headers: { "content-type": "audio/mpeg" },
    body: bytes,
  });
async function fixture() {
  const f = await communityRuntime(),
    authorId = publicId();
  const session: AccountSession = {
    session_hash: hashText("fixture-session"),
    account_id: "private-account",
    author_id: authorId,
    binding_id: "fixture-moss-binding",
    wallet: "0x4444444444444444444444444444444444444444",
    csrf_token: "fixture-csrf",
    expires_at: 999999,
  };
  await f.db.batch([
    f.db
      .prepare("INSERT INTO community_accounts VALUES(?,?,0)")
      .bind(session.account_id, authorId),
    f.db
      .prepare(
        `INSERT INTO creator_bindings VALUES(?,'https://wallet.example','fixture-credential','fixture-sui','fixture-dwallet','fixture-cap','fixture-share',?,'{}',1000)`,
      )
      .bind(session.account_id, "0x5555555555555555555555555555555555555555"),
  ]);
  return {
    ...f,
    session,
    reserve: (key = "fixture-idempotency-key-1") =>
      reserveSubmission(f.db, session, profile, input, key, 1000),
  };
}

test("concurrent reservations retain one post, creator authority and repeated-chorus identities", async () => {
  const f = await fixture();
  try {
    const rows = await Promise.all([f.reserve(), f.reserve(), f.reserve()]);
    assert.equal(new Set(rows.map((r) => r.submission_id)).size, 1);
    assert.equal(new Set(rows.map((r) => r.metadata_json)).size, 1);
    const lyrics = JSON.parse(rows[0]!.metadata_json).lyrics;
    assert.notEqual(lyrics.lines[0].lineId, lyrics.lines[2].lineId);
    await f.db
      .prepare(
        "UPDATE creator_bindings SET evm_address='changed',verified_at=0",
      )
      .run();
    const reopened = await reserveSubmission(
      f.db,
      { ...f.session, wallet: "0x6666666666666666666666666666666666666666" },
      profile,
      input,
      "fixture-idempotency-key-1",
      900000,
    );
    assert.equal(reopened.captured_wallet, f.session.wallet);
    assert.equal(
      JSON.parse(reopened.creator_json).evm_address,
      "0x5555555555555555555555555555555555555555",
    );
    await assert.rejects(
      reserveSubmission(
        f.db,
        f.session,
        profile,
        { ...input, title: "Changed" },
        "fixture-idempotency-key-1",
        1000,
      ),
      /idempotency_key_conflict/,
    );
    await assert.rejects(
      ownedSubmission(f.db, reopened.submission_id, "other-account"),
      /submission_not_found/,
    );
  } finally {
    await f.dispose();
  }
});

test("R2 checksum-validated upload seals once and retries never allocate another publication", async () => {
  const f = await fixture();
  try {
    const row = await f.reserve();
    await assert.rejects(
      sealSubmission(
        f.db,
        f.media,
        f.session,
        profile,
        row.submission_id,
        1001,
      ),
      /upload_not_complete/,
    );
    await uploadAudio(
      f.db,
      f.media,
      f.session.account_id,
      row.submission_id,
      request(),
      1001,
    );
    const [a, b] = await Promise.all([
      sealSubmission(
        f.db,
        f.media,
        f.session,
        profile,
        row.submission_id,
        1002,
      ),
      sealSubmission(
        f.db,
        f.media,
        f.session,
        profile,
        row.submission_id,
        1002,
      ),
    ]);
    assert.deepEqual(a, b);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM publication_jobs")
        .first<{ n: number }>())!.n,
      1,
    );
    // Even a changed-body retry cannot overwrite an already sealed object.
    await uploadAudio(
      f.db,
      f.media,
      f.session.account_id,
      row.submission_id,
      request(new Uint8Array(audio.length)),
      1003,
    );
    const sealed = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    assert.deepEqual(
      new Uint8Array(
        await (await f.media.get(sealed.object_key))!.arrayBuffer(),
      ),
      audio,
    );
    await assert.rejects(
      sealSubmission(
        f.db,
        f.media,
        f.session,
        { ...profile, configurationRevision: 2 },
        row.submission_id,
        1004,
      ),
      /submission_profile_changed/,
    );
  } finally {
    await f.dispose();
  }
});

test("wrong bytes, truncated bodies and cross-account uploads cannot be sealed", async () => {
  const f = await fixture();
  try {
    const row = await f.reserve();
    await assert.rejects(
      uploadAudio(
        f.db,
        f.media,
        "other-account",
        row.submission_id,
        request(),
        1001,
      ),
      /submission_not_found/,
    );
    await assert.rejects(
      uploadAudio(
        f.db,
        f.media,
        f.session.account_id,
        row.submission_id,
        request(audio.slice(1)),
        1001,
      ),
      /audio_length_mismatch/,
    );
    await assert.rejects(
      uploadAudio(
        f.db,
        f.media,
        f.session.account_id,
        row.submission_id,
        request(new Uint8Array(audio.length)),
        181002,
      ),
    );
    await assert.rejects(
      sealSubmission(
        f.db,
        f.media,
        f.session,
        profile,
        row.submission_id,
        181003,
      ),
      /upload_not_complete/,
    );
    await uploadAudio(
      f.db,
      f.media,
      f.session.account_id,
      row.submission_id,
      request(),
      362003,
    );
    await sealSubmission(
      f.db,
      f.media,
      f.session,
      profile,
      row.submission_id,
      362004,
    );
  } finally {
    await f.dispose();
  }
});

test("a lost R2 response is reconciled from the original object without uploading again", async () => {
  const f = await fixture();
  try {
    const row = await f.reserve(),
      originalPut = f.media.put.bind(f.media);
    const losingResponse = new Proxy(f.media, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<typeof originalPut>) => {
            await originalPut(...args);
            throw new Error("fixture response lost");
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      uploadAudio(
        f.db,
        losingResponse,
        f.session.account_id,
        row.submission_id,
        request(),
        1001,
      ),
      /fixture response lost/,
    );
    const before = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    assert.equal(before.upload_state, "uploading");
    await uploadAudio(
      f.db,
      f.media,
      f.session.account_id,
      row.submission_id,
      request(new Uint8Array()),
      1002,
    );
    const after = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    assert.equal(after.object_key, before.object_key);
    assert.equal(after.upload_state, "uploaded");
    await sealSubmission(
      f.db,
      f.media,
      f.session,
      profile,
      row.submission_id,
      1003,
    );
  } finally {
    await f.dispose();
  }
});

test("activation freshness and an atomic unfinished-upload cap gate new reservations", async () => {
  const f = await fixture();
  try {
    const rows = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        f.reserve(`fixture-idempotency-key-${i}`),
      ),
    );
    assert.equal(rows.filter((r) => r.status === "fulfilled").length, 5);
    await f.db.prepare("UPDATE creator_bindings SET verified_at=0").run();
    await assert.rejects(
      reserveSubmission(
        f.db,
        f.session,
        profile,
        input,
        "fixture-idempotency-new",
        400000,
      ),
      /creator_activation_verification_required/,
    );
  } finally {
    await f.dispose();
  }
});

test("a delayed live R2 writer cannot replace the successor's sealed object", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    const row = await f.reserve(),
      put = f.media.put.bind(f.media);
    const delayed = new Proxy(f.media, {
      get(target, key) {
        if (key === "put")
          return async (...args: Parameters<typeof put>) => {
            entered();
            await waiting;
            return put(...args);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = uploadAudio(
      f.db,
      delayed,
      f.session.account_id,
      row.submission_id,
      request(),
      1001,
    );
    const firstOutcome = assert.rejects(first, /upload_lease_lost/);
    await firstEntered;
    const stale = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    await uploadAudio(
      f.db,
      f.media,
      f.session.account_id,
      row.submission_id,
      request(),
      181002,
    );
    await sealSubmission(
      f.db,
      f.media,
      f.session,
      profile,
      row.submission_id,
      181003,
    );
    const sealed = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    assert.notEqual(stale.object_key, sealed.object_key);
    release();
    await firstOutcome;
    const final = await ownedSubmission(
      f.db,
      row.submission_id,
      f.session.account_id,
    );
    assert.equal(final.object_key, sealed.object_key);
    assert.equal(final.upload_state, "sealed");
    assert.deepEqual(
      new Uint8Array(
        await (await f.media.get(final.object_key))!.arrayBuffer(),
      ),
      audio,
    );
  } finally {
    release();
    await f.dispose();
  }
});
