# Community setup to first song

Owner direction, 2026-11-04: the first milestone is an operator bringing a
community online at its selected application origins, appearing in Pirate's community directory and
posting its first song. Sponsored customer name purchases are lower priority.
Alchemy.run owns Cloudflare infrastructure provisioning. Infisical is the
source of service secrets. These are requirements, not optional tooling choices.

The wizard PR 15 source now provisions a workers.dev setup page; it is not a
completed community app. Existing pieces include the testnet HNS name registry,
local operator services and a fixture static client. The maintained
centralized HNS gateway also has prior phone acceptance; its new-registry
adapter and repeatable community setup are not built. The sequence
below is the missing end-to-end integration. It keeps centralized hosted
infrastructure as an explicit part of the decentralized community product.

## Optional domain access and signup

The owner-approved [signup and domains contract](community-signup-and-domains.md)
specifies a sponsored initial 8–63 character ERC-721 username claim on MegaETH
and Web2 only, HNS only or both for browser access. Web2 is optional. When
selected, its hostname, DNS/TLS and Worker attachment are managed through the
wizard's pinned Alchemy Cloudflare provider. HNS-only setup skips Web2 inputs,
resources and readiness gates and cannot redirect login to a Web2 alias.

Both active origins reach the same community with separate host-bound sessions.
The current workers.dev slice does not implement custom domains, dual-origin
sessions or HNS-only access. Ordinary HTTPS remains the first engineering slice;
it is not a requirement that every operator expose a Web2 site. First-song
service integration remains the delivery priority before customer sponsorship.

## MVP namespace scope

Owner decision, 2026-11-04: Spaces support is deferred beyond the decentralized
community MVP. The separately admitted wizard v1 starts on ordinary HTTPS;
HNS configuration and verification are an optional follow-up for that engineering slice.
The operator may instead select HNS-only access and wait for its qualification;
no Web2 resources are then implicitly provisioned.
This deferral adds no HNS prerequisite to wizard v1. The broader first-song
and native-address acceptance requirements below retain their own scope. Native
Spaces community bindings, handle resolution/issuance and their deployment
integration are later work, not first-song acceptance gates. The current
HNS-specific registry/directory design need not be generalized for Spaces to
ship MVP; that later extension needs its own identity and migration design.

The wizard may display a disabled "Spaces — Coming soon" option with the copy
"Spaces support is planned for a future release." It must not promise a date,
accept Spaces setup inputs, request keys or funding, or provision Spaces
services. Configuration/API requests selecting Spaces must return an explicit
unsupported-namespace result before external effects. MVP acceptance must
show that this unavailable option cannot block supported setup. This is a
wizard requirement, not a claim that the wizard is implemented.

