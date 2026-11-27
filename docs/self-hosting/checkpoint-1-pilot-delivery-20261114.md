# Web2 release and optional HNS delivery plan

The workspace_owner approved this revised plan on November 14, 2026. Ordinary
DNS and HNS are addressing options for the same community system. Both use the
same on-chain community identity, publication records, Dance-to-song references
and discovery policy. A community can launch on ordinary HTTPS, participate in
the shared feed and add HNS later without recreating its accounts or content.
HNS ownership gates HNS claims, not community registration or gas eligibility.

The first usable milestone remains a disposable testnet community: fresh
installation, automatic permissionless registration, plain member sign-in, first-song
publication/playback and persistence through restart. The expanded Web2 release
includes Study, Karaoke, Dance, the shared feed and Megapot rewards. The smaller
first-song acceptance remains a staging milestone and does not wait for HNS or
learning-results publication; it does not replace that expanded release scope.

This plan supersedes conflicting Cloudflare-first hosting, HNS-required
registration/discovery, blanket Dance deferral, combined login/publication
consent and broad restore/upgrade prerequisites in older delivery documents.
Existing deployments and historical evidence are not changed by this decision.
Directory and consent contract foundations are merged and CI-qualified source.
The first-song application/runtime source is merged and CI-qualified in
[PR61](https://github.com/pirate-social-club/pirate-operators/pull/61) at
`7515931`. Invited enrollment and capped initial-gas service source is merged
and CI-qualified in [PR60](https://github.com/pirate-social-club/pirate-operators/pull/60)
at `0510f77`. Live Fluence staging acceptance remains open; these source checks do not establish actual provisioning, native installation or external services.
Required CI and authorization checks remain. Publication of this plan authorizes
no deployment, signing, funding or credential operation.

## First-song acceptance status

Status reviewed 2026-11-27. This is the single volatile acceptance-status entry for the first-song Web2 pilot; other documents link here instead of repeating partial results.

A pinned 4 GiB VM run passed at product successor `299ebfe5ccb0371f7b2b0c6e8ef3fe2cf5ffce21` with image SHA-256 `3088dd47364de4878a76dc50047089612fcbec2b885124d9fa70bdd568428565`. The run covered installation, publication, HTTPS playback, restart on the same store, replay with zero duplicate effects, and clean shutdown. It is controlled VM evidence, not live staging acceptance.

Live Fluence staging acceptance remains open. Public DNS/ACME issuance, external providers, real-device readiness, backup/restore, upgrades, expanded activities/rewards and production use remain unqualified by the VM pass.

## Checkpoints and dependencies

| Checkpoint                       | Required result                                                                                                                                                                                                                                                | Dependency and owner                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1a. Web2 foundation contracts    | Community creation without HNS; stable identity; revisioned origin configuration; constrained registrar; independent listing/delisting; Posts and stable song references; reviewed future HNS attachment interface; generated interfaces and behavioral tests. | Source merged and CI-qualified in [PR56](https://github.com/pirate-social-club/pirate-operators/pull/56) at `aef30d0`. Application/runtime source is qualified in PR61; selected-host acceptance remains required. Naming is not a prerequisite.                               |
| 1b. Optional HNS contracts       | Qualified naming registry and constrained gateway, size limit, proof vectors and real admission/refresh integration.                                                                                                                                           | Can proceed alongside Web2 delivery against 1a's agreed attachment interface. Blocks HNS activation only.                                                                                                                                                                      |
| 1c. Separate publication consent | Separate login from learning/Dance publication authorization, including stable community identity, address changes, revocation, replay protection and Dance adapter compatibility.                                                                             | Source merged and CI-qualified in [PR59](https://github.com/pirate-social-club/pirate-operators/pull/59) at `c6c98cb`; [V5/Dance V2](../contracts/publication-consent-v1.md) remain inactive pending application/policy gates. Does not block checkpoint 3.                    |
| 2. Green integration baseline    | Diagnose and repair PR58's actual failures, retain meaningful assertions, independently review and qualify the integrated source through required CI.                                                                                                          | Source merged and CI-qualified in [PR58](https://github.com/pirate-social-club/pirate-operators/pull/58) at `9374f4c`. The combined first-song runtime is source-qualified in PR61; installed-host acceptance remains separate.                                                |
| 3. First-song Web2 community     | Fresh selected Linux host, public HTTPS, automatic enrollment, plain sign-in, real song recognition/pinning/publication/playback, interrupted-operation reconciliation and ordinary restart.                                                                   | PR60/61 qualify service/application source. Acceptance status is recorded in [First-song acceptance status](#first-song-acceptance-status). HNS, names, learning-results and Dance remain disabled.                                                                                         |
| 4a. Activities and shared feed   | V5 Study/Karaoke with private practice independent of publication grants; V2 Dance capture/review and separately consented public videos; canonical song references; aggregate indexing/playback; delisting, retention and deletion.                           | Requires the consent/Dance foundation, actual normal-route/media/source/profile and HTTP/queue/scheduler/Linux joins, and a green baseline. First-song acceptance remains separately useful.                                                                                   |
| 4b. Manual rewards journey       | Connect Web2/song/Dance qualification to the accepted November operator attach/close/settle, Very claim, guarded MOSS payout and onward Send flow. Preserve explicit rehearsal tickets/prizes and prefunded testnet inventory.                                 | Reuse accepted unchanged stages from the [manual reward pilot](../deferred/manual-rewards-pilot.md); qualify changed source/offer/account joins. Live Sepolia drawing/collection and conversion remain separately named later qualifications, not gates to this first manual rehearsal. |
| 5. Release and handback          | Qualify the expanded Web2 scope with operators, bind source/artifact/evidence, disclose limitations and retire superseded worktrees through the maintained lifecycle.                                                                                  | Requires checkpoints 3, 4a and 4b. A first-song staging milestone may precede them; it is not completion of the expanded release. HNS remains independent.                                                                                                            |

Checkpoint 2 fixes known failures without waiting for final contracts. Integrate
contract changes when ready and qualify the combined candidate before release.
Disabled features must be excluded at server and UI boundaries; retain their
source and failing evidence instead of silently filtering required checks.
Directory V3 is the merged source foundation for 1a; that source qualification
does not establish first-song runtime or selected-host acceptance.

Current application source includes the V5 publication runtime and the V2 Dance
reader/binding adapters in [PR75](https://github.com/pirate-social-club/pirate-operators/pull/75),
[PR78](https://github.com/pirate-social-club/pirate-operators/pull/78) and
[PR79](https://github.com/pirate-social-club/pirate-operators/pull/79). Their source
and CI qualification do not enable the expanded Web2 runtime. The existing Web2
profile still excludes the activity/media/rewards routes; the normal rewards
mount still expects a scored source. Complete the actual joins above without
introducing a dummy legacy source or widening the first-song profile.

Complete contracts before implementing the behavior that depends on them.
This is not a requirement to finish every future contract before the first
community works. Freeze the Directory attachment boundary now; use an explicitly
identified stand-in verifier to test attachment, expiry and unauthorized calls.
Real HNS proof, gateway and registry interoperability remains separate acceptance.

The transition case creates a Web2 community, publishes a song and associated
Dance record, attaches HNS and lets its HNS verification expire. Community,
account, song and Dance identities remain unchanged. HNS expiry removes only
HNS-derived claims; a valid Web2 address and listing approval preserve ordinary
discovery. Domain changes require controller-authorized configuration and fresh
address verification, not a new community identity.

## Web2 verification, discovery and aggregation

The selected initial Web2 verification validity is 30 days from successful
observation. Pirate's service verifies an HTTPS or DNS challenge bound to the
community, controller, address and fresh challenge. This demonstrates address
control; it is not real-world identity or brand-ownership verification.

Recheck control through the service daily and before renewing or accepting a
new address. Routine service checks do not require daily on-chain transactions.
Publish a bounded verification renewal before expiry and an early revocation
on confirmed loss of control. An unavailable observer is not proof of transfer:
retain the existing bounded validity, retry, and expire if renewal cannot be
established. Specify exact evidence, authority, revision and renewal encodings
in 1a; this document does not claim a deployed verifier.

Community registration, address verification, listing approval and gas allowance
are separate states and permissions. Discovery requires current qualifying
address evidence plus listing approval, using the same policy for ordinary DNS
and HNS. Expiry or delisting does not erase community identity or chain history.
Never label an ordinary DNS verification as HNS verification.

The listing authority must be able to delist and deliberately restore a
community before the shared feed is public. Qualify index and cache suppression,
including delayed ingestion, stale reads and explicit restoration. A verification
renewal cannot silently undo a delisting. Automated moderation remains deferred;
controller-authorized publication and listing controls remain required.

Contracts emit canonical community, configuration and publication identities,
revisions and public content commitments independent of the web address. Every
Dance references the canonical song tuple and relevant revision/audio commitment,
not a mutable song URL. Goldsky or another qualified event indexer builds a
rebuildable shared feed from canonical events and verified public manifests.
Test duplicates, missing ranges, reorgs, publisher rotation, delisting and replay
from deployment blocks. Public media stays in the content layer; its references
and commitments go to contracts for Web2 and HNS communities alike. Private
review recordings are not automatically public posts.

## First-song profile and consent gate

The checkpoint 3 profile must omit the learning-results contract and V4 sign-in
configuration. The existing plain-sign-in fallback in
[accounts.ts](../../packages/community/accounts.ts) is the selected path.
No learning-results deployment, publication authorization or learning-origin
binding is created by this pilot. Public-results, Dance and names routes remain
disabled. Verify this profile explicitly; the existence of a fallback does not
prove the deployed configuration selects it.

Consent redesign starts alongside 1a, not after checkpoint 3. The present
[LearningResultsV4](../../contracts/LearningResultsV4.sol) combines login with
publication permission and fixes the origin at construction. Dance consumes
that authorization through
[DanceVerdictAuthority](../../contracts/dance/DanceVerdictAuthority.sol).
The successor must separate origin-bound browser authentication from explicit
publication consent tied to stable community, chain, contract and purpose/policy.
Address changes must neither grant new permission nor reinterpret prior consent.
Define withdrawal, fresh authorization, replay and old-signature handling before
changing Dance consumers. Freeze the reviewed interface and migrate dependent
consumers together; do not deploy the current combined version as an interim fix.

The consent owner supplies the failure cases, signed-message/event proposal,
existing-Dance dependency map and executable proof plan first, then the reviewed
implementation. Shared-interface ownership remains with
integration_release_coordinator. Live source custody is explicit in task records;
no second writer may enter another lane's checkout.

## Linux hosting and storage

Qualify one concrete Linux amd64 host profile, with its exact distribution,
Docker/Compose versions and image digests recorded before the host run. The
current pinned Bookworm-based image and workerd composition are candidates, not
a promise to support every Docker host. Use the operator's ordinary DNS domain
or subdomain; defer a Pirate-operated subdomain provisioning service.

The workspace_owner's November 17 decision removes low-end resource measurement
as a launch prerequisite. Select sufficient server capacity for v1 and upgrade
if needed. A 1 GB minimum, capacity benchmark or disk-sizing study is not a
release gate. The selected installation and normal user journey must still work
through public HTTPS and an ordinary restart on the actual pilot host.

Caddy supplies public ingress and automatic certificates. The
[ingress implementation](../../deploy/linux/public-ingress.ts) already supports
public ACME and a separate local fixture CA. Public-host certificate issuance
and connectivity remain unqualified. The foundation Compose's loopback port,
fixture TLS and internal network do not establish that public deployment.
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

For checkpoint 3, qualify the existing pinned workerd/D1/R2-compatible modules,
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
the pending-community request against the checkpoint 1a contract.

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
contract. Member-name sponsorship remains checkpoint 1b/HNS activation work. External creator
registration, creator wallets and royalties remain outside this pilot.

## Invites and funding admission

Ordinary community registration is permissionless and uses no invite. Invites
only admit Pirate-funded initial gas. Use a short-lived, single-use invite that
expires unused and can be revoked before funding redemption. Redeem atomically
into a controller/installation-bound service enrollment after proof of control.
Concurrent redemption, replay, expiry and revocation must not create another
enrollment or budget. Retain the original operation identity after a lost
response. Keep invite secrets out of logs and public configuration; possession
alone authorizes no arbitrary transaction. Subsequent funding requests
authenticate the enrolled binding and action. Revoking an enrollment stops
future service access and top-ups; it does not revoke community keys, reclaim
transferred ETH or erase completed effects.

## Selected external services

| Capability                               | Operator and credential custody                                                                                                                 | Pilot acceptance                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Community enrollment and testnet top-ups | Pirate operates the hosted service and holds registrar/funding credentials. Communities retain publisher/controller signing custody.            | Permissionless registration, real enrollment, capped transfers, funding invite controls, budget enforcement and interrupted-operation reconciliation.                                            |
| Song recognition and shared catalog      | Pirate operates the shared recognition service and holds ACRCloud credentials and catalog costs. Communities use scoped service pairings.       | Real recognition and accepted-song enrollment; unavailable/inconclusive evidence never becomes permission to publish.                                                                            |
| Publication approval                     | Controller-authorized owner publication under the selected owner-catalog policy.                                                                | Real authorization and declared rating/language. Automated moderation is deferred; no OpenAI moderation service is required or claimed for this profile.                                         |
| Public media pinning                     | Pirate's publishing service holds Filebase credentials; the community publisher retains on-chain publication authority.                         | Actual admitted-file pinning, CID verification and retrievable published bytes.                                                                                                                  |
| Chain access                             | MegaETH testnet 6343, initially the single public endpoint `https://carrot.megaeth.com/rpc`; Pirate records and monitors the selected endpoint. | Application reads, role checks and canonical receipts. This is a single point of failure, with no qualified alternate RPC. Unavailable reads hold new effects and preserve uncertain operations. |
| Public media retrieval                   | The selected IPFS gateway/retrieval service; its endpoint and operator are recorded in the runtime profile.                                     | Real browser playback through the supported ingress/egress path.                                                                                                                                 |
| DNS and certificates                     | Operator controls ordinary DNS; Caddy uses the selected public ACME issuer.                                                                     | Valid public HTTPS, persistent certificate state and qualified renewal configuration.                                                                                                            |

These are required capabilities and responsibility assignments, not claims of
deployed services. Bind exact endpoints, service identities and budgets before
checkpoint 3. Selected managed services may remain on Cloudflare under Alchemy;
community hosting is Linux. Operators do not supply Pirate's provider or funding
keys. Learning speech services, Telegram and general creator registration are
not prerequisites for the first-song playback profile.

## Pilot disclosure

Show this notice before enrollment preparation and retain the acknowledgement:

> This is an experimental testnet pilot for disposable data. Backups and
> supported restoration are unavailable. Losing the server or its disk may make
> your community unrecoverable. Do not use it for irreplaceable content or
> production operations. Public media and on-chain records may remain even if
> the community server is lost.

Checkpoint 3 permits operators to perform this testnet acceptance. It
does not authorize general production operation, mainnet or a recoverability
promise. HNS/naming readiness is independent of production storage readiness.

## Dance retention and remaining release decisions

Existing private-media source defines an upload deadline of one hour and an
unsubmitted lifetime of 48 hours from reservation creation. Accepted submission
atomically changes the private review deadline to seven days after the trusted
submission receipt. Identical retries preserve that deadline. Sources are
[retention constants](../../packages/community-media/validation.ts),
[reservation](../../services/community-media.ts),
[submission](../../packages/community-media/submission.ts) and the
[producer specification](../archive/lanes/v1/v1-video-dance-producer.md).

Expiration or withdrawal denies subsequent private access. The
[maintenance service](../../services/community-media-maintenance.ts) erases
objects and retries failed deletion. Qualify its actual scheduler, originals and
derivatives, interrupted deletion, late writes and restart before Dance release.
A timestamp or inaccessible object is not proof of completed erasure. Public
Dance publication requires separate consent and is not subject to the private
seven-day review window. Already-public chain records or media copies cannot be
promised erased by deleting local recordings.

The expanded pilot notice must tell operators and participants that private
recordings may be lost if the server fails; state the private-media deadlines,
who can review recordings, deletion behavior and the difference between private
review and public publication. Decide the retention of private submission,
review and identity-linking metadata before admitting Dance participants.
No metadata retention period is selected by this plan.
The retained owner decision defers that choice to Dance admission. Immutable
command/binding journals and public commitments do not select a private metadata
retention policy; reconcile identity-linking retention and deletion with actual
receipt recovery and outstanding rewards before admitting participants.

Invited enrollment and cumulative per-community/global funding caps remain the
pilot sponsorship policy. New wallets, domains and reinstalls do not reset an
allowance. Opening enrollment does not automatically open unrestricted gas:
a separate admission/abuse-budget policy must precede wider Pirate sponsorship.
Registration, discovery and self-funded operation are not promises of free gas.
Post-invite sponsorship and gateway multisig membership/threshold remain owner
decisions at their respective release gates; neither blocks current source work.

## Ownership and working in parallel

contract_hardening_coordinator owns 1a in the existing Directory lane.
learning_consent_coordinator starts 1c design immediately; its first output is a
concrete contract/interface proposal with the Dance migration boundary.
ci_release_coordinator owns the bounded PR58 repair after source handoff.
integration_release_coordinator owns shared interfaces, integration review and
merges. self_hosting_coordinator owns the later fresh-host journey. Role names
are responsibilities, not claims that an executor has started; dispatch receipts
and task records establish actual custody.

One writer owns each mutable checkout and branch. The contract lane and CI lane
use distinct owned checkouts. CI repairs do not redesign contracts; contract
work does not rewrite browser fixtures or shared runtime mounts without a named
handoff. Consent design initially reads source without a product write claim.
Agree shared boundaries early and integrate small reviewed changes regularly.
Routine bounded commands should use the existing task authority; coordinate
only actual shared state or competing heavy checks. Existing worktree admission
and required CI policies remain in force until separately reviewed changes land.

The observed Solid upgrade was a framework/compiler migration with a real
browser regression, not a package-number-only edit. Recorded task registration
at 08:24:41 UTC and maintained admission at 10:36:49 UTC were 2h12m apart. Its
record cited unrelated unpublished branches and 14 occupied worktree slots;
some preparation occurred during that interval. In
[successful PR57 CI](https://github.com/pirate-social-club/pirate-operators/actions/runs/43605027535),
Web took about 4.1 minutes and the slowest root shard about 9.5 minutes.
These observations support reviewing admission/waiting overhead; they do not
attribute every minute or establish that required testing should be removed.

Advance checkpoints on concrete outputs and evidence, with no invented dates.
The contract foundations, repaired baseline, first-song runtime and hosted
enrollment service are merged and CI-qualified source. Acceptance status is recorded in [First-song acceptance status](#first-song-acceptance-status). Defer further plan-review loops unless a concrete
implementation finding changes an accepted boundary.

## Additional addresses (deferred, after the Web2 pilot)

The workspace_owner approved these three separate levels on November 15, 2026.
None changes the order, dependencies or acceptance of checkpoints 1–5. The ENS
read-only mirror may follow the first-song pilot; verified naming and interactive
additional addresses are separate deferred work, not new pilot prerequisites.

1. ENS read-only mirror. Point a `.eth` name's contenthash at the published IPFS
   release. Authenticated actions open the canonical HTTPS application. This
   requires no Pirate contract change or mirror login. Updating a direct IPFS
   contenthash requires an Ethereum mainnet transaction paid by the name's owner;
   an updatable pointer has its own publishing, signing and availability policy.
   Verify release bytes, retention and retrieval before updating the pointer.
2. ENS as a verified community name. Directory V3 has separate Web2 verification
   and HNS attachment state; neither represents ENS evidence. Before a lasting
   deployment, decide whether its successor adds an ENS attachment or generalizes
   naming attachments with explicit protocol types while retaining HNS. The
   disposable testnet V3 need not change now. Define current ENS control, expiry,
   resolver/delegation changes, evidence freshness and revocation before Pirate's
   verifier attests the binding on MegaETH. Preserve community/content identity
   and independent listing approval. Reading Ethereum state is a useful basis;
   it does not by itself define or qualify the attestation policy. The order of
   verified ENS versus HNS remains a later decision. ENS member subnames are a
   separate issuance design, not implied by attaching a community's ENS name.
3. Interactive additional addresses. Combine HNS, ENS and native IPFS application
   access into one milestone. Define controller-approved addresses and address-
   bound login, session audience, refresh, revocation and API authorization.
   Cross-site page/API deployments must work with third-party cookies blocked;
   design short-lived audience-bound token sessions for that path, including
   storage, replay and logout behavior. Do not weaken the current canonical
   host-only cookie/CSRF boundary; an additional HTTPS address with its own
   same-origin API may retain a separate cookie session. Qualify MOSS connection,
   sign-in, signing and consent on every supported browser/address type. The
   current client uses MOSS-signed SIWE; MOSS's optional authenticate JWT is also
   bound to the requesting host and cannot be replayed as another host's login.
   Reading a mirror successfully does not establish interactive acceptance.

Freedom provides a strong native verification path: Colibri verifies the ENS
resolution to its content reference, and native IPFS retrieval verifies the
content against its CID. This authenticates the name-to-content binding and
retrieved application bytes without trusting a third-party HTTPS content gateway
to serve the code faithfully. Freedom preserves the ENS name as the page origin
across content updates. Acceptance must record that the Colibri-verified path was
used; a fallback resolver must not be presented as the same proof. This is an
existing browser capability, separate from the deferred Pirate/MOSS integration.

An ordinary third-party HTTPS gateway remains a distinct trust path: without
independent content verification it can serve altered application code. The plan
must distinguish that access from Freedom's verified native access. Wallet/API
compatibility and service availability remain separate from name/content proof.

Swarm is a later storage mirror with its own release packaging, retention/postage
and retrieval acceptance. It changes none of checkpoints 1–5.

References: [ENS contenthash](https://docs.ens.domains/ensip/7/),
[MOSS authentication](https://moss.megaeth.com/developers/concepts/authentication),
[Freedom native IPFS](https://github.com/pirate-social-club/freedom-browser/blob/main/docs/protocols/ipfs.md)
and [Colibri verification](https://github.com/corpus-core/colibri-stateless).

## Later naming gateway and refresh policy

Select a constrained gateway holding the naming registry's admin role. It
exposes fixed operations against a pinned registry, with separate enrollment,
refresh and governance capabilities. Hot service keys receive no arbitrary-call,
target-selection or admin-transfer escape hatch. Refresh preserves the active
binding and caps, cannot revive revoked/lapsed authority or extend the stored
absolute maintenance ceiling, and may suspend only on confirmed authority loss.
Observer unavailability is not proof of loss. A lapse requires explicit
readmission. The gateway still relies on trusted HNS observations and does not
alter lease semantics inside V4. The selected registry V4 source at `06606e5`
already passes size qualification; further shrinking is not a Web2 or HNS gate.

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
arrangements before HNS deployment. No signer identities or threshold
are implied. This choice does not block Web2 delivery. Registry size, generated
ABI, Solidity/TypeScript proof-vector agreement, consent, roles, sponsorship,
observer-outage handling and canonical receipts remain HNS activation gates.

## Source and evidence boundary

This packet follows the source/UI application checkpoint at `99abc251` in
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
pilot scope where they conflict. The [ordered onboarding contract](../web2-onboarding-linux-wizard.md)
still describes unimplemented joins. The [application review note](../review-checkpoint-20261114/README.md)
retains actual prior qualification and limitations. Publishing this document
adds no runtime capability and converts no failed or unrun check into a pass.
