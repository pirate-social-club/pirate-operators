# Telegram source handoff

This lane implements native trial Study, secure account linking, returning linked
Study and opt-in notifications as mountable modules. It creates no deployment,
provider connection, credential or public-chain operation. Shared routing,
schema/configuration and publication changes belong to the coordinator.

## Interaction and provenance

`/start` opens Songs immediately. A song tap starts the existing Study queue.
The bot sends a short line prompt and cached reference voice; the learner replies
using Telegram's native microphone. A verdict precedes the next line. There is no
exercise timer, idle reset, new permission screen or enrollment checkbox.

Songs is pinned and edited in place when its delivery receipt is known. Your
Songs uses actual streak/resume facts. The daily draw is one shared timestamp;
native fallback text does not claim to provide a running widget countdown.
Downloads send the complete published song with its verified bytes and filename.
Public reward offers remain distinct from the learner's actual participation.
Unavailable, no-offer, upcoming, closed, practice, testnet and live states remain
distinct. A score alone never means entered or paid. Karaoke, Dance, Claim and
Send open the full website. Mini App hosting remains separately qualified.

`packages/telegram/presentation.ts` provides ordinary native messages and a
presentation port. It does not implement or approve widgets. The UI lane can
replace presentation using the same authoritative state and opaque actions.
Native audio, useful captions and ordinary buttons must remain available.

Source references are the existing c7cb8783 Study/Session/YourSongs presentation
and vendored Solid UI in this repository, plus the legacy native handler patterns
at reference commit `67f58050`. No centralized runtime dependency was added.
On this continuation, the updated Paper R1–R7 storyboard in file
`01M4DWHDEJ6WVWRH6FVX7E3017`, page `p-7-0`, was inspected read-only: pinned Songs,
native voice, separate verdict, compact results, account connection and returning
practice. These are proposed frames with tune-ups pending; earlier rejected
frames were not revised. There is no claim of widget approval or device testing.

## Account connection and returning use

Signing up on the website does not connect Telegram. A deliberate Connect action
creates a five-minute navigation reference bound to the numeric Telegram sender,
community, bot and generation. The existing community session proves account
control. An independent platform login broker proves Telegram identity.

The protocol joins these proofs using exact registered returns, separate host-only
browser cookies, community state, S256 PKCE, nonce and issuer/audience/signature
validation. The signed `profile.id` must match the original numeric sender.
Neither `sub`, usernames, forwarded URLs nor Telegram admin flags substitute for
that proof. Completion is an authenticated same-origin CSRF-protected POST with
an account-switch fence. GET only inspects the transaction. Server redemption is
durable, single-use and idempotent for the same redemption ID after a lost reply.

The durable grant permits Study, progress, reward-status and notifications. It
contains no wallet signing, transfer or moderator authority. Returning Study uses
that grant with fresh account/authorization checks, without requiring a browser
session in chat. Same-bot credential rotation preserves the grant but requires a
new `/start` and discards old pending work. Replacement or unlink revokes it.
Unlink and notification preferences live in ordinary website account settings;
they remain available when bot execution is disabled. Pending provider work and
unsent notifications recheck authority. No website session is minted from chat.

`services/telegram-accounts.ts` consumes the existing community account session,
MOSS credential binding and account-enabled predicate. It does not migrate login
to a different token or depend on unreleased zkLogin. General conversation and
conversation-memory retention are outside this implementation.

## Trial and connected records

Trial records are private, scoped to community/bot/numeric user and separate from
account Study. They never publish or enter the economic ledger, including after
connection. Future connected lessons use the existing Study service and ledger.
They cannot silently resume a website-reserved or pre-link lesson. Connected
learning retains the current public-results policy; this is not a general private
practice option.

An open lesson closes within 30 days of starting. Its private lesson history
remains available for 30 days after completion or closure, after which scheduled
cleanup removes it subject to existing recovery safeguards. Public records remain
separate. Active progress resumes only while open; completed/closed private
history can be downloaded during that separate export window. After cleanup the
song is still available and a new lesson starts cleanly; the old history is not
silently restored. The bot reports that expired history is no longer available.

Trial audio bytes are never journaled. File handles are removed after application
or within 24 hours; an unknown provider result is recovered through status, not
by reuploading. Cleanup holds an unresolved provider/delivery outcome before
removing its related history. Five-minute linking state, including verifier,
browser/account bindings and completion-code indices, is pruned separately from
durable grants. Minimal replay tombstones remain. This makes no deletion promise
about messages or files retained by Telegram or a speech provider.

## Admission, grading and failure behavior

