# HNS community ingress

app.tld is required when HNS access is selected. Web2 is optional under the
[signup and domains contract](community-signup-and-domains.md). First prove that the intended client
can resolve the actual HIP-5 delegation and use its records. An HTTPS gateway
is one transport option after that lookup, not a substitute for it or a
requirement imposed by the registry contract.

## Contract resolution before transport

The TLD owner publishes the HIP-5-style NS target
`<registry-address>.<chain-id>._evm.` through Bob. For this testnet the chain
is 6343. The active app name's holder or record manager sets its records in
the SLDRegistry contract. Publishing the gateway IP and TLSA directly in a
TLD's signed DNS zone describes the earlier centralized setup, not this
contract delegation. A compatible resolver reads the Handshake referral,
verifies the configured registry/state and returns the holder's records.

HIP-5 defines an extension mechanism. Support for some HIP-5 protocols does
not establish support for our custom `._evm` format, MegaETH chain or registry
ABI. An unextended HNS resolver can return the special referral without
performing its EVM lookup. The extension may live in the browser or its
resolver; the browser process need not make every chain request itself.

At pirate-registry 296c97d, packages/resolver parses this delegation and checks
manifest code, registry identity, active ownership, expiry and pinned block
freshness. The contract stores arbitrary keyed bytes, but the resolver's typed
DNS codecs cover A, AAAA, CNAME and TXT only. contenthashKey exists; resolveName
does not return contenthash. TLSA/HTTPS codecs and content loading remain work,
not functionality established by a generic record-storage slot.

The resolver labels its EVM source local-rpc or remote-rpc. Hash-pinned reads
and code checks do not turn an RPC into a light-client proof. A client using
contract TLSA data must authenticate that state under its declared trust model;
it cannot assume the old DNSSEC chain also authenticates synthesized EVM
answers. Handshake SPV verification establishes the TLD delegation side.

At fetched Freedom main 44e189a5, inspection of src and package metadata found
no adapter for this delegation or dependency on pirate-registry. Its shipped
fingertipd source pin 21f044eb has no such adapter in its Go sources. Existing
ENS, IPFS and DNSSEC/DANE support does not prove this route. This is a scoped
source finding, not a browser test or a claim about every HIP-5 implementation.
The Handshake phone app's custom-protocol support remains unverified here.

## Transport choices and trust

For HTTPS at app.tld, the selected client/resolver must authenticate the address
and TLSA binding; an endpoint must possess the matching private key and serve
HTTP. DNS resolution alone does not teach an ordinary browser to validate TLSA;
a DANE-aware client or a trusted local TLS proxy must enforce that step.
An HNS TLS gateway can be that endpoint and forward to an authenticated
ordinary HTTPS Worker origin. Alchemy owns the Worker, D1, R2 and jobs. The
separate TLS endpoint needs its own deployment, custody and health checks.
Cloudflare's custom-domain active-zone requirement does not by itself provide
an HNS endpoint. No native app.tld Cloudflare route is established by this audit.

The gateway terminates TLS and can inspect or alter the pages, requests and
cookies it handles. A shared Pirate gateway therefore keeps Pirate in that
traffic path. A community-operated endpoint need not use Pirate's gateway or
centralized name database. Shared hosting needs authenticated onboarding and
an origin mapping, and must refuse unconfigured hosts; the directory remains
a discovery requirement, not the authority that makes contract records valid.

If HTTPS gateway transport is chosen, reuse the maintained Caddy/DANE design.
Pirate-hosted operation is a proposed first implementation, not an inherent
HIP-5 requirement. Use a separate milestone instance, listener, configuration,
credentials and origin mapping. Do not change the production gateway, its
names, authority backend or routes serving the live product to test the new
adapter. An operator-run package can follow, with explicit key recovery,
renewal and monitoring. This document authorizes no gateway deployment.

For content-addressed transport, a capable client can use the name's content
record to fetch and verify the static Solid application from IPFS. That may
avoid an HNS HTTPS frontend gateway. IPFS hosting does not make JavaScript
read-only: it can call an HTTPS API for login, uploads and posting. A live API
still runs on Cloudflare, with origin isolation, session and CORS/CSRF rules
that the selected client must actually support.

The amended browser contract accepts each explicitly verified HTTPS application
origin with its own same-origin API and origin-bound session. HNS-only access
requires no ICANN application domain or Web2 login redirect. Generic IPFS mirrors
remain read-only; a content-addressed authenticated client still requires separate
origin/wallet qualification. Cross-origin cookies and browser bearer tokens are
not enabled by this amendment. A redirect to an ordinary HTTPS domain proves
navigation, not same-origin app.tld use. Cloudflare, wallet, RPC and gateway
availability remain dependencies; HNS naming alone does not prove censorship
resilience. Test the actual client and network before claiming it works.

