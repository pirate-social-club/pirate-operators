# Finite future rehearsal — all steps unexecuted

This is a sequence for a later coordinator-owned allocation, not a runnable deployment script. No RPC, signing, faucet, key or funded operation occurred in this turn. The registry source at 56d63ad2738e0e6816b6157dba7174198700f2fa in pirate-social-club/pirate-registry is first; the corrected Directory follows only after its fresh source/build/runtime/interface gates. See README.md for immutable review links. No mainline adoption is implied.

## 0. Readiness and read-only network check

Freeze the chosen source, lockfile/gitlink closure, compiler/tool hashes and exact deployment profile. Use approved environment isolation and archived committed-source verification. Record the actual chain-specific constructor arguments and bytecode; never copy a local fixture code hash. Directory source transitions need their own new compiled pins, not the earlier Directory checkpoint's runtime.

A later explicitly allocated read-only probe must record endpoint identity (without credentials), UTC time and raw responses to eth_chainId, latest/safe/finalized blocks, eth_gasPrice, and supported fee-estimation methods. Require chainId 6343 (0x18c7); reject 6342 and mainnet. Check canonical hashes and timestamps over a finite sample interval, including safe lag and unavailable-safe behavior. No fallback to latest-1. A pending nonce read may be cached or treated as latest by the documented public gateway; it is not a mempool inventory or release proof. Record actual 6343 behavior without assuming the documented mainnet observation applies.

