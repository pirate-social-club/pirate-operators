# Decentralized community setup

Reviewed 2026-11-04. This describes the current direction and separates it from
implemented behavior. The setup wizard is not implemented. The decentralized
experiment is independent of the centralized application.

## Architecture and current state

Each community controls its namespace, HTTPS origin, application sessions,
records, deployment and operating budget. Pirate can supply hosted operators,
a creator-wallet site and a public aggregator. Those are explicit dependencies;
independent name ownership does not make all application services trustless.

| Component | Current state |
| --- | --- |
| HNS name registry | Factory, per-TLD ERC-721 registries, CLI and independent lookup exist. Registry PR 2 adds MegaETH testnet and sale policy; testnet deployment/rehearsal are recorded. It is not a production release. |
| Operator services | Main has a working local harness with simulated providers. The segment-payments branch is replacing the payment runtime with MegaETH contract purchases and community D1 storage. Hosted service acceptance is pending. |
| Frontend | PR 9 contains a fixture-backed static Solid client, generated public pages, deterministic CAR and local IPFS mirror tests. It is not a complete independent installation. |
| Ordinary wallet | MOSS is selected for MegaETH. CLI account connection/funding is recorded; delegated approval and real community browser-login acceptance remain unfinished. |
| Creator wallet | PR 10 specifies sponsored Sui/Ika creation and saved passkey access. Implementation and device acceptance are pending. |
| Discovery and posts | Contract-backed posts and a Pirate-funded Goldsky aggregator index are the direction. The publication/discovery contract and complete indexing interface still need implementation. |
| Wizard | Proposed CLI orchestration, no working end-to-end installer. |

These observations use operators main 9f2217e, registry PR 2 at 296c97d,
frontend PR 9 branch at 388018f and creator specification PR 10 at 9c7899b.
Task records remain the authority for later changes. Reported test results in
those records were not rerun as part of this architectural inspection.

## Provisioning and credentials

Use cf for Cloudflare build and deployment. Start with a CLI wizard and a
versioned nonsecret setup manifest, recording each external operation and its
receipt. Resume by reconciling actual state; applying twice must not create a
second registry, duplicate funding or a second community. Proposed plan,
apply, status and doctor commands are not available yet.

Alchemy.run is optional infrastructure orchestration, not an implemented
requirement. Introducing it requires a deliberate ownership boundary: cf and
Alchemy must not independently manage the same resource. The current repository
uses cf and has no Alchemy stack. A browser UI can drive a local or hosted
provisioning runner; it cannot directly execute the native cf CLI. A hosted
runner would become a custodian of deployment authority and needs explicit
credential scope and isolation.

First choose hosted operators or independent operation. A community using
Pirate's operators supplies connection credentials, not Pirate's vendor or
wallet secrets. An independent operator supplies only the keys required by its
enabled services: ElevenLabs for selected speech work, OpenRouter for exercise
generation, OpenAI for moderation, CloudConvert for selected media processing,
and any required audio-matching provider. These are desired integrations, not
completed decentralized adapters. A Telegram bot token is optional until the
Telegram Study/guest flow is enabled. It need not block a web community.

Community hosting needs its own Cloudflare authorization, D1 and object/media
storage, session and signing configuration, public HTTPS origin and backups.
Provider secrets belong to the service that calls the provider. Infisical is
an optional operator secret source; inject narrow credentials into server
secret bindings. No provider, sponsor or deployment key belongs in the static
bundle, public community configuration or IPFS. Never copy centralized keys
into independent communities.

The local runtime is not a deployable production template: its fixture clock,
debug endpoints, local guard and harness transports need a hosted profile,
real time, authentication and persistent jobs. Do not expose it by merely
removing LOCAL_ONLY. Admission, media processing, publication, registration and
retry/reconciliation need defined ownership even if they share one Worker.

## Names and contracts

The namespace owner supplies an HNS TLD and publishes its delegation to the
verified MegaETH registry. HNS ownership/delegation is separate from obtaining
ordinary browser DNS and HTTPS. Keep the HNS root key in its owner's wallet.

Reuse a verified ownerless factory and deploy one registry clone per TLD.
Factory deployment does not make a registry authoritative: the current HNS
record does. There is no central Pirate contract that must approve every
community, and no implemented authoritative community-directory contract was
identified. The aggregator must not become an ownership authority merely
because it lists a community. Do not update unrelated centralized contracts.

The registry PR supports annual prices by label length, an individual premium
price such as king.TLD, and reservation to one recipient address. It explicitly
has no general wallet allowlist or voucher system. Closing ordinary sales and
opening individual premium labels can approximate a label catalogue, but is
not an account allowlist. A requirement to whitelist buyers needs its own
contract policy. Reservation does not waive the sale price or mint the name.

Offer editable infrastructure reservations such as app, www, api, admin, auth,
login, wallet, status, support and docs. Offer optional premium candidates such
as king, queen, vip, music and short labels. These are suggestions, not a
mandatory global list. Reserve labels before enabling their sale price. The
operator must actually register app and maintain its term before setting its
content record; registry admin alone has no right to edit a holder's records.

A registration's annual price is locked for its generation, including renewals
and transfers. A premium is therefore recurring annual pricing, not a one-time
auction surcharge. Admin controls future sales, not arbitrary confiscation or
holder-record edits. The HNS TLD owner can still repoint delegation and orphan
the old registry's names. Both TLD and SLD expiry need monitoring.

