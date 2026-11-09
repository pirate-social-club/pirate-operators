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

A successful sign-in only stores the signature. The application relays it to
`LearningResultsV4.authorize(SignIn, signature)`, sponsored as enrollment is
today, when the learner first starts Study or Karaoke work and has no recorded
authorization since their last withdrawal. Signing in without practising
therefore costs no transaction. The relay runs inline on the start path; while
it is outstanding the start answers `study_authorization_pending` or
`karaoke_authorization_pending` and the client's bounded retry repeats the same
request. An account keeps at most one pending sign-in: a new sign-in replaces
one whose relay was never requested and adds nothing while a requested relay is
outstanding. A failed requested relay is retried on schedule from the stored
signature until its relay window ends; a sign-in whose relay was never
requested is never relayed on schedule. Contract rules:

- The signature is valid for `learner` (ECDSA or ERC-1271), `communityId` and
  `publicationPolicy` match the contract's immutable values, the digest is
  unused, `issuedAt <= block.timestamp <= issuedAt + RELAY_WINDOW` (thirty
  days, the community session, so a learner whose first practice comes days
  after signing in is never asked to sign in again), and
  `issuedAt > revokedAt[learner]`.
- `issuedAt` is the application's own clock, never backdated, because a
  backdated sign-in could fall at or before a just-recorded withdrawal. When
  the application's clock is ahead of the latest block, the operator answers
  `sign_in_not_yet_valid`, a retryable refusal distinct from the expired
  `stale_sign_in`. The application keeps the row pending and retries; it never
  refuses a sign-in for that reason.
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
  learner leaves, at once when the learner turns public results off in
  settings, or at once on a known refusal because permission was withdrawn
  outside the application. Consent end no longer exists as a bound. Session expiry still
  requires a normal sign-in, and does not close lessons.
- Terms and Privacy links are removed from the Study and Karaoke exercise
  surfaces in every mode. The documents stay in normal site navigation (the
  site footer) and on the sign-in screen. The footer links the learning
  documents of the community's actual version: `/learning/v3/terms` and
  `/learning/v3/privacy` in a V3 community, `/learning/v4/terms` and
  `/learning/v4/privacy` in a V4 community.
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
in account settings; their next sign-in is then relayed when they next
practise. That is a settings
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

Release observation:
- Before `LEARNING_RESULTS_V4_CONTRACT` is bound, the release reads the
  deployed V4 contract at a pinned block and checks the runtime code hash
  against the selection's `codeHash`, `VERSION() == 4`, `communityId`,
  `publicityPolicy` against `learningV4PublicityPolicy`, the controller against
  the selection's `controller`, and the grader roles for activities 1 and 2 of
  the configured publisher (`harness/learning-v4-release-observation.ts`).

## Open security question

EIP-712 typed data does not get the wallet-side domain check that EIP-4361
SIWE gets. A SIWE-aware wallet compares the message's domain with the
requesting origin and warns or refuses on a mismatch. Typed data carries
`origin` only as a field; the server checks it, but the wallet is not required
to. A phishing page could therefore ask a learner to sign the `SignIn` typed
data for this community, and the signature would be valid for login and for
publication permission. Before deployment, someone must confirm whether the
MOSS wallet's `signData` shows or enforces the requesting origin, and record
the answer here.

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

## Implementation interfaces (fixed 2026-11-09)

These are the contracts between phases and with Agent 2. A change to any of
them is announced before it lands.

Protocol, in packages/protocol/learning-results-v4.ts:
- the `SignIn` type and `signInTypes`;
- `learningResultsV4Domain(chainId, contract)`, name "Pirate Learning
  Results", version "4";
- `signInIdV4` (the EIP-712 digest, which is the authorization id);
- `resultsV4Abi`. This is the V3 result ABI (`publish`, `correct`,
  `invalidate`, `commitments`, `policyFor`, `activatePolicy`, `VERSION`,
  `ResultPublished`, `ResultInvalidated`) plus `authorize`, `revoke`,
  `nextNonce`, `authorizedSince`, `revokedAt`, `authorizationLearner`,
  `authorizationIssuedAt`, `signInDigest`, `Authorized` and `Revoked`.

Targets:
- `ResultsTarget.version` becomes `2 | 3 | 4`.
- The operator Worker reads `RESULTS_V4_CONTRACT`, which takes precedence over
  V3 for new work when set. The application Worker reads
  `STUDY_RESULTS_V4_CONTRACT`, which must equal the directory's
  `learningRecords`, as V3 does today.
- `retainedTarget` keeps V2 and V3 bindings valid for historical work.

Sign-in, in the application:
- `/api/auth/challenge` returns `{ id, kind: "sign-in-v4", typedData }` when
  V4 is configured, and the SIWE `{ id, message }` otherwise.
- `/api/auth/verify` takes `{ id, signature }` and verifies with
  `verifyTypedData` on chain 6343.
