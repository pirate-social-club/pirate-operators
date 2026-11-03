# Reward-pool settlement boundary

The pool uses the minimal Megapot V2 wire surface in IMegapot.sol. Its local
mock exercises failure modes independently. A separate pinned mainnet fork now
checks actual purchase ownership, winning and losing claims and emergency
refunds against deployed provider code. No public transaction is sent and no
upstream contract implementation is vendored.

The initial interface research used the published V2 audit snapshot at commit
538649e8a05b07efa706083d1158c65f640cb823:
[Jackpot.sol](https://github.com/code-423n4/2025-11-megapot/blob/538649e8a05b07efa706083d1158c65f640cb823/contracts/Jackpot.sol).
The current deployments differ from that snapshot. The verified mainnet and
Sepolia source was subsequently compared with live runtime code, and the
selectors and drawing-state tuple used by the pool match both deployments.
See [fork verification](megapot-fork.md) for exact addresses, hashes, source
links and the limits of that comparison. Audit-snapshot provenance alone is
not proof of deployed compatibility.

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
touch a purchased pool or its allocations. Purchased current-drawing tickets
can instead be recovered when upstream emergency mode is enabled. That path
credits the actual refund to the sponsor and cancels the pool. It cannot touch
a completed drawing or participant allocations. A stalled provider with no
emergency flag still blocks settlement.

The mock is independently written. It simulates ownership, mint callbacks,
burning, pricing and final drawing state through these selectors. Its prize
calculation assigns one total fixture outcome to the pool's tickets. It does
not reproduce number validation, tier payouts, referral accounting, entropy,
referral-adjusted emergency amounts, a complete ERC-721 implementation or
provider upgrade behavior. It implements a separate current-drawing emergency
refund model for failure and accounting tests. Adversarial modes include a successful zero claim before finality,
an advanced drawing ID without results, claim failure and a finalization
callback during settlement.

The fork supplies a pinned deployment, token and NFT wiring, actual ownership,
finality, one winning tier, loss and emergency recovery. Live oracle delivery,
other winning tiers and public operation remain outside that proof. Refresh
deployment evidence before a live integration instead of assuming these
historical pins still describe the intended target.

Focused tests cover quoted cost, approval reset, separate executor permissions,
price-cap refusal, early settlement, missing results, loss, rollback/retry,
reentrant finalization, sponsor capital and the specified signature domain.
Stateful tests track minted tokens, accepted registrations and withdrawals
independently across randomized actions. They assert conservation, finality,
one registration per scoped nullifier and wallet, and one withdrawal per wallet, exact splitting
and continued backing for all unwithdrawn allocations.
