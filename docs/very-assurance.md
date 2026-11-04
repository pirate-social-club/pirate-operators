# Very assurance and the next freshness experiment

The [live probe](very-probe.md) tested one existing enrollment, numeric action
scopes and fresh request challenges. It did not connect different wallets or
establish that one person cannot obtain multiple enrollments. Different scoped
identifiers do not prove cross-pool unlinkability: public claimant/recipient
addresses, transactions and operator observations can still connect activity.

The operator does not recall whether every successful request required a new
palm scan. The number of scans during debugging cannot resolve that question.
The successful probe's broad timestamp bounds prove neither a recent scan nor
fresh liveness. A fresh proof and fresh biometric capture are different claims.

Very's [ZK documentation](https://very.org/docs/developers/zk-integration)
documents a timestamp predicate, an expiry bound and request-binding options,
but does not define enough timestamp semantics to treat a short-window failure
as proof that the timestamp is enrollment time. Its
[Palm Verification overview](https://very.org/docs/developers/palm-verification)
describes re-verification and step-up capture; that description does not show
which freshness guarantee this specific ZK query enforces. The separate
[liveness documentation](https://very.org/docs/developers/liveness) also does
not make a recent ZK timestamp a substitute for a verified liveness claim.
These sources were checked on 2026-11-03.

## Controlled experiment, not yet run

Use the same existing enrollment and the same pinned app/context/type/scope
throughout. Change one predicate at a time. Keep the known credential-expiry
predicate separate from the timestamp condition; changing both would confound
the result. Do not create another enrollment to investigate this.

1. Establish a broad-window control that passes binding and hosted verification.
   Record whether the phone actually requests capture, without recording images.
2. Wait until that known verification is older than the proposed five-minute
   freshness window, with a clock-skew margin. Otherwise a cached recent result
   could pass without showing whether the app can require a new scan.
3. Issue a fresh challenge with a timestamp lower bound of issuance time minus
   five minutes and a bounded upper limit. Freeze both bounds in the request.
   Record the exact query bounds, issue/accept times and redacted failure stage.
   Acceptance delay increases the maximum possible age: a five-minute lookback
   plus a five-minute request lifetime can admit a ten-minute-old timestamp.
4. Observe whether the app requests a new scan, allows reuse, or fails. A pass
   with a new scan supports that path only. A pass without capture needs provider
   explanation. A failure is inconclusive about timestamp meaning.
5. If needed, use a contemporaneous broad-window control and an explicitly
   supported re-verification of the same enrollment to separate query support,
   timestamp behavior and transport errors. Never weaken a failed binding check.

This is a plan, not an implemented freshness mode or an observed guarantee.
Before making freshness a reward-admission rule, confirm the provider's field
semantics and clock behavior. Even a mandatory live scan cannot prevent the
credential holder from cooperating with someone who controls another wallet.
The protocol can bind the request to an authenticated wallet; it cannot infer
who exclusively controls that wallet or eliminate lending and real-time relay.

## Questions prepared for Very

These questions have not been sent. Provider clarification would establish the
claimed contract and limitations; it would not independently prove biometric
accuracy or the absence of duplicate enrollments.

1. What event does the type-3 credential's `val` timestamp describe: enrollment,
   successful capture/re-verification, credential issuance, or another event?
   Which operation updates it? What does `expiredAtLowerBound` constrain?
2. Can a ZK proof be generated from a cached credential without new palm capture?
   What supported query/flow requires recent capture, and what signed evidence
   lets a backend distinguish capture from fresh proof generation?
3. How are two hands, reinstall/restore, account recovery and replacement devices
   deduplicated? Can those paths issue different credential secrets/nullifiers
   to the same person? What continuity and revocation guarantees apply?
4. Is signal 2 stable for a credential and external scope independently of the
   pseudonym? What numeric range is supported for the external nullifier, and
   is SHA-256 of its canonical decimal text modulo the scalar field the pinned
   signal-3 transform for this circuit/version?
5. Which issuer keys and revocation policy does the hosted verifier enforce?
   Is there a supported circuit/verifying-key package and equivalent verification
   path for MegaETH, including issuer/revocation checks?

No real-money rollout follows from the diagnostic result. The next bounded
implementation is an attester using the [versioned scope mapping](very-reward-scope.md),
followed by a MegaETH testnet flow with explicit test credentials/tokens and the
remaining provider assumptions stated plainly.
