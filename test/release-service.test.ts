import test from "node:test";
import assert from "node:assert/strict";
import { preparePin } from "../packages/community/ipfs.ts";
import { releaseFixture } from "./fixtures/release-service.ts";

test("managed ROOT release composes admitted sealed content, canonical metadata, capped mint and retrievable manifest; status and retries buy nothing", async () => {
  const f = await releaseFixture();
  try {
    const absent = await f.clientRequest(
      "/v1/releases/pin/status",
      "release_pin_status",
      { context: f.context, role: "audio" },
    );
    assert.equal(absent.status, 404);
    let response = await f.sendRelease("pin/status", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 404);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM managed_releases")
        .first())!.n,
      0,
    );
    response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
      metadataUri: "ipfs://caller-chosen",
    });
    assert.equal(response.status, 400);
    assert.equal(f.adds(), 0);
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(
        response.status,
        200,
        JSON.stringify(await response.clone().json()),
      );
    }
    assert.equal(f.adds(), 4);
    const noMint = await f.clientRequest(
      "/v1/releases/register/status",
      "release_register_status",
      { context: f.context },
    );
    assert.equal(noMint.status, 404);
    response = await f.sendRelease("register/status", { context: f.context });
    assert.equal(response.status, 404);
    assert.equal(f.story.broadcasts(), 0);
    response = await f.sendRelease("register", { context: f.context });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    assert.equal(f.story.mints(), 1);
    response = await f.sendRelease("register/status", { context: f.context });
    assert.equal(response.status, 200);
    assert.equal(f.story.broadcasts(), 1);
    response = await f.sendRelease("pin", {
      context: f.context,
      role: "post_manifest",
    });
    assert.equal(
      response.status,
      200,
      JSON.stringify(await response.clone().json()),
    );
    const value = (await response.json()) as {
        result: { pin: { uri: string } };
      },
      manifest = JSON.parse(
        new TextDecoder().decode(f.retained.get(value.result.pin.uri.slice(7))),
      );
    assert.equal(manifest.postId, f.context.postId);
    assert.equal(manifest.registration.recipient, f.context.recipient);
    assert.equal(
      manifest.registration.contentSha256,
      f.body.declared.songSha256,
    );
    assert.equal(manifest.media.length, 2);
    assert.equal(f.adds(), 5);
    for (const path of ["pin/status", "pin"]) {
      response = await f.sendRelease(path, {
        context: f.context,
        role: "post_manifest",
      });
      assert.equal(response.status, 200);
    }
    assert.equal(f.adds(), 5);
    assert.equal(f.story.mints(), 1);
  } finally {
    await f.dispose();
  }
});
test("identified reference audio cannot consume a release grant, pin or mint", async () => {
  const f = await releaseFixture(0);
  try {
    const response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "release_rejected" });
    assert.equal(f.adds(), 0);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM managed_releases")
        .first())!.n,
      0,
    );
  } finally {
    await f.dispose();
  }
});

for (const scenario of ["held", "provider_failure", "stale"] as const) {
  test(`${scenario} admission cannot buy pins or a root mint`, async () => {
    const f = await releaseFixture(
        scenario === "held" ? 2004 : 1001,
        scenario === "provider_failure",
        7200,
      ),
      realNow = Date.now;
    try {
      if (scenario === "stale") Date.now = () => realNow() + 3601000;
      const response = await f.sendRelease("pin", {
        context: f.context,
        role: "audio",
      });
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error:
          scenario === "provider_failure"
            ? "release_admission_unavailable"
            : "release_held",
      });
      assert.equal(f.adds(), 0);
      assert.equal(f.story.broadcasts(), 0);
      assert.equal(
        (await f.db
          .prepare("SELECT COUNT(*) AS n FROM managed_releases")
          .first())!.n,
        0,
      );
    } finally {
      Date.now = realNow;
      await f.dispose();
    }
  });
}
test("missing public media holds registration before allocating a mint or fee", async () => {
  const f = await releaseFixture();
  try {
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      const response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(response.status, 200);
    }
    const audio = await preparePin(f.audio, "audio/mpeg");
    f.retained.delete(audio.uri.slice(7));
    const response = await f.sendRelease("register", { context: f.context });
    assert.equal(response.status, 503);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(
      (await f.db
        .prepare("SELECT COUNT(*) AS n FROM funded_registrations")
        .first())!.n,
      0,
    );
    assert.equal(f.adds(), 4);
  } finally {
    await f.dispose();
  }
});

test("publisher rotation during retained-media access prevents a new add", async () => {
  const f = await releaseFixture();
  try {
    f.beforeMedia(() => f.changeAuthority());
    const response = await f.sendRelease("pin", {
      context: f.context,
      role: "audio",
    });
    assert.equal(response.status, 202);
    assert.equal(f.adds(), 0);
    assert.equal(f.story.broadcasts(), 0);
  } finally {
    await f.dispose();
  }
});
test("publisher rotation during registration preflight prevents a new broadcast", async () => {
  const f = await releaseFixture();
  try {
    for (const role of ["audio", "lyrics", "ip_metadata", "nft_metadata"]) {
      const response = await f.sendRelease("pin", { context: f.context, role });
      assert.equal(response.status, 200);
    }
    f.story.beforeEstimate(() => f.changeAuthority());
    const response = await f.sendRelease("register", { context: f.context });
    assert.equal(response.status, 202);
    assert.equal(f.story.broadcasts(), 0);
    assert.equal(f.story.mints(), 0);
    assert.equal(f.adds(), 4);
  } finally {
    await f.dispose();
  }
});
