# Pirate-hosted enrollment and initial gas support, version 1

Status: source implementation; no deployed service, applied migration, live keys,
invites, top-ups or activation. This service is separate from community Workers.
Alchemy owns eventual provisioning; Infisical-delivered signing authority is
online authority, not cold custody. Operators retain their controller/publisher.

## Protocol and failure plan (written before implementation)

The service accepts bounded POST JSON only. `/prepare` takes an invite token,
exact Web2 Directory profile document, configuration/4, immutable IPFS URI and
pilot notice hash. It returns a fixed enrollment ID, expiry and EIP-712 request.
`/redeem` takes that ID and the controller signature. `/status` takes the same
proof and reconciles the original registration. `/initial-topup` additionally
requires each distinct recipient's signature over the same exact enrollment.
The proof is service authorization, not a Directory signature or proof of DNS.
No endpoint admits arbitrary calldata, signer, recipient, amount or nonce.

The EIP-712 domain names Pirate Hosted Enrollment version 1, selected chain and
Directory. The message commits the exact registration plan, server policy,
notice, invite ID, stable allowance ID and expiration. The registration plan
binds controller, publisher, random community key, installation, config, origin,
IPFS URI, chain, Directory, code/ABI/source pins and registrar revision. The
service verifies EOA or deployed ERC-1271 at a canonical safe block. Fresh smart
accounts are not silently activated. All values are reconstructed before await.

Trusted provisioning creates a hashed high-entropy invite with a stable allowance
ID, short explicit expiry and policy hash. No invite-admin HTTP API is exposed.
One preparation per invite and one redeemed enrollment per allowance/community/
installation are persisted. Exact repeats return that original; changed inputs
refuse. Replacement invites cannot reset an allowance. Revocation/expiry blocks
new dispatch; original potentially broadcast transactions remain recoverable.
Controller proof does not list a community or attest an address. Directory
registration creates an unverified, unlisted community.

Initial transfers use explicit policy amounts. Distinct controller/publisher
addresses receive their respective amounts; a shared address receives only the
maximum, once. Current canonical Directory roles must still equal the original
roles before funding. Each recipient proves control. ETH becomes fungible at
receipt: this bounds Pirate's loss, not the recipient's subsequent actions.
Funding a smart account does not qualify its gas-paying execution path.

One D1 database owns invitations, immutable plans, nonce journals and all exact
wei budgets. Reuse the existing budget engine: global pilot, stable community
allowance and recipient lifetime buckets are reserved atomically in one batch.
Reserve principal plus gas limit times max fee plus explicit extra-fee ceiling
before nonce allocation. A crash between reservation and allocation holds that
reservation for the same original ID; it cannot allocate a replacement allowance.
No monthly refill, reset on rotation, or numeric live default is provided.
The first trusted invite provisioning atomically pins the pilot budget namespace
in this database. Later provisioning or service configuration with a different
namespace is refused; no reset API exists. Same-namespace fee-policy rotation
retains original recovery. Policy changes cannot overwrite budget ceilings.

Only dedicated Pirate registrar/funder adapters sign the closed transactions.
Signer adapters must only sign, never broadcast. The immutable unsigned plan
and unique sender/chain/nonce are journalled before signing; raw bytes/hash are
validated and stored before dispatch. A durable dispatch CAS counts attempts and records their time. Status never
sends. A fresh authenticated repeat of redeem/topup may resubmit only the exact
stored raw/hash/nonce after an explicit server interval, up to an explicit
attempt ceiling, while the enrollment and current roles remain eligible. This
recovers a crash after the CAS but before the provider saw the transaction.
There is no background retry, new nonce, re-signing of a persisted original or
replacement protocol. A real receipt awaiting safe confirmation is observe-only.
An unresolved planned/signed sender head blocks new nonce allocation; a dispatched
predecessor must be observed by the node before later nonces are allocated.
Revoked/expired unsent heads require separate manual custody recovery. The source
holds reservations until a safe canonical exact receipt establishes actual cost.
The pilot permanently charges the full worst-case allowance, including reverted
calls. Actual gas, extra fee and transferred principal are metered separately
from `chargedBoundWei`. Safe blocks can reorg: unused headroom is not recycled,
so re-inclusion at a higher allowed fee cannot exceed lifetime ceilings. Later
budget recycling would require separately qualified irreversible finality.
Revocation after the dispatch linearization cannot undo an already sent transfer.

