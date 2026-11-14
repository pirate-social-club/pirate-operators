# Shared naming successor specification — proposal 0.1

Status: design proposal for review, not a generated interface, implemented contract or deployment approval. This begins from the public bc39fdd design review and addresses the next review's nonce reserve, atomic attester replacement and successor questions. It does not rename or overwrite the accepted Registry56 protocol, Directory deployments, old manifests or locked holder terms. All referenced cases remain UNRUN.

## 1. Scope and fixed boundaries

Pirate operates the shared naming infrastructure. Operators receive app permissions, not deployment/admin keys. Full-name uniqueness is namespace plus canonical label across communities using that namespace. Community identity remains independent of the registry address.

One wallet can hold multiple names. The app may select a primary display name; this does not change wallet/account identity, history or fees. An optional feature gate may accept any qualifying active name under its exact community policy. Name count does not multiply gas allowance or free-name entitlement.

The existing registry is an immutable free-only pilot. The successor proposal combines a narrow attester role, paid initial issuance and a future exit mechanism before real holders depend on it. No current free call acquires a paid fallback or token approval. Generic proxy upgrades, auctions, royalties, operator gas wallets and automated treasury top-ups are outside this proposal.

## 2. Ownership core and issuance modules

Recommended design to specify: an immutable ERC-721 ownership/lifecycle core, with explicitly approved, scoped issuance-policy modules. Module extensibility is limited to admission/pricing policy within the core's supported settlement/request protocol. It is not the ability to change arbitrary future contract behavior.

The CORE, for every module and entry path, must enforce:
- canonical namespace/label and a single live authoritative generation;
- current independent namespace authority, migration status, scope and revisions;
- reservations and minimum/admitted sale price, recipient acceptance and replay protection;
- exact terms/currency and their per-generation locks;
- aggregate namespace/community issuance ceilings that cannot reset on module replacement;
- free-path minimum length, zero cost and distinct grant signer/submitter;
- atomic settlement/mint/receipt and safe receiver handling.

Every new generation, free or paid, increments the shared issuance counters. Renewal and transfer do not refill them. A separate free-entitlement policy may impose a narrower allowance; it must retain durable grants/consumption and cannot infer a fresh entitlement from a zero token balance.

Approve a module only for explicit namespaces/communities, supported issuance mode and pinned immutable code/profile. Mutable proxies behind a pinned module address are not accepted by the proposed initial profile. Revocation stops new authorizations but cannot change existing names. No module gets arbitrary storage access, delegatecall, transfer/burn authority over existing tokens, or an unrestricted external mint function. Issuance is a core-controlled operation; module validation cannot bypass core payment or consent checks.

The exact module validation tuple, request-domain version, source profile and generated ABI remain to be specified before implementation. Uniqueness/rights cannot depend only on an off-chain selector choosing a preferred module.

## 3. Proposed first paid-purchase profile

Keep the first sale mechanism small: explicitly configured fixed-price sales, one configured standard ERC-20 settlement asset for the core, and one initial 365-day term. This asset choice is a PROPOSAL; no live token/address or price is selected. Native TESTETH pays transaction gas and is separate from the name price. No swap, oracle, auction, arbitrary-token checkout or automatic currency conversion is proposed.

A purchase quote binds the chain/core/module/code profile, namespace, canonical label, expected generation, community/install context, buyer, recipient, price, settlement asset, initial term, locked annual renewal terms, all relevant revisions, request ID and deadline. Quote validity does not reserve a name unless a separate explicit reservation exists. A competing mint or changed revision causes refusal, never silent repricing.

Proposed wallet-originated paid path: buyer must be the authenticated core caller (including a qualified smart account), and the core debits only that buyer. A merchant/relayer paying gas is not the buyer. Backend spending from an unrelated buyer's standing allowance is outside this first profile. Recipient consent remains mandatory even when buyer equals recipient, using one uniform exact typed request/domain rule; do not special-case consent away before actual wallet qualification.

The core collects exactly the quoted price with exact transaction value zero, so native overpayment is refused. ERC-20 allowance may exceed the price, but debit may not. Reject unsupported fee-on-transfer/rebasing settlement behavior and require exact received amount. Settlement and safe mint are one reverting transaction: failure leaves no protocol payment or mint. There is no ordinary overpayment-refund balance or custody account in this profile. A failed transaction can still cost gas. Refunds after a completed sale are a separate commercial policy, not an implied contract feature.

The acquisition price includes the first term; no second first-year charge is added. Renewal pricing is separate and locked at issuance. Short/premium labels are closed until explicitly admitted by a sale policy and reservation rules; no assumption that every short label becomes publicly purchasable. Free issuance retains its 8-byte minimum and exact zero quote.

Open commercial inputs before real sales: settlement asset/address and decimals; fixed price schedule/premiums/reservations; permitted short-label classes; annual renewal amounts; sale/refund terms shown to buyers. No numeric defaults are supplied. The request schema and exact recipient-consent preimage need normative definitions and independent vectors before code/ABI adoption.

## 4. Renewal policy

Preserve the accepted permissionless renewal model in this proposal: anyone may pay to extend an eligible name, without acquiring ownership or record rights. Sponsor eligibility is narrower and independent. Existing generation currency/price/term obligations cannot be rewritten by a new module or admin policy.

