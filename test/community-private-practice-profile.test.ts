// Release wire contract failures prepared before the profile implementation.
import test from "node:test";
import assert from "node:assert/strict";
import {
  readPrivatePracticeProfile,
  privatePracticeAllows,
} from "../services/community-private-practice-profile.ts";
const h = (n: string) => "0x" + n.repeat(64);
const scope = {
  communityId: h("1"),
  installationId: h("2"),
  deploymentDigest: h("3"),
};
const profile = () => ({
  schema: "pirate.community-private-practice/1",
  ...scope,
  activities: {
    study: { kind: "private-v5", profileHash: h("4") },
    karaoke: null,
    dance: { kind: "private-v2", policyHash: h("5") },
  },
});
test("absence preserves the first-song profile; an explicit selection keeps the original publishing scope", () => {
  assert.equal(readPrivatePracticeProfile(undefined, scope), null);
  const selected = readPrivatePracticeProfile(
    JSON.stringify(profile()),
    scope,
  )!;
  assert.equal(selected.deploymentDigest, scope.deploymentDigest);
  assert.equal(selected.activities.study?.kind, "private-v5");
  assert.equal(selected.activities.dance?.kind, "private-v2");
  assert.equal(selected.activities.karaoke, null);
});
test("unknown, public, malformed and differently-bound selections never fall back to first-song or V4", () => {
  const input = profile();
  for (const body of [
    { ...input, schema: "pirate.community-private-practice/2" },
    { ...input, communityId: h("6") },
    { ...input, installationId: h("6") },
    { ...input, deploymentDigest: h("6") },
    { ...input, extra: true },
    {
      ...input,
      activities: {
        ...input.activities,
        study: { kind: "private-v4", profileHash: h("4") },
      },
    },
    {
      ...input,
      activities: {
        ...input.activities,
        dance: { kind: "publication-bound", policyHash: h("5") },
      },
    },
    {
      ...input,
      activities: {
        ...input.activities,
        dance: { kind: "private-v2", policyHash: h("0") },
      },
    },
    { ...input, activities: { study: null, dance: null } },
    { ...input, activities: { ...input.activities, names: true } },
  ])
    assert.throws(() =>
      readPrivatePracticeProfile(JSON.stringify(body), scope),
    );
  for (const raw of ["", "null", "[]", "{", "x".repeat(16385)])
    assert.throws(() => readPrivatePracticeProfile(raw, scope));
});
test("selection is immutable and only explicitly selected private routes are admitted", () => {
  const selected = readPrivatePracticeProfile(
    JSON.stringify(profile()),
    scope,
  )!;
  assert.throws(() =>
    Object.defineProperty(selected.activities.dance!, "policyHash", {
      value: h("9"),
    }),
  );
  for (const path of [
    "/api/study/song",
    "/api/study/lessons",
    "/api/dance/captures",
    "/api/media/uploads",
  ])
    assert.equal(privatePracticeAllows(selected, path), true, path);
  for (const path of [
    "/api/study-evil",
    "/api/studyx/song",
    "/api/dancex/captures",
    "/api/mediax",
    "/api/learning",
    "/api/publication-consent/v1/state",
    "/api/member-name",
    "/api/rewards",
    "/api/community/join",
    "/api/karaoke/tickets",
  ])
    assert.equal(privatePracticeAllows(selected, path), false, path);
  assert.equal(privatePracticeAllows(null, "/api/dance/captures"), false);
  const off = readPrivatePracticeProfile(
    JSON.stringify({
      ...profile(),
      activities: { study: null, karaoke: null, dance: null },
    }),
    scope,
  )!;
  assert.equal(privatePracticeAllows(off, "/api/dance/captures"), false);
});
