# Operator protocol: admission, publication and participation

Current design contract, reconciled 2026-11-04. The implemented local skeleton
is a subset. Restoring these requirements is not evidence that the full
protocol or real-provider checks have run.

The [setup-to-first-song plan](decentralized-setup.md) is the current priority.
This document restores the non-obsolete requirements accidentally removed from
the staging protocol. Obsolete payment transport and public-chain deployment
instructions are deleted. The [payment specification](operator-payments.md) owns
purchase accounting and current karaoke result fields. Its exact copy is published here so the protocol
has a readable dependency. [Source provenance](payment-specification-source.json)
pins the copy to the local implementation branch at 0dec600. Section 11 of that
specification describes that branch, not the runtime in this documentation PR.
The approved browser contract owns cookie and WebSocket behavior. The creator-wallet specification
owns its separate song-registration proof.

## 1. Purpose and scope

A community authenticates its own operator and participants, admits and
publishes songs through selected operators, and controls its own records,
moderation policy and deployment. It requires no global Pirate user account.
The first complete delivery is community setup followed by a real admitted
song appearing and playing at app.tld. Customer name buying, gas sponsorship,
karaoke rewards and Telegram are later work.

Spaces support is deferred beyond the decentralized community MVP. Wizard v1
starts on ordinary HTTPS, with HNS as an optional follow-up for that slice;
the wizard may mention Spaces only as unavailable
"Coming soon" information. Spaces services, issuance and a Cloudflare Containers
port are not prerequisites for first-song delivery. The setup plan owns this
scope and the later deployment qualification; existing central Spaces services
are outside this deferral.

Signed operator evidence attributes a verdict; it does not prove a provider
was called or that the verdict is honest. Communities choose trusted operators
and bound service spending. Shared public directory records do not become a
private cross-community identity directory. These requirements do not authorize
production deployment, new credentials or mainnet transactions.

## 2. Roles

The community operator controls setup, trusted providers, policies and service
configuration. A participant controls the wallet used within the community.
A moderation/scoring operator owns its provider credentials and signs evidence.
The publication gate is a pure function over current facts and valid evidence.
The ticket issuer signs bounded karaoke attempts. A later qualification
verifier consumes operator results under a frozen reward policy. Reward pools
and Very attesters retain their separately documented limits.

## 3. Encoding conventions

Content digests are SHA-256 over the exact bytes, written as `0x`-prefixed
lowercase hex and typed `bytes32` where signed. Text inputs are hashed as the
exact UTF-8 bytes of the stored artifact revision. Operators never normalize
text before hashing.

Structured bodies (inputs, details, manifests, policies, summaries) are JSON
canonicalized with RFC 8785 (JCS) and hashed with SHA-256. Signed envelopes
carry those hashes, never the bodies.

Off-chain signatures are EIP-712 over the domain `{ name: "Pirate Operators",
version: "1" }`, with no chain ID and no verifying contract. Envelopes the
pool contract checks use a separate domain:

```text
{ name: "Pirate Reward Pool", version: "1", chainId, verifyingContract }
```

Service keys are secp256k1. The signer address recovered from a signature
must equal the envelope's declared signer.

Times are integer Unix seconds unless a field name ends in `Ms`. Amounts are
integers in the asset's base units.

## 4. Evidence records

### 4.1 Envelope

Every check produces one envelope, signed by the operator:

```text
Evidence {
  string  check          // see 4.2
  string  schema         // e.g. "pirate.evidence.audio-identification/1"
  string  submissionId
  string  communityId
  string  jobId
  bytes32 subject        // the primary input digest for this check
  bytes32 inputsHash     // sha256(JCS(inputs))
  string  evaluator      // operator software version and provider pins
  string  policy         // evaluation policy version the operator applied
  string  result         // enum value defined by the check
  bytes32 detailsHash    // sha256(JCS(details))
  uint64  issuedAt
  uint64  expiresAt
  address operator
}
```

