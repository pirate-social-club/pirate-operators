import test from "node:test";
import assert from "node:assert/strict";
import { completeImageRecipe } from "../deploy/linux/complete-image-recipe.ts";

const input = {
  imageBase: "docker.io/library/node:24.18.1-bookworm-slim@sha256:" + "a".repeat(64),
  uid: 1000,
  gid: 1000,
  installedReleasePath: "/opt/pirate-staging/releases/9a4d7c37",
};

test("the image recipe pins the CA bundle mode for the non-root user", () => {
  const recipe = completeImageRecipe(input);
  assert.match(recipe,
    /^FROM [^\n]+\nCOPY --chmod=0644 release\/toolchain\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt\n/);
  assert.doesNotMatch(recipe, /COPY release\/toolchain\/ca-certificates\.crt/);
  assert.doesNotMatch(recipe, /\nCOPY (?!--chmod|--chown)/);
  assert.match(recipe, new RegExp("\nCOPY --chown=" + input.uid + ":" + input.gid + " release/ "));
  assert.match(recipe, new RegExp("\nUSER " + input.uid + ":" + input.gid + "\n"));
});

test("the CA bundle line stays a single COPY before the release tree", () => {
  const recipe = completeImageRecipe(input);
  const lines = recipe.split("\n");
  const ca = lines.filter((line) => line.includes("ca-certificates.crt"));
  assert.equal(ca.length, 1);
  const caIndex = lines.findIndex((line) => line.includes("ca-certificates.crt"));
  const releaseIndex = lines.findIndex((line) => line.includes(" release/ "));
  assert.ok(caIndex >= 0 && releaseIndex > caIndex);
  assert.equal(lines[0], "FROM " + input.imageBase);
});
