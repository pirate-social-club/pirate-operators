import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decrypt, encrypt, hostedProvider } from "../harness/very/transport.ts";
import { CONTEXT, MAX_BYTES } from "../harness/very/proof.ts";

test("published bridge encryption and hosted verification wire shapes", async () => {
  const key = randomBytes(32);
  const calls: string[] = [];
  const provider = hostedProvider(async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    if (String(url).endsWith("/sessions")) {
      const launch = JSON.parse(decrypt(JSON.parse(String(init?.body)), key));
      assert.equal(launch.appId, "app");
      assert.equal(launch.idpContext, CONTEXT);
      assert.equal(launch.idpTypeId, "3");
      assert.equal(
        JSON.parse(launch.idpQuery).options.externalNullifier,
        "1000001",
      );
      assert.equal(JSON.parse(launch.idpQuery).options.pseudonym, "17");
      return Response.json({
        sessionId: "fixture-session",
        sessionAuthToken: "discard-this",
      });
    }
    if (String(url).includes("/session/"))
      return Response.json({
        status: "completed",
        response: encrypt("fixture-proof", key),
      });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      proof: "fixture-proof",
    });
    return Response.json({ status: "valid" });
  });
  const session = await provider.open("app", "1000001", "17", key);
  assert.deepEqual(session, { id: "fixture-session" });
  assert.equal(await provider.poll(session, key), "fixture-proof");
  await provider.verify("fixture-proof");
  assert.deepEqual(calls, [
    "https://bridge.very.org/api/v1/sessions",
    "https://bridge.very.org/api/v1/session/fixture-session",
    "https://verify.very.org/api/v1/verify",
  ]);
});

test("AES-GCM refuses wrong keys, altered tags and malformed envelopes", () => {
  const key = randomBytes(32);
  const sealed = encrypt("test", key);
  assert.equal(decrypt(sealed, key), "test");
  assert.throws(() => decrypt(sealed, randomBytes(32)));
  const altered = Buffer.from(sealed.payload, "base64");
  altered[0] ^= 1;
  assert.throws(() =>
    decrypt({ ...sealed, payload: altered.toString("base64") }, key),
  );
  for (const envelope of [
    { ...sealed, iv: "AA==" },
    { ...sealed, payload: "bad base64" },
    { ...sealed, payload: "AA==" },
  ])
    assert.throws(() => decrypt(envelope, key));
});

test("hosted verifier rejects status, HTTP, timeout and oversized responses without leaking bodies", async () => {
  const factories = [
    async () => Response.json({ status: "invalid", reason: "private-proof" }),
    async () => Response.json({ result: { status: "valid" } }),
    async () => new Response("private-proof", { status: 503 }),
    async () => {
      throw new DOMException("private-proof", "TimeoutError");
    },
    async () => new Response("x".repeat(MAX_BYTES + 1)),
  ];
  for (const response of factories) {
    const provider = hostedProvider(response);
    await assert.rejects(
      provider.verify("private-proof"),
      (error: Error) => !error.message.includes("private-proof"),
    );
  }
});

test("pending bridge results wait; unknown states and unsafe session handles fail", async () => {
  const key = randomBytes(32);
  for (const status of ["pending", "received", "processing"]) {
    assert.equal(
      await hostedProvider(async () => Response.json({ status })).poll(
        { id: "fixture" },
        key,
      ),
      null,
    );
  }
  for (const status of ["error", "valid", "completed", "unrecognized"]) {
    await assert.rejects(
      hostedProvider(async () => Response.json({ status })).poll(
        { id: "fixture" },
        key,
      ),
    );
  }
  await assert.rejects(
    hostedProvider(async () =>
      Response.json({ sessionId: "../other?key=secret" }),
    ).open("app", "1000001", "17", key),
  );
});
