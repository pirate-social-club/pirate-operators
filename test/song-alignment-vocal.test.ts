import test from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "viem";
import {
  curatedSongFixture,
  curatedController,
} from "./fixtures/curated-song.ts";
import { evaluator } from "./fixtures/release-admission.ts";
import { hashJson } from "../packages/community/common.ts";
import {
  serveVocalInput,
  signVocalCapability,
  type VocalCapability,
  type SignedVocalCapability,
  type PublishedVocalSource,
} from "../packages/alignment/vocal-input.ts";

async function fixture() {
  const f = await curatedSongFixture(),
    now = Math.floor(Date.now() / 1000),
    stem = await f.community.db
      .prepare(
        "SELECT * FROM media_stems WHERE submission_id=? AND slot='vocals'",
      )
      .bind(f.row.submission_id)
      .first<{
        sha256: `0x${string}`;
        byte_length: number;
        duration_ms: number;
        object_key: string;
      }>();
  assert(stem);
  const cap: VocalCapability = {
    schema: "pirate.vocal-input/1",
    communityId: f.config.communityId,
    configurationSha256: hashJson(f.config),
    postId: f.row.post_id as `0x${string}`,
    postRevision: 1,
    vocalSha256: stem.sha256,
    byteLength: stem.byte_length,
    durationMs: stem.duration_ms,
    communityOrigin: f.config.app.origin,
    serviceOrigin: f.managed.service.origin,
    issuedAt: now,
    expiresAt: now + 120,
  };
  const signed = await signVocalCapability(
    evaluator,
    cap,
    f.config,
    cap.serviceOrigin,
    now,
  );
  let reads = 0;
  const media = {
    get: (...args: Parameters<typeof f.community.media.get>) => {
      reads++;
      return f.community.media.get(...args);
    },
  };
  const request = (
    value: SignedVocalCapability = signed,
    origin = cap.serviceOrigin,
  ) =>
    new Request(cap.communityOrigin + "/api/alignment/vocal", {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify(value),
    });
  const publication = (): PublishedVocalSource => ({
    configuration: f.config,
    post: {
      communityId: f.config.communityId,
      postId: cap.postId,
      revision: 1,
    },
  });
  return {
    ...f,
    cap,
    signed,
    stem,
    now,
    media,
    request,
    publication,
    reads: () => reads,
    serve: (
      req: Request,
      readPublication: (
        c: VocalCapability,
      ) => Promise<PublishedVocalSource> = async () => publication(),
    ) =>
      serveVocalInput(
        req,
        f.community.db,
        media,
        f.config,
        cap.serviceOrigin,
        readPublication,
        () => now,
      ),
    // Only this unit fixture seeds the published phase. The production caller
    // must separately prove the canonical public post through readPublication.
    published: () =>
      f.community.db
        .prepare("UPDATE publication_jobs SET phase='published' WHERE job_id=?")
        .bind(f.sealed.jobId)
        .run(),
  };
}
test("signed vocal reads require the published job and return only its exact sealed bytes", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.serve(f.request()), /published_vocal_unavailable/);
    assert.equal(f.reads(), 0);
    await f.published();
    let canonicalChecks = 0;
    const response = await f.serve(f.request(), async (cap) => {
      canonicalChecks++;
      assert.equal(cap.postId, f.row.post_id);
      assert.equal(cap.postRevision, 1);
      return f.publication();
    });
    assert.equal(response.status, 200);
    assert.equal(canonicalChecks, 2);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.equal(bytes.length, f.cap.byteLength);
    assert.equal(sha256(bytes), f.cap.vocalSha256);
  } finally {
    await f.dispose();
  }
});
test("changed signatures, origins, revisions and expiry fail before any private vocal read", async () => {
  const f = await fixture();
  try {
    await f.published();
    const forged = {
      ...f.signed,
      signature: await curatedController.signMessage({
        message: { raw: hashJson(f.cap) },
      }),
    };
    await assert.rejects(f.serve(f.request(forged)), /invalid_vocal_signature/);
    await assert.rejects(
      f.serve(f.request(f.signed, "https://unpaired.example")),
      /vocal_capability_required/,
    );
    await assert.rejects(
      f.serve(
        f.request({ ...f.signed, capability: { ...f.cap, postRevision: 2 } }),
      ),
      /invalid_vocal_signature/,
    );
    await assert.rejects(
      serveVocalInput(
        f.request(),
        f.community.db,
        f.media,
        f.config,
        f.cap.serviceOrigin,
        async () => f.publication(),
        () => f.cap.expiresAt,
      ),
      /vocal_capability_expired/,
    );
    await assert.rejects(
      f.serve(f.request(), async () => {
        throw Error("canonical publication revoked");
      }),
      /canonical publication revoked/,
    );
    assert.equal(f.reads(), 0);
  } finally {
    await f.dispose();
  }
});
test("vocal delivery rechecks revocation, post revision and configuration after awaited R2 lookup", async () => {
  const f = await fixture();
  try {
    await f.published();
    for (const change of ["revoked", "revision", "configuration"]) {
      let changed = false,
        checks = 0;
      const media = {
        async get(...args: Parameters<typeof f.community.media.get>) {
          const object = await f.media.get(...args);
          changed = true;
          return object;
        },
      };
      await assert.rejects(
        serveVocalInput(
          f.request(),
          f.community.db,
          media,
          f.config,
          f.cap.serviceOrigin,
          async () => {
            checks++;
            if (changed && change === "revoked")
              throw Error("publication revoked");
            const current = f.publication();
            if (changed && change === "revision") current.post.revision++;
            if (changed && change === "configuration")
              current.configuration = {
                ...current.configuration,
                configurationRevision:
                  current.configuration.configurationRevision + 1,
              };
            return current;
          },
          () => f.now,
        ),
        /publication revoked|vocal_publication_changed|vocal_capability_scope_changed/,
      );
      assert.equal(checks, 2);
    }
  } finally {
    await f.dispose();
  }
});
test("expiry during an awaited D1 lookup cannot initiate an R2 vocal read", async () => {
  const f = await fixture();
  let time = f.now;
  try {
    await f.published();
    const delayed = new Proxy(f.community.db, {
      get(target, key) {
        if (key !== "prepare") return Reflect.get(target, key, target);
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(stmt, name) {
              if (name !== "bind") return Reflect.get(stmt, name, stmt);
              return (...values: Parameters<D1PreparedStatement["bind"]>) => {
                const bound = stmt.bind(...values);
                return new Proxy(bound, {
                  get(result, field) {
                    if (field !== "first")
                      return Reflect.get(result, field, result);
                    return async () => {
                      const row = await result.first();
                      time = f.cap.expiresAt;
                      return row;
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    await assert.rejects(
      serveVocalInput(
        f.request(),
        delayed,
        f.media,
        f.config,
        f.cap.serviceOrigin,
        async () => f.publication(),
        () => time,
      ),
      /vocal_capability_expired/,
    );
    assert.equal(f.reads(), 0);
  } finally {
    await f.dispose();
  }
});
test("vocal capability cannot read changed R2 bytes under an old seal", async () => {
  const f = await fixture();
  try {
    await f.published();
    await f.community.media.put(f.stem.object_key, new Uint8Array([1, 2, 3]), {
      customMetadata: { sha256: f.cap.vocalSha256 },
    });
    await assert.rejects(f.serve(f.request()), /published_vocal_changed/);
  } finally {
    await f.dispose();
  }
});
