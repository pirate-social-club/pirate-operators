# Pinned Megapot fork verification

This document covers local contract/provider experiments. External Megapot is
on Base; it does not authorize Pirate contracts there. The reward funding and
production payout route remain undecided. See the [current setup overview](decentralized-setup.md).

Run `npm run test:fork` after bootstrap. This suite reads historical Base state
from the public RPC and executes mutations only inside Foundry's local fork.
It requires network access for uncached state and is intentionally excluded
from default offline acceptance. The `--offline` compiler flag prevents
compiler downloads; it does not make fork RPC reads offline. No wallet key or
public transaction is needed.

The fork pins Base chain 8453 at block 53468101, whose hash is
`0x8eb1d72b610c5625539aeaba32d8ec811b865cd4dd888069982396de5314e5c2`.
The suite checks the Jackpot runtime hash before making local calls.

| Deployment                   | Base mainnet                                                       | Base Sepolia                                                       |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Chain ID                     | 8453                                                               | 84532                                                              |
| Jackpot                      | 0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2                         | 0x465dA3c859f193A3807386387bEE941B2A4c3279                         |
| USDC                         | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913                         | 0x036CbD53842c5426634e7929541eC2318f3dCF7e                         |
| Ticket NFT                   | 0x48FfE35AbB9f4780a4f1775C2Ce1c46185b366e4                         | 0x45084829ac63f9dC6a3D4981A46FA896f9180ECd                         |
| Jackpot runtime keccak256    | 0x597f3a8e9360fbfc2e623243507ee9e8a66609003078ffc33d9013cb0607002d | 0x8d3104deb8a3fb663c67f8d4a2da43a15aaf5ad8b0e1d303ceed09f582dd4bc9 |
| Verified Jackpot.sol SHA-256 | a5b3df2a9de2fcd622525a2b131291608c819f908aa6fa142ac871deb59f95b9   | 5441f436cb55de81cb00149cff661378bafe205ac67983256b0139575ecc405d   |

Addresses are identified by the official
[contract guide](https://docs.megapot.io/learn/using-smart-contracts) and pinned
[starter configuration](https://github.com/coordinationlabs/megapot-starter-kit/blob/5fdb6c238ad57d9568cf8fce3adbd1a0a5f34baa/src/config/contracts.ts).
The [mainnet Sourcify record](https://sourcify.dev/server/v2/contract/8453/0x3bAe643002069dBCbcd62B1A4eb4C4A397d042a2?fields=all)
and [Sepolia Sourcify record](https://sourcify.dev/server/v2/contract/84532/0x465dA3c859f193A3807386387bEE941B2A4c3279?fields=all)
reported exact creation and runtime matches. Their runtime bytecode was compared
with public RPC code. Mainnet and Sepolia are different builds: the verified
Jackpot source differs in bonus-ball overflow handling and an event parameter's
width. Neither difference changes the selectors or drawing-state tuple used by
this pool. This is not a claim of identical behavior throughout those builds.

## What the tests establish

All four tests buy a real ticket into a newly deployed local RewardPool and
assert NFT ownership. They use the deployed drawing quote, token, NFT, payout
calculator and Jackpot code. Local USDC funding comes from impersonating the
provider; this does not move public funds. Test-only signing keys are public
fixtures and must never be funded on a public chain.

The winning case calls the real runJackpot, pays its quoted randomness fee in
local ETH, then impersonates the configured oracle to deliver deterministic
numbers. It checks the pool's net receipt against the real tier payout and
referral deduction, registers with a participant signature, and pays the fixed
recipient while the claimant has zero ETH. The losing case confirms a zero
claim settles normally. These cover one winning tier and one losing selection,
not every tier or a jackpot-sized prize.

The emergency case impersonates the provider owner locally, enables its actual
emergency mode, calls the actual ticket refund as pool owner and recovers both
ticket capital and unused sponsor funding. A fourth case finishes a drawing
first, then enables emergency mode for the next drawing. Cancellation is
refused and the older ticket still settles to participant winnings.

Oracle delivery is deliberately controlled. These tests do not prove Pyth
liveness, permission to operate a live drawing, current testnet availability,
real Very nullifier stability or a live sponsored-claim deployment. Sepolia
source and wiring were inspected read-only; this suite forks mainnet only.
Self-referral and referral-fee collection are not implemented.
