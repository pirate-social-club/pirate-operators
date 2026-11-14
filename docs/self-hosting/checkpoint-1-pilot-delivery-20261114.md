# Checkpoint 1 Linux pilot delivery decisions

The workspace_owner approved this delivery plan on November 14, 2026. The first
usable milestone is an invited, disposable testnet community on ordinary HTTPS:
fresh installation, automatic community registration, real member sign-in,
first-song publication and playback, then persistence through an ordinary
restart. HNS and member names follow separately. This is an approved plan, not
an implemented installer, qualified deployment or production release.

This dated scope supersedes conflicting Cloudflare-first community-hosting,
mandatory-HNS-before-setup and broad restore/upgrade prerequisites in earlier
delivery documents. Existing Cloudflare services remain independently owned;
Alchemy remains their provisioning authority. Historical source and evidence
remain preserved. Required CI, authorization and effect-reconciliation checks
are unchanged. No deployment, funding, signing or credential action occurs by
publishing this plan.

## Six delivery checkpoints

| Checkpoint                 | Required result                                                                                                                                                                                      | Current state at this publication                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1. Delivery contract       | Public hosting, storage, funding, external-service, ownership and pilot decisions agree.                                                                                                             | This approved decision packet; implementation remains open.                                                            |
| 2. Integration baseline    | Review the reachable pilot path and shared dependencies; disable Dance, names and backup/restore at UI and server boundaries; obtain independent review and required current-base CI before merging. | PR58 is a source/UI checkpoint with failed hosted checks, not an accepted baseline.                                    |
| 3. Community before HNS    | Implement a pending community record, constrained registrar and authenticated revisioned origin configuration, with generated interfaces and meaningful tests.                                       | Contract and producer/consumer work remains open. PR56's current Directory is not the deployment design for this flow. |
| 4. First usable community  | On a fresh selected Linux host, prove public HTTPS, automatic registration, real sign-in, first-song publication/playback and restart with actual selected services and testnet effects.             | No completed end-to-end acceptance. HNS and names remain disabled for this checkpoint.                                 |
| 5. Optional HNS and naming | Qualify one registry successor, gateway roles, matching ABI/proof vectors, admission/refresh, member routes, sponsorship and canonical receipts together.                                            | Separate contract and service proposals; no live admission or naming acceptance.                                       |
| 6. Release and handback    | Publish source/artifact/evidence bindings and limitations; disposition replaced PRs and retire worktrees through the maintained lifecycle.                                                           | Follows acceptance. No broad cleanup or history deletion is part of checkpoint 1.                                      |

Checkpoint 2 is bounded by observable pilot behavior, including authentication,
setup, enrollment, publication, playback, persistence and their shared security
and state dependencies. Disabled UI alone does not exclude reachable server
behavior. Retain deferred source and failing evidence; do not silently filter
required checks. Once the bounded candidate is reviewed and green, merge it as
the baseline. A source merge does not authorize deploying the current Directory.
Checkpoint 5 remains part of the fuller v1 naming commitment; it does not block
the deliberately narrower checkpoint 4 pilot.

## Linux hosting and storage

Qualify one concrete Linux amd64 host profile, with its exact distribution,
Docker/Compose versions and image digests recorded before the host run. The
current pinned Bookworm-based image and workerd composition are candidates, not
a promise to support every Docker host. Use the operator's ordinary DNS domain
or subdomain; defer a Pirate-operated subdomain provisioning service.

Caddy supplies public ingress and automatic certificates. This is new packaging
and integration work. The current foundation Compose publishes a loopback port,
uses fixture TLS and an internal network. It is not the pilot deployment.
Provide public ingress, persistent certificate state, a private application
upstream and outbound access to the explicitly selected services. The complete
runtime's existing outbound allowlist is groundwork, not deployed connectivity.

The application must observe its exact configured public HTTPS origin through
the proxy. Preserve host-only Secure cookies, origin checks and CSRF protection.
Do not trust caller-supplied forwarding headers to select another origin or
relax host checks to make sign-in pass. Qualify certificate issuance and renewal
configuration, public-browser sign-in, authenticated writes, logout, media range
playback, wrong-host/forged-forwarding refusals and restart through real ingress.
Prove permitted RPC, IPFS and Pirate-service calls and denied unconfigured egress.

For checkpoint 4, qualify the existing pinned workerd/D1/R2-compatible modules,
SQLite state and local object bytes on persistent volumes. The backend manifest
remains qualification-only, experimental and not production-selected. Do not
start a second database implementation alongside this first journey. Verify
the actual migrations, accounts, sessions, private objects, pending operations
and ordinary restart. Storage qualification for general production remains a
separate gate; finishing HNS cannot satisfy it. Backup/restore, automated upgrade,
second-host recovery and a broad platform matrix remain deferred.

