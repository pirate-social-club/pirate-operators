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

The workspace_owner chose a standard SIWE (EIP-4361) login text, with the same
single signature covering login and the versioned publication permission. The
sign-in challenge is one EIP-4361 message signed through MOSS `signMessage`,
the call the deployed login already uses, so MOSS's own SIWE check applies:
it compares the message's domain with the host of the page that opened it,
the address with the connected account and the chain with its network, and
refuses to sign before Not Before. One user action covers both purposes, and
the sign-in screen is unchanged.

The text is built only by viem `createSiweMessage`, through
`signInMessageV4` in packages/protocol:

```
{host} wants you to sign in with your Ethereum account:
{learner, EIP-55}

{Statement}

URI: {community origin}
Version: 1
Chain ID: {6343, or 31337 locally}
Nonce: {64 lowercase hex digits}
Issued At: {issuedAt, YYYY-MM-DDTHH:MM:SS.000Z}
Not Before: {the same}
Resources:
- {origin}/learning/v4/terms
- {origin}/learning/v4/privacy
- urn:pirate:publication-policy:4:0x{publicationPolicy}
- urn:pirate:community:0x{communityId}
- eip155:{chainId}:0x{V4 contract}
```

There is no Expiration Time and no trailing newline. The Statement is a draft
for the workspace_owner's approval, held as `SIGN_IN_STATEMENT` in the
contract and `SIGN_IN_STATEMENT_V4` in packages/protocol, which a test keeps
equal:

> Sign in to this community and let it publish your Karaoke and Study results
> under its terms, version 4, until you turn them off in settings. This does
> not join, create a creator wallet or authorize spending.

`LearningResultsV4` fixes the community origin at construction (`https://`,
a lowercase host, an optional port, nothing else) and rebuilds this exact
text on chain from `authorize(SignIn{learner, nonce, issuedAt}, signature)`:
`signInMessage` renders it and `signInDigest` is its EIP-191 personal-sign
hash, which equals viem `hashMessage(text)` and is the authorization id. A
text for another host, community, policy, chain or contract is a different
text, so its signature is `invalid_consent`. The server verifies login with
viem `verifyMessage`, which covers EOAs and ERC-1271/6492 smart accounts such
as MOSS. For a smart account the contract passes the same digest to
`isValidSignature`; an IthacaAccount-style account checks its key's signature
over its own `ERC1271Sign(bytes32 digest)` wrapper of that digest. The
deployed plain login text and the former EIP-712 `SignIn` never authorize.

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

- The signature is valid for `learner` (ECDSA or ERC-1271) over the text the
  contract renders from its own origin, `communityId`, `publicationPolicy`,
  chain and address, the digest is unused,
  `issuedAt <= block.timestamp <= issuedAt + RELAY_WINDOW` (thirty days, the
  community session, so a learner whose first practice comes days after
  signing in is never asked to sign in again), and
  `issuedAt > revokedAt[learner]`.
- `issuedAt` comes from the application's own clock, backdated by at most
  `SIGN_IN_BACKDATE_S` (60 seconds) so that a wallet whose clock is behind
  still signs (Not Before equals Issued At), and never backdated into the
  minute after the account's last withdrawal recorded by the application:
  `issuedAt = min(now, max(now - 60, floor(lastWithdrawnAt / 1000) + 61))`.
  The application records a withdrawal on its own clock when the operator
  accepts the Revocation, which can be before the revoke is mined, so the
  chain's `revokedAt` can be a little later than the record; within that
  minute a sign-in is issued at the current second, as it was before the
  backdate.
  A V4 session ends no later than `(issuedAt + RELAY_WINDOW)`, so a sign-in
  relayed during its session is never stale. When the application's clock is
  more than the backdate ahead of the latest block, the operator answers
  `sign_in_not_yet_valid`, a retryable refusal distinct from the expired
  `stale_sign_in`. The application keeps the row pending and retries; it never
  refuses a sign-in for that reason. A withdrawal made directly on chain is
  not known to the application, so a sign-in within the minute after it is
  issued before it and refused (`revoked_sign_in`); it never authorizes, and
  the next sign-in after that minute does.
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

