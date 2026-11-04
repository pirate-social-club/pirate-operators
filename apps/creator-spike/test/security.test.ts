import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { Miniflare } from "miniflare";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import {
  b64,
  unb64,
  hash,
  randomToken,
  utf8,
  rpId,
  walletOrigin,
  communityOrigin,
} from "../src/shared.ts";
import { sealSeed, openSeed } from "../src/vault.ts";

let mf: Miniflare, db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
before(async () => {
  mf = new Miniflare({
    modules: [
      { type: "ESModule", path: resolve("dist/worker/index.js") },
      { type: "CompiledWasm", path: resolve("dist/worker/ika.wasm") },
    ],
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: "test" },
    bindings: { SUI_OPERATOR_SECRET_KEY: "" },
    serviceBindings: {
      ASSETS: async () =>
        new Response("<html>test</html>", {
          headers: { "Content-Type": "text/html" },
        }),
    },
  });
  db = await mf.getD1Database("DB");
  await db.exec((await readFile("schema.sql", "utf8")).replaceAll("\n", " "));
});
after(async () => {
  await mf?.dispose();
});
async function post(
  origin: string,
  path: string,
  body: unknown,
  cookie?: string,
  overrideOrigin?: string,
) {
  return mf.dispatchFetch(`${origin}/api/${path}`, {
    method: "POST",
    headers: {
      origin: overrideOrigin ?? origin,
      "sec-fetch-site": "same-origin",
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
async function connection(account = randomToken()) {
  const token = randomToken(),
    state = randomToken(),
    verifier = randomToken();
  await db
    .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
    .bind(await hash(token), "community", account, Date.now() + 900_000)
    .run();
  const cookie = `__Host-community_session=${token}`;
  const r = await post(
    communityOrigin,
    "launch",
    { state, verifierHash: await hash(verifier) },
    cookie,
  );
  assert.equal(r.status, 200);
  const value = (await r.json()) as { id: string };
  return { request: value.id, cookie, account, state, verifier };
}
test("encrypted seed rejects wrong PRF, passkey, origin, derivation and ciphertext", async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32)),
    prf = crypto.getRandomValues(new Uint8Array(32)),
    id = randomToken();
  const sealed = await sealSeed(seed, prf, id);
  assert.deepEqual(await openSeed(sealed, prf, id), seed);
  await assert.rejects(() =>
    openSeed(sealed, crypto.getRandomValues(new Uint8Array(32)), id),
  );
  await assert.rejects(() => openSeed(sealed, prf, randomToken()));
  await assert.rejects(() =>
    openSeed({ ...sealed, rpId: "attacker.example" }, prf, id),
  );
  await assert.rejects(() =>
    openSeed(
      { ...sealed, derivation: "unknown" as typeof sealed.derivation },
      prf,
      id,
    ),
  );
  const tampered = unb64(sealed.ciphertext);
  tampered[0] ^= 1;
  await assert.rejects(() =>
    openSeed({ ...sealed, ciphertext: b64(tampered) }, prf, id),
  );
  await assert.rejects(() => sealSeed(seed, new Uint8Array(0), id));
});
test("write guards reject cross-origin, wrong-surface and unauthenticated launches", async () => {
  const page = await mf.dispatchFetch(communityOrigin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html>/);
  assert.match(
    page.headers.get("content-security-policy")!,
    /frame-ancestors 'none'/,
  );
  assert.equal(
    (
      await post(
        communityOrigin,
        "launch",
        {},
        undefined,
        "https://attacker.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (await post(communityOrigin, "activation/reserve", {})).status,
    404,
  );
  assert.equal((await post(walletOrigin, "launch", {})).status, 404);
  assert.equal(
    (
      await post(communityOrigin, "launch", {
        state: randomToken(),
        verifierHash: randomToken(),
      })
    ).status,
    401,
  );
});
test("real P-256 WebAuthn registration persists ciphertext; assertion authenticates; challenges cannot replay", async () => {
  const c = await connection(),
    id = randomToken(),
    { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = isoCBOR.encode(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, unb64(jwk.x!)],
      [-3, unb64(jwk.y!)],
    ]) as never,
  );
  const options = (await (
    await post(walletOrigin, "passkey/options", {
      request: c.request,
      mode: "register",
    })
  ).json()) as { id: string; nonce: string };
  const data = utf8.encode(
    JSON.stringify({
      type: "webauthn.create",
      challenge: options.nonce,
      origin: walletOrigin,
      crossOrigin: false,
    }),
  );
  const auth = new Uint8Array([
    ...unb64(await hash(rpId)),
    0x45,
    0,
    0,
    0,
    0,
    ...new Uint8Array(16),
    0,
    32,
    ...unb64(id),
    ...cose,
  ]);
  const attestation = isoCBOR.encode(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", auth],
    ]) as never,
  );
  const seed = crypto.getRandomValues(new Uint8Array(32)),
    prf = crypto.getRandomValues(new Uint8Array(32));
  const sealedSeed = await sealSeed(seed, prf, id);
  const body = {
    id: options.id,
    sealedSeed,
    response: {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(data),
        attestationObject: b64(attestation),
        transports: ["internal"],
      },
    },
  };
  const registered = await post(walletOrigin, "passkey/register", body);
  assert.equal(registered.status, 200, await registered.clone().text());
  const cookie = registered.headers.get("set-cookie")!;
  assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
  const stored = await db
    .prepare("SELECT * FROM credentials WHERE id=?")
    .bind(id)
    .first<{ sealed_seed: string; sui_address: string }>();
  assert(stored);
  assert.equal(stored.sealed_seed, JSON.stringify(sealedSeed));
  assert.equal(stored.sui_address.length, 66);
  assert.equal(
    (await post(walletOrigin, "passkey/register", body)).status,
    400,
  );
  const a = (await (
    await post(walletOrigin, "passkey/options", {
      request: c.request,
      mode: "authenticate",
    })
  ).json()) as { id: string; nonce: string };
  const client = utf8.encode(
    JSON.stringify({
      type: "webauthn.get",
      challenge: a.nonce,
      origin: walletOrigin,
      crossOrigin: false,
    }),
  );
  const authenticator = new Uint8Array([
    ...unb64(await hash(rpId)),
    5,
    0,
    0,
    0,
    1,
  ]);
  const sig = sign(
    "sha256",
    new Uint8Array([...authenticator, ...unb64(await hash(client))]),
    privateKey,
  );
  const assertion = {
    id: a.id,
    response: {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(client),
        authenticatorData: b64(authenticator),
        signature: b64(sig),
        userHandle: null,
      },
    },
  };
  const authenticated = await post(
    walletOrigin,
    "passkey/authenticate",
    assertion,
  );
  assert.equal(authenticated.status, 200, await authenticated.clone().text());
  assert.equal(
    (await post(walletOrigin, "passkey/authenticate", assertion)).status,
    400,
  );
  const wrong = await connection();
  await db
    .prepare("INSERT INTO bindings(account,credential_id) VALUES(?,?)")
    .bind(wrong.account, id)
    .run();
  assert.equal(
    (
      await post(
        walletOrigin,
        "activation/reserve",
        { request: wrong.request },
        cookie.split(";")[0],
      )
    ).status,
    403,
  );
  const result = await post(
    communityOrigin,
    "exchange",
    { code: randomToken(), state: c.state, verifier: c.verifier },
    c.cookie,
  );
  assert.equal(result.status, 401);
});
test("database atomically caps daily funding attempts and prevents duplicate active creators", async () => {
  const credentialId = (await db
    .prepare("SELECT id FROM credentials LIMIT 1")
    .first<{ id: string }>())!.id;
  const insert = (id: string, account: string, status = "failed") =>
    db
      .prepare(
        "INSERT INTO attempts(id,account,credential_id,status,intent,created) VALUES(?,?,?,?,?,?)",
      )
      .bind(id, account, credentialId, status, "{}", Date.now())
      .run();
  await insert(randomToken(), "budget-account");
  await insert(randomToken(), "budget-account");
  await insert(randomToken(), "budget-account");
  await assert.rejects(
    () => insert(randomToken(), "budget-account"),
    /account_attempt_limit|operator_daily_attempt_limit/,
  );
  await assert.rejects(
    () => insert(randomToken(), "different-account"),
    /operator_daily_attempt_limit/,
  );
  await db.prepare("UPDATE attempts SET created=0").run();
  await insert(randomToken(), "live-account", "reserved");
  await assert.rejects(
    () => insert(randomToken(), "live-account", "reserved"),
    /UNIQUE constraint/,
  );
  await assert.rejects(
    () => insert(randomToken(), "other-account", "reserved"),
    /UNIQUE constraint/,
  );
});
