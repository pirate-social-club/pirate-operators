# MegaETH testnet deployment

`OperatorPayments` runs on MegaETH testnet (chain 6343). The deployment of
2026-11-04 is recorded in
[`evidence/megaeth-operator-payments-2026-11-04.json`](evidence/megaeth-operator-payments-2026-11-04.json).

| Item | Value |
|---|---|
| Contract | `0x98a5242f80ecc9e01295e03a18712b4256d9f071` |
| Runtime code hash | recorded in the evidence file |
| Token | PirateTestUSD `0xC5321666F425812D1C12F44dA7BFe08CEB00044B` (6 decimals, no value) |
| Community | `0xBF85a150114d3df8B90A7793C0Ea4B2F4bB8C319` |
| Purchase signer | `0xa67aC40Bc3d5e1b25D7da5CA2e8585f335A37329` |
| Operator | `0x14B90A55657D9695A727254EAec5E0e32D20d602` |
| Deposit | 500 ptUSD, less the 0.001 ptUSD smoke purchase |

The run deployed the contract, minted and deposited test tokens, named the
purchase signer, and ran one smoke purchase: the signer authorized a segment
purchase, the operator redeemed it and closed its ticket. Independent reads
confirmed the domain separator, signer, deposit, the stored redemption digest,
the closure and the operator's payment.

Measured gas at the run's effective price of 0.001 gwei:

| Step | Gas |
|---|---|
| Deploy `OperatorPayments` | 64,659,412 |
| Deposit | 157,056 |
| Redeem one segment purchase | 243,572 |
| Close a ticket | 110,022 |

One redemption therefore cost about 2.4 × 10⁻⁷ test ETH, or about 10⁻⁵ for a
40-line song. These are testnet prices, not a production estimate.

## Running it again

`npm run megaeth:payments` is manual and never runs in CI. It refuses any chain
other than 6343. It reads dedicated keys from
`~/.config/pirate-operators/megaeth-testnet/keys.json`, outside the
repository, with roles `communityAdmin`, `purchaseSigner` and `operator`; it
never prints them. The community admin needs test ETH from the MegaETH faucet
and forwards gas to the operator itself. Each run deploys a fresh contract and
writes a new evidence file.
