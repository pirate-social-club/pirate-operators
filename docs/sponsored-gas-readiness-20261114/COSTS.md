# Cost measurement and accounting proposal

No measured public-chain gas price, operation cost or numeric allowance is available from this task. Estimate first, record actual receipts, then choose explicit ceilings. Testnet tokens have no money value; any later currency projection must name its gas-price and ETH-price assumptions and timestamp.

MegaETH estimates include compute and persistent-storage gas; ordinary local EVM numbers are not a substitute. Use the actual endpoint and state for exact calldata/creation estimates. Receipt gasUsed already includes both dimensions, so do not add an invented storage surcharge a second time. Mainnet resource documentation is not proof of testnet limits. [Gas model](https://docs.megaeth.com/developer-docs/overview-3/gas-model), [resource limits](https://docs.megaeth.com/developer-docs/overview-3/resource-limits), retrieved 2026-11-14.

## Measurement units

For each operation record source commit, ABI digest, runtime code hash, chain/deployment, block/hash, calldata bytes, actor/payer, state/generation/revisions, estimate and selected limits, safe receipt, gasUsed, effectiveGasPrice, status, raw optional fee fields and actual payer balance reconciliation. Keep integer wei as decimal strings and native asset explicit. Null means not observed; absent L1 fields do not automatically mean zero.

Ordinary EVM execution component = gasUsed * effectiveGasPrice. Additional data/L1 or relay fees are added only after their semantics and non-inclusion in that component are verified. Preserve raw l1Fee/l1GasUsed/l1GasPrice fields when returned. MOSS account payment may compensate a separate outer relayer; report chain cost and sponsor payment separately and do not sum them as independent costs unless proven. [Receipt reference](https://docs.megaeth.com/developer-docs/rpc/reference/eth_gettransactionreceipt), retrieved 2026-11-14.

For a controlled payer balance window: attributable debit = balanceBefore - balanceAfter + knownIncoming - knownNonFeeOutgoing. Include transaction value/token payments separately. Concurrent unrelated traffic or unobserved transfers makes balance attribution unknown; it is not a zero-fee result. Use protocol payment events/traces where needed and separately admitted. Reverted operations consume gas. A fee refund is settled only when evidenced.

## Reservation formula

For an ordinary transaction reserve gasLimit * maxUnitFeeWei plus a proven independent upper bound for all additional fee liabilities. If the fee mode has no maxFeePerGas, bind the selected gasPrice and its actual semantics. MOSS paymentMaxAmount is a protocol cap to verify, not proof of an EVM-only cost model. Require a native payment token, exact fee recipient and final intent.

If an additional fee cannot be bounded, refuse the online request rather than assume it is zero. Also bound native transaction value separately; eligible pilot ordinary calls should have explicit expected value. Fee caps must not be misused as a token-purchase allowance.

Unspent operational budget is cap - settledCosts - outstandingWorstCaseReservations (including unknowns). Check community and global values in the same transaction. Available wallet balance must also cover already authorized liabilities, external outstanding nonce activity and the new request. A balance check does not replace reservations and can become stale; stop signing on low balance/provider uncertainty.

## Coverage matrix

| Operation | Cost owner/route | Measurement distinction |
|---|---|---|
| Shared registry deployment | Pirate setup | One-off creation and immutable profile |
| Corrected shared directory deployment | Pirate setup after gates | New compiled pin, not old estimate |
| Namespace/policy/scope admission | Pirate admin | Per namespace/scope setup, not member claim |
| Registry authority refresh | Pirate admin today | Per namespace; schedule shorter than TTL with chosen operational margin |
| Directory verification refresh | Pirate admin today | Per community and after configuration change |
| Free name claim | Pirate backend submitter | Two signatures, first-year quote0; actual _safeMint account behavior |
| Record write/transfer | Candidate MOSS holder/manager route | Exact allowed key/value/recipient; permission check retained |
| Renewal | Candidate MOSS holder-originated sponsor policy only | Token renewal price separate; third-party contract permission unchanged |
| Directory enrollment/configuration | Exact controller/service route qualified later | msg.sender and original enrollment journal |
| Community post/result | Existing backend path qualified per profile | Data size, per-community results deployment where applicable |
| Failure/revert/reconciliation | Pirate overhead | Revert fee and RPC load, no “free failure” assumption |
| RPC/indexer/D1/R2/Worker/grading | Off-chain budget | Separate usage/provider bill, no invented zero cost |

Budget recurring attestations from measured transaction count and chosen refresh interval per namespace/community, including re-attestation after configuration edits. A 24-hour maximum validity does not safely imply exactly one transaction each calendar day. Charge shared namespace cost once and allocate transparently; avoid billing it once per member.

Record samples across fresh/existing storage, minimum/representative/maximum admitted payloads, initialized/fresh wallet, success/revert, and distinct operation types. First sample is not a percentile. Report count/min/max and raw observations; derive quantiles only with adequate samples. Model 1x/10x/100x observed unit-fee scenarios with fixed stated gas/state assumptions; no promise that future fee/state policy stays constant.

The existing [services/sponsor-budget.ts at pirate-operators af70dc7e744c2f4b4886802e4b78125d3eb79444](https://github.com/pirate-social-club/pirate-operators/blob/af70dc7e744c2f4b4886802e4b78125d3eb79444/services/sponsor-budget.ts) is a conservative lifetime fuse, not a monthly billing ledger. Do not refill its old lifetime counters or silently merge its semantics. New accounting must coexist through an explicit reviewed integration, preserving unknown original transactions.

## Fee ceilings, concurrency and real wallet payloads

Select the live per-flow unit-fee ceiling only after measuring the applicable 6343 fee mode. Record the observed unit price/time, an explicitly approved rational multiplier, the absolute per-operation ceiling and quote expiry. No multiplier or numeric allowance is chosen here. A published mainnet price is not a live testnet observation; a price spike beyond the approved bound pauses rather than silently enlarges liability. Bound independent extras and value as above.

Worst-case reservations can exhaust a small cap even when expected spend is low. Measure concurrent pending liability, limit in-flight requests, and choose gas/payload bounds from actual simulations rather than arbitrary huge limits. Release the proven unused portion promptly after canonical safe accounting. Do not release unknowns to improve the dashboard. Qualified backend same-nonce attempts use one group maximum, with separate protected Pirate recovery headroom and the conditional allocation rules in ARCHITECTURE.md. Ordinary requests cannot consume that headroom. Do not apply the maximum rule to unrelated nonces, MOSS intents or independently charged fees.

Record actual initialized/fresh MOSS account state, nested consent signature length, calldata zero/nonzero byte counts and gas estimate/receipt. Passkey payloads must be measured directly. Track per-wallet known preflight reverts separately from included reverts: preflight refusals cost RPC resources, included reverts consume real gas and remain charged. Rate-limit both request abuse and included-revert count/cost, with explicit values selected later.

Recovery is Pirate overhead: preserve a configured part of the global ceiling and native sender float for unblocking. A community at its fee ceiling must not prevent an otherwise qualified cancellation or fee bump funded from that reserve. Neither the reserve nor manual approval permits exceeding the explicit total ceiling; fees beyond the protected reserve still cause a truthful pause. Report ordinary cost, incremental fee-bump overhead and full cancellation cost separately. An allocation in the ledger does not move ETH between wallets.
