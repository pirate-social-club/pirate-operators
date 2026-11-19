/** Integration support: actual HTTP/auth/D1/crypto/operator Store.
 * Reuses the existing explicitly scripted RPC; no production permission port. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import type { Hex } from "viem";
import { digest } from "../packages/protocol/index.ts";
import { hashText } from "../packages/community/common.ts";
import { DanceStore } from "../packages/dance/store.ts";
import {
  danceAccountCommitment,
  type DanceCapture,
} from "../packages/dance-chain/v2/wire.ts";
import {
  createDancePublicationJournal,
  type DancePublicationBindingPlan,
} from "../services/dance-publication-journal.ts";
import { PublicationRequestSession } from "../services/publication-app-request.ts";
import { parseCommand } from "../services/publication-command-contract.ts";
import { publicationAppFixture, other } from "./fixtures/publication-app.ts";

export async function journalFixture(
  t: TestContext,
  options: {
    recorded?: boolean;
    activate?: boolean;
    submitted?: boolean;
    schema?: boolean;
  } = {},
) {
  const f = await publicationAppFixture(t, {
    omitDancePublicationMigration: options.schema === false,
  });
  const db = f.ports.db;
  await db
    .prepare(
      "CREATE TABLE dance_binding_acceptance_probe(id TEXT PRIMARY KEY,capture_hash TEXT)",
    )
    .run();
  const prepared = await f.prepare("dance-original", "dance-verdict");
  assert.equal(prepared.status, 200, JSON.stringify(prepared.value));
  const command = parseCommand(prepared.value.command);
  assert.equal(command.action, "grant");
  if (options.submitted !== false) {
    const sent = await f.submit({
      commandId: command.commandId,
      signature: await f.sign(command),
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.value));
  }
  let original:
    | Awaited<ReturnType<typeof f.historicalRecordedOriginal>>
    | undefined;
  if (options.recorded !== false && options.submitted !== false) {
    original = await f.historicalRecordedOriginal(command);
    if (options.activate !== false) {
      const observed = await f.call("commands/" + command.commandId);
      assert.equal(observed.status, 200, JSON.stringify(observed.value));
      assert.equal(
        (observed.value.currentGrant as { state: string }).state,
        "allowed",
      );
    }
  }
  const session = async (
    cookie = "a".repeat(64),
    csrf = "fixture-csrf-value",
  ) => {
    assert.ok(f.ports.installation);
    return PublicationRequestSession.open(
      new Request(f.context.origin + "/api/dance/captures", {
        method: "POST",
        headers: {
          cookie: "__Host-community_session=" + cookie,
          origin: f.context.origin,
          "x-csrf-token": csrf,
        },
      }),
      db,
      f.context,
      f.ports.installation,
    );
  };
  const journal = async () =>
    createDancePublicationJournal(f.ports, await session());
  const capture = (label = "capture-A", c = command): DanceCapture => {
    assert.equal(c.action, "grant");
    if (c.action !== "grant") throw Error("fixture_grant_required");
    const domain = {
      chainId: BigInt(c.source.chainId),
      communityId: c.source.communityId,
      verifier: c.message.publicationTarget,
    };
    const z = ("0x" + "0".repeat(64)) as Hex;
    return {
      captureId: digest(label),
      accountCommitment: danceAccountCommitment(
        domain,
        c.accountId,
        c.message.learner,
      ),
      learner: c.message.learner,
      identityEpoch: 1n,
      groupId: digest("known-account-group"),
      groupEpoch: 1n,
      publicationGrantId: c.digest,
      reservedAtMs: f.now() * 1000n,
      song: {
        chainId: domain.chainId,
        posts: f.authority.release.configuration.postsContract,
        communityId: domain.communityId,
        postId: digest("song"),
        revision: 1n,
        manifestSha256: digest("manifest"),
        audioSha256: digest("audio"),
      },
      rulesSha256: digest("rules"),
      termsSha256: digest("terms"),
      rubricSha256: digest("rubric"),
      mediaPolicySha256: digest("media-policy"),
      referenceSelection: {
        present: false,
        id: z,
        revision: 0n,
        epoch: 0n,
        segmentLayoutSha256: z,
        segmentId: z,
        startSample: 0n,
        durationSamples: 0n,
      },
      offer: {
        present: false,
        offerIdCommitment: z,
        inputHash: z,
        sourceHash: z,
        opensAtMs: 0n,
        cutoffAtMs: 0n,
      },
    };
  };
  const request = (c = capture()) => ({
    commandId: command.commandId,
    capture: c,
    configurationRevision: "1",
    ownerEpoch: "7",
  });
  const commit = (plan: DancePublicationBindingPlan, id: string) =>
    new DanceStore(db).atomic(plan.fences, [
      ...plan.statements,
      db
        .prepare("INSERT INTO dance_binding_acceptance_probe VALUES(?,?)")
        .bind(id, plan.captureHash),
    ]);
  const bindings = async () =>
    (
      await db
        .prepare(
          "SELECT * FROM dance_publication_bindings ORDER BY capture_hash,account_id,purpose",
        )
        .all()
    ).results;
  const markers = async () =>
    (
      await db
        .prepare("SELECT * FROM dance_binding_acceptance_probe ORDER BY id")
        .all()
    ).results;
  const originals = async () =>
    (await f.rows()).map((r) => ({
      id: r.command_id,
      request: r.request_json,
      typed: r.typed_json,
      nonce: r.nonce_hex,
      signature: r.signature,
      accepted: r.accepted_json,
    }));
  return {
    f,
    db,
    command,
    original,
    session,
    journal,
    capture,
    request,
    commit,
    bindings,
    markers,
    originals,
    async secondGrant(id = "new-grant") {
      const p = await f.prepare(id, "dance-verdict");
      assert.equal(p.status, 200);
      const c = parseCommand(p.value.command);
      assert.equal(c.action, "grant");
      assert.equal(
        (await f.submit({ commandId: c.commandId, signature: await f.sign(c) }))
          .status,
        200,
      );
      f.authority.state.safe = {
        ...f.authority.state.safe,
        number: f.authority.state.safe.number + 2n,
        hash: digest("scripted-safe-" + c.commandId),
      };
      await f.historicalRecordedOriginal(c);
      assert.equal((await f.call("commands/" + c.commandId)).status, 200);
      return c;
    },
    async reviewer() {
      const cookie = "b".repeat(64),
        csrf = "reviewer-csrf",
        created = Number(f.now() * 1000n);
      await f.db.batch([
        f.db
          .prepare("INSERT INTO community_accounts VALUES(?,?,?)")
          .bind("reviewer", digest("reviewer-author"), created),
        f.db
          .prepare("INSERT INTO credential_bindings VALUES(?,?,?,?,?,?)")
          .bind(
            "reviewer-binding",
            "reviewer",
            "moss",
            6343,
            other.address.toLowerCase(),
            created,
          ),
        f.db
          .prepare("INSERT INTO community_sessions VALUES(?,?,?,?,?,?,?)")
          .bind(
            hashText(cookie),
            f.context.communityId,
            f.context.origin,
            "reviewer",
            "reviewer-binding",
            csrf,
            Date.now() + 3600000,
          ),
      ]);
      const headers = {
        cookie: "__Host-community_session=" + cookie,
        "x-csrf-token": csrf,
      };
      const p = await f.call(
        "grants/prepare",
        { purpose: "dance-review-attribution", requestId: "reviewer-grant" },
        headers,
      );
      assert.equal(p.status, 200, JSON.stringify(p.value));
      const c = parseCommand(p.value.command);
      assert.equal(
        (
          await f.call(
            "commands/" + c.commandId + "/submit",
            { signature: await f.sign(c, other) },
            headers,
          )
        ).status,
        200,
      );
      f.authority.state.safe = {
        ...f.authority.state.safe,
        number: f.authority.state.safe.number + 2n,
        hash: digest("scripted-safe-" + c.commandId),
      };
      await f.historicalRecordedOriginal(c);
      const current = await f.call(
        "commands/" + c.commandId,
        undefined,
        headers,
      );
      assert.equal(current.status, 200, JSON.stringify(current.value));
      assert.equal(
        (current.value.currentGrant as { state: string }).state,
        "allowed",
      );
      return {
        command: c,
        journal: createDancePublicationJournal(
          f.ports,
          await session(cookie, csrf),
        ),
      };
    },
    async artifact(label: string) {
      const value = {
        schema: "pirate.dance-publication-journal-integration/1",
        label,
        boundaries:
          "real HTTP/auth/D1/crypto/Store; scripted RPC; accepting mutation is a probe, not a production mount",
        bindings: options.schema === false ? [] : await bindings(),
        markers: await markers(),
        originals: (await originals()).map((o) => ({
          commandId: o.id,
          originalSha256: digest(o),
        })),
        operatorNonce: f.store().get("op:nonce") ?? null,
        operatorIntents: f.store().entries("intent:").length,
      };
      const bytes = JSON.stringify(value, null, 2) + "\n";
      const directory = ".local/dance-publication-journal-integration",
        path = directory + "/" + label + ".json";
      await mkdir(directory, { recursive: true });
      await writeFile(path, bytes);
      t.diagnostic(JSON.stringify({ artifact: path, sha256: hashText(bytes) }));
    },
  };
}