- On success it creates or reuses `credential_bindings` (moss, 6343,
  lowercased wallet) and `community_sessions` exactly as today.
- It also stores a row in a new D1 table, `learning_authorizations`
  (migration 0013, renumbered from 0011; applied only when a release selects
  V4, after the deployed 0012), with: `authorization_id` (primary key), `account_id`,
  `subject`, `sign_in_json`, `signature`, `policy_hash`, `policy_version`,
  `issued_at`, `state` (`pending`, `recorded` or `refused`), `tx_hash`,
  `relay_requested_at` (set when a Study or Karaoke start first requests the
  relay; the scheduled retry covers only rows that have it), `created_at` and
  `updated_at`.
- A second table, `learning_settings`, holds `account_id` (primary key),
  `public_results_withdrawn_at`, set while public results are off, and
  `last_withdrawn_at`, the latest withdrawal, kept after turning on. Both are
  milliseconds.
- A sign-in relays only when the account is not withdrawn and has no
  `recorded` authorization issued after its last withdrawal. Session state,
  the authorization a new lesson or run binds, and the relay count only
  sign-ins issued after that withdrawal.
- `/api/session` adds
  `publicResults: "on" | "pending" | "off" | "unavailable"`. When
  `STUDY_RESULTS_V4_CONTRACT` is set, a failed configuration read reports
  `pending`, never `unavailable`, so a temporary outage cannot fall back to
  the V3 enrollment prompt.
- When V4 is the configured learning records, the V3 enrollment request route
  `/api/karaoke/enrollment` is refused with `enrollment_unavailable`.

Relay, in the operator Worker:
- `POST /authorization` carries `{ signIn, signature }`.
- `acceptAuthorization` simulates `authorize`, reserves sponsorship and submits
  the transaction kind `record_authorize`. It is idempotent per authorization
  id, and `resumeAuthorizations` retries it from the alarm. A sign-in whose
  `issuedAt` is later than the latest block's timestamp is refused, before
  anything is reserved, with the retryable `sign_in_not_yet_valid`.
- `GET /authorization/:learner` returns `{ since, revokedAt }` read from chain.
- `POST /authorization/revoke` with `{ learner }` returns the typed V4
  `Revocation` to sign; with `{ learner, nonce, signature }` it relays `revoke`
  as `record_revoke`, keyed by the contract's `revocationDigest`, and the alarm
  retries it.

Binding:
- A V4 Study lesson offer adds `authorizationId`, and so does a Karaoke ticket.
- The operator accepts the binding only when all of these hold:
  `authorizationLearner(id) == learner`,
  `authorizationIssuedAt(id) <= startedAt`, `authorizedSince(learner) != 0`
  and `authorizedSince(learner) <= authorizationIssuedAt(id)`.
- The binding stores `authorization: { id, issuedAt, target }` in place of
  `enrollment`. V2 and V3 bindings keep `enrollment`.

Publication:
- V4 results set `enrollmentId` to the authorization id, and `sessionId` uses
  the same digest formula with that id.
- Before dispatch, publication re-reads `authorizedSince`. If it is 0 or later
  than the authorization's `issuedAt`, the job goes private with reason
  `authorization_withdrawn`.
- A Study terminal other than `completed` goes private with reason
  `unfinished` and never dispatches. The bounded private-history cleanup and
  erasure proof are unchanged.
- Karaoke keeps V3 semantics: every run's final result is published.

Study close bound for a V4 lesson:
- `open_limit` at `startedAt` + 30 days;
- leaving;
- a known `enrollment_required` refusal after withdrawal, recorded as
  `consent_ended`.
- There is no consent-expiry bound.

Withdrawal:
- Account settings offers "Turn off public results". This uses the existing
  signed revocation, which is an explicit settings action, never an exercise
  prompt. It sets `public_results_withdrawn_at`.
- Turning public results off also closes the account's open V4 Study lessons
  at once, as abandoned with reason `consent_ended` at that time, through the
  lesson service's own closure. Their private results stay unpublished and
  the bounded retention and erasure apply.
- "Turn on public results" clears that and performs a normal sign-in, whose
  signature is relayed when the learner next starts practice.
- The application routes are `POST /api/learning/public-results/off` (request,
  then the signed revocation) and `POST /api/learning/public-results/on`.
- When the operator refuses new work with `study_authorization_required` or
  `karaoke_authorization_required`, the application reads
  `GET /authorization/:learner`. A chain revocation with no counted sign-in
  after it is recorded as a withdrawal, so settings offer turning public
  results back on. Nothing is relayed automatically.

Reader, for Agent 2:
- `readPublicResults` in packages/records accepts V3 or V4 by pinned code
  hash and `VERSION()`.
- It returns the same verified-result shape. A V4 `enrollmentId` is the
  authorization id.