- Sign-in: the challenge and verify routes issue and check the V4 SIWE text;
  the live app signs it with `signMessage`, as it signs the plain login. The
  sign-in screen and its Terms and Privacy links are unchanged. The session
  view reports whether the account's publication authorization is recorded.
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
withdrawal on the account and stops relaying that account's sign-ins. While
the account's public results are off, `/api/auth/challenge` gives it only the
plain deployed SIWE login, never the V4 text, so a V4 sign-in made after a
withdrawal exists only once the learner has turned public results back on. Public
practice then stays unavailable until the learner turns public results back on
in account settings; their next sign-in is then relayed when they next
practise. That is a settings
control, not an exercise prompt. The contract enforces only that no sign-in made
at or before the withdrawal can restore permission.

The application also never stores a sign-in issued at or before the account's
last withdrawal, so a challenge requested before turning off and signed after
turning back on is a login only. A login replaces only a pending, unrequested
sign-in that is not newer than its own, so an older challenge completed late
never displaces a newer one. The scheduled relay takes the requested rows
tried least recently first, so rows that stay retryable take turns.

Turning public results off closes every open Study lesson of the account in
that community at once, privately, as abandoned with reason `consent_ended`.
That covers V4 lessons, bound or not (a start that failed after creating its
lesson, or one whose binding is still landing), and any V3 lesson still open
from before V4 became the records. A start whose permission check came just
before the withdrawal re-checks once its lesson exists and closes it the same
way. The withdrawal also stops V3 publication for that learner in that
community. When the operator accepts the learner's signed V4 Revocation, it
records that the learner's results bound to an earlier version (a V3 Study
lesson, or a V2 or V3 Karaoke run) and not yet sent on chain stay private.
Both V3 dispatch paths check this just before sending, so a V3 result queued
in the application or held at the operator is kept private with reason
`authorization_withdrawn`. "Not yet sent" is decided by the operator's
transaction journal, as described under "Unsent and sent V3 result
transactions" below. Turning public results back on never resumes V3
publication, because V4 is the records now. None of this adds a menu item or a
second wallet signature, and the learner's V3 enrollment is not revoked on
chain, which only the learner's own signature could do.

A learner may also withdraw by calling `revoke` on the V4 contract directly,
which never reaches the operator's relay. That stops V3 publication too. When
the operator's V4 contract is configured, both V3 dispatch paths read the
learner's `revokedAt` from it whenever the operator's record above is absent:
the Study path at the block its dispatch already observes, and both paths
again in the check just before sending. Only `revoke` writes `revokedAt`, and
a later sign-in (`authorize`) never resets it, so it stays nonzero from the
first withdrawal on, even when the learner signs in again before the result is
dispatched. A nonzero value is recorded as the same operator record and keeps
the result private with reason `authorization_withdrawn`. A failed read sends
nothing: the result stays pending and is retried. With no V4 contract
configured, nothing is read. The application notices a direct withdrawal when
the operator refuses new Study or Karaoke work for missing permission. It
records the withdrawal, as before, and while the chain withdrawal holds with
no later sign-in it also closes the account's open V3 and V4 Study lessons in
that community as abandoned with reason `consent_ended`, the same closure the
settings turn-off uses. A V3 lesson the application has not closed, because
the learner signed in again first, still cannot publish: its result is
withheld by the operator's read.

### Unsent and sent V3 result transactions

The rules here apply to the first revision of a result bound to an earlier
version (a V3 Study lesson, or a V2 or V3 Karaoke run). Corrections and V4
results are not affected.

Every send of such a result checks the withdrawal: the Study and Karaoke
publication paths, the operator's transaction dispatch, and its background
transaction recovery (`recoverLearningTransactions`), which rebroadcasts
unmined transactions. The operator's own record of the Revocation is checked
where the nonce is allocated and again immediately before any send, with no
asynchronous step in between. The V4 contract's `revokedAt` is read before
each send; a failed read sends nothing and leaves the transaction for later.