If zero-price generations are allowed, permissionless repeated renewal has NO automatic sunset. A new maximum expiry, holder-only rule or forced retirement would be a different product/contract policy; none is silently introduced. Before real issuance, explicitly decide whether new zero-price generations are allowed. Existing zero-price rights must be preserved regardless.

Specify maximum years per renewal, active/grace eligibility, exact expiry arithmetic and deadline/max-cost checks in the implementation-level successor spec, preserving existing obligations on import. Failure or lost receipt must never create an automatic second renewal. The first initial term and later recurring fee are shown separately in the UI.

## 5. Attestation transitions

Retain the bounded authority lifetime. Separate semantic authority revision from observation sequence:
- pure refresh: same admitted authority identity/configuration, current delegation and still-live enabled scope; advance freshness only;
- semantic change, suspension, expiry revival or compromise: admin transition with a new semantic revision, invalidating old grants;
- standalone revoke: remove the key and usable freshness immediately;
- combined revoke-and-re-attest: admin supplies independent fresh evidence bound to current identity/configuration; validate it, revoke and replace the observation atomically, with one new semantic revision.

An invalid combined request reverts all effects; urgent standalone revocation remains available. A successful combined transition avoids an intermediate resolution outage, but does not make the observation trustless or preserve old grants after a compromise. Key rotation must not preserve a compromised attestation by default. Names, locked terms and permanent receipts remain intact.

The exact authority-identity commitment, source evidence schema, delegated scope and emitted transition events must be fixed in the successor interface. Directory and registry verification bind their own current configuration, not an interchangeable admin claim.

## 6. Exit from the successor

Design the exit before relying on the new core. Recommended direction: holder-initiated, atomic per-name export to an explicitly reviewed compatible destination, rather than a general admin power to confiscate or freeze all holders.

A qualified export must:
1. Bind current holder consent to source/destination chains/contracts/profiles, name key/generation, current state/terms digest, nonce and deadline. Destination and source must be same-chain for this first proposed mechanism.
2. Import the exact holder, remaining term, locked currency/renewal obligations and record state in the SAME transaction, or revert entirely. Unsupported destination terms cause refusal.
3. Permanently retire that source generation's mutation/renewal/transfer/re-registration authority and write a non-reusable full-name tombstone with exact destination/receipt mapping. There must be no simultaneously authoritative spendable copy.
4. Preserve original issuance/renewal history and consumption receipts at their original sources. Do not copy NFT approvals or record-manager powers as fresh authority without explicit treatment/consent.
5. Keep nonparticipating holders on the old core with their rights intact. New issuance across source lineages must reject names still authoritative elsewhere. Destination import and new registration cannot bypass the old live-name exclusion.
6. Require resolver/directory clients to accept pinned migration mappings explicitly; do not automatically follow an arbitrary destination supplied by an admin or NFT holder. Detect loops and conflicting lineage. Source selection alone does not prove an export.

This is an exit DESIGN, not a shipped capability or a promise of an easy migration. The exact export schema, bounded record-state encoding, source-lineage exclusion, destination acceptance handshake and resolver routing still require specification and adversarial tests. A destination that cannot enforce them is ineligible.

This new export path cannot retroactively freeze the current Registry56. Migrating real rights from that immutable deployment still requires its separately reviewed holder-preserving mechanism. A static snapshot or stopped attestation is insufficient. The disposable pilot avoids creating new real-holder reliance while this is settled.

## 7. Canonical labels across all callers

Use the accepted Labels rules for both TLD and label: complete canonical ASCII bytes, length1..63, lowercase a-z/0-9/hyphen only, no leading/trailing hyphen, no simultaneous hyphens at byte offsets2 and3. Reject uppercase, Unicode, xn--, ab--cd, dots and any whitespace/line terminator; do not normalize during signature validation.

Free issuance adds minimum8 bytes. A future paid-short policy may admit canonical shorter labels explicitly; it does not alter the common canonical validator. Directory, Solidity core/modules, TypeScript SDK, quotes and source descriptors must share literal positive/negative vectors, including valid single/internal hyphens and length boundaries. Never fix one side by accepting a namespace that the other can never admit.

## 8. Pilot disposition and acceptance boundaries

Tell testers before claiming: disposable test namespace/deployment, no production entitlement/value or promised automatic migration; receipts/history remain, and resets do not erase blockchain assets. No live community points to the pilot. Carry-over, if later offered, is explicit and holder-preserving, not assumed by using the same label.

The corrected Directory public successor is still a separate publication/gating task; do not cite af70 as proving corrected safe recovery, cache or label behavior. No new registry gate is imposed on its narrow fixes.

Before implementation: settle exact interfaces, authority/quote/export preimages and source-profile versions, and review them with downstream callers. Before a finite rehearsal: qualify MOSS initialized/fresh consent and actual sender/payer semantics, verified6343 network, explicit public roles/custody, bounds and test namespace. Before real issuance: complete tests/independent review, prices/currency/zero-renewal policy, exit/migration behavior and operational attestation readiness. None of these claims is established by this documentation draft.
