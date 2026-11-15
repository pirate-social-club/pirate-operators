import test from "node:test";
import assert from "node:assert/strict";
import { hashJson, hashText } from "../packages/community/common.ts";
import { verifyCatalogStatus } from "../packages/recognition/status-receipt.ts";
import { staleSessionReplica } from "./shared-recognition-replication-fixture.ts";
import {
  communityA,
  communityB,
  namespace,
  origin,
  profileSha256,
  publication,
  publisherA,
  recognitionFixture,
  recognitionSigner,
} from "./shared-recognition-fixture.ts";

/** Real signed service/client and D1; provider and publication authority remain simulated. */
test("community client verifies separate recognition trust and exact request/publication before ready", async () => {
  const f = await recognitionFixture();
  try {
    const journal: {
      action: string;
      requestSha256: string;
      requestJson: string;
    }[] = [];
    const client = f.client(communityA, {
      beforeSend: async (request) => {
        journal.push(request);
      },
    });
    const p = publication(),
      enrolled = await client.enroll(p);
    assert.equal(enrolled.payload.state, "pending");
    await assert.rejects(client.ready(p), /recognition_catalog_pending/);
    await f.run(enrolled.payload.recordingId);
    await f.run(enrolled.payload.recordingId);
    const ready = await client.ready(p, enrolled.payload.recordingId);
    assert.equal(ready.payload.state, "ready");
    assert.equal(ready.payload.publicationSha256, hashJson(p));
    assert.equal(ready.payload.profileSha256, profileSha256);
    assert.equal(ready.payload.requestSha256, journal.at(-1)!.requestSha256);
    assert.equal(
      journal.at(-1)!.requestSha256,
      hashJson(JSON.parse(journal.at(-1)!.requestJson)),
    );
    assert.equal(ready.payload.expiresAt - ready.payload.issuedAt, 60);
    const second = await f.client(communityB).enroll(publication(communityB));
    assert.equal(second.payload.state, "ready");
    assert.equal(second.payload.recordingId, ready.payload.recordingId);
    assert.notEqual(second.payload.associationId, ready.payload.associationId);
    assert.equal(second.payload.communityId, communityB);
    assert.deepEqual(f.counts(), { uploads: 1, deletes: 0, identify: 1 });
  } finally {
    await f.dispose();
  }
});

test("a publisher key cannot substitute for the independently pinned recognition signer", async () => {
  const f = await recognitionFixture();
  try {
    await f.enroll();
    const client = f.client(communityA, {
      connection: {
        namespace,
        origin,
        profileSha256,
        signer: publisherA.address.toLowerCase(),
      },
    });
    await assert.rejects(
      client.status(publication()),
      /recognition_status_signature_invalid/,
    );
  } finally {
    await f.dispose();
  }
});

test("an unsigned ready flag cannot replace a signed pending state", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication();
    await f.enroll(p);
    const client = f.client(communityA, {
      transport: async (request) => {
        const response = await f.fetch(request),
          body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, state: "ready" });
      },
    });
    await assert.rejects(
      client.ready(p),
      /recognition_status_envelope_mismatch/,
    );
    assert.equal(f.counts().uploads, 0);
  } finally {
    await f.dispose();
  }
});

test("a request for another service profile is refused before enrollment or queue delivery", async () => {
  const f = await recognitionFixture();
  try {
    const authority = f.authorities.get(communityA)!;
    // Simulate a client/community pairing rotated ahead of this service.
    authority.profileSha256 = hashText("other-recognition-profile");
    const client = f.client(communityA, {
      connection: {
        namespace,
        origin,
        profileSha256: authority.profileSha256,
        signer: recognitionSigner.address.toLowerCase(),
      },
    });
    await assert.rejects(
      client.enroll(publication()),
      /recognition_catalog_request_failed/,
    );
    assert.equal(f.wakes.length, 0);
    assert.equal(
      (await f.db
        .prepare("SELECT count(*) AS n FROM shared_recognition_publications")
        .first<{ n: number }>())!.n,
      0,
    );
    assert.deepEqual(f.counts(), { uploads: 0, deletes: 0, identify: 0 });
  } finally {
    await f.dispose();
  }
});

test("an old ready response cannot answer a new nonce after withdrawal", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      enrolled = await f.client().enroll(p);
    await f.run(enrolled.payload.recordingId);
    await f.run(enrolled.payload.recordingId);
    let saved: string | undefined;
    const capture = f.client(communityA, {
      transport: async (request) => {
        const response = await f.fetch(request);
        saved = await response.clone().text();
        return response;
      },
    });
    await capture.ready(p);
    await f.withdraw(p);
    const replay = f.client(communityA, {
      transport: async () =>
        new Response(saved!, {
          headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(replay.ready(p), /recognition_status_scope_mismatch/);
    assert.equal((await f.client().status(p)).payload.state, "withdrawn");
    assert.equal(f.counts().uploads, 1);
  } finally {
    await f.dispose();
  }
});

test("a signed receipt cannot cross communities, media or publication revisions", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      receipt = await f.client().enroll(p);
    const expected = {
      connection: {
        namespace,
        origin,
        profileSha256,
        signer: recognitionSigner.address.toLowerCase(),
      },
      publication: p,
      communityOrigin: "https://a.example",
      requestSha256: receipt.payload.requestSha256,
    };
    const now = () => Math.floor(f.now() / 1000);
    for (const changed of [
      publication(communityB),
      publication(communityA, 2),
      { ...p, audioSha256: hashText("other-media") },
      { ...p, termsSha256: hashText("other-terms") },
    ]) {
      await assert.rejects(
        verifyCatalogStatus(
          receipt,
          { ...expected, publication: changed },
          now,
        ),
        /recognition_status_scope_mismatch/,
      );
    }
    await assert.rejects(
      verifyCatalogStatus(
        receipt,
        { ...expected, recordingId: hashText("other-recording") },
        now,
      ),
      /recognition_status_scope_mismatch/,
    );
    f.advanceClock(60000);
    await assert.rejects(
      verifyCatalogStatus(receipt, expected, now),
      /recognition_status_expired/,
    );
  } finally {
    await f.dispose();
  }
});

