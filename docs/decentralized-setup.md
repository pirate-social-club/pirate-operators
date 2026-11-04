# Community setup to first song

Owner direction, reconciled 2026-11-04: the first milestone is a disposable
managed-mode community on ordinary HTTPS, one real admitted and registered song,
and direct-feed playback after a fresh-browser reload. Interrupted work resumes
without duplicate charges, registrations or posts. Verified discovery and native
app.tld/browser acceptance are later gates. Sponsored customer names, HNS browser
access and karaoke remain outside this milestone.

Alchemy.run owns Cloudflare provisioning, and Infisical is the service-secret
source. PR 15 supplies a provisioning wizard with separate live recovery evidence;
it does not implement the song application. Main includes payments, learning
records and the account-design specification. The application account migration,
managed moderation, publication jobs and live upload-to-playback path remain work.

## MVP namespace scope

Owner decision, 2026-11-04: Spaces support is deferred beyond the decentralized
community MVP. The separately admitted wizard v1 starts on ordinary HTTPS;
HNS configuration and verification are an optional follow-up for that slice.
This deferral adds no HNS prerequisite to wizard v1. Native-address acceptance below is a separate follow-up to the ordinary-HTTPS
first-song milestone. Native
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
wizard requirement; the provisioning implementation remains on PR 15.

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

## First-song setup prerequisite

The first-song integration coordinator arranges a separate disposable managed-
mode community before directory/posts qualification and records setup ownership,
fixed settings and evidence in the task register. That community is not yet
provisioned. Select its own TLD and deployment/access settings before the first
deployment attempt; wizard v1 does not migrate a deployed setup to new settings.
Use separate resource names, private Alchemy state and the approved credential
workflow. Managed communities receive scoped service pairing, not provider keys.

The community operator creates and administers a dedicated registry clone through
the verified shared factory. The wizard does not perform that transaction.
Record the clone, factory/implementation profile, admin and publisher in the
reviewed setup manifest. The contracts lane qualifies the permanently unlisted
disposable directory/posts profile using this registry, not c22's, and supplies
its addresses, ABIs and deployment manifest. The MegaETH clone transaction uses
the existing approved operator test-funding workflow with a finite budget.
HNS delegation is unnecessary for this unverified direct-feed test.

Keep c22 independent for storage/job acceptance. Its provider placeholders are
not a managed-service configuration or evidence of real checks. Do not switch
its mode. Pair the new community to the managed service, prove capped operator-
funded creator activation and actual admission, then run the complete song path.
A further community is a later repeatability check after that journey passes.

## Native-address follow-up

| Step | Wizard responsibility | Completion evidence |
| --- | --- | --- |
| 1. Select namespace and operator | Verify current TLD control, select community ID and public origins, and choose Pirate-hosted or independent service operation. | Bound TLD/operator identity and explicit deployment account; no secrets in public configuration. |
| 2. Prepare the name registry | Reuse a verified MegaETH factory; create the TLD registry with NOT_FOR_SALE, reserve app to its intended holder, set app's premium to zero, register it, and configure other selected names. | Verified code and receipt, app owned by the intended holder, selected reservations/prices read back. |
| 3. Save secrets and provision services | Save required provider/service credentials to the right Infisical scope. Alchemy provisions Workers, D1/migrations, R2, job transport, bindings and public ingress. | Secret versions installed without logging values, migrations applied, health and storage checks pass. |
| 4. Make app.tld work | Build the Solid release, publish the chosen static artifact, set the holder-authorized app records, have the TLD owner sign the HIP-5 delegation/update, and qualify the actual client's registry lookup and chosen HTTPS/content transport. Use an isolated gateway only if that transport needs one. | Independent HNS-to-registry-to-app lookup and an actual load, login and API request in the intended browser. An ordinary HTTPS alias is tested separately. |
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
The first operator can pay its own bounded setup gas. Normal user onboarding,
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

The trusted provisioner uses the operator's existing Infisical CLI login by
default; an existing scoped machine identity is an unattended option. It reads
only the selected scope and supplies secrets to Alchemy's protected bindings. Infisical is the recoverable source of
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
systems. The former exists in pirate-registry. The latter is required for this
happy path and is not implemented yet. Its deployment/update interface must be
built; this requirement is not dismissed because HNS already owns name authority.

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

HNS app.tld is a required acceptance target, not shorthand for a workers.dev
URL. Cloudflare custom domains require an active zone; publishing HNS records
does not itself establish a Cloudflare zone, ordinary DNS resolution or trusted
TLS. Identify and test the actual HNS-capable browser/resolver/gateway and its
secure-origin/session behavior. Keep an ordinary HTTPS origin available for
ordinary browsers, but do not count that alone as app.tld acceptance. A redirect
proves navigation only; it must not be reported as same-origin app.tld operation.
For later native-address acceptance, start with the
[HIP-5 client and transport proof](hns-community-ingress.md). These checks do
not gate ordinary-HTTPS first-song acceptance.
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

At merged payment baseline 4aaf76e, _redeem accepts the signed recipient and
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
retains the configured canonical session/API origin; alternate gateways are
read-only snapshots under the current browser contract. IPFS-hosted JavaScript
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

This integration merges main 4aaf76e into guidance ba36312 without rewriting
published history. Main includes payment PR 14, learning-record PR 18 and
account-design PR 20. The [payment document](operator-payments.md) matches the
merged baseline with exact [source provenance](payment-specification-source.json).
The restored protocol's encoding, evidence and publication-gate sections remain
byte-identical to their recorded recovery hashes. Joining follows reviewed
PR 12's Very-only rule; publishing an admitted song does not require membership
or its provider proof.

Wizard PR 15 at 1151a8b, creator spike PR 13 at a9810cc and directory/posts
PR 17 at a64ae9d remain separate source and acceptance boundaries. Their task
records distinguish provisioning/recovery, the creator browser pilot and local
contract tests from full first-song acceptance. The new managed community,
registry clone, contracts deployment, provider run and playback are not claimed
by this source integration. Consult the current task register and refresh exact
refs before executing any live step.