## Transaction authority and Pirate-paid gas

The pilot uses capped top-ups, not relayed song publication. Pirate runs a
hosted enrollment and funding service with a managed testnet funding account.
Its funding key never goes to an operator's server. A constrained registrar
submits community enrollment after authenticating the controller and validating
the pending-community request against the checkpoint 3 contract.

Pirate transfers small, capped amounts of testnet ETH to each admitted
community's publisher and controller gas accounts. The community retains its
own signing authority. The publisher submits song publications;
`CommunityPostsV1.publishRevision` requires `msg.sender` to equal the configured
publisher. The controller submits configuration changes, including later web
address changes; Directory configuration requires the current controller and
revision. Funding an address does not make Pirate either role. If a selected
role is a smart account, qualify its actual execution and gas-paying path;
sending ETH to the role address alone does not establish that path.

Before funding, bind allowed recipients to the admitted community, current
roles and proof of control. Record per-transfer, per-community and total pilot
ceilings, including distinct publisher and controller needs. Count cumulative
transfers against the allowance; low balances, rebuilds and role rotation do not
reset it. Use durable reservations, nonce/transaction journals and canonical
receipt reconciliation. An uncertain top-up is not permission to send another.
Exact accounts and monetary limits must be recorded before a funded rehearsal.

Transferred ETH is fungible: Pirate cannot enforce which action the recipient
spends it on or recover it by revoking an invite. The caps bound Pirate's loss;
they are not action-restricted sponsorship. Recipients can use or transfer their
allowance. Reconcile this limit explicitly in the funding accounting and tests.
Automatic enrollment and funding must not introduce a per-request staff approval
step after valid pilot admission.

Community-signed relayed publishing is a later design, requiring a separately
reviewed authorization/replay/fee protocol and contract change. Do not set a
shared Pirate sender as every community's publisher to bypass the current
contract. Member-name sponsorship remains checkpoint 5 work. External creator
registration, creator wallets and royalties remain outside this pilot.

## Invites and service admission

Use a short-lived, single-use invite that expires unused and can be revoked
before redemption. Redeem atomically into a controller/installation-bound
service enrollment after proof of control. Concurrent redemption, replay,
expiry and revocation must not create another enrollment or budget. Retain the
original operation identity after a lost response. Keep invite secrets out of
logs and public configuration; possession alone authorizes no arbitrary
transaction. Subsequent requests authenticate the enrolled binding and action.
Revoking an enrollment stops future service access and top-ups; it does not
revoke community keys, reclaim transferred ETH or erase completed effects.

## Selected external services

| Capability                               | Operator and credential custody                                                                                                                 | Pilot acceptance                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Community enrollment and testnet top-ups | Pirate operates the hosted service and holds registrar/funding credentials. Communities retain publisher/controller signing custody.            | Real enrollment and capped transfers, invite controls, budget enforcement and interrupted-operation reconciliation.                                                                              |
| Song recognition and shared catalog      | Pirate operates the shared recognition service and holds ACRCloud credentials and catalog costs. Communities use scoped service pairings.       | Real recognition and accepted-song enrollment; unavailable/inconclusive evidence never becomes permission to publish.                                                                            |
| Publication approval                     | Controller-authorized owner publication under the selected owner-catalog policy.                                                                | Real authorization and declared rating/language. Automated moderation is deferred; no OpenAI moderation service is required or claimed for this profile.                                         |
| Public media pinning                     | Pirate's publishing service holds Filebase credentials; the community publisher retains on-chain publication authority.                         | Actual admitted-file pinning, CID verification and retrievable published bytes.                                                                                                                  |
| Chain access                             | MegaETH testnet 6343, initially the single public endpoint `https://carrot.megaeth.com/rpc`; Pirate records and monitors the selected endpoint. | Application reads, role checks and canonical receipts. This is a single point of failure, with no qualified alternate RPC. Unavailable reads hold new effects and preserve uncertain operations. |
| Public media retrieval                   | The selected IPFS gateway/retrieval service; its endpoint and operator are recorded in the runtime profile.                                     | Real browser playback through the supported ingress/egress path.                                                                                                                                 |
| DNS and certificates                     | Operator controls ordinary DNS; Caddy uses the selected public ACME issuer.                                                                     | Valid public HTTPS, persistent certificate state and qualified renewal configuration.                                                                                                            |

