# Reward-pool settlement boundary

This local M1 follow-up replaces the count-based simulated buy/claim functions
with the minimal Megapot V2 wire surface actually used by the pool. It does
not establish a deployed integration, choose a chain address, or transfer
real funds. No upstream contract implementation is vendored.

The primary source is the published V2 audit snapshot at commit
538649e8a05b07efa706083d1158c65f640cb823:
[Jackpot.sol](https://github.com/code-423n4/2025-11-megapot/blob/538649e8a05b07efa706083d1158c65f640cb823/contracts/Jackpot.sol).
The official [starter kit](https://github.com/coordinationlabs/megapot-starter-kit)
also exposes per-drawing state and distinguishes awaiting, settling and settled
rounds. These sources describe V2, not a promise that an older Megapot deployment
has the same interface or that any listed address has been verified here.

The relevant boundary facts are independently represented in IMegapot.sol:
purchase takes numbered ticket selections and a recipient and returns ticket
NFT IDs; price comes from the drawing state; claiming takes owned ticket IDs
and pays the calling owner. In the reviewed source, final settlement stores a
nonzero encoded winning ticket before advancing to the next drawing. The pool
requires both facts before its public settle operation can change state.
Elapsed time, a lock flag and a zero token transfer are insufficient alone.

The pool records returned ticket IDs and checks ownership. It accepts the
expected NFT callback and claims its own tickets. A separate immutable executor
may purchase only the configured ticket count, in the configured open drawing,
using a quote below the sponsor's immutable maximum token spend. Approval is
limited to that quote and reset after purchase. USDC has six decimals; the
fixture price is one million atomic units, while the pool has no hardcoded
one-USDC price assumption. Unused initial ticket funding remains a sponsor
liability and is not included in the winnings split. A pool with no purchase
can refund prefunding to its sponsor after the entry cutoff; this path cannot
touch a purchased pool or its allocations. A purchased drawing still depends
on upstream finality, with no local emergency cancellation path.

The mock is independently written. It simulates ownership, mint callbacks,
burning, pricing and final drawing state through these selectors. Its prize
calculation assigns one total fixture outcome to the pool's tickets. It does
not reproduce number validation, tier payouts, referral accounting, entropy,
emergency recovery, a complete ERC-721 implementation or provider upgrade
behavior. Adversarial modes include a successful zero claim before finality,
an advanced drawing ID without results, claim failure and a finalization
callback during settlement.

Before any real integration, pin the intended chain, deployment and code;
verify token and NFT wiring; exercise actual purchase ownership, finality and
winning and losing claims; check per-ticket aggregate net payouts and any
emergency or upgrade path. The audit snapshot is research provenance rather
than proof of live bytecode compatibility.

Focused tests cover quoted cost, approval reset, separate executor permissions,
price-cap refusal, early settlement, missing results, loss, rollback/retry,
reentrant finalization, sponsor capital and the specified signature domain.
Stateful tests track minted tokens, accepted registrations and withdrawals
independently across randomized actions. They assert conservation, finality,
one registration per scoped nullifier and wallet, and one withdrawal per wallet, exact splitting
and continued backing for all unwithdrawn allocations.
