# Compact Karaoke testnet implementation

The workspace_owner authorized pursuing the reviewed plan on 2026-11-06,
with a fully deployed MegaETH testnet 6343 product before mainnet work.
This document records the implementation choices for that testnet milestone.
It is not evidence of a completed deployment or acceptance run.

## Publication and authority

LearningResultsV2 has one immutable community identity and publicity-policy
hash, a community controller, and authorized Karaoke graders. Pirate can deploy
and operate the launch instance; deployment funding does not implicitly select
the controller. Directory configuration remains the controller's operation.
Changing that configuration invalidates its previous namespace verification.

Enrollment is a learner-signed EIP-712 message naming chain, verifying contract,
community, activity mask, publicity policy, expiry and nonce. The launch mask
supports Karaoke only. A relay pays the transaction fee. The nonce is consumed
on enrollment as well as revocation. Each session is bound to the exact grant
identifier before practice. A new enrollment does not revive a pending session
bound to a revoked grant. Renewal supersedes the prior grant.

Initial publication requires the original enrollment to remain current and
unexpired at canonical inclusion. Revocation blocks pending initial results;
those remain private. There is no additional publication deadline. The original
completion time determines the learning day, independently of publication delay.
No funded rewards are enabled. Corrections retain the original context and time
and remain possible after enrollment expiry or revocation.

Each outcome occupies five bytes: a big-endian two-byte manifest ordinal,
one-byte status and two-byte basis-point score. Every scored Karaoke manifest
line occurs in order, including unreached lines. Only assessed outcomes carry
a score; silent, unpaid, unmeasured and unattempted outcomes decode without one.
The event contains the complete result header and outcomes. Persistent session
storage contains the current commitment only. Corrections supply the previous
bundle and must match its current commitment. Controller invalidation creates
a new revision; an ordinary grader cannot restore an invalidated result.

The contract enforces structural coverage of the declared line count, not the
honesty of the grader or source membership against the historical posts index.
Public readers must authenticate the pinned source manifest, song tuple and
full line count. A grader-supplied shortened manifest is not accepted evidence.
This is the explicit enforcement split for standing enrollment, which does not
individually authenticate each session's exercise set. Study is unsupported by
this version until its separate result semantics are implemented and qualified.

## Runtime and private history

The deployed operator profile is pirate-karaoke-testnet-v2. It requires testnet
chain 6343, internal accounting, the v2 contract, explicit sponsor limits and a
shared speech-budget binding. Local fixture control endpoints are unavailable
in this profile. A Durable Object alarm advances abandoned sessions and pending
publications independently of the browser. Idle objects retain a later history
expiry alarm instead of polling continuously.

Internal accounting is a distinct signed quote/result mode. It creates no
redemption references and performs no ticket-close payment transaction. The
same scorer measures covered lines; the verifier checks the selected mode.
The sponsor journal reserves work before session acceptance and conservatively
charges the full transaction maximum for allocated work. Unknown and reverted
transactions remain charged. Its configured lifetime allowance cannot reset
through restart or a changed profile. This deliberately stops earlier than
actual-fee accounting might. L1 fee enforcement and funding exposure must be
qualified before public sponsored deployment; execution-gas accounting alone
is not a complete hard native-fee bound.

The shared speech ledger counts every provider stream start before dispatch,
including reconnects and unknown outcomes. Its day resets at 00:00 UTC; this
operating-budget boundary does not change the 17:00 UTC learning day. The cap
is explicit deployment configuration and cannot change within an active day.
Live speech and alignment acceptance require bounded provider execution.

The interim private receipt preserves expected text, recognized word timings,
source and scoring versions and final outcomes. It distinguishes recognition
evidence from pronunciation conclusions. Retained receipts can be downloaded
through an authenticated community session and ticket-scoped proof. The
operator removes private history, relay snapshots and recognized words after
the configured retention interval. The launch disclosure selects thirty days.
This is not an implemented learner-held encrypted vault or backup system.

## Acceptance still required

Qualify the real MOSS testnet enrollment path for activated and new accounts,
with an explicitly approved account activation when required. Preserve unknown
activation and enrollment transactions across interruption. Use actual Worker
runtime and browser checks for the automatic publication flow, private export,
retention, shared speech exhaustion and scheduler recovery. Compare independent
public reconstruction at the same canonical head, including correction and
reorg fixtures. Publish and inspect the exact deployment package and bindings,
align the real song under a bounded execution and complete a real learner run.
No live deployment or provider success is implied by local tests.
