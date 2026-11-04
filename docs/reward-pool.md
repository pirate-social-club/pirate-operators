# Sponsored reward registration and recovery

This document covers local contract/provider experiments. External Megapot is
on Base; it does not authorize Pirate contracts there. The reward funding and
production payout route remain undecided. See the [current setup overview](decentralized-setup.md).

The local immutable RewardPool models one drawing's tickets and winnings.
The community verifier commits the qualifying entries. The configured Very
attester establishes credential eligibility. A participant authorizes their
payout address; a relayer pays gas without acquiring custody of the allocation.
No central login service or additional production service is introduced.

## Registration authorization

The EIP-712 domain is `Pirate Reward Pool`, version `1`, with the chain ID and
pool contract address. The new primary type is:

```text
Registration(bytes32 scope,address claimant,address recipient,bytes32 attemptId,bytes32 nullifier,uint256 expiresAt)
```

Scope is `keccak256(abi.encode("pirate-pool-registration/1", chainId, pool,
drawingId))`. The existing RewardAttestation type is unchanged. The participant
and attester sign the same claimant, nullifier, scope and expiry. The
participant additionally binds the attempt and recipient. A Merkle proof binds
the claimant and attempt to the committed entry list. One accepted registration
consumes that claimant and nullifier for this pool, preventing a replay without
introducing a second nonce registry. Authorization and registration must both
remain unexpired when submitted. Signatures are canonical 65-byte ECDSA.

The [Very scope protocol](very-reward-scope.md) specifies the separate numeric
scope sent to Very, the expected proof signal and the contract-facing nullifier.
It keeps this contract's full bytes32 scope unchanged and pins frozen vectors.
The real attester is not implemented; the harness still uses a fake subject.

Any address can call registerFor. The community service is the initial relayer,
but another relayer or the participant can submit exactly the same authorization
if it becomes unavailable. Claimants may have empty code or the exact 23-byte
[EIP-7702 delegation indicator](https://eips.ethereum.org/EIPS/eip-7702#delegation-indicator):
`0xef0100` followed by a 20-byte address. Other nonempty code is refused. This
shared check applies to direct registration and every sponsored batch item.
Sponsored signatures still recover the original EOA key; the pool never calls
the delegated implementation to validate them. Delegated session-key and
ERC-1271 signatures and other contract wallets remain
outside this compatibility scope. Recipients can have code; they must be
able to receive the pool's token. Direct register remains available to the
claimant and fixes its own address as recipient.

Regression tests install marker bytes in local EVM state, then exercise direct
registration, sponsored batches and rejection of a wrong signing key or other
bytecode lengths and prefixes. They do not exercise a wallet upgrade UI or a
type-4 authorization-list transaction. The test VM itself refuses malformed
delegation sizes and versions before that code can be installed.

The constructor's zero duration means seven days. Positive durations remain
explicit overrides for fixtures or a disclosed pool configuration; there is no
minimum-duration enforcement. The clock starts at successful settlement. There
is no extension or provider fallback. Settlement, registration and finalization
do not happen automatically: someone must submit their transactions.

## Payouts and batching

Anyone can call withdrawFor after finalization. It pays only the recipient
stored at registration, once. A claimant-sent withdraw transaction can instead
choose another address for recovery. A failed token transfer rolls back the
withdrawal marker. There is no withdrawal expiry or sponsor sweep.

registerBatch and withdrawBatch accept one through 32 items. Each runs as an
isolated self-call with at most 300,000 gas and emits BatchItem with its success
flag. Oversized proofs or signatures are rejected before copying a registration
into the self-call. A duplicate, invalid signature, blocked address or item
that exhausts its gas does not undo successful siblings. Malformed outer
calldata, too many items or insufficient outer transaction gas can still
revert the whole transaction. Callers should inspect receipts and retry only
failed items, or submit an individual call when a valid operation needs more
than the batch allowance.

These bounds protect a batch, not the community's total gas spend. The relayer
still needs a funded account, request validation and an operating cap. Low gas
prices reduce cost; sponsorship removes the need to acquire gas tokens before
claiming. No fixed dollar fee or production spending policy is asserted here.

## Emergency mode

recoverEmergency requires purchased tickets, an unsettled pool, Megapot's
emergency flag, the same current drawing and no finalized winning ticket.
Anyone can trigger it. The pool calls emergencyRefundTickets as ticket owner,
measures the returned token amount and adds it to unused sponsor funding.
It then marks the pool cancelled. Only the sponsor can withdraw that credit,
to an address of its choice. A failed refund or sponsor withdrawal is retryable.

Cancellation cannot touch an older completed drawing or allocated winnings.
Older tickets continue through settle even if emergency mode is enabled for a
later drawing. Without upstream emergency mode, elapsed time alone does not
authorize cancellation. Self-referral remains deferred; purchases specify no
referrer and recovery credits the actual amount returned, not an assumed fee.

The local suite exercises these state boundaries and accounting rules. The
[fork suite](megapot-fork.md) exercises the real provider. Neither replaces an
independent security audit, live oracle delivery or real Very integration.
