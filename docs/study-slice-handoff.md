# Text-only Study component handoff

This slice supplies say-it-back grading, private lesson and attempt persistence,
and a recording screen. It starts at first-song
c58d013017f773aaf8e899b0d8177cee9b2efea5. All component files are new relative
to that base. The first-song coordinator owns live integration and release.
This source does not establish live sign-in, provider acceptance, public learning
records, Karaoke or rewards.

## Source and assessment policy

The server source is api-next a5c63b8db01d4359344d33c31d294a00fbeadb20. These
are independently owned copies and adaptations, with no runtime imports or
session trust crossing into that application. Source SHA-256 fingerprints are:

| Source path                                            | SHA-256                                                          |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| packages/domain/src/rewards/study-v2-grading.ts        | 8971d235abe8f52a7dff0321d14fdbc2fe072a1a7b568bd4a2a0bc49d836ccbb |
| packages/domain/src/study/english-phonetics.ts         | d844bb7065dfa9c6d6e0055d45e33afc25d4480a3fe4e15b89d8304bba382f9d |
| packages/platform-cf/src/study-spoken-audio.ts         | b29012b1a15e252c0e160739f3c8be4b543e72600872867e37eade493954c581 |
| packages/application/src/study-shared-lesson-engine.ts | 6615bc83053134719cb5287fb3ee0cfd64e0f76f652b73cd36ebd294526df57c |
| packages/platform-cf/src/study-v2-repository.ts        | dddadb6c76366230b55698cbe40f817801006275f4d3ee29d8c84604cb18cf75 |
| packages/application/src/study-v2-lifecycle.ts         | bedf3bfbe48b35fea99ac9be3d68f18c5031e759e005eb728ba6f511dcaf4e14 |
| packages/domain/src/study/lyric-line-identity.ts       | 111bef1b58201c4c241659788f1cef05fea2e5388afc8274c48fa1a146d2076f |

packages/study/transcript-grading.ts retains the pinned implementation with a
provenance comment, repository formatting and its phonetic import redirected
to packages/scoring/english-phonetics.ts. That existing helper is byte-identical
to the source above. Only script_aware_token_phonetic_v4 is admitted and stored
with each attempt. English phonetic tolerance is inherited. Other languages use
normalized segmented text comparison. This grades transcribed words, not accent,
acoustic pronunciation or singing. The September 30 run-together/split-word fix
remains intact.

packages/study/speech-transcriber.ts independently adapts the transport to a
Promise port, composed through Effect in services/study-spoken.ts. It retains
Scribe v2, disabled diarization/audio-event tags, no timestamps, the language
hint, stored provider retention, a 20-second header/body deadline, a 64 KiB
response bound and a 4096-character transcript bound. It refuses redirects and
cancels rejected/oversized responses. Reference lyrics and account identifiers
are not sent to the provider. Known refusals and unknown outcomes remain distinct.

The frontend source is pirate-web-solid
667a6f22325cc7dd07ed7bcdfc088864e519f71d. Paths below its
src/features/studying/ directory have these source fingerprints:

| Source file                  | SHA-256                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| studying-route-view.tsx      | 57fd135bc38465a14eca27740eff570b11ea16cf06e3ea1cf0a66b6918c6a9a2 |
| studying-recording-policy.ts | 170271ab68510e43e64a9818bd2848c82d73d7148e16a13965dc2ed269ec82e1 |
| studying-feedback-audio.ts   | 0637e3308140df52b795325c153787b02fc2142ac234e98677555d3c7130bd95 |
| studying-browser-recorder.ts | f261990d865685bba2030dc2d92057cb3a7832745af87fbc059b5cb64fe8f9d8 |

The copied public/sounds/study/correct.mp3 fingerprint is
e0d4d9e900efabbe47f3b8c48812a9466b3dce39cf9030d65463a74e8f3c1855.
The incorrect.mp3 fingerprint is
3587e70c9f9ba54b2e00a9b69d7d3206c45c75d610579546f0d47902136b61c1.
Both are independently owned byte-identical assets under apps/web/src/study/sounds/.
The screen and feedback helper adapt the old behavior to this component's
contracts rather than importing its route or application state.

## Lesson behavior

Stopping capture submits immediately. A correct grade plays the correct sound
and displays the server's next line. A miss plays the incorrect sound and holds
the reference and heard text with one Continue button. Continue dismisses only
that feedback; the server has already chosen the next line. Reload resumes the
server-selected line, matching the centralized route. A one-second minimum
rejects short recordings before opening an attempt or dispatching speech.

