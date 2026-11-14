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

For the first finite rehearsal, prepare hardware-reviewed refresh transactions inside an explicit observation window and stop when it ends. That is not unattended service readiness. A separately scoped successor could delegate refresh of already-admitted namespaces/communities, with revocation, monotonic evidence times, matching authority/configuration revisions and bounded expiry. It must not admit new namespaces, change issuance policy, clear migrations, move treasury, transfer admin, seize names or manufacture HNS authority. Existing attestNamespace includes issuanceEnabled, so a narrow role cannot be a blanket permission to call the current method. Define suspension versus re-enabling and observer trust explicitly before implementing it.

Such a successor requires review, generated ABI/code pins, tests and explicit adoption/migration. This packet proposes no contract edit, new TTL, silent repointing or admin custody change. Zero/paid locked renewal sponsorship remains permissionless in the contract; the sponsor may independently refuse unwanted renewals.

## Needed public inputs

All pilot public addresses and custody references are unspecified in this proposal. The rehearsal coordinator needs public addresses and custody references, dedicated test namespace authority, an admitted community/install/origin/namespace binding, supported wallet/account implementation pins, verified RPC/faucet network, safe-lag observations, fee bounds and separate signer scope attestations. Do not request or copy private keys.

Application membership needs an independently authoritative Pirate-owned record or signed entitlement from a trusted issuer. No currently inspected directory record alone proves membership or sponsorship admission. If that join is missing, refuse sponsorship; the operator-owned app's assertion is insufficient.

No fee/currency/renewal amount is selected here. Initial free claim must remain first-year, eligible ordinary label >=8, exact maxCost0/effective price0, genuine reservation/premium checks, separate grant signer/submitter and finite issuance caps. Token renewal charges are separate from sponsored gas. A zero renewal price permits indefinite third-party extensions within the contract's term limits; it is not a reason to sponsor them.
