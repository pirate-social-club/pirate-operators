// Reproduce the real legacy master -> owner policy -> missing stems boundary.
// Authentication is actual SIWE/cookie/CSRF; providers/chains are fixture-only.
import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import { verifyLoginOffline } from "../harness/login-verifier.ts";
import { privateKeyToAccount } from "viem/accounts";
import { loginChallenge, loginVerify } from "../packages/community/accounts.ts";
import { CommunityError, hashJson } from "../packages/community/common.ts";
import { requireCuratedOwner } from "../packages/community/curated-amendment.ts";
import { ownedSubmission } from "../packages/community/submissions.ts";
import { loadJob } from "../packages/community/publication-store.ts";
import { originalProviderCalls } from "../packages/moderation/curated-admission.ts";
import { communityReleaseApi } from "../services/community-release-api.ts";
import { curatedSongFixture } from "./fixtures/curated-song.ts";
import { publisher } from "./fixtures/release-admission.ts";

test("an account can attach both private stems before owner adoption without publication readiness or advancing its held job", async () => {
  const f = await curatedSongFixture(),
    context = {
      communityId: f.config.communityId,
      origin: f.config.app.origin,
    };
  try {
    const original = await ownedSubmission(
      f.community.db,
      f.row.submission_id,
      f.session.account_id,
    );
    // The real master was sealed before stem slots existed. Delete only these
    // explicit local-fixture attachments to reconstruct that historical state.
    await f.community.db
      .prepare("DELETE FROM media_stems WHERE submission_id=?")
      .bind(f.row.submission_id)
      .run();
    assert.equal(
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM publication_amendments")
        .first<{ n: number }>())!.n,
      0,
    );
    await f.community.db
      .prepare("INSERT INTO credential_bindings VALUES(?,?,'moss',6343,?,?)")
      .bind(
        "fixture-owner-stem-binding",
        f.session.account_id,
        publisher.address.toLowerCase(),
        Date.now(),
      )
      .run();
    const signIn = async (account: typeof publisher) => {
      const challenge = await loginChallenge(
          f.community.db,
          context,
          account.address,
        ),
        login = await loginVerify(
          f.community.db,
          context,
          challenge.id,
          await account.signMessage({ message: challenge.message }),
          verifyLoginOffline,
        );
      return {
        cookie: login.cookie.split(";")[0]!,
        "x-csrf-token": login.csrf,
        origin: context.origin,
        "content-type": "application/json",
      };
    };
    const auth = await signIn(publisher),
      otherAuth = await signIn(privateKeyToAccount(`0x${"44".repeat(32)}`));
    let wakeups = 0,
      readinessCalls = 0;
    const env = {
      DB: f.community.db,
      MEDIA: f.community.media,
      JOBS: {
        send: async () => {
          wakeups++;
        },
      },
    };
    const unavailable = async () => {
        readinessCalls++;
        throw Error("fixture publication runtime unavailable");
      },
      ready = async () => ({ config: f.config, ports: f.ports });
    const call = async (
      path: string,
      method: string,
      body?: BodyInit,
      headers: Record<string, string> = auth,
      runtime: typeof ready = unavailable,
    ) => {
      try {
        return await communityReleaseApi(
          new Request(context.origin + path, { method, body, headers }),
          env,
          context,
          runtime,
          (body, status = 200) => Response.json(body, { status }),
        );
      } catch (error) {
        if (error instanceof CommunityError)
          return Response.json({ error: error.code }, { status: error.status });
        throw error;
      }
    };
    const base = `/api/uploads/${f.row.submission_id}/stems`,
      metadata = JSON.stringify({
        sha256: sha256(f.managed.audio),
        byteLength: f.managed.audio.length,
      });
    assert.equal(
      (await call(base + "/vocals", "POST", metadata, {
        origin: context.origin,
      }))!.status,
      401,
    );
    assert.equal(
      (await call(base + "/vocals", "POST", metadata, {
        ...auth,
        "x-csrf-token": "wrong",
      }))!.status,
      403,
    );
    assert.equal(
      (await call(base + "/vocals", "POST", metadata, {
        ...auth,
        origin: "https://attacker.example",
      }))!.status,
      403,
    );
    assert.equal(
      (await call(base + "/vocals", "POST", metadata, otherAuth))!.status,
      404,
    );
    for (const slot of ["instrumental", "vocals"]) {
      assert.equal(
        (await call(`${base}/${slot}`, "POST", metadata))!.status,
        201,
      );
      assert.equal(
        (await call(`${base}/${slot}`, "PUT", f.managed.audio, {
          ...auth,
          "content-type": "audio/mpeg",
        }))!.status,
        200,
      );
    }
    assert.equal(readinessCalls, 0);
    const saved = (await (await call(base, "GET"))!.json()) as {
      stems: { state: string }[];
    };
    assert.equal(saved.stems.length, 2);
    assert(saved.stems.every((s) => s.state === "sealed"));
    assert.equal((await call(base, "GET", undefined, otherAuth))!.status, 404);
    assert.equal(
      (await call(
        base + "/vocals",
        "POST",
        JSON.stringify({ sha256: sha256(new Uint8Array([1])), byteLength: 1 }),
      ))!.status,
      409,
    );
    // Attachment cannot install authority, start another release, or wake work.
    await assert.rejects(
      requireCuratedOwner(
        f.community.db,
        f.config,
        publisher.address.toLowerCase(),
      ),
      /curated_owner_scope_unavailable/,
    );
    assert.equal(
      (await call("/api/uploads", "POST", "{}", auth, ready))!.status,
      503,
    );
    assert.equal(
      (await call(
        `/api/uploads/${f.row.submission_id}/seal`,
        "POST",
        "{}",
        auth,
        ready,
      ))!.status,
      503,
    );
    assert.equal(wakeups, 0);
    assert.deepEqual(
      await loadJob(f.community.db, f.sealed.jobId),
      f.originalJob,
    );
    assert.deepEqual(
      await ownedSubmission(
        f.community.db,
        f.row.submission_id,
        f.session.account_id,
      ),
      original,
    );
    const operation = await f.community.db
      .prepare("SELECT * FROM external_operations WHERE operation_id=?")
      .bind(f.originalOperation.operation_id)
      .first();
    assert.equal(hashJson(operation), hashJson(f.originalOperation));
    assert.equal(
      hashJson(await originalProviderCalls(f.managed.db, f.originalId)),
      hashJson(f.originalCalls),
    );
    assert.equal(
      (await f.community.db
        .prepare("SELECT COUNT(*) AS n FROM publication_amendments")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await f.managed.db
        .prepare("SELECT COUNT(*) AS n FROM funded_pins")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.equal(
      (await f.managed.db
        .prepare("SELECT COUNT(*) AS n FROM funded_registrations")
        .first<{ n: number }>())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});
