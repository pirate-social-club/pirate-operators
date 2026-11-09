// The V4 sign-in text the live V4 fixture issues as its challenge. It is a
// frozen copy of packages/protocol signInMessageV4 for the inputs below, so the
// web client's own CI (which installs apps/web only, without viem) never
// imports the root protocol package. test/learning-sign-in-fixture-text.test.ts
// rebuilds it with the shared builder and fails if the two ever differ.
export const fixtureSignIn = {
  origin: "https://study-v4.example",
  chainId: 6343,
  contract: `0x${"4".repeat(40)}`,
  communityId: `0x${"2".repeat(64)}`,
  publicationPolicy: `0x${"5".repeat(64)}`,
  learner: `0x${"a4".repeat(20)}`,
  nonce: `0x${"9".repeat(64)}`,
  issuedAt: 1793552400,
} as const;

export const fixtureSignInText = [
  "study-v4.example wants you to sign in with your Ethereum account:",
  "0xA4a4A4A4A4a4a4a4a4a4a4A4a4a4a4a4A4a4A4A4",
  "",
  "Sign in to this community and let it publish your Karaoke and Study results under its terms, version 4, until you turn them off in settings. This does not join, create a creator wallet or authorize spending.",
  "",
  "URI: https://study-v4.example",
  "Version: 1",
  "Chain ID: 6343",
  "Nonce: 9999999999999999999999999999999999999999999999999999999999999999",
  "Issued At: 2026-11-01T17:00:00.000Z",
  "Not Before: 2026-11-01T17:00:00.000Z",
  "Resources:",
  "- https://study-v4.example/learning/v4/terms",
  "- https://study-v4.example/learning/v4/privacy",
  "- urn:pirate:publication-policy:4:0x5555555555555555555555555555555555555555555555555555555555555555",
  "- urn:pirate:community:0x2222222222222222222222222222222222222222222222222222222222222222",
  "- eip155:6343:0x4444444444444444444444444444444444444444",
].join("\n");