The resolver returns all eligible published lines in song order, up to the
manifest's 2000-line bound. The server validates the complete candidate set and
chooses up to ten using only this learner's saved graded presentations: fewest
first, then least recently practised (never practised first), then song order.
It removes later occurrences of repeated text before applying the limit, using
the pinned NFKC, case, punctuation/symbol and whitespace normalization. The
first occurrence supplies the reference and line ID. Four distinct-text lines
remain the minimum. The chosen set is frozen in that lesson; new practice never
reshuffles an already opened or replayed lesson.

History is scoped to account, community, chain, posts contract and post. It
counts assessed attempts attached to saved lessons, including misses, and uses
their original completion times. Repeated uploads count once. Ungraded provider
failures, uncertain calls and unsubmitted recordings count zero. Text and
language identify practice across revisions, so unchanged chorus text retains
its history even when occurrence IDs change; edited text starts fresh. This is
the requested local presentation history, without importing the old review
scheduler or its database. The query uses saved grades directly, including one
whose queue reconciliation is pending, so a restart cannot lose practice.

The server snapshots four to ten selected lines from one published revision and
manifest. The browser never supplies reference text or chooses queue order.
Unseen lines come before unresolved repeats. Repeats sort by least recent
presentation, then original line order. A line resolves on a correct
answer or its third graded presentation. Three misses resolve it without
mastering it. A lesson ends when all lines resolve or after min(20,3\*lineCount)
graded presentations. The latter can leave unresolved lines. Completion reason,
first-pass outcomes and mastery remain separate facts.

A known failed provider call permits a new ungraded take on the same
presentation. An uncertain or interrupted dispatch remains paused without a
grade or queue advance. Study again creates a distinct lesson and preserves the
old one. Expired, unsubmitted attempts also permit an ungraded take. No provider
failure becomes a miss. A later correct repeat never rewrites a failed first pass.

The new durable lesson policy is pirate.study.lesson-queue/1. It adopts the
pinned spoken graded-return rules and production line-count bounds. It does
not adopt multiple choice, optional language-detection-based ungraded rerecords,
long-term review scheduling, streaks or reward qualification. Those were separate
policy/composition concerns in the source. qualification remains not_evaluated
on every lesson and attempt; completion alone cannot award anything.

## Coordinator wiring

1. Adopt this branch's new files onto the reviewed first-song successor.
   packages/study/schema.sql is consolidated component-owned SQL, not an applied
   migration. Assign the next actual application migration ordinal, register it
   and apply it through the reviewed process. It creates study_lessons and
   study_attempts, with ownership-bound lesson references. If an earlier version
   was already applied, make an additive migration instead of recreating tables.
   The component never creates tables on a request or edits the shared runner.
2. Construct makeStudyService with D1, a trusted resolveLine callback and a
   Pirate-managed StudyTranscriber. Construct makeStudyLessonService with the
   same D1, that attempt service and a trusted resolveLines(song) callback.
   Resolve the visible published post and hash-verified lyric manifest through
   existing public-read authority and validateLyrics. Return all eligible valid
   lines in manifest order, rather than a fixed first-ten subset. The lesson
   service receives the authenticated principal and selects its least-practised
   distinct-text lines from its own saved history. Return StudyLine objects
   matching chain, posts contract, community, post, revision, line ID, lineVersion,
   language and manifest digest. Lines must be nonempty and at most 512 characters.
   Opening an attempt revalidates the frozen line against resolveLine; a changed
   reference conflicts. No clip or timings are required for this exercise.
3. Bind makeStudyTranscriber within Pirate's managed service using the approved
   ElevenLabs binding. The community app receives an authenticated scoped speech
   capability, not a provider key. Preserve known_failed versus unknown outcomes.
   The existing pairing handler, capability and shared daily counter remain
   coordinator work. Production must never select the browser fixture.
4. Derive StudyPrincipal from accountSession/authenticatedWrite and the configured
   community. Keep existing HttpOnly cookie, Origin and CSRF protection. Ordinary
   sign-in suffices: no membership, creator wallet, DATA or Palm admission gate.
   Before public release, write Terms and Privacy adapted from the old policies
   to this system's actual storage and obtain owner review. Add and record their
   acceptance at MOSS sign-in, for example "By continuing, you agree to the Terms
   and Privacy Policy." Cover ElevenLabs processing/retention, transcript/result
   storage and assessment limitations there. Do not copy an old audio-retention
   period that this system does not implement. Per the October 20 ruling, Study
   has no provider checkbox or in-flow provider/assessment notices. Browser
   microphone permission remains unchanged.
