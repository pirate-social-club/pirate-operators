# Text-only Study component handoff

This slice supplies say-it-back grading, private attempt persistence and a
recording screen. Its base is first-song c58d013017f773aaf8e899b0d8177cee9b2efea5,
whose runtime is the independently qualified d9775df MOSS-origin successor.
All changes are new files. The first-song coordinator owns integration into
its evolving branch, live service and release packages. This handoff does not
establish live sign-in, provider acceptance, public learning records or rewards.

## Source and assessment policy

The upstream is api-next a5c63b8db01d4359344d33c31d294a00fbeadb20. These are
independently owned copies and adaptations; no runtime import or session trust
crosses into that application.

`packages/domain/src/rewards/study-v2-grading.ts` has source SHA-256 `8971d235abe8f52a7dff0321d14fdbc2fe072a1a7b568bd4a2a0bc49d836ccbb`.

`packages/domain/src/study/english-phonetics.ts` has source SHA-256 `d844bb7065dfa9c6d6e0055d45e33afc25d4480a3fe4e15b89d8304bba382f9d`.

`packages/platform-cf/src/study-spoken-audio.ts` has source SHA-256 `b29012b1a15e252c0e160739f3c8be4b543e72600872867e37eade493954c581`.

packages/study/transcript-grading.ts is the pinned grading file with one
provenance comment, repository formatting and its phonetic import redirected to the existing
packages/scoring/english-phonetics.ts. That helper is byte-identical to the
upstream above. The original policy implementations remain intact; this slice
admits only script_aware_token_phonetic_v4 and stores it with every attempt.
English phonetic tolerance is inherited. Other languages use normalized
segmented text comparison, without English phonetics. This compares transcript
text; it does not measure accent, acoustic pronunciation or singing.

packages/study/speech-transcriber.ts adapts the upstream transport into a
narrow Promise port, with the processing workflow represented by Effect in
services/study-spoken.ts. It retains Scribe v2, disabled diarization/audio-event
tags, no timestamps, the language hint, stored provider retention, the 20-second
header/body deadline, 64 KiB response bound and 4096-character transcript bound.
It also refuses redirects and cancels rejected/oversized responses. It never
sends reference lyrics or learner/account identifiers to the provider.
Provider refusals and unknown outcomes remain distinct.

The upstream R2 archive adapter is not copied. This component retains reference,
audio digest, policy, transcript and result in private D1. Raw recording bytes
are held only for the current dispatch; the browser keeps its recording in
memory for an interrupted-upload replay. The provider may retain the recording.
There is no audio download route or public recording publication. If durable
raw-audio retention is required before integrated release, the coordinator must
add the established protected archive workflow and matching disclosure; it is
not supplied by this component.

The transport contract was checked against the official endpoint reference:
https://elevenlabs.io/docs/api-reference/speech-to-text/convert . D1's conditional
statements and transactional batch behavior were checked against
https://developers.cloudflare.com/d1/worker-api/d1-database/ .

## Integration sequence

1. Adopt the new files onto the coordinator's reviewed first-song successor.
   Assign packages/study/schema.sql the next actual application migration
   ordinal, add it to the coordinator's migration runner and apply it through
   the reviewed release process. Do not leave a reserved ordinal gap. The
   component does not create or migrate tables on a request.
2. Supply makeStudyService with the application D1 binding, a trusted
   resolveLine callback and a Pirate-managed transcriber port. Resolve the
   current visible published post and hash-verified lyric manifest through the
   existing public-read authority. Validate it with validateLyrics, match the
   requested chain/posts/community/post/revision/line identity, then return its
   lineVersion, text, language and manifest digest. Never accept reference text,
   grading policy or account ID from a request. This slice supports nonempty
   lines up to 512 characters. No audio clip or timings are needed.
3. Bind makeStudyTranscriber only within the Pirate-owned managed service using
   its existing approved ElevenLabs binding. The community application receives
   a scoped managed-speech capability, not a provider key. Its implementation of
   StudyTranscriber must authenticate that capability and preserve known_failed
   versus unknown outcomes. Wiring the existing pairing/managed-service handler
   is coordinator work. The adapter accepts an injected fetch transport for
   local tests; the production composition must never select the test fixture.
4. Use accountSession for reads and authenticatedWrite for writes in
   services/community-application.ts or its owned route composition. Derive
   StudyPrincipal from session.account_id and the server's configured communityId.
   Preserve the existing HttpOnly cookie, Origin and CSRF protections. Ordinary
   sign-in is enough; creator connection, DATA registration, membership and Palm
   are not admission checks. Return no private account ID in response bodies.