The evidence identifier is the EIP-712 digest. The `inputs` and `details`
bodies travel beside the envelope. The gate recomputes both hashes and checks
`inputs` against the submission's current facts. `details` may hold restricted
provider evidence; it is retained but never published.

Binding `submissionId` and `communityId` prevents evidence from being moved
to another submission or community. Within one submission, evidence stays
reusable across revisions as long as its `subject` and `inputs` still match
the current revision.

### 4.2 Checks

| check | subject | inputs body | result values |
|---|---|---|---|
| `audio.identification` | sealed song SHA-256 | see 4.3 | `identified`, `not_identified`, `inconclusive` |
| `title.rating` | title revision SHA-256 | `{ titleRevision, titleSha256 }` | `general`, `adult_18` |
| `lyrics.classification` | lyrics revision SHA-256 | `{ lyricsRevision, lyricsSha256 }` | `general`, `adult_18` (details add `explicit`, `primaryLanguage`, optional `secondaryLanguage`) |
| `artwork.display` | normalized cover artifact SHA-256 | `{ songSha256, coverSha256, normalization }` | `permitted`, `withheld` |

Artwork evidence controls only whether the cover is displayed. It never
raises the song's rating; this follows the cover-art amendment of 2026-08-28
in spec 013. The rating is the strictest of `title.rating`,
`lyrics.classification` and the author's raise-only declaration. When lyrics
are absent, `lyrics.classification` is not required and the song is
unavailable for karaoke.

### 4.3 Audio identification inputs

```text
{
  songSha256, songByteLength,
  extraction: "mp3-frame-window/1",
  windows: [
    { role: "primary" | "alternate",
      firstFrame, frameCount, startMs, durationMs,
      sampleSha256, providerCode }
  ],
  provider: "acrcloud", providerEndpoint
}
```

`mp3-frame-window/1` is the spec 007 rule:

- 12-second-target, frame-aligned raw MP3 windows from the sealed original;
- complete frames retained;
- one primary window and at most one alternate. The alternate follows code
  `2004`, and may optionally follow `1001`.

A second implementation must reproduce the same windows and sample hashes from
the same bytes (vector V3).

Results:

- `identified`: any window returns code `0` with a match.
- `not_identified`: every attempted window returns `1001`.
- `inconclusive`: the alternate returns `2004`, or transport errors are
  exhausted.
- Configuration errors produce no evidence.

## 5. Publication gate

### 5.1 Contract

```text
decide(submission, evidence[], communityPolicy, now) ->
  { decision: "publish" | "block" | "hold" | "needs_evidence",
    rating: "general" | "adult_18" | null,
    coverDisplayed: boolean,
    used: evidenceId[], missing: check[], reasons: string[] }
```

The gate is pure and does no I/O.

### 5.2 Evidence selection

For each required check, the gate keeps evidence only when all of these hold:

- the signature recovers to the declared operator;
- that operator is trusted for the check;
- the `schema` and `policy` are in the accepted set;
- `subject` and the recomputed `inputs` match the current revision;
- `submissionId` and `communityId` match;
- the evidence is unexpired, and within the policy's maximum age for the
  check.

If trusted operators disagree, the decision is `hold`. Otherwise the newest
valid evidence is used.

### 5.3 Release policy `pirate-release/2026-08-29`

This follows the 2026-08-29 ACR release amendment in spec 007, which
supersedes the `requires_reference` row of spec 007 section 5 for the current
release.

| Audio result and declaration | Decision |
|---|---|
| `identified` | `block` |
| `not_identified`, `songType: "original"` | continue to the other checks |
| `not_identified`, any other song type | `hold` |
| `inconclusive` | `hold`; there is no override surface |

When every required check is valid, the decision is `publish`, with the
rating and the cover display flag. When any check is missing or invalid, the
decision is `needs_evidence`. Declared terms are gate inputs only, so a
terms-only edit reuses all prior evidence.

### 5.4 Community policy

```text
{ policyVersion, release: "pirate-release/2026-08-29",
  checks: { "<check>": { operators: [address], schemas: [string],
                         policies: [string], maxAgeSeconds } } }
```