OperatorPayments is the separate MegaETH payment-contract build. Communities
fund their own deposit and designate a purchase signer; operators redeem signed
purchases for an admission job or karaoke segment take. A signed purchase is
revocable and may be unfunded. Confirmation of redemption, not the signature
alone, establishes payment. The shared-versus-per-community deployment policy
for this contract is not yet a completed wizard interface.

## Funding

Do not present one undifferentiated gas deposit. Show the purpose, asset,
network, spending authority, cap and remaining balance separately.

| Purpose | Current plan |
| --- | --- |
| MegaETH execution and user sponsorship | Test ETH for transaction gas and a bounded funded sponsor; actual MOSS sponsorship acceptance remains pending. |
| Names and operator work | MegaETH testnet PirateTestUSD, ptUSD, six decimals, with no real value. Name purchase price and OperatorPayments deposits are distinct from gas. Production payment asset is undecided. |
| Creator-wallet setup | Registration operator pays IKA protocol fees, SUI reimbursements and Sui gas. |
| Song IP registration | Test proof uses DATA/Story Aeneid, chain 1315, with gas paid by the registration operator. Production DATA deployment and migration are unresolved. |
| Cloud and providers | Hosting, inference, media conversion and pinning bills belong to the operating service. They are not chain gas. |
| Rewards | Prize source and production payout route remain undecided. External Megapot operates on Base; Pirate does not deploy contracts there. A local reward experiment is not a production reward route. |

Use MegaETH testnet 6343 for our application contracts and local anvil for local
tests. Song registration invokes the selected external protocol; its distinct
Sui/Ika and Aeneid testnet proof does not authorize our own Base deployment or
a production migration. No production stablecoin, automatic bridge or reward
funding guarantee is selected by this document.

The creator design already selects operator-paid setup rather than asking
creators to acquire coins. With Pirate's registration operator, a community
needs no SUI/IKA treasury or DATA signer. An independent registration operator
funds those itself. Who ultimately reimburses the operator is a commercial
policy still to specify; the creator-facing setup remains sponsored.

Only first song release creates the creator wallet. The creator owns the native
Sui passkey account and Ika control capability; zero-trust Ika supplies EVM
signing. Persist the PRF-encrypted Ika seed and public metadata, verify reopening
and signing, and wait for confirmed activation before upload/registration.
Ordinary reading, Study, karaoke and dance posts do not create this wallet.
Ika signing support does not migrate DATA assets, licences or royalties to Sui.

## Frontend publication and browsers

The current frontend task uses ordinary IPFS and excludes Filecoin/Synapse.
Build one deterministic UnixFS/CAR release containing the client and public
snapshot. Import the same CAR into independently controlled pinning services
or nodes, verify the same website root CID, and test retrieval through two
gateways before updating the holder-authorized contenthash. Filebase can be
one provider; another provider or node supplies redundancy. Pinning a CAR as
an ordinary file is not importing the site's DAG.

The primary app uses one stable community-controlled HTTPS origin with /api
on that origin and Secure, HttpOnly host-only cookie sessions. IPFS mirrors
are read-only snapshots and link sign-in/actions to the canonical origin.
IPFS stores bytes; Workers still handle private sessions, jobs and services.
An ordinary HTTPS gateway is trusted to serve correct browser code unless an
independent loader verifies it. HNS reachability, ordinary HTTPS and Telegram
in-app browsing require separate acceptance.

If Filecoin is reconsidered later, use a publisher-side adapter such as
filecoin-pin for IPFS/CAR integration over Synapse. Filecoin storage payments
and gas add another funding system. Raw treasury-key export is not necessary:
filecoin-pin supports wallet-approved scoped session keys. Such a delegate can
still consume funded storage allowance, so expiry, revocation and budgets
matter. It does not belong in a public site bundle. This is an optional future
adapter, not a current setup prerequisite.

## Security assumptions and next delivery

Community operators control their server, moderation policy, private records
and served JavaScript. They can censor, misreport results or disclose data they
receive. Operator signatures prove who signed a verdict, not that an AI provider
was called or that a score is honest. Provider services receive the submitted
content. Small budgets and selected trusted operators bound this exposure;
the prototype is not a trustless moderation system.

A separate wallet origin and creator-held capability limit community custody,
but wallet-site code, the passkey provider, saved encrypted material and Ika/Sui
availability remain dependencies. Compromised wallet code can misuse material
while it is decrypted. The simplified MVP defers independent recovery machinery;
it does not establish recovery during a wallet-site outage. Infisical protects
secret distribution, not a compromised runtime using its authorized key.

The next complete demonstration is MOSS login on a fresh HTTPS origin,
independent challenge verification, a sponsored MegaETH name purchase and
record update, followed by resumable cf provisioning of a second community.
Finish actual provider admission and sponsored first-song proof separately.
Telegram Study/guest attachment follows the web path. Complete the public-post
contract/index interface and independent pinning before describing an autonomous
community release as ready. No new general architecture decision is needed to
continue the already authorized isolated implementation lanes.

## References

[Registry PR 2](https://github.com/pirate-social-club/pirate-registry/pull/2),
[static frontend PR 9](https://github.com/pirate-social-club/pirate-operators/pull/9),
[creator-wallet PR 10](https://github.com/pirate-social-club/pirate-operators/pull/10),
[community browser contract](community-web-client.md), and
[Filecoin Pin session permissions](https://github.com/filecoin-project/filecoin-pin#session-key-permissions).