`TelegramTrialSpeech` consumes lane 5's per-community, per-provider-key-generation
reserve/dispatch/get/resolve interface with channel `telegram-trial`. There is no
fallback to the legacy global count-only budget. The current lane 5 SQLite
implementation was exercised directly with simultaneous website/trial fixtures:
trial units cannot consume website-reserved units. That is a unit-reservation
test, not proof of provider concurrency or rate isolation under real load.
Per-user daily speech and open-lesson limits are required mount inputs.

A known provider refusal consumes no counted take and preserves the prompt.
Known rate limits get one bounded retry with backoff. Unknown submissions recover
only by status/retained receipt, never by another chargeable submission. Updates,
jobs, grants, callback bindings and delivery effects are journaled transactionally.
An unknown Telegram send cannot be assumed idempotent: without a retained send
receipt it stays held rather than being blindly resent.

Trial grading delegates to the shared Study grader and queue. The default follows
the released `STUDY_POLICY`. Lane 5 can supply its full policy-at-start and spoken
rerecord grading port after its owned policy/queue changes are integrated. This
lane neither silently activates V5 nor duplicates its spoken-language checks.

Linked Study requires lane 6's current connected authorization resolver and a
lane 5 factory that binds `telegram-linked` admission and **durably persists the
Telegram publication fence**. The adapter refuses a legacy factory without that
capability. A callback check around submission is insufficient: queued unsent
publication must recheck the current grant after restart. The concrete metadata
and hook requirements are in `.local/linked-publication-fence-proposal.json`.

## Coordinator mounts

`services/telegram-community.ts` composes the controllers. Supply SQLite Durable
Object storage, current registration, account and authorization services, admitted
catalog/reference audio, speech admission/transcriber, bounded voice access,
managed delivery, current notice facts, and a durable earliest-deadline scheduler.
The scheduler must survive isolate termination; `waitUntil` or a process timer
alone is insufficient. ACK waits for persistence and scheduling, not speech work.
Run `tick` on the durable alarm/queue, and run retention periodically. Notification
entry points also schedule durable work. A pre-armed retry protects a consumed
alarm if processing crashes. Provider/status recovery ports must remain bounded.

`.local/integration.patch` proposes community routing and the superseded guest
publication wording. It is review-only and has not been applied. The HTML
`/telegram/connect/return` navigation belongs to lane 1's shell; only the explicit
JSON preflight goes to the protocol handler. Serve callback HTML with no-store
and no-referrer, preserve pending navigation across existing account login, and
mount `TelegramConnectionResult` and `TelegramAccountSettings` using the existing
shell. Do not consume a link on GET or add an enrollment flow.

Bot tokens and webhook secrets should be supplied by the community setup lane
to that community's Infisical scope and runtime, never revealed by the moderation
panel. Show configured/disabled/rotation/webhook-health states, not secret values.
The platform login registration is a distinct integration; a bot token wizard
field does not configure or prove OIDC. `connect.pirate.sc` remains only a candidate.
Inspect the existing registration before proposing another credential.

Per-community production speech also needs the community's own learning operator
in its own account, provider secret, speech quota, publishing grader and sponsorship
cap, with results-contract authorization. The shared `pirate-learning-testnet-v2`
operator remains the pilot. Coordinate with the deployment lane; these requirements
do not block local trial source work and require no new owner policy decision.

## Evidence and rollout gates

Focused tests use real SQLite transactions, WebCrypto JWT verification, queue and
grading code, HTTP route handlers and bounded media transport. Speech, Telegram
delivery/status, provider registration, account activation and economic projections
are explicitly simulated. The linked fixture uses the actual shared Study
services, with simulated operator/publication authority. It proves no live reward
entry or contract qualification. The cross-lane probe imports the actual lane 5
admission and lane 6 predicate and records their hashes; refresh at integration.

1. Coordinator integrates the mounts, durable scheduler, shared policy and
   publication hooks, then reruns the local suites. Keep runtime disabled without
   these ports and a qualified per-key admission mechanism.
2. Before paid trials, approve the concrete community trial allocation and qualify
   mixed website/trial load, 429/refusal behavior and bounded recovery on the real
   provider key. Required provider and credential actions are separate gates.
3. Before linking activation, independently review the protocol and prove the
   chosen login origin, existing registration, nonce echo and callback on real
   iOS and Android with MOSS account switching and a deployed eligible wallet.
   A fresh undeployed wallet remains subject to lane 6's actual activation gates.
4. Run device acceptance for first-start latency against the legacy experience,
   native microphone, audio, retries/restart, pinned Songs, full MP3 saving and
   offline playback, history expiry, unlink, bot blocking/rotation and notices.
   Widget support/fallback requires a separate UI/client check. No real visible
   latency or phone acceptance was measured by local handler tests.

Exact test commands, results, source digests and remaining holds are recorded in
`.local/handback.json`. No changes were made to canonical records or common Git.