5. Compose the following private no-store routes. Bound JSON and query inputs;
   accept only the listed fields, never caller-provided principals or references.
   GET /api/study/lessons?song=<bounded JSON> calls lessons.latest(principal,song)
   and returns a lesson or null. POST /api/study/lessons accepts requestId and
   song, then calls lessons.start. GET /api/study/lessons/:lessonId calls get.
   POST /api/study/lessons/:lessonId/attempts accepts presentationNumber and
   takeNumber, then calls openAttempt. PUT
   /api/study/lessons/:lessonId/attempts/:attemptId/audio passes the original
   bounded Request to lessons.submit. Run its Effect through Effect.match and
   sanitize StudyError.code/status. The lesson wrapper checks current presentation,
   take, account and community. Do not expose standalone attempt open/submit as a
   way around lesson authority. Never log provider bodies, audio, transcripts or
   credentials, or put authenticated results into public caches.
6. Add the Study action and route in the coordinator-owned live UI. Mount
   StudyScreen with createStudyClient(song,()=>currentSession.csrf,lessonId,onOpened).
   Store the returned lesson ID in the route, as the acceptance entry does, so
   reload addresses that same lesson. Without an ID, load resumes the latest
   lesson for this song. The ID is a private-record locator, not authentication.
   The browser sends x-study-duration-ms alongside the captured Blob. The standalone
   entry's GET /api/study/config returns song and CSRF only for its fixture; use
   the live app's existing session/router composition. Do not deploy study-e2e/host.ts.

The song coordinator owns real publication identity, the LearningRecords song
mapping, timing revisions and Karaoke. The MOSS consent lane owns activation
and consent for public records. Component timestamps are Unix milliseconds.
Later publication must preserve original lesson/attempt identity, activity time,
line revision and policy, explicitly map clocks and retain the original
qualification period. Later wallet attachment cannot fabricate earlier consent.

## Recovery, storage and limits

An owner-scoped request key opens one lesson. Each presentation/take opens one
attempt using a deterministic key. The first accepted audio digest and duration
atomically move ready to assessing before provider dispatch. Repeated uploads
cannot dispatch again; changed bytes or duration conflict. Saved grades reconcile
into the queue using a conditional revision update. If the process stops after
the grade is saved, the next read finishes that transition exactly once. This is
tested using an actual disk-backed D1 restart, not a process-local cache.

Unknown provider outcomes remain uncertain. An interruption after dispatch can
remain assessing; neither permits automatic redispatch. A lost response after
successful persistence is recovered by reading the lesson. Only the just-completed
attempt can hold miss feedback. An old replay returns its original grade without
advancing the current queue. Operator reconciliation of abandoned uncertain
attempts remains later work.

At most 100 new attempts per account/community can open in a rolling 24 hours;
existing-key replays remain readable. Audio must arrive within five minutes of
opening. The actual stream is capped at 512 KiB with a supported MIME/container
header. Capture is bounded to 60 seconds. The browser checks one second and the
server checks the supplied integer duration from 1000 to 60000 milliseconds,
binding it to replay identity. This is product metadata, not decoded duration
verification. Header sniffing and the byte bound do not establish provider cost.

The account limit does not bound Pirate's total bill. Before public enablement,
the managed speech service needs one shared daily call count across all accounts,
communities and speech entrypoints. Increment it atomically before every provider
call; refuse calls at the configured limit. Attempt replays make no call and
consume no additional count. A dispatched call remains counted even if its
outcome is unknown. Choose the daily number and day boundary in coordinator
configuration and test concurrent exhaustion. This owner-approved v1 gate needs
no price assumptions, monetary reservations or cost reconciliation. At exhaustion,
show one short try-later message; the limit stays out of the ordinary learner flow.

The old R2 audio archive is not copied. Pirate retains reference, audio digest,
submitted duration, transcript, outcome, policy and private lesson state in D1.
Raw recording bytes are transient during capture/dispatch, with no download or
publication route. ElevenLabs may retain them. The coordinator must make the
policies match this behavior, including any later protected archive it adds.
No learner recording or transcript belongs in public telemetry.

A pass does not mint shares, enter a drawing, create winnings or pay USDm. Reward
qualification, drawing deduplication, claim-time Palm, custody and funding are
subsequent decisions/slices. Historical practice is never retroactively rewarded.
Streak is excluded. Telegram and funded activity remain outside this component.

## Acceptance