A dispatch can fail after its transaction was queued and before a nonce was
allocated: a failed `eth_gasPrice` read, `gas_price_above_limit`,
`total_fee_limit`, or a failure inside the allocation, which rolls back with
its nonce. Such a result was never sent. The next attempt still checks the
withdrawal, and a withheld result's queued transaction is removed, so no path
can dispatch it later, and its sponsorship reservation is refunded.

From allocation on, the journal row of a result transaction records whether
it was ever handed to an RPC: `broadcast` is `none` from allocation until
immediately before the first send, then `attempted`. A row withheld while
`none` was provably never sent. Its own bytes are never sent, and the nonce
is consumed in its place by a cancellation: a legacy transaction at the same
nonce, of zero value, to the operator's own address, with empty calldata and
no authorization list. It meets the limits every dispatch meets: the fee read
must not exceed the sponsor gas price, its gas, from `eth_estimateGas`, must
fit the withheld transaction's own gas limit, and the journal's fee total,
counting this nonce once, by its cancellation, must stay within the sponsor
cap. When the limits refuse, nothing is sent and the cancellation waits, like
any dispatch. The row keeps the withheld transaction's kind, reference,
target, calldata, signed bytes and hash, adds `withheld` and `cancellation`,
and is marked mined with status `cancelled`, which nothing reads as a
publication. The result is private, never submitted, with reason
`authorization_withdrawn`, and no result is published for it.

A row marked `attempted`, and any row written before the `broadcast` field
existed, may already have been sent, so the operator treats it as sent or
uncertain. The journal holds no evidence that would show such a row was never
sent, and none is accepted. V3 does not read V4, so a V3 result transaction
already sent, or whose send outcome is uncertain, when the withdrawal happens
can still be mined, and so can one sent after the operator's last read of
`revokedAt` and before a direct revoke it has not yet observed. Once the
operator observes the withdrawal, it sends no further publication attempt for
that transaction: the row is marked `withheld`, its bytes are never sent
again, and only its receipt is reconciled. If that transaction is mined, the
result is published. It is never cancelled or replaced. While it stays
unmined, its nonce stays open and the operator's later transactions wait
behind it; each recovery pass logs `operator_nonce_withheld` with the nonce,
kind, reference and hash, and the journal row `tx:<nonce>` carries
`withheld`. Resolving such a nonce is left to an operator.

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
  the selection's `controller`, the grader roles for activities 1 and 2 of
  the configured publisher, and `communityOrigin()` against the selection's
  `communityOrigin` and the community's origin
  (`harness/learning-v4-release-observation.ts`). The release profile
  requires the selection's `communityOrigin` to be canonical, one for which
  `signInMessageV4` builds a text, and equal to the application profile's
  `origin` (`harness/learning-v4-release-profile.ts`). The constructor also
  accepts some origins the builder refuses (a one-letter or numeric top
  label, a label over 63 characters, an IPv4 form that `URL` rewrites,
  invalid punycode); a contract deployed with one could never sign anyone
  in, and `communityOrigin` is immutable, so the release refuses them.

## Phishing and relay (settled by the SIWE sign-in)

The former typed `SignIn` had no wallet-side origin check, so a phishing page
could obtain a valid sign-in and permission, and a crafted future `issuedAt`
could be relayed after a withdrawal. The SIWE sign-in closes this in three
layers:

1. The text is valid on chain only for the community origin fixed in the
   contract. MOSS signs a SIWE message only for the host of the page that
   opened it (`domainMismatch` blocks Sign), so a phishing host can obtain
   only a text naming itself, which the contract refuses as `invalid_consent`.
   The release observation checks that origin before binding the contract.
2. Not Before equals Issued At, and MOSS refuses to sign while Not Before is
   later than the device clock, so a future `issuedAt` cannot be signed in
   advance; with `issuedAt > revokedAt`, an accepted sign-in was made after
   the withdrawal.
