import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";
import { alignmentOperation } from "../packages/alignment/operation.ts";
import { hashText } from "../packages/community/common.ts";
import {
  ALIGNMENT_RESPONSE_BYTES,
  ALIGNMENT_REQUEST_BYTES,
  ALIGNMENT_RESULT_BYTES,
  ALIGNMENT_ROW_BYTES,
} from "../packages/alignment/limits.ts";

const identity = {
    communityId: `0x${"11".repeat(32)}` as `0x${string}`,
    postId: `0x${"22".repeat(32)}` as `0x${string}`,
    lyricsRevision: 1,
  },
  grant = `0x${"33".repeat(32)}` as `0x${string}`,
  intent = {
    vocalSha256: `0x${"44".repeat(32)}`,
    provider: "elevenlabs-forced-alignment/1",
  };
const receipt = {
  status: 200,
  contentType: "application/json",
  requestId: "fixture-alignment",
  body: '{"fixture":true}',
  bodySha256: hashText('{"fixture":true}'),
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pirate-alignment-"));
  const create = () =>
    new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('fixture')}}",
      // The repository's pinned local workerd supports this fixture date.
      compatibilityDate: "2026-08-06",
      d1Databases: ["DB"],
      d1Persist: directory,
    });
  let runtime = create(),
    db = await runtime.getD1Database("DB");
  const sql = await readFile("packages/alignment/schema.sql", "utf8");
  await db.batch(
    sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
  return {
    get db() {
      return db;
    },
    stop: () => runtime.dispose(),
    async reopen() {
      runtime = create();
      db = await runtime.getD1Database("DB");
    },
    async dispose() {
      await runtime.dispose();
      await rm(directory, { recursive: true });
    },
  };
}
test("alignment is purchased once and a successor grant cannot replenish the lyric revision", async () => {
  const f = await fixture();
  let sends = 0;
  const ports = {
    authorize: async () => {},
    send: async (received: (r: typeof receipt) => Promise<void>) => {
      sends++;
      await received(receipt);
    },
    interpret: () => ({ words: ["fixture"] }),
  };
  try {
    const result = await alignmentOperation(
      f.db,
      identity,
      grant,
      intent,
      ports,
    );
    assert.equal(result.state, "complete");
    await f.stop();
    await f.reopen();
    assert.deepEqual(
      await alignmentOperation(f.db, identity, grant, intent, ports),
      result,
    );
    await assert.rejects(
      alignmentOperation(f.db, identity, `0x${"55".repeat(32)}`, intent, ports),
      /alignment_intent_changed/,
    );
    await assert.rejects(
      alignmentOperation(
        f.db,
        identity,
        grant,
        { ...intent, vocalSha256: grant },
        ports,
      ),
      /alignment_intent_changed/,
    );
    assert.equal(sends, 1);
    const retained = await f.db
      .prepare("SELECT response_json FROM song_alignments")
      .first<{ response_json: string }>();
    assert.deepEqual(JSON.parse(retained!.response_json), receipt);
  } finally {
    await f.dispose();
  }
});
test("an unknown alignment send remains uncertain after reload and repeated resumes", async () => {
  const f = await fixture();
  let sends = 0;
  const ports = {
    authorize: async () => {},
    send: async () => {
      sends++;
      throw Error("lost response");
    },
    interpret: () => ({ words: [] }),
  };
  try {
    assert.equal(
      (await alignmentOperation(f.db, identity, grant, intent, ports)).state,
      "uncertain",
    );
    await f.stop();
    await f.reopen();
    for (let n = 0; n < 3; n++)
      assert.equal(
        (await alignmentOperation(f.db, identity, grant, intent, ports)).state,
        "uncertain",
      );
    assert.equal(sends, 1);
  } finally {
    await f.dispose();
  }
});
test("a retained alignment response survives a worker stop before interpretation without repurchase", async () => {
  const f = await fixture();
  let sends = 0;
  const ports = {
    authorize: async () => {},
    send: async (received: (r: typeof receipt) => Promise<void>) => {
      sends++;
      await received(receipt);
      await f.stop();
      throw Error("worker stopped");
    },
    interpret: () => ({ words: ["retained"] }),
  };
  try {
    await assert.rejects(
      alignmentOperation(f.db, identity, grant, intent, ports),
    );
    await f.reopen();
    const result = await alignmentOperation(
      f.db,
      identity,
      grant,
      intent,
      ports,
    );
    assert.equal(result.state, "complete");
    assert.deepEqual(result.result, { words: ["retained"] });
    assert.equal(sends, 1);
  } finally {
    await f.dispose();
  }
});
test("concurrent alignment wakes share the first send and accept its late receipt", async () => {
  const f = await fixture();
  let sends = 0,
    started!: () => void,
    release!: () => void;
  const began = new Promise<void>((done) => {
      started = done;
    }),
    gate = new Promise<void>((done) => {
      release = done;
    });
  const ports = {
    authorize: async () => {},
    send: async (received: (r: typeof receipt) => Promise<void>) => {
      sends++;
      started();
      await gate;
      await received(receipt);
    },
    interpret: () => ({ words: ["late"] }),
  };
  try {
    const first = alignmentOperation(f.db, identity, grant, intent, ports);
    await began;
    assert.equal(
      (await alignmentOperation(f.db, identity, grant, intent, ports)).state,
      "uncertain",
    );
    release();
    assert.equal((await first).state, "complete");
    assert.equal(sends, 1);
  } finally {
    release();
    await f.dispose();
  }
});
test("alignment status and denied authority cannot reserve a revision or poison its grant", async () => {
  const f = await fixture();
  let sends = 0;
  const denied = {
    authorize: async () => {
      throw Error("revoked");
    },
    send: async () => {
      sends++;
    },
    interpret: () => ({}),
  };
  try {
    const missing = await alignmentOperation(
      f.db,
      identity,
      grant,
      intent,
      denied,
      "reconcile",
    );
    assert.equal(missing.state, "absent");
    await assert.rejects(
      alignmentOperation(f.db, identity, grant, intent, denied),
      /revoked/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS count FROM song_alignments")
        .first<{ count: number }>())!.count,
      0,
    );
    const actual = await alignmentOperation(f.db, identity, grant, intent, {
      authorize: async () => {},
      send: async (received) => {
        sends++;
        await received(receipt);
      },
      interpret: () => ({ words: ["authorized"] }),
    });
    assert.equal(actual.state, "complete");
    assert.equal(sends, 1);
  } finally {
    await f.dispose();
  }
});
test("the worst escaped bounded receipt and result fit one actual D1 row through restart", async () => {
  const f = await fixture();
  let sends = 0;
  const body = "\0".repeat(ALIGNMENT_RESPONSE_BYTES),
    raw = { ...receipt, body, bodySha256: hashText(body) },
    largeIntent = {
      ...intent,
      padding: "i".repeat(ALIGNMENT_REQUEST_BYTES - 2048),
    },
    expected = { artifact: "r".repeat(ALIGNMENT_RESULT_BYTES - 64) },
    ports = {
      authorize: async () => {},
      send: async (received: (r: typeof receipt) => Promise<void>) => {
        sends++;
        await received(raw);
      },
      interpret: (r: typeof receipt) => {
        assert.equal(r.bodySha256, hashText(r.body));
        return expected;
      },
    };
  try {
    assert.equal(
      (await alignmentOperation(f.db, identity, grant, largeIntent, ports))
        .state,
      "complete",
    );
    const size = await f.db
      .prepare(
        "SELECT LENGTH(CAST(request_json AS BLOB))+LENGTH(CAST(response_json AS BLOB))+LENGTH(CAST(result_json AS BLOB)) AS bytes FROM song_alignments",
      )
      .first<{ bytes: number }>();
    assert(size!.bytes > 1400000 && size!.bytes + 4096 <= ALIGNMENT_ROW_BYTES);
    await f.stop();
    await f.reopen();
    const retained = await alignmentOperation(
      f.db,
      identity,
      grant,
      largeIntent,
      ports,
    );
    assert("result" in retained);
    assert.deepEqual(retained.result, expected);
    assert.equal(sends, 1);
  } finally {
    await f.dispose();
  }
});
test("oversized intents cannot reserve a slot and oversized results retain the receipt without another send", async () => {
  const f = await fixture();
  let sends = 0;
  const ports = {
    authorize: async () => {},
    send: async (received: (r: typeof receipt) => Promise<void>) => {
      sends++;
      await received(receipt);
    },
    interpret: () => ({ tooLarge: "r".repeat(ALIGNMENT_RESULT_BYTES) }),
  };
  try {
    await assert.rejects(
      alignmentOperation(
        f.db,
        identity,
        grant,
        { padding: "i".repeat(ALIGNMENT_REQUEST_BYTES) },
        ports,
      ),
      /alignment_request_too_large/,
    );
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS count FROM song_alignments")
        .first<{ count: number }>())!.count,
      0,
    );
    assert.equal(
      (await alignmentOperation(f.db, identity, grant, intent, ports)).state,
      "unavailable",
    );
    assert.equal(
      (await alignmentOperation(f.db, identity, grant, intent, ports)).state,
      "unavailable",
    );
    assert(
      (await f.db.prepare("SELECT response_json FROM song_alignments").first())!
        .response_json,
    );
    assert.equal(sends, 1);
  } finally {
    await f.dispose();
  }
});