## 6. Admission request

```text
POST /v1/admissions          (operator work purchase)
{ jobId, submissionId, communityId, checks: [check],
  inputs: { song?: Capability, title?: Capability,
            lyrics?: Capability, cover?: { fromSong: true } },
  declared: { songSha256?, titleSha256?, lyricsSha256? } }

Capability = { url, sha256, byteLength, expiresAt }
```

A capability is a short-lived signed download URL. The operator hashes what
it downloads, refuses a mismatch with `input_digest_mismatch`, and signs no
evidence for it.

Idempotency:

- The same `jobId` with the same request hash returns the retained evidence,
  with no second charge.
- The same `jobId` with a different request hash returns `job_conflict`.
- Operators retain results for at least 30 days.

The payer sponsors an admission job only under the sponsorship policy in
section 9.

## 7. Community sign-in

Each community authenticates participants with Sign-In with Ethereum
(EIP-4361) on its own domain. There is no Pirate identity provider, password
service, recovery service, or directory across communities.

- The message's `domain` and `uri` are the community host. Its `nonce` comes
  from the community server and is single-use. Its `chainId` is the network
  whose signature rules apply.
- The community server verifies secp256k1 signatures with `ecrecover`, and
  smart-account signatures with ERC-1271.
- The resulting session is community-local and refreshable. The experiment
  uses a 30-day lifetime, in line with the persistent-login ruling of
  2026-10-29.
- The persona is the wallet address within that community. Recovery is the
  wallet's responsibility.

MOSS is the selected ordinary wallet. The implemented adapter must verify its
actual signature/account format independently on MegaETH; the local ECDSA
fixture is not that proof. The approved browser contract in
[community-web-client.md](community-web-client.md) owns host-only cookies,
Origin/CSRF handling, nonce expiry and renewal. Test actual wallet origin
binding; a matching domain field alone does not establish which site requested
the signature. Operator sign-in is needed for first-song posting, while
customer onboarding, gas sponsorship and name purchase are later acceptance.

## 8. Karaoke attempt ticket

### 8.1 Issuance rule

The ticket issuer signs a ticket only when all of these hold:

1. The request carries a valid community session (section 7) for wallet `w`.
2. The song is published in that community, has accepted lyrics and timed
   lyrics, and has a segment manifest.
3. The sponsorship policy (section 9) admits the attempt's quoted maximum cost for
   `w`, or for the Very nullifier `w` presents.

The ticket names `w` directly. A hash of the community and wallet would hide
nothing, because anyone who knows the wallet can compute it. The published
entry list (section 10.3) also names wallets. Within a community a wallet is
its public persona, so operators, verifiers and anyone reading the entry list
can see which wallet performed which attempt. Participants are told this
before taking part. Hiding entries would require a different commitment and
claim design, which is out of scope here.

### 8.2 Ticket

```text
AttemptTicket {
  string  ticketId
  string  communityId
  address participant
  address operator
  string  songPostId
  bytes32 audioSha256
  bytes32 lyricsSha256
  bytes32 manifestSha256
  string  scoringPolicy        // e.g. "karaoke-scoring/5"
  uint32  maxDurationMs
  bytes32 quoteId
  address community             // identity in OperatorPayments
  string  mode                  // performance or practice
  uint32  maxPaidSegments
  bytes32 sessionKey           // RFC 7638 JWK thumbprint of the browser's P-256 key
  uint64  notBefore
  uint64  expiresAt
  address issuer
}
```

The browser generates a non-extractable WebCrypto P-256 key pair for each
attempt, and signs the operator's connection challenge with it.

### 8.3 Segment manifest

```text
{ songPostId, audioSha256, lyricsSha256, timedLyricsSha256,
  admissionEvidence: [evidenceId],
  segments: [{ segmentId, startMs, endMs, lyricLineIds: [string] }] }
```

Segments inherit the admitted revision. New or changed source material goes
back through admission.

### 8.4 Redemption and result