5. Compose GET /api/study/attempts as service.list(principal, selection), with private
   no-store responses.
   The optional GET selection is bounded JSON in the selection query parameter;
   validate it through the service. The screen filters by the selected line so
   newer attempts on other lines cannot hide an older saved result.
   POST at that path accepts only requestId and selection, with a bounded JSON
   body, then calls service.open. PUT
   /api/study/attempts/:attemptId/audio passes the original bounded request to
   service.submit. Run its Effect through Effect.match so StudyError.code and
   status become sanitized errors, without logging provider bodies, transcripts
   or credentials. GET for one attempt may call service.get. Do not cache any
   authenticated result in public assets or public read caches.
6. Add a Study action and route in the coordinator-owned live UI. Mount
   StudyScreen with the published song's ordered StudyLine array and
   createStudyClient(() => currentSession.csrf). Use the same canonical origin
   and existing ordinary MOSS sign-in. apps/web/src/study/entry.tsx and the
   standalone Vite configuration are acceptance entrypoints, not a replacement
   for the live router. Do not package or deploy study-e2e/host.ts.

packages/study/contracts.ts is the versioned exercise/result boundary. It only
admits say-it-back. It carries the real publication identity without interpreting
it as the placeholder LearningRecords song key. The song coordinator owns the
canonical record mapping, timing revisions and Karaoke prerequisites. The MOSS
consent lane owns activation and publication consent. Later public publication
must preserve the original attempt identity, time, line revision and policy.
Component timestamps are Unix milliseconds. A later chain publisher must
explicitly map them to the contract clock and retain the original qualification
period rather than assigning the later publication time.

## Recovery and operational bounds

An idempotency key opens one attempt per private account/community. A different
reference on that key conflicts. The first accepted audio digest atomically
moves ready to assessing before dispatch. Concurrent/repeated uploads cannot
send a second provider request; changed bytes conflict. Results persist after
reload and service/runtime restart. Unknown provider outcomes remain uncertain,
and a process interruption after dispatch remains assessing. Neither state is
a failure grade or permission to automatically redispatch. A learner may
explicitly record a new attempt; operator reconciliation of abandoned pending
attempts is later integration work.

There are at most 100 new attempts per account/community in a rolling 24-hour
window. An existing-key replay remains readable at that limit. New audio must
arrive within five minutes of opening. Audio is capped at 2 MiB from the actual
stream, with a supported MIME and container header; the UI stops at 30 seconds.
Header sniffing is not full audio decoding, and the server does not establish
recording duration from client claims. Existing provider budgets and financial
holds still apply before any live enablement. The reference and heard-text
bounds also limit grading work. No learner recording or transcript belongs in
public telemetry.

This is private operational attempt evidence awaiting downstream qualification
and consented publication. qualification is always not_evaluated. A passed
assessment does not mint shares, enter a drawing, create settled winnings or
pay USDm. The reward policy, deduplication by permitted drawing share and
claim-time Palm rules remain subsequent slices. Historical practice sessions
are not imported or converted into paid results.

## Local acceptance

The root Study tests use the actual pinned Miniflare D1 engine and a disk-backed
runtime restart. Browser tests use built Solid assets, actual MediaRecorder
capture, actual D1 and the real Study service, with an explicitly simulated
speech response and authenticated session. They do not test production MOSS
sign-in or real ElevenLabs accuracy. The local runtime's August compatibility
date is its installed engine limit, not production November-date qualification.

Run focused checks from the task worktree in a loopback-only namespace:

    node --test test/study-*.test.ts
    npm run check

From apps/web run its typecheck, then these additional commands:

    node_modules/.bin/vite build --config vite.study.config.ts
    node_modules/.bin/playwright test --config playwright.study.config.ts

Use the repository's installed matching Chromium through
PLAYWRIGHT_BROWSERS_PATH where needed. No existing package script was edited.
The source task record carries the final checked source and exact outcomes.

Before integrated acceptance, wire the authenticated routes, migration,
published-manifest resolver, managed speech capability and live router. Then
qualify one published song and an ordinary account with no membership, creator
wallet or Palm; exercise failure, replay and reload, and perform the separately
bounded real-provider run. A database-only replacement for public learning
records is not adopted. Telegram, funded claims and Karaoke remain outside this
slice.

Verification on November 5 passed the full loopback-only root check: TypeScript,
194 Node tests (including 13 Study tests), 134 Solidity tests and local skeleton
acceptance. Web TypeScript, the standalone Study build and four built-browser
scenarios passed. The standalone browser host and spec also passed an explicit
strict TypeScript check. Desktop and 390-pixel mobile visual inspection passed;
only the isolated local acceptance host and simulated speech were used. The
pinned grading copy was compared after its documented import/comment/formatting
transformations. No existing tracked file changed. Independent review, hosted
checks and all live integration/provider acceptance remain distinct gates.