These are required capabilities and responsibility assignments, not claims of
deployed services. Bind exact endpoints, service identities and budgets before
checkpoint 4. Selected managed services may remain on Cloudflare under Alchemy;
community hosting is Linux. Operators do not supply Pirate's provider or funding
keys. Learning speech services, Telegram and general creator registration are
not prerequisites for the first-song playback profile.

## Invited pilot disclosure

Show this notice before invite redemption and retain the acknowledgement:

> This is an experimental testnet pilot for disposable data. Backups and
> supported restoration are unavailable. Losing the server or its disk may make
> your community unrecoverable. Do not use it for irreplaceable content or
> production operations. Public media and on-chain records may remain even if
> the community server is lost.

Checkpoint 4 permits invited operators to perform this testnet acceptance. It
does not authorize general production operation, mainnet or a recoverability
promise. HNS/naming readiness is independent of production storage readiness.

## Ownership and the next review

The existing self_hosting_coordinator owns end-to-end delivery through
checkpoints 1-4. The contract_hardening_coordinator supplies the bounded
Directory interface and implementation. The integration_release_coordinator
owns shared-interface acceptance, independent review and integration merges.
One writer owns each mutable branch/checkout; this plan creates no new parallel
roadmap and does not transfer another lane's source custody implicitly.

The Directory interface-design review target is November 16, 2026 at 18:00 UTC.
Review pending-community identity, constrained registration, revisioned origins,
controller/publisher authority and the required negative cases. This is not a
two-day promise of contract implementation, generated ABI or passing tests.
Record implementation and qualification dates after that review. If the design
is not ready, record the blocker and revised target rather than claiming a pass.

Checkpoint 4 acceptance depends on the reviewed, integrated Directory change,
qualified hosted enrollment/funding and publication services, and working ingress
and storage. Their preparation may proceed before that dependency clears;
end-to-end acceptance cannot. PR56's existing origin-bound, admin-only Directory
is not silently promoted to the revised deployment design.

## Later naming gateway and refresh policy

Select a constrained gateway holding the naming registry's admin role. It
exposes fixed operations against a pinned registry, with separate enrollment,
refresh and governance capabilities. Hot service keys receive no arbitrary-call,
target-selection or admin-transfer escape hatch. Refresh preserves the active
binding and caps, cannot revive revoked/lapsed authority or extend the stored
absolute maintenance ceiling, and may suspend only on confirmed authority loss.
Observer unavailability is not proof of loss. A lapse requires explicit
readmission. The gateway still relies on trusted HNS observations and does not
fix the registry's current size excess or alter lease semantics inside V4.

Keep a maximum 24-hour freshness lease, target normal renewal at 12 hours, and
allow successful refreshes no closer than six hours. Retry within finite budgets
using fresh observations, preserving uncertain submitted transaction identity.
Validity is bounded by observation time and the controller's mandate ceiling.
Update policy encodings and outage tests before implementing these values; the
HNS proposal's 23-hour spacing is superseded for this pilot design.

Budget approximately two successful batched namespace/scope refresh transactions
per active TLD per day, or 60 per 30 days. The six-hour spacing permits roughly
four daily successes during recovery. Admissions, claims and failed/replacement
transactions need separate accounting. Price measured gas with an explicit fee
assumption; this document makes no monetary cost claim. One community/installation
per TLD remains the naming pilot limit.

The workspace_owner must select gateway governance signers, threshold and recovery
arrangements before checkpoint 5 deployment. No signer identities or threshold
are implied. This choice does not block checkpoints 1-4. Registry size, generated
ABI, Solidity/TypeScript proof-vector agreement, consent, roles, sponsorship,
observer-outage handling and canonical receipts remain checkpoint 5 gates.

## Source and evidence boundary

This packet follows the reviewed application checkpoint at `99abc251` in
[PR58](https://github.com/pirate-social-club/pirate-operators/pull/58). Relevant
source is [Posts V1](../../contracts/community/CommunityPostsV1.sol),
[Directory V2](../../contracts/community/CommunityDirectoryV2.sol),
[owner policy](../../packages/community/owner-policy.ts),
[RPC selection](../../packages/community/chain.ts),
[backend pins](../../deploy/linux/backend-pins.json),
[qualification Compose](../../deploy/linux/compose.yaml) and
[the runtime egress policy](../../deploy/linux/egress-policy.worker.mjs).

The [earlier delivery graph](linux-compose-delivery-contract-v1.json) describes
its pinned historical source and broader acceptance; this checkpoint governs
pilot scope where they conflict. The [ordered onboarding contract](../v1-onboarding-linux-wizard.md)
still describes unimplemented joins. The [application review note](../review-checkpoint-20261114/README.md)
retains actual prior qualification and limitations. Publishing this document
adds no runtime capability and converts no failed or unrun check into a pass.
