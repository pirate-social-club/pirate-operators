# Held Telegram factory composition

`services/telegram-connected-community.ts` composes the existing native bot,
durable grants and managed publication lifecycle with the shared connected
authorization service and the frozen private Study adapter. It provides source
for a coordinator mount. It activates no runtime and exports no connected
capability marker. No Telegram UI or linking screen changes are included.

The source base is `ee6a820ee20d5b9b7a7ebe6b432f9e8a62b6e94d`. Integration
requires held shared core `59908a5469702266e48a147c73fb68cf2de09f22` (or its
independently reviewed successor) and the exact protected-adapter proposals in
`.local/telegram-connected-factory`. Those proposals have not been applied to
this source checkout. The shared authority ledger is absent from this base;
the factory is deliberately dependent on its canonical module, with no copied
implementation or fallback authority reader. Existing adapter-test fixtures
also require coordinator adaptation to the required lifecycle contract.

## Construction and binding

The factory takes the existing community D1, Study environment/configuration
and public source readers, explicit selected HTTPS origin, current bot
registration, and native DO storage. It requires existing real account
enablement, catalog, personal views, speech admission/provider, broker, media,
delivery and notification ports. None is supplied with a permissive default.

The explicit origin must exactly equal `config.app.origin`. This constructor
selects no domain. Community and V4 contract selection must agree with frozen
Study. The signed lifecycle target is derived from Study's configured operator,
payment chain, community and results contract. The existing local-chain fixture
may use an operator signing domain of 31337 while published source provenance
uses 6343; these are separately bound by the existing source verifier. The
constructor does not silently substitute either chain or contract.

Both browser and native account checks use the same `telegramAccountPort`,
whose authority reader is the shared `readAuthorityState`. Shared
`permissionRevision` is required for account authority versions. The existing
web adapter retains session/Origin/CSRF checks. Signup alone does not create a
Telegram grant. Existing broker verification and one-use link redemption remain
required; this factory adds no login endpoint or account administration API.

The linked adapter is constructed internally. Callers cannot replace it with a
generic `createLinkedStudy` hook. The factory passes the same actual
`TelegramManagedPublication` through the linked and frozen adapters, uses the
actual shared `connectedPracticeAuthorization`, and constructs actual private
`liveStudy` through `frozenTelegramStudy`. Original request, authorization,
start time, source and account/grant/bot bindings remain frozen on retries.
Trial history remains separate from connected history.

The existing internal publication-authority handler uses those same grants and
lifecycle. The local Study resolver invokes this handler directly. The returned
`publicationAuthority` handler must also be mounted to the operator's existing
internal authority binding. It must not become a public route. This source
does not select or create a binding or provision a resource.

## Native alarm mount

`TelegramConnectedStorage` requires native storage SQL, synchronous journal
transactions, asynchronous storage transactions and alarm methods. The
scheduler compares and updates the deadline inside the native alarm
transaction, preserving the earliest wake under concurrent requests and
restart. It creates no in-memory authoritative timer.

The containing community DO must pass its actual `ctx.storage`, retain its
existing object identity and forward its real `alarm()` event to the returned
factory's `alarm()`. Existing webhook, route, tick and notification methods
retain transition-first readiness. Recovery is not gated out when ordinary
readiness fails. A function signature alone supplies no scheduler evidence;
the unrun native DO tests are queued for the coordinator.

## Proposed protected changes

`protected-adapters.patch` is a full replacement proposal for the earlier sealed
`.local/telegram-managed-transitions/shared-composition.patch`. It is against
the current exact base, not an incremental patch on that old proposal. The old
artifact remains unchanged. Only the coordinator may apply the new proposal.

The linked adapter requires a real lifecycle with the same grants, calls
`ready()` before authority/admission/recovery, and carries that actual lifecycle
reference into the frozen context. The frozen adapter requires the identical
reference, snapshots Study configuration, asserts the entire signed target,
and checks readiness and current grant/account/wallet/version around shared
authority reads. It does not supply a marker to stand in for shared enforcement.
The existing frozen first-terminal, private grading, uncertainty, erasure and
same-original recovery paths remain in the shared modules.

## Deferred checks and limits

No tests, typechecks, build or runtime checks were run for this successor. Only
the owned-file pinned formatter and `git diff --check` are permitted. The
handback records exact queued commands and prerequisite pins.

New test source covers actual native handler/SQL/V4 private Study composition
with explicit test transports, delayed authority and bind responses, lost
speech acknowledgement and restart, and actual native DO SQL/alarm lifecycle
composition. A separate native alarm test checks earliest-deadline persistence.
The handler fixture uses an explicitly labeled alarm emulator; the Worker
fixture uses actual native storage. Manual invocation of the exact alarm
handler does not qualify real deployed alarm event delivery. Required account,
personal and optional source/provider outages fail explicitly in fixtures.

Shared account withdrawal and authorization discovery, migration admission,
the onboarding actor's held reader/protocol repairs, operator binding races,
final shared composition and all integrated exact-candidate checks remain
coordinator gates. Broker account/origin provisioning, provider admission,
durable wake in the selected runtime and real native-phone acceptance remain
held. No provider, credential, resource, domain, deployment or financial action
is part of this handoff.

## Source provenance

Construction follows `telegram-community.ts`, `telegram-accounts.ts`,
`telegram-publication-authority.ts`, `telegram-managed-publication.ts`,
`telegram-linked-study.ts` and `telegram-frozen-study.ts` at the exact base.
The shared authority interfaces are imported from canonical paths at the held
core pin; they are not copied from another worktree. Native alarm transactions
follow the existing storage API used by `operator-store.ts`.

The new tests extend the existing `telegram-fixture.ts`,
`study-community-fixture.ts`, `telegram-bot-fixture.ts`,
`telegram-minimal-roundtrip.test.ts` and `study-binding-wake.test.ts` patterns.
They preserve the existing native message interactions and copy. No new Paper,
widget or coach design is proposed or implied approved.