test("a withdrawal during asynchronous status signing cannot expose ready", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      enrolled = await f.client().enroll(p);
    await f.run(enrolled.payload.recordingId);
    await f.run(enrolled.payload.recordingId);
    f.onNextStatusSign(async () => {
      await f.store().withdraw(p, hashText("withdrawn-during-signing"));
    });
    const response = await f.request("catalog_status", {
      associationId: enrolled.payload.associationId,
    });
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "recognition_status_changed",
    );
    assert.equal((await f.client().status(p)).payload.state, "withdrawn");
  } finally {
    await f.dispose();
  }
});

test("final status fence sees withdrawal even when an older session permits stale replica reads", async () => {
  let replica: ReturnType<typeof staleSessionReplica> | undefined;
  const f = await recognitionFixture({
    serviceDatabase: (database) => {
      replica = staleSessionReplica(database);
      return replica.database;
    },
  });
  try {
    const p = publication(),
      enrolled = await f.client().enroll(p);
    await f.run(enrolled.payload.recordingId);
    await f.run(enrolled.payload.recordingId);
    const query =
      "SELECT state FROM shared_recognition_publications WHERE association_id=?";
    const oldSession = replica!.database.withSession("first-primary");
    const oldView = oldSession
      .prepare(query)
      .bind(enrolled.payload.associationId);
    assert.equal((await oldView.first<{ state: string }>())!.state, "active");
    f.onNextStatusSign(async () => {
      await f
        .store()
        .withdraw(p, hashText("withdrawal-committed-during-replica-status"));
    });
    const response = await f.request("catalog_status", {
      associationId: enrolled.payload.associationId,
    });
    // Establish that the modeled replica really can retain an older view while
    // another request's withdrawal is committed in the actual D1 database.
    assert.equal((await oldView.first<{ state: string }>())!.state, "active");
    assert.equal(
      (await f.db
        .prepare(query)
        .bind(enrolled.payload.associationId)
        .first<{ state: string }>())!.state,
      "withdrawn",
    );
    assert.ok(replica!.counts.staleReads > 0);
    // Reusing the request's old session here would return ready/200. A fresh
    // primary-anchored joined snapshot must reject that pre-withdrawal receipt.
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "recognition_status_changed",
    );
    assert.equal((await f.client().status(p)).payload.state, "withdrawn");
  } finally {
    await f.dispose();
  }
});

test("changed canonical terms during signing prevent a ready response", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      enrolled = await f.client().enroll(p);
    await f.run(enrolled.payload.recordingId);
    await f.run(enrolled.payload.recordingId);
    f.onNextStatusSign(async () => {
      f.publications.set(
        `${p.communityId}:${p.postId}:${p.publicationRevision}`,
        { ...p, termsSha256: hashText("revoked-terms") },
      );
    });
    const response = await f.request("catalog_status", {
      associationId: enrolled.payload.associationId,
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "recognition_publication_unverified",
    );
  } finally {
    await f.dispose();
  }
});

test("mutating a reused authority object during signing is detected", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication(),
      enrolled = await f.client().enroll(p);
    f.onNextStatusSign(async () => {
      f.authorities.get(communityA)!.enabled = false;
    });
    const response = await f.request("catalog_status", {
      associationId: enrolled.payload.associationId,
    });
    assert.equal(response.status, 403);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "recognition_pairing_changed",
    );
  } finally {
    await f.dispose();
  }
});

test("client holds a response if its authority changes in place during transport", async () => {
  const f = await recognitionFixture();
  try {
    const p = publication();
    await f.enroll(p);
    const client = f.client(communityA, {
      transport: async (request) => {
        const response = await f.fetch(request);
        f.authorities.get(communityA)!.enabled = false;
        return response;
      },
    });
    await assert.rejects(client.status(p), /recognition_pairing_changed/);
  } finally {
    await f.dispose();
  }
});

test("outbox lease refusal and expiration during signing stop before transport", async () => {
  const f = await recognitionFixture();
  try {
    let sends = 0;
    const client = f.client(communityA, {
      beforeSend: async () => {
        throw Error("publication_lease_lost");
      },
      transport: async (request) => {
        sends++;
        return f.fetch(request);
      },
    });
    await assert.rejects(
      client.enroll(publication()),
      /publication_lease_lost/,
    );
    assert.equal(sends, 0);
    const p = publication();
    const enrolled = await f.client().enroll(p);
    f.onNextStatusSign(async () => {
      f.advanceClock(60000);
    });
    const response = await f.request("catalog_status", {
      associationId: enrolled.payload.associationId,
    });
    assert.equal(response.status, 409);
    assert.equal(
      ((await response.json()) as { error: string }).error,
      "recognition_status_expired",
    );
  } finally {
    await f.dispose();
  }
});
