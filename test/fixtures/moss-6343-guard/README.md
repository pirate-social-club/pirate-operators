# Captured MOSS account runtime

This is public deployed bytecode captured read-only from MegaETH testnet 6343
on 2026-11-08. `runtime.json` records the source RPC, safe block number and
hash, addresses, runtime bytes and Keccak-256 digests. It contains no storage,
credentials, keys or wallet signatures. It is test evidence, not a Pirate
contract or a claimed reproducible source build.

The account proxy's default implementation and the relay's capability reply
both named this implementation at capture time. The public package
`@megaeth-labs/wallet-intent@1.0.8` documents the 2D nonce and ERC-7821 account
execution ABI. Upstream account source was inspected at
`https://github.com/ithacaxyz/account/blob/main/src/libraries/LibNonce.sol`.
Source correspondence to this deployed version has not been established; the
qualification executes these exact deployed runtime bytes instead.

The offline test loads both runtimes into a disposable Anvil chain and gives
an invented local account the proxy delegation. Local impersonation exercises
the authorized self-call, not MOSS browser approval or relay signing. No fork,
public write, or new deployed payment contract is involved. The encoder is
also compared with independently constructed ABI calldata.

Recompute each runtime digest with viem's `keccak256` over the corresponding
hex bytes. Re-fetch it with `eth_getCode(address, hex(blockNumber))` against the
recorded RPC, and verify `eth_getBlockByNumber` returns the recorded block hash.
The root test suite checks both digests against the adapter pins. A different
proxy, implementation or account override must fail closed until separately
reviewed and qualified.

The request path was also inspected read-only in the hosted wallet's public
bundle at
`https://account.megaeth.com/_expo/static/js/web/index-84d75623598f3ef5bc796d5dd6c31f0a.js`.
Its SHA-256 was
`7c258d107f4881b01e8335ca6f4756c95d0d0441b052a0d979252aaad96accaf`.
The request validator checks address/ABI/calldata/value types, and the ordinary
call handler preserves raw calldata and opens approval. Those paths contained
no self-target exclusion. No hosted bundle code is imported or executed by
Pirate. This source read does not qualify the approval screen or relay.

Primary interface references are
`https://moss.megaeth.com/developers/methods/calling-contracts/call-contract`
and `https://moss.megaeth.com/developers/packages/wallet-intent.md`.
The installed wallet SDK is pinned to 1.0.8. Its callContract method forwards
the request to the hosted wallet and exposes neither an outer intent nonce
nor a terminal-cancellation guarantee. The guard does not rely on either.
