# Recoverable governance account candidates

The community controller may use an EOA for the testnet first-song milestone.
The wizard still tracks recovery readiness and must establish it before mainnet
or real-user onboarding. Pirate's verifier and listing roles require separate,
stable governance-controlled addresses from deployment; the EOA bootstrap allowance
does not apply to those roles. See the [directory boundary](community-directory.md#operator-bootstrap-and-recovery).

## Safe candidate and recovery threshold

Safe is a candidate that does not depend on MOSS recovery. A proposed testnet
profile is SafeL2 1.4.1 through that version's canonical SafeProxyFactory on
MegaETH 6343. This is a profile to qualify, not a selected live deployment or
permission to create keys, fund gas or deploy accounts. The same profile could
serve the community controller and separate governance accounts administering
the verifier and listing authorities. Do not collapse those authorities into
one shared address. The directory's verifier and listing addresses are the
proposed bounded contracts described below, not their governance Safes.

Safe owners can replace an owner through a transaction authorized by the current
threshold. Our proposed 2-of-3 profile uses three independently controlled
signers, including an offline recovery signer. After loss of one signer, the
remaining two can replace it without changing the Safe address. One stolen
signer alone cannot authorize a transaction. Independence must cover custody
and recovery, not merely three addresses derived from the same exposed secret.
Loss of two signers is outside this profile's guarantee. An offline owner in a
2-of-2 account cannot recover it alone; a 1-of-2 account lets either compromised
owner act alone. See Safe's [account and owner model](https://docs.safe.global/advanced/smart-account-overview)
and [owner replacement](https://docs.safe.global/reference-smart-account/owners/swapOwner).

This profile uses ordinary threshold-authorized account transactions for
controller and authority-governance changes, including normal listing decisions.
It does not require a recovery module, unrestricted session key or guard. Confirm a working transaction
preparation, signing and submission path on MegaETH rather than inferring Safe
Wallet UI or transaction-service support from code presence.

## Automated verifier authority

Recurring namespace verification needs automation. The recommended profile is
a dedicated [NamespaceVerifierAuthorityV1](namespace-verifier-authority.md), with
a stable address and a service key limited to typed verification calls to one
directory. A separate 2-of-3 governance Safe binds the directory once and rotates
or disables that key. Its owners do not co-sign each refresh; the service key
has no Safe owner/module authority and cannot list communities or edit their
configuration. One service-key compromise can still forge attestations: the
governance threshold protects key administration, not the truth of routine evidence.

This chooses a bounded contract over two continuously online Safe signers or a
general Safe module. Safe documents that modules can execute transactions through
the account outside its ordinary owner-signature path; accepting one would add
another execution authority to qualify. See [Safe modules](https://docs.safe.global/advanced/smart-account-modules).
The bounded verifier is new code still to implement and review. Local tests of
binding, rotation, pause, freshness and incident handling precede directory
deployment. Actual account and service acceptance follows the one-time binding
and precedes live listings. A direct Safe or the current governance fixture is
not a substitute for this automated acceptance.

## Emergency listing authority

The proposed [CommunityListingAuthorityV1](community-listing-authority.md) holds
that fixed directory role. Its governance Safe may list or delist, bind the
directory once and rotate/disable a separate emergency key. The emergency key
can only forward a typed delisting with literal false; it cannot add listings,
change config, verify namespaces or gain Safe owner/module authority. This is
another contract to implement and review, not a deployed capability.

The emergency path avoids waiting for two Safe signers to remove a suspicious
community. The key must be independent of the verifier service key. A stolen
emergency key can disrupt discovery across all communities, so governance must
revoke or rotate it before restoration. Verification refresh alone cannot undo
a delisting. Actual account recovery, emergency submission and feed invalidation
must pass acceptance before live listings; neither a direct Safe nor a generic
fixture establishes this path.

## Testnet code observation

A read-only observation on November 4 at finalized MegaETH testnet block
34,090,238 found the canonical Safe and SafeL2 implementations and proxy factories
for both 1.4.1 and 1.3.0. All six runtime Keccak-256 hashes match the corresponding
canonical `codeHash` values in the official
[safe-deployments snapshot](https://github.com/safe-global/safe-deployments/tree/685f22be940739259cfc4148db3df7048f39a4e8/src/assets).
The [evidence JSON](../evidence/megaeth-safe-code-2026-11-04.json) records exact
addresses, source files, expected/observed hashes, block hash, sizes and timestamp.

The snapshot's `networkAddresses` maps do not list 6343 for those artifacts;
the direct code observation supplies the testnet presence evidence. It is a
single-RPC observation at the recorded finalized block, with its hash rechecked
after reading code. It does not establish an initialized community Safe,
signer custody, recovery, UI support or transaction-service availability.
Version 1.3.0 matching is recorded evidence, not a recommendation to deploy it.

To repeat the check, confirm `eth_chainId` is 6343, fetch the recorded block by
number and verify its hash, then call `eth_getCode` for each recorded address at
that block. Hash the returned runtime bytes with Keccak-256 and compare with the
pinned official asset's canonical `codeHash`. Recheck the block hash afterward.
For deployment acceptance, refresh the observation at a current confirmed block
and pin the exact selected implementation and factory; do not treat this dated
snapshot as continuing deployment approval.

## Account acceptance still required

Under a separately admitted testnet task, verify the actual proxy's runtime and
singleton, initialization, owners and threshold, with no unexpected modules,
guard, fallback handler or setup delegatecall. Retain the reviewed initialization
inputs and confirmed receipts without secrets. Demonstrate the selected account
can execute the required directory calls with that account as `msg.sender`,
including acceptance of the exact handoff proposal and the
[config retrieval preflight](community-directory.md#configuration-publication-lifecycle).

Exercise a signer-loss scenario without using that signer: the remaining owners
must replace it through the actual account, preserve the address and threshold,
and prove the retired signer cannot authorize subsequent requests. Check chain,
target, calldata, nonce/replay and unauthorized signer rejection. Reconcile
canonical receipts, then show that directory authority, configuration and post
identity survive. Do not destructively delete a credential to simulate loss.
Record which losses and compromises were tested; a threshold compromise is
outside this profile's one-signer guarantee.

No account deployment, initialization, key operation, funding, transaction or
recovery drill ran for this documentation. Existing fixture-account tests prove
contract sender/revision rules only. MOSS remains a separate candidate with its
own fee, first-execution and recovery checks, and the ordinary participant wallet
choice is unchanged.
