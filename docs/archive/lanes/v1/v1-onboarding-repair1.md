# Onboarding exact-source repair 1

This successor repairs the review of source
`edc7db725032fe197c0c4aaeec0e6182cddc05b2` against the original live-verified
base `67cbe118ade39790bc1539999ca75d0d7ff10b6d`. Historical handback, manifests,
check logs and evidence remain unchanged. New results and the successor source
manifest live in `.local/onboarding-repair1/` and
`.local/handback-onboarding-repair1.json`.

## Expired first-use work

Expired authorization work is retired transactionally. The retirement marker,
removal of unallocated activation/authorization intents, refunds of provably
unsent reservations, cohort/account release and pending-job removal commit
atomically. Expired pending-job recovery uses its retained digest and local
allocation proof, so it can reclaim provably unsent capacity while RPC is
unavailable. A retired digest cannot reserve again, including a stale caller
whose clock has moved backward. The sender's allocation gate rechecks expiry
after awaited fee/nonce reads; an expired unallocated intent cannot later
allocate and spend. The relay-window endpoint remains inclusive.

An allocated intent, any matching transaction row (including orphan evidence),
or a charge missing its intent is uncertain. Its charge and account slot remain
retained. Raw signed bytes, attempted/unknown broadcasts, confirmed successes
and reverts are never refunded by this repair. A provably unsent half of a
partially allocated bundle may release only its own gas reservation; the
cohort slot and conservative full bundle commitment remain. Generic recovery
continues reconciling retained allocated transactions. This narrowly supersedes
the original runbook's blanket statement that no activation refund exists;
there is no time-based refund of uncertain work.

## Early withdrawal cleanup

Study start, a new Karaoke ticket and connected learning share central
admission cleanup. A usable observed chain withdrawal is applied before the
early refusal is returned, without a second RPC observation that could mask
it. Local public-results state becomes off, and existing active Study lessons
close with the canonical lesson/attempt CAS logic. Pending attempts are sealed,
and terminal facts remain available to the existing D1 outbox/recovery path.
Cleanup resolves no source, requests no speech and starts no new key or ticket.
A retry that already sees the local off flag retries unfinished cleanup.

The local community/account scope, newer sign-in and explicit turn-on nonce
fences remain. Login/settings paths also retry canonical cleanup rather than
leaving earlier interrupted work active. Closure does not fabricate eligibility
or bypass the contract's publication/qualification fences. These are backend
repairs; no new screen, consent prompt or learner approval is introduced.

## Mandatory shared integration fixes

The fresh `pirate-community-learning-v4` profile remains a proposal. Profile
admission alone is insufficient. Both `.local/integration.patch` and the
standalone fresh-profile proposal now include these required shared changes:

1. In coordinator-owned `operator-tx.ts`, enforce the configured data-fee
   allowance for all configured learning result versions, including V4 with no
   V2 binding. Keep the local 31337 exemption. Missing/malformed bounds,
   unavailable observations and above-limit fees must fail closed before
   broadcast. Zero is a real zero bound. The coordinator must run actual sender
   regressions for V4-only and retained legacy behavior. No current public fee
   amount or oracle availability is established here.
2. In source5/coordinator-owned `karaoke.ts`, the alarm `tick` must resume Study
   publication recovery when either V3 or V4 is configured. The coordinator
   must prove actual V4-only retry, confirmation/revision reconciliation and
   expired private-publication cleanup through `tick`, retaining V3 behavior.

Neither shared source file is edited by this lane. Syntax/applicability of an
unapplied patch is not runtime evidence. Do not adopt or release V4-only until
these mounts, their focused tests and independent integrated-source review pass.
Alchemy ownership, managed Infisical scopes, speech/channel budgets and trusted
Telegram linking remain required integration work.

## Centralized UI and Storybook comparison

Read-only comparison used `pirate-web-solid` commit
`c7cb8783` (the packet's established UI reference). Inspected sources were
`src/routes/auth/sign-in.tsx`, `src/features/auth/sign-in-panel.tsx`,
`src/features/auth/sign-in-panel.stories.tsx` and
`src/features/community/owner-settings/community-telegram-settings.stories.tsx`.
Exact full commit and file SHA-256 values are recorded in
`.local/onboarding-repair1/centralized-source-comparison.json`.

The sign-in route composes the established card and SignInPanel; the panel
uses the same SignInView/session interaction as the modal. Its Storybook
failure case disables unavailable sign-in actions. Telegram stories cover the
password bot-token field, disconnected/configuring/unavailable/refused and
read-only states, with advanced details collapsed. The existing onboarding
password/masked-status and disabled-unavailable behavior follows those patterns.
The local wizard is an operator setup surface, not a replacement learner login.
The repair introduces no UI and copies no centralized auth/API/persona runtime.
MOSS sponsorship, immutable contract authority and community-owned Alchemy and
Infisical setup require the separate decentralized backend safeguards above.
Storybook source was inspected; no Storybook/browser run occurred under the
coordinator's occupied heavy-check slot. Dance screens remain outside this
lane's writable scope and must follow the established flow under their owner.

## Verification limits

Only focused single-worker local tests and typecheck are authorized for this
repair. No full check/build, browser, Forge, live provider contact, deployment,
publication, managed credential change, new key or fund movement is performed.
The scoped runner cannot write `/tmp`; temporary/cache paths stay inside
`.local`. Inside-repository activation guard refusals from other source lanes
are environment limitations, not proof of a product regression; no guard is
weakened. Real fresh-account MOSS and reproducible second-community song,
credential, permission and learning acceptance remain unproven. Historical
219-test Forge and full-check results belong only to the retained prior source.

The successor focused command is
`node --test --test-concurrency=1 test/learning-authorization-retirement.test.ts test/learning-authorization-admission.test.ts test/learning-authorization-live.test.ts test/learning-sign-in.test.ts test/sponsor-budget.test.ts test/sponsor-budget-retirement-durable.test.ts`.
It passed 37 tests. `npm run typecheck` passed. Both unapplied integration patches
passed `git apply --check`. The SQLite regression compiles a local Worker test
fixture with esbuild and runs one workerd instance at a time; no product build
was run. Exact logs and their hashes are included in the new handback/manifest.
