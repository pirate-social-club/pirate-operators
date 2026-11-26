# Learning reliability interface v1

Lane 5 owns this proposal against source
`67cbe118ade39790bc1539999ca75d0d7ff10b6d`. Integration and activation belong
to the coordinator. This file grants no deployment or provider action.

Grading adds `script_aware_token_phonetic_v5`; v1 through v4 keep their
existing behavior and stored results. V5 canonicalizes English dropped-g
spellings and wanna/want to, preserving negation and numeric protections.
It carries the centralized `study_spoken_rerecord_v1` assessment: low voice
overlap, confident language mismatch, or a single harmless insertion with a
strong remainder can request one uncounted re-record per presentation.
The second recording is graded normally. Re-records do not advance first-pass
facts, presentations or mastery. Provider failures are separate from that rule.

The grader selection is frozen when a lesson starts. Default selection remains
v4 until the coordinator supplies an exact future qualification period and
Unix timestamp, verifies their equality against the contract epoch, and
reviews the new policy and schema migration. Lessons already open continue
their frozen grader. Historical assessed attempts are never regraded.

Speech admission uses `pirate.speech-admission/1`. Trusted service callers pass
community identity, key generation, channel (`website-study`,
`website-karaoke`, `telegram-linked`, `telegram-trial`, `processing`), stable
request identity, payload digest and bounded units. One Durable Object per
community/key generation serializes reservations. Daily limits must be finite
and positive; a website Study reserve cannot be used by any other channel.
Trial capacity has a separate finite cap. Reservation, dispatch and resolution
are idempotent. A confirmed pre-dispatch/provider refusal releases capacity;
an unknown outcome stays charged and is read back without redispatch. Only
trusted callers can reconcile a reservation. The service never accepts API keys
from a learner or Telegram payload. Key provisioning belongs to onboarding.

Provider refusal must preserve prompt/progress and consume no graded attempt.
Safe internal retries are bounded and only repeat confirmed refusals. Unknown
dispatch outcomes block fresh speech on that slot until reconciliation; a lost
client response reads back the same attempt. No blind timeout redispatch.

Shell routing consumes the owned learning route helper. Opening Karaoke sets
`?sing=<postId>` and removes Study parameters; exit removes `sing`. Refresh
and browser history restore that song and fetch the server's current take.
No ticket, proof, account or recording is stored in the URL. The shell owner
mounts this helper; lane 5 does not edit `entry.tsx`.

Publication and qualification must still reject withdrawn/replaced sign-in
authority. Lane 6 owns sign-in refresh/activation. Lane 5 tests the existing
publication fences and never turns stale lesson recovery into fresh permission.

Local simulated provider/browser evidence does not establish real microphone,
provider, mobile-device or prospective on-chain activation acceptance.

The unnumbered migration is `packages/study/grader-v5-migration.sql`. Its
table rebuild preserves existing v4 rows, JSON grades, identity constraints
and foreign keys. The coordinator assigns the next contiguous ordinal and
applies it before configuring v5. `STUDY_POLICY` remains v4. Each new lesson
freezes `graderRevision`; a v5 terminal uses facts schema 2 and a distinct
scoring-policy hash. Historical facts schema 1 and its scoring bytes remain
unchanged. An old lesson completed after activation cannot acquire v5 credit.

`packages/study/qualification-v5.ts` supplies separate policy schema 2 and
its prospective reader. Shared reward sources must explicitly pin that policy
and activation; accepting either scoring revision with an unchecked OR is
insufficient. The current shared reward reader still admits v4 only, so v5
activation remains held until coordinator integration.

Admission units count bounded provider dispatches, not money or audio minutes.
Study audio retains the existing sixty-second maximum; Karaoke retains the
ticket's maximum duration. The deployment must review daily cap, Study reserve,
trial cap, key generation and provider spending together. All callers sharing
one community key use the canonical object name from
`speechAdmissionObjectName`. Configuration must match on the operator and
SpeechBudget Worker. Legacy `claim()` refuses when admission configuration is
enabled, so unconverted processing cannot silently bypass the reserve.
Connected Telegram lesson offers must freeze `speechChannel: telegram-linked`
in their authenticated V4 binding; the operator then admits them to that
channel instead of website Study. The browser supplies no channel selector.
Trial speech uses `telegram-trial` admission directly and cannot carry that
channel into a public-result Study binding.

The community service limits failed dispatches with a one-minute
cooldown after each three; it never increments the learner's take for a
provider refusal or expired unsubmitted audio. Safe internal retry repeats only
explicit rate-limit refusal, at most twice after the initial call. Every
unknown outcome remains blocked until a retained receipt or a trusted read-only
recovery port resolves it. The ElevenLabs adapter has no remote receipt-query
implementation; genuinely lost provider outcomes stay uncertain rather than
being fabricated as failures. A lost community response can recover the
operator's retained terminal receipt today.

The re-record assessment was independently adopted from api-next
`f017e8014001a31d07b9e2de891e0907ad194b50`,
`packages/domain/src/rewards/study-spoken-rerecord.ts`, source SHA-256
`4819c665f331f83a32337fe35c69a731177a6aea06fb47e85649c97c55bb47c1`.
The one-ungraded-recording rule follows
`packages/application/src/study-shared-lesson-engine.ts` at that revision.
Copied code has no runtime link to that repository.

The coordinator's mount proposal and release/configuration instructions live
in the private handback, `.local/integration.patch` and
`.local/integration-proposal.json`. The route browser regression
`apps/web/karaoke-e2e/resume.spec.ts` requires that mount and should enter the
normal Karaoke browser workflow when the shell owner integrates it. This lane
tested a local Vite review artifact with that proposal; the source entry stayed
unchanged. The existing finished-take/new-visit behavior remains unchanged.

SQL transaction behavior was checked against the installed Workerd types and
[Cloudflare's SQLite storage documentation](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
Validation includes actual local Durable Object RPC and D1, simulated speech,
anvil, and a Chromium fake microphone. It does not establish provider billing,
real-device capture or public-chain activation.
