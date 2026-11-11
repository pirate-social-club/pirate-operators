# Wallet assembly privacy repair — exact W1 proposal

This packet proposes two bounded P2 corrections against
`6c26c677ee2a68a4055884fb17cb057ec9d8569b`. The assigned W2 checkout remains
unchanged at `a8666842291afe1be87cfd5cea5940389f46a263`; it is not the integration
base. The earlier verification cancellation repair and coordinated failure-budget
correction are retained from exact W1. All files here are proposals for coordinator
custody. No proposal has been applied or executed in W1.

The review is bound to SHA-256
`d945414386160d33726951393002d5afe6e9be8f3c3d6d543ed19270624e9e2d`.
The separate Study header finding belongs to the original learning lane.

## Concrete producer and interface

`packages/community/accounts.ts` creates private `community_accounts.account_id`
with `crypto.randomUUID()` during verified login. `accountSession()` joins that
private UUID, binding and session. `services/rewards-community-api.ts` already
captures `principal.accountId = session.account_id`; it uses that value to select
credits. `services/community-profiles.ts` exposes the same UUID through the
authenticated `/api/profile/owner` contract. It is distinct from public author ID
and MOSS address. No new account identity is invented or inferred.

The minimal producer proposal adds `accountId: principal.accountId` to the private
wallet and credit-list response envelopes. Existing financial `RewardWalletView`
and payment contracts are unchanged; a small wallet helper validates the additive
private field at runtime. No profile fetch, migration, public profile change,
provider call or entry mount change is needed.

The adapter captures its existing session CSRF value. Every learner wallet read
sends `x-csrf-token`; every credit page also sends `x-pirate-reward-owner` with the
validated private UUID captured from that wallet response. The actual rewards
producer rejects supplied mismatched session/owner guards before private reads.
The guard is optional for compatibility with existing independent single-read
clients; the new wallet adapter always sends it. A supplied owner without the
matching session guard is refused. Operator routes/payloads are unchanged.

The controller reads wallet then credits under one request/verification/session
generation. Private GETs carry an abort signal; each page checks its captured
lifetime before requesting and after decoding, so a cancelled/stale body cannot
start another page. Financial POSTs are not aborted or replayed by this read
lifetime. Every page envelope and every row must match its captured UUID. The
summary consumer independently checks wallet owner and every row before summing.
Missing owners, public IDs, MOSS addresses, foreign rows or stale scopes fail
closed; there is no inferred owner, partial-success filter or default-ready state.
Duplicate credit IDs, bounded pagination/cursors, currency and exact amount
validation remain. Claim responses are checked against the same private owner.

This binds each response to the authenticated server session at its request,
and publication to the current captured client lifetime. It does not claim that
an HTTP response can observe an unreported cookie change after its own headers.
The reported A-body/B-next-page race is refused at the next request, before its
private read. Known client session replacement masks all old accessors immediately.

## Header denial and lifetime behavior

`live/api.ts` keeps the existing GET fast path and original messages. Typed status
is added without waiting for error JSON. POST now also rejects 401/403 at headers,
before decoding. Ordinary errors retain decoded code/retry behavior.

Known current 401/403 or invalid private scope masks view, credits, winnings,
QR/verification and action accessors; invalidates refresh/verification/busy
generations; stops timers; and clears cached private projections. The existing
Portfolio/Hub/Receive/Send/Winnings descendants and their portals unmount through
the same composition seam. `live/rewards.tsx` only substitutes a reopen/sign-in
link for the temporary-error Retry button after terminal authority loss. It does
not redesign the page or alter the shell.

Authority loss is sticky for the old controller. A changed CSRF prop cannot grant
it new authority. New session recovery requires the normal fresh page/session;
the old claim/verification return URL is removed so reauthentication cannot
automatically replay it. This removes an automatic resume route, not a server
intent or receipt. No cancellation/deletion/write is sent on authority loss.
Unknown claim/payment/SDK outcome records, payment nonces, receipts and native
wallet recovery stay with their original durable producers. Payment/nonce/Max,
MOSS SDK, hosted token-only navigation and explicit native approval source are
byte-identical to W1. No Send, verification provider or payout is performed.

Ordinary 503/network failure preserves an already validated current projection
and explicit Retry. Cancel/replacement/disposal retain the reviewed request and
busy ownership fences, and current verification still follows its original
qualification/claim transitions. Genuine account replacement also invokes the
existing account-change callback/reload after masking.

## Prepared cases and coordinator probe

All new cases are **UNRUN**. No tests, types, builds, browsers, installs, providers,
devices, cryptography, keys, financial actions or release commands ran in this
source actor. Writing test code does not establish that it passes.

- Nine Node HTTP/consumer cases use actual `get`/`post`/`rewardsData`/summary and
  native deferred `Response.json()`: GET/POST 401/403 before body decoding,
  A-page/B-page mismatch with same currency and distinct IDs, missing/foreign
  owner rejection, cancellation/replacement before another page request, positive
  current-owner multipage totals and ordinary 503.
- Ten component cases mount the actual controller or `LiveRewardWallet` with its
  default HTTP adapter. They cover header masking of amounts/winnings/Receive
  portal/actions, held verification responses and stopped timers, late wallet
  and credit bodies after replacement/disposal, foreign rows and 503 recovery.
  Component verification uses an honestly absent launch URL; native App cases
  below exercise actual QR generation. No canvas or success substitute is added.
- One root case uses actual local login/signature verification and D1, then the
  actual rewards producer/store. Two login-produced UUIDs receive simulated
  settled credits through the existing local rewards fixture. It checks private
  producer envelopes, distinct same-currency rows, positive multipage reads,
  and replacement-session/owner guard refusal before private reads. Local test
  signers are generated only if the coordinator executes that case; there is no
  key export, funding, remote chain or real verification provider call.
- Seven actual built-App cases reuse `serveAccounts` and its genuine private-owner
  fixture contract: desktop/mobile 401/403 header masking, native QR/poll denial
  and no later restart, and held A-page/replacement-cookie B next-page refusal.
  Their strict protocol ports reject unexpected wallet writes. They complement
  the actual producer case; they do not substitute for backend authorization.

Existing source-story, cancellation and native financial recovery assertions are
not skipped or weakened. Necessary synthetic wallet/credit UUID fields are added
to existing fixture inputs and the duplicate-page adapter invocation. Original
amounts, payment/nonce facts, assertions and counts remain. Existing operator
fixture payloads remain unchanged.

Minimal coordinator order: review/apply or adapt the exact pinned patches; run
the new HTTP/consumer and root producer cases; run new component and actual-App
cases; then the existing serial wallet/cancellation/native and complete web/root
checks. Use new output paths to preserve historical evidence. No shared harness,
manifest, dependency, workflow, entry or actual runtime is edited here.

The reported full web passes (455 Node, 112 components, 22 static, 53 App, 38 wallet,
29 native, build/reproducibility) remain dated predecessor evidence only. Gate20
was reported running and is not inferred to pass. Real MOSS/palm/device/native
approval, provider inputs, combined all-page rendering, full root/CI and release
acceptance remain separate coordinator/owner decisions. This packet establishes
neither whole-held-branch nor production acceptance.