Original server policy is stored privately alongside the preparation. Recovery
uses that original policy even after current service policy changes; new effects
require the current policy hash. Status authenticates the bound controller and exposes only public identifiers,
state and transaction hashes/costs. It never returns invite tokens, signatures,
private raw transactions or SQL/provider error text. Unknown original outcomes
remain unknown. Safe block unavailable/reorg/pin mismatch must refuse settlement.
A restart reads persisted originals; it cannot reinterpret them using new roles.
Database restore requires service pause and chain reconciliation; this slice
provides no rollback/restore tooling or claim that a stale backup is safe.

## Required observable proofs

Use actual disposable D1/SQLite and owned Anvil with the compiled Directory V3,
real EOA and ERC-1271 cryptography. Preserve original assertions. Test invite
expiry/revocation/conflicting redemption, exact repeat and concurrent requests;
wrong chain/domain/profile/code/config/origin/notice/installation/signature;
unverified listing; private response fields; same-address role deduplication;
recipient/value/calldata/nonce tampering; lifetime/global cap races; original
raw/hash replay and restart; loss of a response after real broadcast; safe-block
settlement and reorg refusal; role rotation/new invite without allowance reset;
unknown schema/partial schema refusal. Fault transport may drop a real response,
never implement successful business logic. Local qualification: 25 real integration cases pass, with TypeScript and scoped
formatting. The separate schema was applied only to disposable local D1. Both
test files compile the selected Directory source with solc 0.8.30 and compare its
runtime to the accepted generated pin before deploying on owned Anvil. No
existing Solidity, ABI, application consumer or deployment profile changed.
The tests include a post-dispatch/pre-send fault and response loss after real
broadcast, policy-change recovery, delayed safe-view expiry and exact one-winner
cap contention. No public RPC, deployment or funded effect was exercised.

## Integration and operations

The unnumbered `packages/community/schema/hosted-enrollment.sql` is a separate
service database proposal. No current community schema is modified or migrated.
Runtime requires exact schema objects/fingerprint and explicit policy, service
origin, source profile, registrar/funder public addresses and signing adapters.
Use the primary database binding, not an independently lagging replica/session.
No network endpoints, live amounts, TTLs, fee assumptions or credentials are
selected by this source. Community routes/wizard consumption belong to their
own lane. Provisioning, deployment, live RPC compatibility and funded acceptance
remain separate gates, including actual smart-account execution.

Cloudflare documents D1 batch rollback on any failing statement; our CAS guards
and all bucket updates use that single transaction boundary, not separate
per-community objects. Primary source checked 2026-11-15:
https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

## Reproduction and remaining gates

From this checkout, with its existing pinned dependencies and local Anvil:

```sh
npm run typecheck
node --test --test-concurrency=1 test/hosted-community-enrollment.test.ts test/hosted-community-funding.test.ts
```

The tests emit JSON receipt evidence for registration and transfers. Amounts,
keys, ports, timestamps and fees in these fixtures are disposable local inputs,
not MegaETH estimates or live policy choices. Test wallets never receive public
funds. They cover actual EOA and deployed ERC-1271 verification, not MOSS passkey
activation or sponsored smart-account execution. Extra-fee handling has explicit
`none` versus required `l1Fee` policy; the selected live chain's returned fields
still need read-only qualification before any funded run.

A failed or stale proof provider yields redacted 503 unavailable, not a final
invalid-wallet result. Missing enrollment and invalid local proof share opaque 403. No secret or original transaction is returned with either response.

Schema installation, trusted invitation administration, operational signing
adapters, service bindings, current-chain roles/fee policy, public configuration
availability, monitoring and consumer adoption are still deployment/activation
gates. The exported handlers are real standalone services but are not mounted
into an operator or a deployed Worker by this change. Full required CI and
independent exact-candidate review remain publication/integration gates.

Historical failed local attempts are retained in the author's ignored evidence:
an initial clock fixture ran behind fast-mined blocks; the first nonce guard
incorrectly refused a concurrent repeat before reloading the winner. Their fixes
retain the original successful-flow assertions. The later cap policy deliberately
charges full bounds (rather than actual cost) per review; tests separately assert
actual cost arithmetic, all three charged buckets and no reorg headroom reuse.

The final schema check excludes SQLite's literal reserved internal prefix and
D1's exact `_cf_METADATA` table only. A regression reproduced that SQL LIKE underscores
could otherwise hide an unrelated table; the literal check now refuses it.
