# HNS community ingress

app.tld is a required first-song target. Reuse the maintained HNS gateway
architecture before inventing another ingress. The earlier centralized product
already served app.8s28 through a DNSSEC/DANE gateway in the Handshake phone
app. That establishes a usable starting point, not acceptance of this new stack.

## Request path and trust

The intended route is an HNS-capable client validating Handshake/DNSSEC and the
TLSA certificate-key binding, then HTTPS to the selected gateway, then an
authenticated HTTPS request to the community's Cloudflare Worker origin.
Alchemy owns the Worker, D1, R2 and jobs. It does not automatically deploy or
control that separate HNS TLS endpoint. Cloudflare custom domains require an
active Cloudflare zone; an HNS delegation alone does not satisfy that condition.

DNS publishes the TLSA binding to a certificate key, not a substitute ordinary
certificate-authority certificate. The selected client must implement this
trust path. Ordinary browsers use the separate conventional HTTPS origin.
A redirect to that origin is not same-origin app.tld acceptance.

The gateway terminates TLS and can read or alter the requests, responses,
session cookies and application code passing through it. The client-side
resolver/proxy is also part of the trust path. Cloudflare and the community
Worker operator remain trusted on the origin side. A community running its own
Worker while using Pirate's gateway still depends on Pirate for this ingress.

The wizard must record the gateway operator separately from the community and
moderation operators. Pirate-hosted ingress is the shortest proposed first
integration because it reuses the existing operated design. An independently
operated gateway needs a reproducible package, its own TLS/DNS/forwarding key
custody, renewal and monitoring. Neither mode is selected or deployed by this
document; the setup must show and persist the actual choice.

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
The historical host addresses are not installation defaults; use the current
owned gateway inventory and release procedure at implementation time.

## Remaining first-song integration

Implement the authority adapter against verified HNS delegation, app ownership,
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
cover the Worker/storage/job side. Neither reference establishes native
Handshake-name onboarding into Cloudflare; this plan uses the existing HNS
gateway boundary instead.
