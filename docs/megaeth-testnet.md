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

## LearningRecords

`LearningRecords` runs on MegaETH testnet at
`0x0eae432258c5954cf3d06e707acb3490a2f20a12`, deployed on 2026-11-04 and
recorded in
[`evidence/megaeth-learning-records-2026-11-04.json`](evidence/megaeth-learning-records-2026-11-04.json).
The community admin above is its controller, and the operator is its karaoke
grader. The learner was an ephemeral key, generated in memory, that only
signed consent. The records are synthetic, for a 40-line fixture manifest.

The run opened one attempt and published it as the operator's publisher does,
one transaction per line, then completed it. It corrected one line and
completed it again. It then published a second attempt with the same lines,
in batches of ten. The independent reader (`packages/records/reader.ts`)
rebuilt both attempts from the logs and the manifest alone. It verified every
record and recomputed both rewards, including the corrected one. `cast` reads
of the controller, the grader, the corrected attempt and its corrected line
agreed.

| Step | Gas |
|---|---|
| Deploy `LearningRecords` | 110,488,100 |
| Open an attempt | 380,170 |
| Record one line, in its own transaction | 219,881 to 232,672 |
| Complete a 40-line attempt | 281,143 |
| Correct one line | 194,813 |
| Complete again after the correction | 261,075 |
| Record ten lines in one transaction | 1,457,456 to 1,556,346 |
| Publish 40 lines, one transaction per line | 9,864,137 |
| Publish 40 lines, in batches of ten | 6,786,159 |

At 0.001 gwei, publishing a 40-line attempt line by line cost about
10⁻⁵ test ETH, about as much as redeeming its 40 segments. Batches of ten
used 31 percent less gas.

Two earlier deployments that day are superseded. The first failed one reader
check, the batched attempt's reward. Its address was not recorded, so the cause
could not be confirmed; the likeliest is that the reader ran before the last
completion's log appeared. The script now waits for that log and prints what
it read if a check fails. The second, at
`0x3ead04d3935b9f5eee7a577da55983c1b424c0be`, used a completion that copied
its buffer once per line, so its memory cost grew with the square of the line
count. Its 40-line figures were within 2,000 gas of the table, but a 500-line
completion would have cost about 31 million gas more. The contract now
preallocates the buffer, and a Foundry test bounds a 500-line completion.

## The operator service on MegaETH

On 2026-11-04 the actual community and operator services ran against both
deployed contracts, recorded in
[`evidence/megaeth-operator-run-2026-11-04.json`](evidence/megaeth-operator-run-2026-11-04.json).
They ran in the local Workers runtime with outbound access limited to the
MegaETH RPC, and their clocks followed the chain's block time. The learner was
an ephemeral key that only signed sign-in, the session and consent.

The community admitted the fixture song, issued a ticket and signed each
segment purchase. The operator redeemed the admission and all four segments,
closed the ticket and built the signed result. All four lines were assessed at
10,000. It then published the consented result: it opened the attempt, wrote
four line records and completed it at `performanceEndedAt`. Its twelve
transactions used consecutive nonces and all succeeded. The deposit fell by
6,000 units, and the operator received exactly 6,000. The independent reader
rebuilt the attempt from the logs and the manifest, and recomputed the reward.
`cast` reads confirmed the closure and the completion.

| Operator transaction | Gas |
|---|---|
| Redeem the admission | 219,518 |
| Redeem a segment | 226,455 to 226,472 |
| Close the ticket | 110,022 |
| Open the attempt | 380,170 |
| Record one line | 208,858 to 208,878 |
| Complete a 4-line attempt | 181,658 |

The run needed one service change. The operator's quote window was fixed at
the local fixture clock, from 1800000000, which is in 2027. It is now operator
configuration (`QUOTE_VALID_FROM` and `QUOTE_VALID_UNTIL`), with the old values
as defaults.

Two earlier runs that day stopped short and left public traces. The first
stopped at the first segment purchase, because the harness had not advanced
the service clocks before opening the attempt. It left an admitted fixture
song and an open ticket with no segment redemptions. The second ran to
publication, but the harness sent the words after the song had ended, so the
operator rejected them. That published a completed attempt with all four lines
`silent`. Both used ephemeral learners. The harness now advances the clocks
before opening, streams words during the song, and requires every line to be
assessed.

## Running it again

`npm run megaeth:payments`, `npm run megaeth:records` and
`npm run megaeth:operator-run` are manual and never run in CI. They refuse any chain other than 6343. They read dedicated keys from
`~/.config/pirate-operators/megaeth-testnet/keys.json`, outside the
repository, with roles `communityAdmin`, `purchaseSigner` and `operator`, and
never print them. The community admin needs test ETH from the MegaETH faucet
and forwards gas to the operator itself. Each run deploys a fresh contract and
writes a new evidence file for that day. The records script uses only the
`communityAdmin` and `operator` keys.


## MOSS consent continuation

The real MOSS signature capture and fork rehearsal are preserved in
`evidence/moss-consent-probe-2026-11-04.json` and
`evidence/moss-activation-rehearsal-2026-11-04.json`. The account activation
and attempt opening on the real network are still pending. The prepared
[activation command](moss-activation.md) resumes its private journal after
interruption and enforces a total ceiling of 0.000001 test ETH. Its network
checks are read-only unless the owner-approved `--send` flag is supplied.
