# Readiness and custody

## Current evidence

The registry review baseline is [pirate-registry source 56d63ad2738e0e6816b6157dba7174198700f2fa](https://github.com/pirate-social-club/pirate-registry/commit/56d63ad2738e0e6816b6157dba7174198700f2fa), with [documentation bf480445c88030910501923ac12350b2fe1d7e6e](https://github.com/pirate-social-club/pirate-registry/commit/bf480445c88030910501923ac12350b2fe1d7e6e). Its canonical 119-entry ABI digest is e580c03988a02a6ecd1d414c7a3e0ac0e306c823e07b0f9a9078b30a06c3a802. The canonical ABI digest is distinct from the pretty JSON file's SHA-256. A compiler template hash is not a deployed 6343 code hash: constructor immutables and chain-specific data must be verified on the actual deployment. This public packet supplies no new build or public-chain acceptance result.

The source profile requires solc 0.8.30+commit.73712a01, Cancun, optimizer enabled/200 runs, viaIR false or absent, no metadata bytecode hash/CBOR. The future rehearsal must independently pin and verify its actual tools and generated artifacts. Machine-specific tool, Git and sandbox evidence is not included in this public review. The integration coordinator continues its separate source and test work.

No pilot address, custody proof, balance, nonce, RPC chain ID, safe lag, MOSS deployment implementation or public-chain receipt has been verified. Historical addresses in docs are references only. CI's 31337 fixture addresses and public local keys must never be funded or reused on a public chain.

## Roles and locations

| Role | Proposed custody/location | Existing qualification |
|---|---|---|
| Treasury | Proposed offline treasury custody; no server access | Custody mechanism and public address not specified |
| Deployment approval | Explicit hardware approval, dedicated TESTETH identity | Unknown hardware/chain support; no deployer selected |
| Registry/directory admin | Offline approval for a finite supervised rehearsal | Current admin-only refresh means manual operation |
| Grant signer | Separate Pirate issuer service and Infisical scope, bounded on-chain issuance | Address/online capability not provisioned |
| Claim submitter and backend transaction sender | Separate Pirate service scope, small TESTETH balance, exact original transaction journal | Existing backend pattern; central pilot integration absent |
| MOSS sponsor payer | Separate isolated Pirate merchant service/scope, small balance | Candidate only; package and account compatibility UNRUN |
| Member/controller | Their own wallet; MOSS/passkey may be one option | Nested on-chain consent and sender checks UNRUN |
| Observer/attester | Independent evidence collection; no automatic admin key access | Narrow delegated role does not exist in accepted contracts |

The issuer, submitter and MOSS payer must not share an environment, secret scope or service identity able to read all three keys. A common fee ledger is not a common key store. In backend claims the submitter itself pays ordinary transaction gas; a distinct MOSS payer cannot simply pay that EOA transaction without a separately qualified protocol. Meter both routes once.

Infisical distributes secrets to an online signer. It does not turn that signer into cold custody. Passkey recovery, Safe policies and hardware prompts each need independent custody and recovery qualification. A stolen online payer key can bypass application checks outside the gateway: small balances and account-enforced limits, if proven, are the containment. No significant treasury balance should sit there.

## Attestation decision

Registry SharedNameRegistryV3.attestNamespace is onlyAdmin; MAX_AUTHORITY_LIFETIME is one day. Directory CommunityDirectoryV2.verifyNamespace requires admin; maxVerificationAge is immutable and at most one day. Directory configuration changes invalidate the matching verification. Registry refresh changes authorityRevision and therefore makes old in-flight grants stale.

Expiry stops fresh resolution/discovery; it does not erase NFT ownership, change locked renewal terms or undo permanent claim consumption. Receipt recovery must continue without fresh HNS authority.

Decide the attester design BEFORE any deployment that communities or holders will depend on. The accepted registry is immutable: introducing the role requires new bytecode, a generated ABI/hash, source verification, tests, consumer review and explicit adoption/migration. It cannot be installed by changing an admin setting. A disposable finite rehearsal on the current build may use hardware-reviewed manual refreshes in a stated observation window; do not present it as unattended service readiness.

Proposed successor semantics, still design-only:
- Separate the claim-bound semantic authority revision from a monotonic observation sequence. A pure freshness refresh for the SAME admitted authority identity, namespace and configuration leaves the semantic revision unchanged, so an otherwise valid in-flight grant survives. Keep evidence hash/time and a refresh event/sequence separately.
- Bind a delegated refresh to the expected authority/configuration revision, exact scope and current delegation. Require independent current evidence, monotonic observation time and the existing bounded lifetime. A changed owner, authority identity, scope or issuance policy is an admin-controlled semantic transition that invalidates old grants. The exact authority-identity commitment and migration mapping must be specified in the successor; the current evidence hash alone is not such a commitment.
- The attester may only extend still-live, enabled attestations for its explicitly delegated scopes. It cannot revive lapsed or suspended authority, enable issuance, admit namespaces, change policy/caps/treasury/admin, clear migrations or seize names. Admin revival requires fresh evidence and a new semantic revision. Directory refresh additionally binds the current installation/configuration and controller; a configuration change still needs new matching verification.
- Admin-only revocation removes the delegation, invalidates that scope's freshness and bumps the semantic revision. Also provide a combined admin revoke-and-re-attest transition: validate independent fresh evidence against the current identity/configuration, revoke the old delegation and install the replacement observation in ONE transaction and one semantic revision transition. No intermediate offline state is exposed after a successful combined call. Old grants become stale, as they should after a compromise. If replacement evidence is invalid the combined call reverts entirely; standalone urgent revocation must remain available so bad evidence cannot prevent disabling the key. Neither path may delete names, change locked terms or undo receipts.
- The online attester is still trusted to observe outside TLD ownership accurately. Scope restriction cannot prevent a stolen attester from lying about freshness within its scope before revocation. Monitoring, bounded lifetime and explicit revocation limit exposure; they do not turn an off-chain observation into a trustless proof.

Existing attestNamespace includes issuanceEnabled, so granting the current whole method to an online key would not implement this proposal. On the current build, coordinate manual refresh with the finite signing window; a stale grant is refused and preserved. Do not silently issue a new claim, nonce or consent as a retry. Neither this proposal nor pure refresh changes the 24-hour maximum.

Zero/paid locked renewals remain permissionless in the contract. The sponsor may independently refuse unwanted renewals; no holder-only contract change is proposed.

## Needed public inputs

All pilot public addresses and custody references are unspecified in this proposal. The rehearsal coordinator needs public addresses and custody references, dedicated test namespace authority, an admitted community/install/origin/namespace binding, supported wallet/account implementation pins, verified RPC/faucet network, safe-lag observations, fee bounds and separate signer scope attestations. Do not request or copy private keys.

## Pilot eligibility: existing action authority plus an explicit test list

For the pilot, Pirate maintains a small versioned allowlist of test wallet/service identities, communities, installations, namespaces and exact allowed actions. This limits pilot exposure; it is not a new membership database or blanket sponsorship of admitted wallets. A valid application session or operator-owned Worker assertion is insufficient. Every request separately proves the action's actual authorization and passes fee/rate limits.

| Action | Existing evidence to verify independently |
|---|---|
| Initial free-name claim | Approved issuer's exact scoped grant and recipient consent, live revisions/quote and caps. The grant is the entitlement decision; do not require an existing username or a second general membership record. |
| Name record/transfer | Current holder, record manager or approved operator as allowed by the exact contract method; verify the namespace/name/generation and admitted community attribution. Pilot policy may be narrower. |
| Renewal | Contract renewal is permissionless. Pilot sponsorship may require the current holder, admitted name and explicit renewal window; this is a payer rule only. |
| Learning result | That community's live learner publication consent and authorized grader/result rules. Consent is not general membership or spending permission. |
| First learner authorization | Verify the exact signed community/origin/contract-bound consent and current withdrawal/replay state; do not require the on-chain authorization that this very operation will establish. |
| Directory configuration | Current controller and exact configuration/install/source binding. A username alone does not grant controller authority. |

The learning sign-in text explicitly separates publication consent from joining. Its authorization is lazily relayed at first practice, so a signed-in learner can lack an on-chain entry. See [LearningResultsV4 at af70dc7](https://github.com/pirate-social-club/pirate-operators/blob/af70dc7e744c2f4b4886802e4b78125d3eb79444/contracts/LearningResultsV4.sol) and [learning-sign-in service](https://github.com/pirate-social-club/pirate-operators/blob/af70dc7e744c2f4b4886802e4b78125d3eb79444/services/learning-sign-in.ts). These references establish specific relationships, not a complete membership registry or a new contract audit.

A claim event records the originating community/recipient; current NFT ownership may have changed. Neither alone proves general current membership. Transferring a name to an unlisted test wallet does not admit that wallet to this pilot. Production membership and transfer-based sponsorship policy remain undecided. Where an existing action-specific authorization is sufficient, a general member list may never be needed.

An optional selected-feature username gate is described in UI-NOTE.md. It is an app policy proposal, not a universal contract requirement or a live adoption decision.

No fee/currency/renewal amount is selected here. Initial free claim must remain first-year, eligible ordinary label >=8, exact maxCost0/effective price0, genuine reservation/premium checks, separate grant signer/submitter and finite issuance caps. Token renewal charges are separate from sponsored gas. A zero renewal price permits indefinite third-party extensions within the contract's term limits; it is not a reason to sponsor them.

## Upgrade boundary and later paid names

The accepted shared registry has no proxy or in-place upgrade entry point. Admin configuration may change only the parameters the deployed contract explicitly exposes. Multiple NFTs per wallet already work; paid initial purchases and delegated attestations do not become available through an admin configuration change.

Keep the current pilot disposable. Before deploying a version others will rely on, settle the narrow attester change and the future issuance/migration boundary together. Do not add a broad proxy solely to implement an app-level username gate. A successor is possible but requires new reviewed code/generated ABI, exact source/deployment pins and explicit consumer selection. Keeping namespace/label identifiers stable does not migrate ERC-721 ownership or prevent a second contract from issuing a conflicting name.

Preserve holder consent where required, full-name uniqueness across the selected versions, provenance, existing NFT rights and locked renewal terms. Do not silently repoint resolvers or overwrite old deployment manifests. The existing [migration specification](https://github.com/pirate-social-club/pirate-registry/blob/56d63ad2738e0e6816b6157dba7174198700f2fa/docs/SHARED-NAMES-MIGRATION-V1.md) is a boundary, not an implemented automatic migration. Contract upgrades are therefore possible through explicit successors, not easy transparent code replacement.

## Proposed successor scope to settle before real users

The current build is a disposable pilot. Known successor requirements are narrow delegated attestation, a separately specified paid initial purchase path and an explicit renewal policy. Do not market paid/short-name acquisition on the current free-only ABI, or defer the ownership architecture decision until many holders depend on it.

One option to review is an immutable ownership/lifecycle core with admin-approved issuance modules. This is not an accepted or implemented design yet. It is only useful if the CORE enforces canonical full-name uniqueness, existing generation/holder protection, reservations, term/price locks and shared namespace/community lifetime counters across every issuer. Replacing a module cannot reset caps, overwrite an active name, seize a token, alter existing locked terms or bypass required consent. Separate module interfaces and scopes must not provide delegatecall/arbitrary storage access or an unrestricted mint backdoor. Paid issuance pricing, payment/currency/refunds and short-label policy still need an exact specification.

Module approval is a powerful new-admission authority, even without ownership upgrade power. Preserve explicit admin custody, scope revocation, separate operational keys and bounded caps. The alternative of a general upgradeable proxy would give its upgrader power to rewrite holder rules; it is not proposed for a single-admin pilot. Neither architecture is selected by this documentation update.

Stopping attestation or selecting a new resolver source does NOT freeze transfers or renewals in the old registry. A static snapshot can become stale. Migration must establish an exclusive authoritative cutover with continuing reconciliation or a specifically reviewed enforceable holder-authorized mechanism, preserving existing obligations. Resolver control alone is not proof of holder-preserving migration. A locked zero renewal price also has no automatic sunset. No freeze/export/migration capability is invented here.

There is no per-wallet free-name cap in the accepted contract. Namespace and community counters are on-chain backstops; any one-free-name entitlement is an issuer/service policy requiring durable exact grant accounting. Do not infer that policy from token balance or assume a transfer restores an entitlement. No primary-name record exists in the accepted registry; display selection stays in the app.

The design starting point and remaining implementation inputs are collected in [SUCCESSOR-SPEC.md](SUCCESSOR-SPEC.md). It is a separate successor proposal; accepted registry code/ABI and the operator rollout remain unchanged.