Official faucet documentation points to testnet.megaeth.com but does not itself prove the active chain is 6343. Verify the actual faucet network and public recipient before providing funding instructions. Use only native TESTETH; no bridge, real ETH, token purchase or local fixture keys. [Official faucet](https://docs.megaeth.com/user-guide/faucet), retrieved 2026-11-14.

For public roles already supplied through a future admitted input, read balance and pending/latest nonce and reconcile previously reserved liabilities. No address is supplied here. Load the versioned manual test-wallet/community/install/namespace/action admission list, and independently verify each operation's existing contract authorization; do not invent a general membership-store prerequisite. Confirm independent grant signer and submitter, separate merchant payer, no key reuse from public test fixtures, hardware display of chain/to/value/data, and low operational float. A custody statement without verified public-address binding is incomplete.

## 1. MOSS compatibility first

Pin exact SDK/merchant/account implementation versions and addresses; no package is installed here. Prepare two independently identified test accounts: initialized code and genuinely fresh/no-code. MOSS documents EIP-712 and ERC-1271, but this does not establish the nested claim and fresh-account behavior. [MOSS sign data](https://moss.megaeth.com/developers/methods/signing/sign-data), retrieved 2026-11-14.

The registry domain is name PirateSharedNames, version 3, chain 6343, verifyingContract the exact reviewed deployment. The recipient signs ClaimAcceptance containing the exact FreeClaim; the issuer still signs the original FreeClaim digest. Use generated ABI/types from the accepted source; do not retype an ABI here.

Registry's pinned SignatureChecker uses ECDSA for code-less accounts and ERC-1271 for accounts with code. A helper supporting counterfactual verification is not proof the registry accepts the signature. Test actual claimFreeName and _safeMint receiver behavior for both account states. A fresh account may require separately qualified activation; record the honest result without bypassing consent or silently introducing a new activation protocol. Mutated label, recipient, namespace, revision, chain or verifying contract must fail. Check real onERC721Received behavior and permanent receipt/event.

Also qualify the merchant integration's surrounding Pirate policy: independent canonical-safe RPC reads of holder/controller/consent state, exact-call simulation before reservation, invalid-state refusal and limits on repeated reverts. Treat simulation as a preflight, not a promise about later state. Prove relayer outage and lost payment-authorization responses retain the same intent and liability without automatic replay, new nonce or refund. Measure actual passkey consent byte length and exact claim calldata; an ordinary EOA signature is not a cost substitute.

First run compatible local tests under separate allocation where possible; then a narrowly budgeted actual 6343 rehearsal is required for MOSS account/network semantics. If incompatible, stop that route while retaining the existing backend submitter architecture. Do not call helper success “claim success.”

## 2. Registry-only supervised TESTETH measurement

Before signing: compile/verify exact selected source, estimate deployment on the verified MegaETH endpoint, establish target resource limits, confirm test namespace authority and explicit live configuration. Native gas funding does not select the registry's paymentToken or locked renewal annual price. Those constructor/policy values remain separately required. No paid initial purchase fallback.

After separately admitted deployment, verify source against runtime and canonical safe deployment receipt. Manually approve namespace admission/attestation, policy and finite scope caps. Record every setup transaction as a one-off Pirate cost. Coordinate refresh revisions with in-flight grants on this immutable build. No automatic reissue is allowed. The proposed attester successor is a separate decision before a relied-upon deployment; it is not part of this rehearsal's accepted ABI.

Execute only the listed finite measurement cases: eligible first-year claim, record write, transfer, selected renewal route, admin refresh and relevant refusal/revert cases under an explicit budget. No real community is repointed. Claim lifecycle includes request/nonce journal, issuer and recipient signatures, durable before-send persistence and canonical safe event/receipt reconciliation. Do not send public adversarial cases that can be proven locally unless specifically budgeted.

For wallet-originated sponsored calls prove target msg.sender, actual fee payer/debit and the executed final intent; for backend claims prove the submitter pays. The outer transaction sender alone does not establish MOSS payer identity. Record fee fields and failure costs.

## 3. Corrected Directory and community operations

Only after the integration coordinator's corrected Directory build, generated consumer-interface comparison and safe recovery/cache gates pass: pin new source/runtime/deployment and measure registerSharedCommunity, configure, verifyNamespace and one controller-authorized path. Preserve community identity, immutable install/namespace/source bindings and old directory histories. No V1 overwrite or implicit adoption.

CommunityPosts and LearningResults have separate current source/deployment profiles. Qualify their actual handlers and original receipts before any measured app flow. Test post publication and a representative learning result with real data size/policy rather than claiming name-claim gas predicts them. The existing learning lifetime fuse neither bills a community nor covers names/Directory automatically.

## 4. Indexing and service acceptance

Index only explicitly pinned test deployments and start blocks. Compare Goldsky output with canonical raw receipts, source-authenticated manifests and the existing reference reducer. Validate expiry without events, reorg, backfill, duplicate logs, revision/revocation and learner privacy. Use a separate project/read model; no mainline schema/default/mount changes.

The central Worker, durable ledger, signer scopes, manual pilot admission plus existing action-authority checks, usage UI and alerting remain serviceIntegration UNRUN until their actual implementation is independently reviewed and tested. Local chain CI acceptance and this document do not substitute for that.

## Unsigned transaction options

Hardware path: prepare chainId/from/to or creation, exact calldata/init code, value, nonce, gas limit, selected fee fields and explicit expiry/authority checks plus human-readable action and byte digest. Confirm on-device support and independently display address/chain. Do not blind-sign unsupported data. Journal exact returned signed bytes before any broadcast.

Bounded online path: separately admitted service, narrowly authenticated requests, fixed native fee ceiling, small balance, per-operation reservation and private exact-original journal. No online root treasury. Manual top-up is a separate reviewed operation, not an automatic sweep from cold storage.

Draft read requests (placeholders are intentionally not executable): eth_getBalance(publicRole, canonicalBlock); eth_getTransactionCount(publicRole, pending) plus canonical nonce; eth_estimateGas(exactUnsignedCall); eth_getTransactionReceipt(exactHash); eth_getBlockByNumber(safe,false); eth_getCode(exactDeployment,canonicalBlock). Balances and nonces are observations, not permission to send.

## Manual stuck-sender qualification

Before enabling the proposed backend replacement procedure, test the exact procedure in ARCHITECTURE.md on a separately allocated local chain: sender-wide pause, immutable original journal, explicit same-nonce approval, atomic group-maximum and recovery-allocation updates before signing, successful replacement versus cancellation/revert/foreign consumption, and reorg reversal. Test unblocking with the originating community at its cap while protected recovery headroom remains; unavailable recovery/global headroom still refuses the attempt. Receipt or nonce ambiguity retains original liability. A stuck transaction must not trigger fresh grants or a second operation. Qualify this revised accounting before adding a second community to the shared sender.

The current exact-original SDK is not replaced by this design sketch. Until an attempt-aware implementation is independently qualified, the pilot pauses for manual investigation; it has no automatic unblock guarantee. MOSS relay failures need separate intent/account protocol evidence, not this EOA procedure.

Guided restore, cross-host migration and automated disaster recovery are outside this pilot and the first operator release. Preserve ordinary restart durability and safe uncertainty handling. The deferred restore scenarios in gate-plan.json document future requirements; they are not implementation or release prerequisites here.

## Tester notice before any pilot name claim

Display and require acknowledgement: these are disposable test names on a test deployment, with no production entitlement, guaranteed continuation, paid value or promised automatic migration. A reset or successor may use a different contract and token identity. Keep receipts and experiment history; do not market resets as deleting on-chain assets. Use only test namespaces and TESTETH. This notice does not change contract rights or authorize public deployments/funds. Never silently point real communities at the pilot.

If a later design proposes to carry a pilot asset forward, it must explicitly opt in the holder and preserve uniqueness/terms under the qualified migration mechanism. A tester acknowledgement is not evidence that migration has already been implemented.
