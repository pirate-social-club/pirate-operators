# Latest reviewer comments: dispositions

| Concern | Disposition in this proposal | Required future evidence |
|---|---|---|
| Daily attestations require admin | Confirmed in both actual contracts. Offline admin supports finite manual rehearsal only. Separate narrow attester is a new contract/authority decision; no change now. | Refresh/expiry/config-revision cases; successor review if pursued |
| Atomic reservation before effects | One explicit synchronous transaction for all rows, durable completion before signer/network effects. No await inside transaction. | Concurrent last-budget-unit races, crash and sync-failure injection |
| PITR can forget spends | Append-only semantics alone insufficient. External signer epoch/high-water fence, pause, reconcile chain AND unbroadcast authorizations. | Restore-before-spend/signed-response-loss tests; missing evidence stays paused |
| Global plus community caps | One object is the pilot transaction boundary. No claim of cross-object atomicity or optimistic compensation. | Two-community global race and user/community/global invariants |
| Do not trust operator Worker | Independent wallet/service authentication and Pirate-owned admission/membership proofs, full installation and call binding. | Compromised app, cross-community, expired membership, mutable-input cases |
| Three separate keys/scopes | Issuer, submitter and MOSS payer distinct service principals, secret scopes and public role bindings. Admin remains separate. | Permission inventory shows no runtime principal can read all keys |
| Delivery order and costs | MOSS consent compatibility first, then finite native-fee measurements. Include separate data-fee fields and recurring attestations. | Initialized/fresh actual claim, payer debit and safe receipts |

The registry grant signer/submitter inequality and lifetime issuance limits stay mandatory. Fee limits are distinct from those issuance limits and from deferred payment-contract spending-cap work. Neither renewal permission nor 24-hour authority policy is changed. No unsupported claim that passkeys, Infisical or a merchant helper constitute cold custody.

The proposed v1 policy is Pirate-paid gas for admitted operations, without operator prepaid balances or wallet funding forms in the wizard. Dollar scenarios are not measured service costs or selected allowances.