Cloudflare Containers are a candidate for the later Spaces service deployment,
consistent with the preference to keep hosting on Cloudflare. They are not a
qualified replacement for the existing VPS stack. Container disk is ephemeral
by default; snapshots and object-storage mounts do not by themselves establish
safe wallet, name-tree or journal recovery. A future qualification must prove
durability and interrupted-operation recovery, wallet isolation, independent
verification, chain/relay connectivity and the proving dependency. The current
RunPod proving path is external, so an entirely Cloudflare-hosted stack remains
unproven. See the [Containers lifecycle and storage limits](https://developers.cloudflare.com/containers/faq/).

MVP provisions neither a Spaces VPS nor a Spaces container. This deferral does
not retire or migrate existing centralized Spaces services, alter their
acceptance records, or settle the separate HNS ingress/transport decision.

## The happy path

| Step | Wizard responsibility | Completion evidence |
| --- | --- | --- |
| 1. Select namespace, access mode and operator | Select community identity, Web2 only/HNS only/both and service operation. Verify the relevant domain authority; HNS verification separately gates discovery. | Bound identity and deployment account; disabled Web2 requires no ICANN input, zone or public alias. |
| 2. Prepare the name registry | Reuse a verified MegaETH factory; create the TLD registry with NOT_FOR_SALE, reserve app to its intended holder, set app's premium to zero, register it, and configure other selected names. | Verified code and receipt, app owned by the intended holder, selected reservations/prices read back. |
| 3. Save secrets and provision services | Save required provider/service credentials to the right Infisical scope. Alchemy provisions Workers, D1/migrations, R2, job transport, bindings and public ingress. | Secret versions installed without logging values, migrations applied, health and storage checks pass. |
| 4. Activate selected application origins | Build the release. For Web2, reconcile the reviewed Alchemy/Cloudflare hostname and TLS. For HNS, set holder records, verify delegation and qualify actual client resolution and secure transport; use isolated ingress if needed. | Load, login and same-origin API behavior pass independently for every selected origin. Both share one community; HNS-only has no forced Web2 redirect. |
| 5. Update Pirate's community registry | Submit/update the community record, verify namespace authority independently, and expose the verified entry through the directory/index. | The correct community and app link appear; a forged factory announcement is not accepted as ownership. |
| 6. Configure real admission | Select trusted operators and policy, validate the required provider connections and enable durable admission/publication jobs. | The restored evidence and publication gate run against real inputs; failures hold rather than publish. |
| 7. Post the first song | Authenticate the operator/creator, run the applicable creator activation flow, upload sealed media, perform admission, publish the post and complete the configured registration step. | The post appears and plays after reload, its page and media are retrievable, and retries do not duplicate publication or registration. |

These steps are a resumable dependency graph. Infrastructure may be prepared
before HNS records change. The directory can hold a provisioning record, but
must not mark the community active before reachability and required admission
checks pass. The wizard saves nonsecret resource IDs, input/config hashes and
transaction receipts before/after external effects. Re-running it reconciles
existing work instead of duplicating deployments, jobs or transfers.

Operator login is part of posting. It does not require proving customer name
buying, deploying a MOSS gas sponsor or completing a rewarded Telegram journey.
The first operator can pay its own bounded setup gas. An ordinary EOA may be
the registry admin and bootstrap the community directory; the controller can
later propose a handoff that the receiving MOSS account accepts. MOSS first-
transaction fee funding and execution must be proven before that handoff, not
assumed from an ETH balance. See the [directory bootstrap boundary](contracts/community-directory.md).
These are proposed integration requirements, not completed directory/wizard
acceptance. Normal user onboarding,
name sales, gas sponsorship, karaoke and rewards follow this milestone.

## Alchemy, Cloudflare and Infisical

Alchemy.run is the sole infrastructure reconciler for this stack. It owns the
Workers, D1, R2, required Queues/Workflows, bindings and ordinary HTTPS ingress.
If HTTPS ingress uses an HNS TLS gateway, it is a separate service with its own
operator and keys; its necessity depends on the chosen client/transport.
Use cf for relevant diagnostics and account inspection, not a second deployer
that independently changes Alchemy-owned resources. Do not assume cf login
credentials automatically authenticate Alchemy. Pin the selected Alchemy release
and its state/authentication behavior before implementation; current upstream
includes a v2 API and older examples must not be copied blindly.

The provisioner authenticates to Infisical through a scoped machine identity,
reads only the selected operator/community environment, and supplies secrets
to Alchemy's protected secret bindings. Infisical is the recoverable source of
truth; Worker bindings are runtime copies. Use one installation path rather
than an independent automatic sync overwriting Alchemy's bindings. Verify
rotation and a redeploy from stored secrets. Do not attempt to recover secrets
by reading Worker bindings back. Back up D1 and retained objects separately.

Keep Alchemy state, state-store credentials and any required encryption material
under explicit access control and backup. Secret redaction alone does not prove
state is encrypted. Inspect the pinned provider's serialized state during the
first deployment. A browser wizard can use a trusted local or hosted runner;
provider credentials must not become part of the static client or its public
configuration. A hosted runner has deployment authority and is a security
boundary. Unattended operation needs signing authority, but not necessarily a
plaintext long-lived private key on a local disk.

For Pirate-hosted operators, their provider keys live in Pirate's operator
Infisical scope. Independently operated services use the operator's own scope.
The wizard saves each supplied key to its actual owning service; it must not
copy shared provider credentials into every community Worker.

ACRCloud configuration is required by the current audio-identification policy.
OpenAI supplies the selected text/artwork moderation adapter. ElevenLabs is
needed only for enabled speech/transcription work; OpenRouter exercise generation
and Telegram bot credentials are not prerequisites for posting a song.
CloudConvert is required when selected media conversion uses it. Preserve the
specific MP3 frame-window rule for identification; a generic transcoded sample
does not satisfy that rule. No simulated allow verdict counts as configuration.

## Namespace and directory authority

The per-TLD SLDRegistry and Pirate's shared registry of communities are different
systems. The former exists in pirate-registry. The latter has a separate
[contract specification](contracts/community-directory.md) and implementation
lane; this documentation branch does not establish its deployment or integration.
The directory remains required for discovery even though HNS owns name authority.

The initial directory is Pirate-maintained, with a shared MegaETH community
registry/index interface. Define the community ID, TLD, chain and SLD-registry
address, app identity/origin, public configuration URI/hash, feed signer and
lifecycle state. Specify authorized updates and a revision so retries cannot
create duplicate communities. The public-post contract is a separate interface
for publishing and indexing posts; a directory entry does not implement it.
These are minimum interface requirements, not claims of deployed contracts.

Before listing an active community, Pirate's verifier checks current Handshake
delegation, registry code/manifest, TLD match, app ownership and configured
endpoint/signing authority. Goldsky may index chain events; an event alone
cannot prove HNS control. The verifier records the observed height/hash/time
and refreshes after delegation or ownership changes and expiry. Reorgs and
stale verification must not leave an old registry advertised as current.
The directory is a discovery service, not power to rewrite HNS ownership.

Create a new registry with every ordinary name closed before any public
transaction can buy app. Then reserve app, set its explicit zero price and
register it to the intended holder. Apply premiums and reservations before
opening general sales. The contract supports a label catalogue exactly: keep
all length tiers closed and enable only explicitly priced labels. It has no
buyer-address allowlist. Premium prices are annual, not one-time surcharges.

Reservations persist after expiry until changed by the admin. A reserved app
cannot be registered by another recipient, but an expired app still stops
resolving. Monitor and renew both SLD and HNS TLD. Admin controls future sale
policy and treasury; the app holder or appointed record manager controls its
records. TLD ownership can still repoint delegation and orphan old names.

HNS app.tld is an acceptance target when HNS access is selected, not shorthand
for a workers.dev URL. Cloudflare custom domains require an active zone;
publishing HNS records does not establish that zone or trusted transport.
Identify and test the actual HNS-capable browser/resolver/gateway and its
secure-origin/session behavior. An ordinary HTTPS origin is optional and is
configured only when Web2 is selected. It never counts as app.tld acceptance.
A redirect proves navigation only, not same-origin HNS application operation.
Start with the [HIP-5 client and transport proof](hns-community-ingress.md).
The contract holds app records; a compatible resolver must read the custom
`._evm` delegation before any transport can use them. Current typed resolver
support does not yet include TLSA or return contenthash. The existing DANE
gateway is reusable for an HTTPS option, in a separate milestone instance.
Its earlier phone run used a signed DNS zone, not this contract path.
Do not modify the production gateway to qualify the new authority adapter.

## First-song publication and DATA

[operator-protocol.md](operator-protocol.md) restores the evidence envelope,
input hashing, MP3 windows, admission request, publication gate, authentication,
ticket and sponsorship requirements. Its encoding, evidence and publication
sections are byte-identical to the recovered source. In the current release,
identified audio blocks, an unidentified original proceeds to other checks,
and inconclusive identification or another declared song type holds. Artwork
controls cover display, not the rating. Missing/invalid evidence never publishes.

The existing creator design still requires confirmed Sui/Ika activation before
song-release upload. Do not bypass that requirement under the phrase first song.
The specified proof targets Sui/Ika testnet and DATA/Story Aeneid 1315 with an
operator-funded creator account and registration. This is part of the testnet
first-release work when that flow is enabled, not a production DATA launch.
The dedicated Pirate creator-wallet site and activation flow are specified,
not implemented end to end. They remain first-release dependencies.
Posting, admission and IP registration retain distinct durable states and
receipts. The UI must not label a post registered without a confirmed receipt.

Production DATA/Sui registration and migration remain unresolved. The concrete
work is to finish the supported testnet creator/registration adapter while
building the community publication path against explicit network profiles.
Do not invent migration rights, royalties or a production contract. Selecting
local publication without registration, or moving creator activation after
upload, would change the existing product contract and is not done here.

## Secret custody and spending exposure

| Authority or state | Custody and recovery | Exposure if compromised |
| --- | --- | --- |
| HNS TLD key | Operator's HNS wallet; its own recovery procedure. Never a Worker secret. | Repoint or lose the namespace, affecting all names beneath it. |
| Registry admin and app holder | Operator-controlled wallet; separate from provider/payment keys. | Admin can change future sales/treasury; app holder/record manager can redirect app records. |
| Cloudflare deploy and Infisical machine authority | Scoped operator provisioning identity; protected bootstrap/rotation procedure. | Read accessible secrets or replace infrastructure/frontend within granted scope. |
| HNS gateway TLS and forwarding authority | The selected gateway operator holds TLS/forwarding keys under its own protected recovery procedure. | Can inspect and alter requests, sessions and served code for traffic it terminates. Independent community Workers do not remove this trust. |
| OperatorPayments purchase signer | Scoped server secret in Infisical, installed only in the purchasing service. | Current contract permits arbitrary signed recipient/amount: the entire funded deposit is exposed. |
| Ticket, evidence and feed signing keys | Infisical-backed service keys with key IDs, rotation and restore checks. | Forge that service's tickets, verdicts or feed/config records. |
| Community sessions | Random opaque cookies; only token hashes/session records in D1, with backup/invalidation policy. | A stolen valid token impersonates its session; database/server compromise has wider authority. No extra session-signing key is assumed. |
| AI, conversion and pinning keys | Owning operator's Infisical scope; provider quota and rotation. | Spend provider budget, access permitted data or change retained pins. |
| MOSS gas sponsor, if added later | Separate bounded sponsor service/treasury. | Spend sponsor authority/balance; it is not needed for the operator-first setup milestone. |
| Creator passkey and Ika seed | Authenticator plus PRF-encrypted seed record at the wallet site; never plaintext in Infisical. | Loss of passkey or unavailable encrypted record/site can make registrations inaccessible. Independent recovery is deferred, not proven. |

At inspected payment commit d635d46, _redeem accepts the signed recipient and
amount without an independently enforced operator allowlist or spending cap.
Small deposits bound loss. A stronger change must have the community admin,
not the hot signer, authorize operators, immutable/versioned recipients and
amount/period limits. A global operator-to-recipient registration alone is
insufficient if an attacker can register itself and the signer can select it.
Even approved recipients can consume the allowance through fabricated work;
software quotas are not containment once the signing key is stolen. This is
a source-review finding for the payment lane, not a contract fix in this PR.
Do not fund it materially before that policy is reviewed.

Test ETH covers MegaETH gas; ptUSD currently prices test names and operator
work. HNS wallet operations have their own fees. Creator setup needs operator
IKA/SUI and Aeneid gas. Production assets are undecided. The USDm idea concerns
later buyer UX and needs actual wallet/network support verification; it does
not delay community setup or eliminate the need to acquire a purchase token.

## Publication and later work

The fixture frontend currently builds a deterministic IPFS CAR. Preserve its
UnixFS root CID when importing it into independently controlled providers and
verify retrieval before publishing the content pointer. Primary browser access
uses the verified enabled application origins with separate host-bound
sessions; generic mirror gateways remain read-only snapshots. IPFS-hosted JavaScript
can use live APIs; the restriction here is the selected origin/authentication
policy, not an IPFS limitation. Any interactive content-addressed route needs
its own client/origin acceptance without weakening that policy. Gateways serving
executable code remain trusted unless an independent loader verifies it.

Filecoin/Synapse is outside the first frontend implementation task, not rejected
as a product option. A later adapter can import the same CAR, but still needs
payment authorization, provider/IPNI/retrieval checks, budgeting and renewal;
an upload response alone is not acceptance. Session keys reduce treasury
exposure but can consume prepaid allowance. Do not put them in a public bundle.

Name sales and sponsored buyer transactions, USDm payment decisions, exercise
generation, Telegram, rewards and additional storage adapters follow the core
setup-to-first-song path. MOSS testnet work remains authorized by the owner;
commercial SDK/service permission must be established separately before a
commercial dependency is launched. No licensing finding changes today's
operator-first implementation order or requests a new general decision.

## Observed source and acceptance

Inspected operators main 9f2217e, registry PR 2 at 296c97d, frontend branch
388018f and creator PR 10 at 9c7899b. The payment documentation copy is now
refreshed from 0dec600 to 412c098, defining performanceEndedAt and unattempted.
The [payment specification](operator-payments.md) is included with exact
[source provenance](payment-specification-source.json). Its implementation is
published separately in [PR 14](https://github.com/pirate-social-club/pirate-operators/pull/14)
at 412c098; the documentation copy does not include that runtime.
No Alchemy provisioner, Infisical setup wizard, shared community directory or complete
first-song acceptance exists in these inspected sources.

The critical integration dependencies are the real ACRCloud/OpenAI adapters,
a client that resolves the custom HIP-5 records and supports the selected
transport/session path (including an isolated gateway if needed), and the creator
wallet site plus Sui/Ika/Aeneid testnet flow. CloudConvert joins this list only
if selected for conversion. Verify readiness independently, then prove them
together; substituting a fake verdict or a pending-registration bypass does
not satisfy the existing first-release contract.

The implementation must prove one real run through steps 1-7, safe interrupted
resume, no duplicate community/post/registration, provider failure refusal,
retrieval after reload, and restoration of its configuration from Infisical.
A local fixture run, a registry rehearsal, a published static shell or a passing
CLI wallet delegation is not that result. This document is the corrected plan;
it performs no deployment or provider/key operation.

Current primary references:
[Alchemy Cloudflare](https://alchemy.run/cloudflare/),
[Alchemy secrets](https://alchemy.run/cloudflare/security/secrets-env),
[Cloudflare custom-domain requirements](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
[Infisical secrets management](https://infisical.com/platform/secrets-management),
and [Filecoin Pin](https://github.com/filecoin-project/filecoin-pin).