- The first valid connection creates exactly one attempt, with
  `attemptId = sha256(ticketId)`. A reconnect with the same ticket and session
  key resumes it.
- A different session key, an expired ticket, a different operator, or a
  manifest the operator cannot serve is refused.
The [payment specification](operator-payments.md) owns attempt timing, the
reconnect window, closure/reconciliation and the signed per-line result. It replaces the old
metered fields and ceiling status. In the published specification, the
terminal states are completed, abandoned, expired and payment_missing.
A disconnect alone is not a terminal event. A reconnect with the same ticket
and key within the permitted window resumes the attempt.

The result pins the manifest and includes complete scored-line and billing
lists. Its score is not itself reward eligibility. The qualification verifier
checks the signed result against the frozen community policy in section 10.
The versioned admission/ticket contract here is a target interface; the local
service-envelope version 0 is a named subset, not wire-compatible acceptance.

## 9. Sponsorship policy

Making a new wallet costs nothing. So sponsorship of operator work (admission
jobs and karaoke tickets) is budgeted so that new wallets can only drain a
small, separate bucket:

```text
SponsorshipPolicy {
  communityId, periodSeconds,
  communityBudget,                 // total per-period sponsored-work limit
  openBucketBps,                   // share of the budget open to any wallet
  perWalletOpenAllowance,
  perCredentialAllowance }         // per Very nullifier
```

- Every sponsored job draws from the community budget.
- A wallet without a credential draws only from the open bucket, up to its
  per-wallet allowance. When the bucket is exhausted, sponsorship without a
  credential stops for the rest of the period.
- A wallet presenting a Very proof draws from the rest of the community
  budget, up to `perCredentialAllowance` per nullifier. That allowance is keyed
  by the nullifier, never by the wallet. The proof's scope is
  `keccak256("pirate-sponsorship/1", communityId, periodIndex)`.
- The policy bounds spending only. It never gates publication or reward
  eligibility.

Contract-purchase accounting reserves the quoted maximum at ticket issuance
and reconciles against confirmed redemptions after the terminal payment window.
An uncertain transaction stays reserved. The
[payment specification](operator-payments.md) owns that accounting; no old
channel or voucher rules apply.
These application quotas are not on-chain containment of a stolen purchase
signer. See the credential exposure in [decentralized-setup.md](decentralized-setup.md).

## 10. Qualification verifier

The verifier sits between operators and the pool. It applies a frozen reward
policy to signed results and commits each drawing's entry set.

### 10.1 Reward policy

```text
pirate.reward-policy/1 {
  policyVersion, communityId, pool, chainId, drawingId,
  objective: "karaoke", songPostId, audioSha256, lyricsSha256,
  scoringPolicies: [string], trustedOperators: [address],
  minRewardScoreBps, maxUnmeasuredBps, acceptedQuoteIds,
  eligiblePlayback: ["full_mix"],
  entryOpensAt, cutoff,
  registrationWindowSeconds }
```

The policy is JCS-hashed and published before its entry window opens. The
registration window and the credential requirement are disclosed before
participation, not at the outcome.

### 10.2 Acceptance

The participant submits `{ attemptId, wallet }` over its community session.
The verifier accepts an entry only when:

1. The result signature is by a trusted operator, and the ticket signature is
   by the community's issuer.
2. The result's `ticketId`, `communityId`, `songPostId`, `manifestSha256` and
   `scoringPolicy` match the ticket and the policy.
3. The result's `participant` equals `wallet`, the wallet of the session that
   submits the entry.