## Evidence and limits

The retained staging acceptance records a phone run on 2026-10-09 from
05:04:58 to 05:06:18 UTC. app.8s28 loaded, membertest.8s28 returned its profile
with status 200 twice, a claimed name on the other root opened, and an
unclaimed name under 8s28 returned 421. The previous evening's failure was
recorded as the phone's Handshake peer-sync failure, not a successful page test.

The source evidence is the staging package
archive/hns-wildcard-aaaa-https-compat-test-2026-10-08/staging-zone-adoption/README.md,
section "Phone check of the final state", with captures phone-30 through
phone-34 and phone-8s28-metrics.txt under evidence-final. The control-plane task
api-hns-existing-root-zone-adoption records the operation and its limits.
This is historical staging evidence; no live route was probed for this audit.

The maintained api-next source at
f017e8014001a31d07b9e2de891e0907ad194b50 contains the Caddy DANE terminator,
interactive gateway, immutable deployment manifests and protected origin
forwarding under apps/hns-platform-gateway. The relevant operations contracts
are ops/README.md and ops/COMMUNITY.md within that application. Those files
have no diff between the inspected checkout and fetched origin/main.
They bind the gateway to centralized authority queries, forwarding credentials
and paired Worker consumers. They are design/source evidence, not a package
that already reads the decentralized registry.

The old acceptance did not exercise the new MegaETH SLD registry, shared
community directory, MOSS login, creator-wallet site, or first-song upload.
The historical host addresses are not installation defaults. Reuse source and
release procedures in the separate milestone instance, preserving production.

## Remaining first-song integration

First select and qualify one real client against the actual `_evm` referral,
contract records and chosen content/HTTPS transport, including its secure origin.
Then prove same-origin login, API access and first-song upload at the selected
HNS application origin without a forced Web2 redirect. A CLI
registry ceremony or the old DNS-zone browser test cannot replace this proof.

For a selected shared HTTPS gateway, implement the authority adapter against verified HNS delegation, app ownership,
community configuration and lifecycle state. A factory event alone must not
admit a host. Preserve fail-closed unknown-host behavior and reject a stale or
repointed authority. Reuse the protocol and owned source without importing a
frozen application or its authentication runtime.

Package the selected gateway mode and bind it to the Alchemy-managed origin.
Preserve SNI/Host validation, strip untrusted forwarding headers, authenticate
the gateway-to-origin boundary and keep Origin/CSRF checks. Prove host-only
secure cookies, the wallet login/callback origin, API requests, upload limits,
media retrieval and any required WebSocket path from the actual HNS browser.
The separate creator-wallet site's passkey/RP origin must remain its own
specified boundary; a working HTTPS gateway does not prove passkey support.

Repeat positive and negative browser acceptance on the new deployment: a
verified app opens and posts, unknown hosts fail, invalid DNSSEC or a wrong
TLSA key is refused, and reload/retry preserves the correct session and post.
Keep DNS/SLD expiry, gateway outage and provider failure visible. Provisioning
must resume safely and retain the receipts needed to reconcile each service.

Cloudflare's current [custom-domain requirements](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
confirm the active-zone prerequisite. [Alchemy's Cloudflare resources](https://alchemy.run/cloudflare/)
cover the Worker/storage/job side. Neither reference establishes native Handshake-name onboarding into Cloudflare.
The [HIP-5 specification](https://hsd-dev.org/HIPs/proposals/0005/) requires a
compatible external resolver. IPFS documents [origin isolation for apps](https://docs.ipfs.tech/how-to/best-practices-for-ipfs-builders/)
and [API-origin effects](https://docs.ipfs.tech/how-to/websites-on-ipfs/custom-domains/).

## c22 observation, 2026-11-04

The new MegaETH registry is 0xe56E25eAf86FB8BF641754Fd7918735B98851744.
Its Handshake UPDATE f860ac4676d3a0c2107fc52755267064a069fd0a0dfce348e09713453aa2a024
was recorded included at height 354290. The owning watcher expects SPV
verification from height 354324. At 12:24 UTC, a read-only NS query to the
existing local hnsd still returned the prior chain-84532 delegation; the
latest logged hnsd height was 354312 and no verification receipt existed.
Thus the update was already submitted, while resolver acceptance remained
pending. Do not issue another UPDATE merely because the old answer is cached
or the SPV node has not reached its verification threshold. Recheck the owning
lane's receipts and actual referral before using c22 for browser acceptance.