Root tests use actual Miniflare D1, including disk-backed restart. Browser tests
use built Solid assets, actual MediaRecorder capture, actual D1 and both real
Study services, with explicitly simulated speech and an authenticated fixture.
Six additional D1 selection tests cover successive lessons over 25 lines,
learner/song isolation, practice count and recency ordering, normalized chorus
exclusion, immutable existing lessons, revisions and restart recovery. They
also verify failed/uncertain provider outcomes and replay do not inflate history.
Browser scenarios check automatic submit/advance, both feedback sound requests,
one Continue on a miss, server-selected returns and reload, completion, lost response recovery,
short recording refusal, known/unknown provider failure, microphone denial and
mobile fit. Audio calls are instrumented; this is not a physical speaker test or
real-provider accuracy test. The local engine's August compatibility date is
its installed limit, not November production qualification.

Run npm run check from the task worktree and web TypeScript from apps/web.
Additional Study commands from apps/web are:

    node_modules/.bin/vite build --config vite.study.config.ts
    node_modules/.bin/playwright test --config playwright.study.config.ts

Run runtime checks in a loopback-only network namespace. The dedicated
.github/workflows/study.yml installs server/browser dependencies, builds Study
and runs all four browser scenarios in hosted CI. Failure traces/screenshots
are retained as study-browser-results. It does not edit the coordinator's shared
workflow or package scripts. Use PLAYWRIGHT_BROWSERS_PATH for the installed
matching local Chromium. The authoritative task record carries exact final
source, counts and hosted run evidence; local and PR-merge counts can differ.

After wiring, qualify one published song and an ordinary account with no
membership, creator wallet or Palm, including misses, replay and reload. A
separately bounded real ElevenLabs run and the full published-song journey remain
open. This handoff supplies component source for review, not a live release.


## Centralized presentation restoration, November 7

The microphone runtime repair is deployed separately at application profile
34c1a020 and operator module 6fa28d54. The first real post-repair lesson saves
an exact correct answer and a first-pass miss. Private offline replay against
the original centralized grader reproduces both stored grades exactly. The
whole grader and phonetic primitive remain the existing centralized code.
An English v4 missing-word budget rejects the recognized article in place of
the expected whole word in that miss. This is transcript comparison, not a
validated pronunciation score. Central exercises retain versioned policies;
old exercises may use an earlier policy. No policy or saved grade is changed.

The initial cream Study screen is superseded by owned copies of the actual
central StudyingSurface, studying-model and studying-route-states from current
main c7cb87835a1858a1955c820b03d566365e6d42db. Their original bytes are also
identical to the accepted production website source 6074ba72 and the original
667a6f22 reference. Only import paths and provenance comments change. Existing
owned activity header/results and the exact vendored design primitives are
reused. There is no dependency on the centralized runtime or repository.

The host maps existing durable lesson facts into that presentation. Recording,
authentication, server selection, recovery and grading remain owned by their
existing ports. Correct answers advance immediately; a miss holds its actual
reference and recognized words until Continue, without dispatching another
answer. Completion displays immutable first-pass accuracy. Expired/abandoned
lessons use the existing central route state with an explicit unfinished-lines
caveat and their publication controls; they never display a fabricated Missed
count. Terminal restart errors remain visible. No streak, reward, translation
or new exercise is inferred. Policy links remain accessible in the safe-area
footer without a new modal. Standalone acceptance uses the same tokens and
Tailwind scanning as the live host.

The central view body hashes are pinned independently by study-parity.test.ts;
import-only differences are allowed. The previous Karaoke parity ratchet stays
unchanged. Actual live 34c is archived byte-exact as application-plan-v20.json
for the next reviewed update. The older v19 and v18 predecessors stay historical.


The release source inventory now explicitly includes the Study directory,
including the owned central view copies. Its two audio source files use raw
byte digests; text sources retain the existing validated UTF-8 digest. Served
asset hashes were already bound. This closes the missing source-provenance
entries without changing runtime or assessment behavior.


## Learner publication panel removal, November 8

The owner removes the extra publication status and Check publication control
from Study. Completed, expired and abandoned cards use the existing central
presentation without a technical footer or empty replacement slot. Actionable
restart errors remain visible. Automatic terminal reconciliation, bounded
receipt polling, stop-on-confirmation, cancellation on exit and authenticated
private-history download remain unchanged. Operator/public reader tools carry
publication evidence; the practice screen does not require learners to manage
it. Stored grades and public results are not changed by this presentation fix.
The actual 860b predecessor plan is preserved byte-exact as v21 for the reviewed
successor. Earlier v20 and v19 archives remain historical.