4. The signed result is performance mode and names an accepted quote. Its
   line and billing lists exactly cover the pinned manifest; the verifier
   recomputes their hashes and fixed-denominator reward score. The denominator
   is positive, rewardScoreBps meets minRewardScoreBps, and
   unmeasuredCount * 10000 <= maxUnmeasuredBps * linesTotal. Playback meets
   eligiblePlayback. [Payment specification section 6](operator-payments.md#6-qualification)
   owns the detailed score/status and hash checks.
5. `endedAt` and the acceptance time both fall within the entry window,
   before `cutoff`.

There is one entry per `(pool, drawingId, wallet)`. Further qualifying
attempts collapse into it.

### 10.3 Commitment

Before the cutoff, the verifier commits to the pool contract:

- the Merkle root of the entry leaves:
  `keccak256(abi.encode(pool, drawingId, wallet, attemptId))`;
- the entry count;
- the reward policy hash.

It publishes the leaf list, the signed results and the summary bodies, so
anyone can recompute the root. The verifier's key is trusted by the pool for
commitments only. It can never move funds.

This retains the qualification interface for later reward work. It neither
selects a prize source nor makes reward deployment part of first-song setup.

## 11. Reward settlement boundary

The existing [reward-pool contract](reward-pool.md) owns local settlement,
registration and withdrawal semantics. External Megapot research is separate;
no Pirate contract deployment on its network follows. Reward funding remains
undecided and is not a first-song prerequisite.

## 12. Evidence per action and the reward credential

### 12.1 Each action declares its own evidence

| Action | What must be established | Evidence |
|---|---|---|
| Sign in | control of the wallet | a wallet signature (section 7); no humanity check |
| Join a community or acquire a gated name | the community's membership requirement | the community's gate: Self or Very, as the community configures it; the name registry has no buyer allowlist |
| Sing, dance or study | nothing beyond sign-in | none; entries are free |
| Extra sponsorship | an allowance not tied to a wallet | Very, scoped to the community and period (section 9) |
| Register for winnings | entry ownership, and duplicate prevention | the Merkle proof, the wallet's own call, and Very scoped to the pool and drawing |

Self serves as a membership gate only. A membership proof from either provider
never substitutes for the reward proof. Very is the only reward and
sponsorship credential, everywhere. A community cannot select another
provider, add a second one, or weaken the requirement. If Very is unavailable,
registration fails closed and no fallback provider is accepted. This mirrors
v1, where spec 015 §5.2a also checks Palm (Very) at claim time.

Someone who joined through Self meets Very only when they have winnings to
claim, or want more than the open sponsorship allowance. Someone who already
uses Very does not enroll again, but each claim needs a fresh proof under the
claim's scope.

### 12.2 Credential adapter

The versioned scope mapping and verified signal interpretation in
[very-reward-scope.md](very-reward-scope.md) own the adapter. Its
[assurance limits](very-assurance.md) remain explicit. A local fake credential
is not provider acceptance. No provider proof is needed merely to authenticate
the operator or publish an admitted song; extra sponsorship has its own limits.

## 13. Required verification

Retain V1-V3 for canonical JSON, signature/digest bytes and reproducible MP3
windows. Retain G1-G15: identified audio blocks; an unidentified original can
publish; another song type or inconclusive identification holds; wrong input
hash, untrusted operator, unaccepted schema, invalid signature and expired
evidence fail; terms-only edits reuse evidence; lyrics edits invalidate it;
withheld artwork does not change rating; adult rating is the strictest input;
disagreeing operators hold; absent lyrics do not require classification.

Retain ticket tests for one attempt, wrong key, reconnect, expiry, wrong
operator and manifest mismatch. Current contract-purchase limits replace the
old metered ceiling test. Retain sign-in tests for valid login, wrong domain,
replay and the supported smart-account signature, plus the browser contract's
cookie and socket cases. Retain sponsorship tests for open-bucket containment,
exhaustion, per-nullifier allowance across wallets, the community cap and period
reset. Qualification verifies participant binding, signed inputs, cutoff,
current score rules and entry deduplication. Reward and credential tests remain
with their owning documents; payment retry tests belong to OperatorPayments.

## Recovery provenance

The source is protocol revision 5 from 2026-11-03, recovered read-only from the
operator's local editor history. protocol-recovery.json records its SHA-256,
exactly retained sections and the reconciliation map. Sections 4 and 5 are
byte-identical to that source. Section 3 is also retained exactly. Later browser,
payment and creator decisions supersede only their corresponding fields or
scope. No complete obsolete plan or retired execution path was reintroduced.
