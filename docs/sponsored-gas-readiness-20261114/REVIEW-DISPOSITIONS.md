# Review history and current dispositions

This is a design response, not a claim that a service or contract fix has shipped. The current total is84 proposed cases, all UNRUN. The sections distinguish the prior review from the current follow-up.

## Prior review: 05e293d to bc39fdd

The following dispositions describe the prior72-case revision; the next section supersedes its replacement-budget rule.

| Concern | Revised proposal | Evidence still required |
|---|---|---|
| Immutable registry and daily admin attestations | Decide scoped attester successor before any relied-upon deployment. Current build supports finite disposable manual rehearsal only. | New bytecode/generated ABI, trust scope, migration and adoption review; ATT-01 through ATT-07, UPG-01 |
| Refresh cancels in-flight grants | Separate semantic authority revision from pure observation refresh. Same-authority live refresh preserves grant revision; semantic changes/revocation invalidate it. | Successor specification and tests; no current ABI change |
| Revive/revoke powers and false freshness | Attester cannot revive expired/suspended scope or enable issuance. Admin revocation invalidates freshness and semantic revision. Observer trust remains explicit. | Scope escalation, expiry and compromise cases |
| Shared sender nonce blockage | Pause new sender signing, bounded queue; proposed explicitly approved same-nonce attempts preserve original forever. No automatic replacement. | SUB-01 through SUB-06, attempt-aware SDK qualification |
| Release after nonce consumption | Canonical safe consuming-transaction proof required, fees reconciled, cancellation not operation success; reorg reverses settlement. | Exact sender/nonce/raw/receipt/ancestry, unknown-fee and reorg evidence |
| General membership prerequisite was too broad | Manual pilot wallet/community/action list plus existing action-specific authority. Grants, learner consent and controller/name rights do not require a new general membership store. | AUTH-01/03 revised; AUTH-06 through AUTH-09 |
| Username as selected-feature prerequisite | Optional API/UI gate with first-claim/recovery/renewal exceptions. Exact community attribution and active ownership policy needed. | UX-01/02; no universal membership or production transfer policy adopted |
| Several names per wallet | Primary display selection separate from wallet identity; any qualifying name may satisfy the proposed gate. No multiplied gas/free-name allowance. Current free cap is not per wallet; paid initial mint does not exist. | UX-03 and explicit future issuance/migration qualification |
| Extensible successor | Evaluate immutable ownership core with scoped issuance modules before real users. Core must enforce uniqueness/holder protection/shared caps; no module bypass or proxy selection here. Resolver changes cannot freeze the old registry. | Successor design, paid/renewal decisions and UPG-01/02 before relied-upon adoption |
| Reverts, merchant RPC checks, relay outage, signature size | Safe-state simulation before reservation, Pirate-owned checks, revert controls, unknown-intent retention and actual passkey-payload measurements. | MOSS-08 through MOSS-12; initialized/fresh actual consent cases retained |
| Fee ceilings and concurrency | Observed-price multiplier plus absolute per-flow cap, explicitly selected later. Bounded in-flight liability and prompt proven-unused release. | COST-05/06; no numeric limits invented |
| Finality mismatch with older directory | Require safe-block evidence in this plan; public af70 is historical and not the corrected successor. | Separate corrected Directory checkpoint and gates; no duplicate registry acceptance |
| Restore/DR scope | Pilot refuses journal rollback/data loss; guided restore, cross-host migration and automated DR deferred. Ordinary durable restart and uncertain-effects safety retained. | No new operator rollout gate; REC-07/08 retained as deferred design cases |

The earlier atomic reservation, single coordination object, separate issuer/submitter/payer scopes, full-call/domain validation and measured fee-accounting requirements remain. No authority TTL, locked renewal terms, issuance counters or contract permissions change. The server may restrict what it pays for without changing what a holder or third party may do at their own expense.

The original 46 case IDs remain. AUTH-01/03 replace generic membership wording with exact action authorization and pilot admission; ATT-02 explicitly refers to the current immutable build; REC-07/08 are marked deferred. Twenty-six new cases cover the follow-up. These are planned scenarios, not executable test declarations or passing results.

## Review of bc39fdd: follow-up

The review accepted the prior design direction but identified a shared-sender deadlock in sum-of-attempt reservation. That limit is superseded here before a second community shares the backend sender.

| New concern/input | Disposition | Planned evidence |
|---|---|---|
| Attempt reserves exhaust originating community | One nonce-group maximum; retain original identity and all potentially signed attempts. Atomically update conditional community/recovery allocations. | Revised SUB-02, SUB-07/09/10; prior reorg cases retained |
| Clearing sender is Pirate overhead | Protect recovery budget and real sender native float from normal use. Charge bump excess and cancellation to Pirate recovery. Finite reserve is not a guarantee against arbitrary fee shocks. | SUB-08/11, actual receipt accounting |
| Revocation causes avoidable outage | Add proposed admin atomic revoke-and-re-attest, one semantic transition, independent fresh proof; retain standalone urgent revoke. | ATT-08 |
| Successor needs its own exit | Propose holder-initiated atomic export/import, source tombstone and explicit lineage routing. Exact protocol remains open; no retroactive Registry56 freeze. | UPG-05; implementation-level schema/handshake review |
| Paid purchase details | Propose one explicitly configured ERC-20, exact fixed-price debit, zero native value, atomic rollback, and recipient consent even for self-purchase. No live asset/price or post-sale refund policy chosen. | UPG-03/04 |
| Renewal decision | Retain permissionless renewal in proposal; zero has no automatic sunset. Decision whether new real zero-price generations are permitted remains explicit. | UPG-06 |
| Shared module rules and labels | Core owns uniqueness/caps/locked terms; common canonical byte rules across Solidity/TS, paid-short permission separate from syntax. | UPG-02/07 |
| Pilot names | Notice before claim: disposable test deployment, no promised production entitlement or automatic migration. | PILOT-01 |
| Corrected Directory publication | Separate coordinator-owned source/gates; no new public successor inferred in this packet. | Actual public commit required before adoption claim |

All prior72 IDs remain; SUB-02 is amended,12 cases added, total84 ALL_UNRUN. Earlier counts in the prior-review section describe that historical revision, not additional execution evidence.
