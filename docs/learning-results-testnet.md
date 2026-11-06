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

## Testnet candidate, 2026-11-06

The candidate contract is `0xc26d3b5df9e191148424323bb61ee019e432dc74`
on MegaETH testnet 6343. Directory configuration revision 3 selects it. The
application remains at the existing first-song origin and the operator is
`pirate-learning-testnet-v2`. Alchemy retains the existing application resource
identities and its authenticated dependency preservation copy. The exact
[contract receipts](deployments/learning-results-testnet-20261106.contract.json)
and [configuration and policy](deployments/learning-results-testnet-20261106.configuration.json)
are retained with this source. This section does not claim completed learner acceptance.

The pilot qualification policy starts at learning period 5, on 2026-11-06 at
17:00 UTC. It accepts Karaoke terminal outcomes, requires 70 percent over the
fixed eligible denominator and permits at most 10 percent unmeasured lines.
Earlier periods earn no qualifying day. Delayed publication keeps its original
day and policy. No funded rewards are enabled.

The first song now has real forced alignment for all 23 sung lines. The provider rejected the first request before processing. A separately
bounded recovery request succeeded after the workspace_owner resolved the issue. Both responses were retained. The provider includes whitespace
separators and whole section labels in its word list; the parser accepts those
while retaining timing, loss, transcript and occurrence checks. Reprocessing the
successful saved response bought no additional provider work.

A timed manifest is limited to one 262144-byte raw IPFS block. Its public
SHA-256 result revision therefore determines its CID directly. The first timed
manifest is 18233 bytes and is pinned at
`ipfs://bafkreigdj6qu6xxy5nfyxghfjc5oyvkx3pg25wxfecjp72t662biua7m7y`.
Practice admission checks its public availability. A public reader can retrieve
that manifest and authenticate its complete ordered lyric set using historical
post and configuration evidence, without the community database or API.

Read-only simulations against the deployed testnet contract, using synthetic
EOA consent and state overrides, estimated the following execution gas. All
simulation calls succeeded. These are not funded learner publications or
mainnet operating quotes; MOSS enrollment measurement remains separate.

| Operation | Estimated gas |
| --- | ---: |
| Enroll once, EOA | 234973 |
| Publish 23 lines | 333539 |
| Correct 23 lines | 333647 |
| Publish 40 lines | 388049 |
| Correct 40 lines | 401681 |
| Revoke, EOA | 123438 |

The pilot service allowance is a fixed lifetime 50000000000000 wei, with a
1000000 wei gas-price ceiling, 1500000 gas per transaction and a conservative
100000000000 wei data-fee reserve. Session admission reserves publication and
one correction atomically; enrollment also reserves a future revocation. The
service charges the full maximum rather than silently recycling unused gas.
The shared speech allowance is ten starts per UTC day, including alignment,
reconnects and uncertain sends. The two alignment requests consumed that same
allowance. None of these controls refills the native sponsorship allowance.
Service controls and point-in-time L1 fee quotes do not independently constrain
a compromised signing key; funded-key and inclusion-fee exposure still need
qualification before mainnet.

Private history remains an interim operator-held thirty-day receipt with an
authenticated download. It is not the learner vault. Study, independent-provider
escrow, rewards, per-community pseudonyms and automatic records deployment by
the wizard remain later work. Adding Study requires a result adapter and a
contract successor; this deployed contract authorizes Karaoke only. Mainnet work starts only after deployed testnet
learner acceptance, correction/recovery qualification and complete cost measurement.

The workspace_owner observed slow page loading, an awkward enrollment alert
and an indefinite audio-start spinner during live acceptance. The requested
disposition is to record the UI and load-performance issues for later work,
without a visual redesign in this task. The functional startup defect is a
case-sensitive address comparison between deployment profiles; the equivalent
Ethereum addresses must compare equally. The browser fixture now deliberately
uses mixed address casing across its community and operator.

Actual sponsored MOSS activation and ERC-1271 enrollment succeeded on testnet.
The retained enrollment signature was 737 bytes. Activation used 327442 gas and
enrollment used 340557 gas at 1000000 wei per gas. These are separate from
recurring terminal-publication costs. The
[MOSS receipts](deployments/learning-results-testnet-20261106.moss.json)
record this actual path without claiming a completed learner performance.
