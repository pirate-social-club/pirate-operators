# Learning results V4: one sign-in, then exercises only

Status: design for review, 2026-11-09. Nothing here is deployed.

## Goal

A learner signs in once with MOSS and then studies or sings with no further
wallet signature, checkbox, consent modal or periodic learning-enrollment
prompt. Study and Karaoke results stay public and keep their reward
qualification. Very verification at Claim and explicit signatures for actual
payments are unchanged; this concerns practice only.

## Why the current contract cannot do this

Sign-in today is a SIWE (EIP-4361) personal-sign message whose statement says it
only signs in. Publication permission is a second, separate EIP-712
`Enrollment` signature that `LearningResultsV3.enroll` verifies. The grant it
creates lasts thirty days, and `publish` requires the result's `enrollmentId` to
equal the learner's current grant. A new grant therefore strands every lesson
bound to the previous one. Having Terms and Privacy pages does not authorize
that contract to accept anything else, and old SIWE login signatures must not
be reinterpreted as permission.

## Design

### One signature with both purposes

The sign-in challenge becomes EIP-712 typed data signed through MOSS
`signData`, the call already used today for enrollment. One user action covers
both purposes:

```
EIP712Domain(name "Pirate Learning Results", version "4", chainId, verifyingContract = V4)
SignIn(
  address learner,
  bytes32 communityId,
  string origin,              // the community origin, checked by the server like SIWE's domain
  bytes32 publicationPolicy,  // hash of the versioned publication policy accepted by signing in
  bytes32 nonce,              // the server's single-use login challenge nonce
  uint64 issuedAt,
  uint64 expiresAt            // login challenge expiry, five minutes as today
)
```

The server verifies login with viem `verifyTypedData`, which covers EOAs and
ERC-1271/6492 smart accounts such as MOSS, exactly as `verifyMessage` does
today. It stores the challenge, the signature and the accepted policy hash and
version against the account. The challenge, single use, expiry and session
rules are otherwise unchanged. A SIWE signature cannot verify under this V4
domain, so no old login becomes permission.

### Recording authorization on chain

After a successful sign-in, the application relays the same signature to
`LearningResultsV4.authorize(SignIn, signature)`, sponsored as enrollment is
today. It relays only when the learner has no live authorization. A failed relay
is retried from the stored signature until its relay deadline. Contract rules:

- The signature is valid for `learner` (ECDSA or ERC-1271), `communityId` and
  `publicationPolicy` match the contract's immutable values, the digest is
  unused, `issuedAt <= block.timestamp <= issuedAt + RELAY_WINDOW` (seven days),
  and `issuedAt > revokedAt[learner]`.
- The first accepted authorization after any revocation sets
  `authorizedSince[learner] = issuedAt`. Later sign-ins record their digest but
  never move `authorizedSince`, so signing in again cannot end other lessons.
- No expiry. Authorization lasts until the learner withdraws it.
- `revoke(learner, nonce, signature)` is kept as in V3: by the learner directly
  or relayed with the learner's revocation signature. It sets `revokedAt` and
  clears `authorizedSince`. Withdrawal comes from the account settings, not an
  exercise.

The operator cannot publish against an arbitrary wallet. `publish` still requires
the grader role and a learner-signed authorization.

### Publishing

`Result.enrollmentId` keeps its V3 position and becomes the authorization digest
in force when the lesson started. `publish` requires:

- `authorizationLearner[r.enrollmentId] == r.learner`;
- `authorizedSince[r.learner] != 0 && authorizedSince[r.learner] <= r.startedAt`, so
  the lesson started under permission that has not been withdrawn since;
- the activity, grader, coverage, period-policy and commitment rules unchanged
  from V3.

Corrections and invalidations keep their V3 rules. As before, authorized
corrections or invalidations remain possible after withdrawal. Outcomes keep the
V3 encodings. Recordings, transcripts and private retries never enter calldata.

### Application

- Sign-in: the challenge and verify routes issue and check the typed `SignIn`;
  the live app calls `signData` instead of `signMessage`. The session view
  reports whether the account's publication authorization is recorded.
- Study and Karaoke: the enrollment request/sign step
  (`apps/web/src/live/study-enrollment.ts`, the Karaoke equivalent) is removed.
  A lesson or run binds to the account's recorded authorization. A session
  created before V4, with no authorization, simply signs in again.
- Background retention is separate from sessions and permission. A new Study
  lesson closes privately thirty days after it started (`open_limit`), when the
  learner leaves, or at once on a known refusal because permission was
  withdrawn. Consent end no longer exists as a bound. Session expiry still
  requires a normal sign-in, and does not close lessons.
- Terms and Privacy links are removed from the Study and Karaoke exercise
  surfaces. The documents stay in normal site navigation and on the sign-in
  screen.
- Historical V2/V3 contracts, results and private-history rules are unchanged.
  V3 lessons in progress keep their V3 binding and close by their existing
  rules.

### Policy text

A new versioned publication policy replaces the V3 disclosure's wording about a
standing permission with an end date and a separate learning enrollment. It says
that signing in authorizes public results for Study and Karaoke until withdrawn
in settings. Its hash is the V4 constructor's immutable `publicationPolicy`, and
the Terms/Privacy pages carry the text. The content needs the workspace_owner's
approval before deployment.

### Withdrawal and later sign-ins

Because signing in is the permission, a learner who withdraws must not be
re-authorized silently by their next login. The application records the
withdrawal on the account and stops relaying that account's sign-ins. Public
practice then stays unavailable until the learner turns public results back on
in account settings, which relays their next sign-in. That is a settings
control, not an exercise prompt. The contract enforces only that no sign-in made
at or before the withdrawal can restore permission.

### Rewards source succession (Agent 2)

Reward qualification reads one pinned results source through readPublicResultsV3.
V4 keeps the Result struct, the ResultPublished and ResultInvalidated events,
the outcome encodings, the grader key and the policy rules, so a V4 reader can
reuse the same verification. Only the permission events change. Agent 2 builds
the append-only source succession (V3 kept for historical offers, V4 added).
Sign-in keeps the credential_bindings row (moss, 6343, lowercased wallet), and
`learner` stays that wallet. Custody of the controller key and the deploy, and
the directory revision naming V4, are assigned by the coordinator. That
revision is sequenced with the publishing lane's policy revision.

## Open product decision

Unfinished lessons close privately and earn no rewards. A completed lesson
publishes; an unattended one does not. This awaits the workspace_owner's
decision. The design supports either choice.

## Release order

Release custody (Agent 2) deploys the reviewed V4 contract and grants the grader
roles. Then come the operator module, which accepts V4 bindings, and then the
application. The deployed V3 contract and operator stay in place for historical
results. Reward qualification must read V4 results as well as V3. Agent 2 owns
that change and confirms it before release.
