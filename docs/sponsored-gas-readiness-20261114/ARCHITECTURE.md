# Proposed bounded pilot architecture

Operator-owned community Worker -> authenticated HTTPS -> Pirate-owned gateway -> one authoritative sponsor-budget Durable Object -> separately isolated signing services -> chain. Reconciler, usage projection and alerting read the authoritative journal. No central sponsor secret is installed in a community account. Same-account private bindings can connect Pirate services; cross-account community requests require independent authentication.

Alchemy owns future resource provisioning. Infisical owns secret delivery per service scope. This packet provisions neither. Existing community Workers/D1/R2/jobs stay unchanged. The public gateway is stateless and performs bounded decoding and authentication; essential state is durable.

## One reservation transaction

For the small manually admitted pilot, one SQLite Durable Object coordinates the fixed chain's whole fee budget. It contains global, community and per-user counters, policy/admission revisions, the original-operation journal and final-intent reservations. Every reservation checks and changes all relevant rows in ONE synchronous storage.transactionSync callback: no await, external RPC, signature request or service call in that callback. Await durable storage completion before any external effect. Failure prevents signing.

Cloudflare's synchronous transaction and storage.sync facilities support this boundary; PITR can restore older storage. This proposal deliberately uses explicit transactions rather than relying on implicit batching. [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), retrieved 2026-11-14.

A single bounded coordination object is a pilot tradeoff, not a production throughput claim. Ordinary application traffic and expensive RPC verification stay outside it. Sharding later needs reviewed escrow allocation: separate community objects and a global object do not form an atomic transaction. Global-first compensation alone is insufficient unless uncertain failures retain reservations and recovery is proven. No such distributed scheme is introduced here. [DO coordination guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), retrieved 2026-11-14.

Transaction predicates: active policy epoch, matching prior ledger revision, community admitted/not paused, exact supported route and operation, verified authorization digest, unused logical-operation identity, unused final intent, unexpired quote, available global/community fee headroom and user rate allowance. Atomically reserve worst-case native fee liability, mark both identities, allocate journal sequence, advance counters and append an event. Duplicate equal requests return the same reservation; altered duplicates conflict. No count-only budget or implicit unlimited default.

Rolling/global policy windows are not selected here. Any future reset must retain outstanding liabilities from prior windows. A new policy or epoch is not permission to discard unknown spends.

## Immutable identity and signing

Canonicalize a closed envelope and own its bytes before awaits. Bind communityKey/communityId, directory instance, installId, origin, namespace, chain, source profile, exact contract/code, actor, role, function and all arguments/value, logical operation, revisions, nonce and expiry. Reject unknown fields and alternate encodings. Digest generation and validators need later implementation and tests; the proposed TypeScript is not a validator.

Wallet requests carry a separately verified authorization challenge for the exact operation and domain, with nonce and expiry. This is required even if a merchant callback receives an unsigned intent. Service-originated requests use an authenticated service principal plus independently verified entitlement. Host/Origin, a claimed wallet, a community header or an operator app session is not enough. Check membership/admission against Pirate-owned authority; bind the installation as well as community.

Validate every batch call and secondary effect: pre-calls, transfers, delegation/key authorizations, funders/settlers, fee token, payment recipient, account implementation and all domains. Default deny unknown structures, chain, value or selectors. Allowlisted target alone is insufficient. Explicit MOSS mode is a client preference; server enforcement is mandatory.

The final MOSS intent may change payer/fee fields from its initial request. Construct and validate those final bytes before reserving their final digest, while retaining the logical operation. The merchant documentation exposes a server policy callback and per-intent fee cap, but its permissive default must never be used. These hooks do not establish compatibility with this durable boundary: verify actual package sequencing before use. [MOSS merchant API](https://moss.megaeth.com/developers/packages/wallet-merchant), retrieved 2026-11-14.

Journal sequence: validated -> reserved -> signing-intent-durable -> signed-original-durable -> send-intent-durable -> submitted-or-unknown -> canonical-safe-success/revert. External signer calls are idempotent against exact bytes and reservation identity. Persist signer-side exact request/result before reply. A lost signing response is uncertain authorization, not permission to refund and mint a new request. Recheck pause, epoch, expiry and authority after external awaits before the next effect.

For backend transactions persist exact signed raw bytes and hash, sender, nonce, chain and deployment before broadcast. For MOSS persist exact final intent/digest, payer authorization, account nonce/expiry and eventual execution transaction. An outer relayer hash alone does not prove the intended payment or execution.

## Reconciliation and restore

Unknown transaction/receipt, provider disagreement, nonce uncertainty, reorg or lost reply retains the original reservation and maximum liability. Do not automatically issue a new nonce, claim, signed intent or replacement. A definite safe revert still costs gas. Release only the proven unspent remainder after authoritative accounting. Returning an existing signed response must never trigger an implicit send.

A logical append-only journal inside the same DO is not rollback-proof. Signing services need an independently durable epoch/high-water/outbox fence outside its rollback domain. Before any restore, disable all signer authorization and dispatch. After restore, compare retained sequences and reconstruct spends plus all outstanding signed or potentially signed authorizations; chain receipts alone cannot reveal valid unbroadcast authorizations. Missing evidence keeps the pilot paused. Reopening requires a reconciled epoch, liabilities carried forward and independent approval of the recovery evidence. No autonomous reset from a PITR snapshot.

Pausing stops new authorizations. It cannot revoke signatures already issued; outstanding liabilities remain reserved until definitively settled, expired or revoked under the actual protocol. No fake exactly-once claim: external effects use durable at-most-once authorization identity plus explicit uncertainty recovery.

Receipt accounting requires canonical block hash, safe confirmation, successful intended execution/event, actual payer debit and exact intent or original raw transaction. Recovery of consumed name/enrollment remains independent of current holder, authority freshness and discoverability. Current state is reported separately. Derived usage views/alerts may lag; they never authorize spend.