3. While an account's public results are off, the application issues it only
   the plain login, so a V4 text exists after a withdrawal only once the
   learner turns public results back on.

Layers 1 and 2 rest on MOSS's checks, which the hosted wallet can change; the
on-chain origin and layer 3 do not. test/learning-sign-in-moss.test.ts holds
the hosted wallet's strict pattern, `checkSiwe` and parser verbatim (bundle
sha256 `7c258d10...6accaf`, fetched 2026-11-09) and checks the V4 text against
them. What remains to confirm with a real MOSS account before deployment: that
the account's on-chain `isValidSignature(hashMessage(text), signature)` accepts
MOSS `signMessage` output, that MOSS shows the Statement rather than signing
silently, and that the one-minute backdate covers real device clocks. The
Revocation stays EIP-712, signed with `signData` in account settings.

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
- the compact `SignIn` type `{ learner, nonce, issuedAt }` and the
  `SignInV4Context` `{ origin, chainId, contract, communityId,
  publicationPolicy }`;
- `signInMessageV4(context, signIn)`, the exact text, and `signInIdV4`, its
  EIP-191 hash, which is the authorization id;
- `readSignInMessageV4(text)`, which returns the context and sign-in only
  when `signInMessageV4` rebuilds the text byte for byte;
- `SIGN_IN_STATEMENT_V4`, `SIGN_IN_BACKDATE_S`, `signInIssuedAtV4` and
  `canonicalOriginV4`, the constructor's origin rule narrowed to origins
  `signInMessageV4` can render;
- `resultsV4Domain(chainId, contract)`, name "Pirate Learning Results",
  version "4", now used only by the Revocation;
- `resultsV4Abi`. This is the V3 result ABI (`publish`, `correct`,
  `invalidate`, `commitments`, `policyFor`, `activatePolicy`, `VERSION`,
  `ResultPublished`, `ResultInvalidated`) plus `authorize`, `revoke`,
  `nextNonce`, `authorizedSince`, `revokedAt`, `authorizationLearner`,
  `authorizationIssuedAt`, `signInDigest`, `signInMessage`,
  `communityOrigin`, `SIGN_IN_STATEMENT`, `Authorized` and `Revoked`.

Targets:
- `ResultsTarget.version` becomes `2 | 3 | 4`.
- The operator Worker reads `RESULTS_V4_CONTRACT`, which takes precedence over
  V3 for new work when set. The application Worker reads
  `STUDY_RESULTS_V4_CONTRACT`, which must equal the directory's
  `learningRecords`, as V3 does today.
- `retainedTarget` keeps V2 and V3 bindings valid for historical work.

Sign-in, in the application:
- `/api/auth/challenge` returns `{ id, kind: "sign-in-v4", message }` when
  V4 is configured and the account's public results are not off, and the
  plain SIWE `{ id, message }` otherwise.
- `/api/auth/verify` takes `{ id, signature }` and verifies the stored text
  with `verifyMessage` on chain 6343. A stored V4 text must read back as this
  learner's, community's and origin's sign-in before any verifier sees it.
- On success it creates or reuses `credential_bindings` (moss, 6343,
  lowercased wallet) and `community_sessions` exactly as today.
- It also stores a row in a new D1 table, `learning_authorizations`
  (migration 0013, renumbered from 0011; applied only when a release selects
  V4, after the deployed 0012), with: `authorization_id` (primary key, the
  text's EIP-191 hash), `account_id`, `subject`, `sign_in_json` (the compact
  `authorize` arguments), `message` (the exact signed text), `signature`,
  `policy_hash`, `policy_version`,
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
- `POST /authorization` carries `{ signIn, signature }`, with `signIn` the
  compact `{ learner, nonce, issuedAt }`.
- `acceptAuthorization` takes the authorization id from the contract's own
  `signInDigest`, so it needs no origin setting, verifies an ERC-8010
  signature with `verifyHash` over that id, simulates `authorize`, reserves
  sponsorship and submits
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
