# Community web client and deployment contract, version 2

This document specifies the browser client for an independently operated
community and the way it is deployed. It is a design contract for later
implementation. Nothing described here is built yet, apart from the local
behaviour recorded as current state.

The [restored operator protocol](operator-protocol.md) supplies section 7
sign-in and section 8.2 ticket requirements. This document completes their
browser cookie and handshake behavior. The current payment contract owns
payment fields and does not change the browser key boundary. The [current setup overview](decentralized-setup.md) owns the chain and
provisioning direction: Alchemy.run, Infisical, MegaETH, app.tld and the
operator's first song. Customer name purchase and Telegram attachment are later. OperatorPayments purchases replace the original draft payment
fields; the active payment specification owns those fields. No cross-chain
simulated payout is required. Browser session and handshake rules follow this
version-2 amendment.

The [signup and domains amendment](community-signup-and-domains.md) permits
Web2 only, HNS only, or both. Web2 is optional. Solid renders the client; every
enabled verified application origin serves its own same-origin API and
host-bound session over the same community data. Public reading never depends
on login. Generic IPFS mirrors remain read-only; this revision does not enable
credentialed cross-origin browser sessions. A preferred origin is a sharing
preference, not a forced redirect from another enabled origin.

Spaces is deferred beyond the decentralized community MVP. Wizard v1 starts
on ordinary HTTPS as an engineering slice, with HNS as a follow-up. Web2 is
optional product configuration, not a prerequisite for HNS-only communities.
A namespace picker may
show a disabled "Spaces — Coming
soon" option, with no promised date, setup form or provisioning action. It must
not request Spaces keys or funds or block supported setup. The
[MVP namespace scope](decentralized-setup.md#mvp-namespace-scope) also requires
the configuration/API boundary to reject unsupported Spaces setup before any
external effect. Cloudflare Containers feasibility is later engineering work,
not part of the wizard's customer-facing deployment choices.

## 1. Sessions and sign-in

At each enabled application origin the application and its API share
`https://<community-host>`, with the API under `/api`. Static hosting does not
require bearer tokens. The browser session is a cookie:

```text
Set-Cookie: __Host-community_session=<opaque>; Path=/; Max-Age=<seconds>; Secure; HttpOnly; SameSite=Lax
```

The `__Host-` prefix makes the browser refuse the cookie unless it is Secure,
has `Path=/` and has no `Domain`, so it stays host-only. The value is 256
random bits. The server stores only its SHA-256 and the session record:
wallet, community, exact application origin, creation time and expiry. Session
lookup checks that origin as well as the community. A valid cookie copied from
another enabled origin is refused. The trusted ingress route map supplies the
public origin; unknown hosts and untrusted forwarding headers are rejected.

- Lifetime follows the draft's 30 days. The cookie always carries `Max-Age`.
  Without `Max-Age` or `Expires` it would be a browser-session cookie, deleted
  when the browser closes, whatever the server record says. `Max-Age` is the
  number of seconds left until the server record expires, so the browser never
  keeps the cookie longer than the server honours it.
- At sign-in the server record expires in 30 days and `Max-Age` is 30 days.
  Any authenticated request in the second half of that period extends the
  record to 30 days from now. It re-sends the cookie with the new remaining
  lifetime. Sign-in always issues a new value and never reuses a previous one.
- Logout is `POST /api/session/logout`. It deletes the server record. It also
  clears the cookie by sending the same name, `Path` and attributes with an
  empty value and `Max-Age=0`. Deleting the record ends the session in every
  other tab too.
- An expired or unknown session returns 401 `session_required`. The client
  switches to its signed-out state. Public content stays on screen.
- Every request with a method other than GET, HEAD or OPTIONS must carry an
  `Origin` header exactly equal to this request's validated public origin,
  and a JSON content type. A missing or different Origin is refused with
  403 `origin_refused`.
  When `Sec-Fetch-Site` is present it must be `same-origin`. SameSite=Lax is a
  second layer, not the CSRF defence.
- The API never answers credentialed cross-origin requests:
  `Access-Control-Allow-Credentials` is never sent.
- No credential is kept in browser storage: no session value, token or wallet
  secret goes into localStorage, sessionStorage, IndexedDB or the Cache API.
  The karaoke attempt key in section 2 is a non-extractable WebCrypto key held
  only in memory for that attempt.

Non-browser clients, such as the headless harness, a CLI or a bot adapter,
may use explicitly signed requests or a bearer token from a separate
non-browser flow. The browser client never does. A cross-origin browser client
is out of scope here. If it is added later it needs its own design, for
example signed requests or tokens with a stated audience. It must not reuse
the cookie.

Sign-in binds the signature to the page's real origin. With Sign-In with
Ethereum (EIP-4361), `domain` is the host of the page origin and `uri` is that
origin with the `https` scheme. EIP-4361 asks wallets to compare `domain`
with the origin that requested the signature. The server checks `domain` and
`uri` against this request's validated enabled origin and refuses any mismatch.
The nonce is bound to that origin and community, is single-use and expires
after five minutes. A nonce or signature from another enabled host is not valid
here. Sign in independently at each origin to reach the same wallet/community
persona; do not transport a cookie or login token between domains. The same
origin rule applies to the challenge format the MOSS wallet uses; the MOSS
spike establishes that exact format.

The local skeleton differs. It builds SIWE with an `http://` URI, which is
acceptable only on loopback. It returns a bearer token in the JSON response
body, and later requests send that token in the `Authorization` header. A
hosted deployment replaces both.

A generic IPFS mirror (section 6) never offers sign-in. Each authenticated
action links to the same path on an enabled application origin from the
community configuration; in HNS-only mode that is the HNS origin. An explicitly
verified HNS application origin is not classified as a mirror. Other interactive
content-addressed origins still require their own accepted-origin, wallet and
session design. Revoking an application origin invalidates its sessions, login
nonces and sockets; the other origin and community records remain intact.

## 2. Karaoke attempt connection

Section 8.2 of the restored operator protocol stays the authority: an issuer-signed ticket naming
the participant, the operator and a per-attempt browser key, and a signed
response to the operator's connection challenge. Browser WebSockets cannot
attach an `Authorization` header, and a cookie for the community origin is
never sent to an independent operator. So the ticket travels inside the
socket, in the first message.

The local skeleton differs in four ways that this contract corrects:

- the session key is a secp256k1 address, where the draft specifies the RFC
  7638 thumbprint of a P-256 key;
- the browser proves the key by signing the fixed text `connect:<ticketId>`
  and sending it in the URL query, so the proof never changes and appears in
  logs;
- the operator checks no Origin;
- the community delivers the ticket to the operator in a server-to-server
  `/prepare` call, which verifies the issuer signature, before the socket
  opens. The browser then presents only the ticket ID. In this contract the
  browser presents the signed ticket itself in the first message, and the
  operator verifies it at that point.

The handshake is:

1. The browser generates a non-extractable ECDSA P-256 key pair. It asks the
   community, with its session cookie, for a ticket bound to the thumbprint of
   the public key. The community applies section 8.1 and returns the signed
   ticket.
2. The browser opens `wss://<operator>/attempt` with the subprotocol
   `pirate-karaoke.1`. The URL carries no ticket, proof or other secret.
3. Before upgrading, the operator applies its Origin allowlist. It cannot yet
   know the ticket's community, because the ticket arrives after the upgrade.
   The allowlist is the union of the origins that each community it serves
   lists in its configuration. A request whose `Origin` header is not on the
   allowlist gets 403. The operator records the `Origin` value with the socket.
   A request with no `Origin` header comes from a non-browser client and passes
   this step.
4. After the upgrade the operator sends
   `{ "type": "challenge", "nonce": <32 random bytes, base64url>, "expiresAt": <ms> }`
   with a ten-second deadline.
5. The browser sends exactly one message:
   `{ "type": "hello", "ticket": <signed ticket>, "publicKey": <JWK>, "signature": <base64url> }`.
   The signature is ECDSA P-256 with SHA-256 over the JCS encoding of
   `{ "purpose": "pirate-karaoke-connect/1", "ticketId", "operator", "nonce" }`.
6. The operator verifies, in order:
   - the issuer signature, and that the issuer is the key configured for that
     community;
   - if an `Origin` was recorded in step 3, that it is listed for the verified
     ticket's `communityId`, not merely for some community this operator
     serves;
   - that `operator` is itself;
   - that `notBefore <= now < expiresAt`;
   - that the JWK thumbprint equals `sessionKey`;
   - that the signature covers this socket's nonce;
   - that the manifest can be served.

   It then creates or resumes the attempt
   (`attemptId = sha256(ticketId)`, as in section 8.4) and sends
   `{ "type": "ready", "attemptId", "resumed": <bool> }`.
7. Performance frames are accepted only after `ready`. The attempt ends at
   `expiresAt` or at `maxDurationMs`, whichever comes first, with the outcomes
   of section 8.4.

Authorization comes only from the verified ticket and the challenge signature.
An accepted Origin is defence in depth for browsers. It never authorizes on
its own, and its absence never bypasses steps 5 and 6.

Every refusal after the upgrade sends `{ "type": "error", "code" }` and closes
the socket:

| Close code | Error code | Cause |
|---|---|---|
| 4400 | `protocol_error` | malformed message, or a frame before `ready` |
| 4401 | `invalid_ticket` | bad issuer signature, wrong community or wrong operator |
| 4403 | `wrong_session_key` | thumbprint or challenge signature mismatch |
| 4406 | `origin_mismatch` | the recorded Origin is not listed for the ticket's community |
| 4408 | `hello_timeout` | no valid `hello` before the challenge deadline |
| 4409 | `ticket_conflict` | the same ticket ID with a different ticket body |
| 4410 | `expired_ticket` | outside `notBefore` to `expiresAt` |
| 4422 | `manifest_unavailable` | the operator cannot serve the manifest |

A reconnect repeats steps 2 to 6 with a fresh nonce. The same ticket with the
same key resumes the attempt; a different key is refused, as section 8.4
requires.

## 3. Public HTML and the application

There are two separately deployed artifacts. An application release is the
versioned static client (section 6). Content publication writes HTML documents
for public pages into the community's object storage. Publishing, editing or
removing a post never rebuilds the application, and an application release
never regenerates content.

The publisher generates the community page and one page per post. Each page
contains the visible content (title, text, author handle, song title and cover
image), share metadata (Open Graph title, description, image and canonical
URL), and `lang` and `dir` for the content language. Telegram and X preview
crawlers read this HTML; they do not run the client. The markup comes from
pure presentational Solid components rendered to strings at publication time.
Content and locale messages are passed in explicitly, with no context,
fetching or browser globals. Where reuse is impractical a plain template is
acceptable, but the components stay the source of the markup and classes.
The client never hydrates this markup.

Ownership of the document is fixed:

| Region | Owner | Rule |
|---|---|---|
| `<main id="public-content">` | publisher | written at publication; the client does not modify it while the page is the entry document |
| `<div id="app-shell-root">` | client | empty in generated HTML; the client mounts header and navigation here with `render` |
| `<div id="app-actions-root">` | client | empty; the client mounts the post's interactive controls here |
| `<link href="/public/document-v<N>.css">` | publisher | the immutable stylesheet for the page's document version; no release replaces it |
| `<script src="/app/boot.js">` | release | a small, unhashed, short-cache loader that imports the current release's hashed entry |

Solid's `render` creates new nodes inside an empty root. It does not adopt
existing markup. The client therefore mounts only into the empty roots above.
When the reader navigates away from the entry page inside the client, the
client deliberately replaces `#public-content` with its own route view and
owns that region from then on. Returning to the post renders the client's own
post view from data, not the generated HTML.

Generated pages outlive releases. They are not regenerated when the client
changes. Each page therefore records `data-document-version`, the version of
its markup contract: the region IDs and data attributes above, the classes in
its markup, and its stylesheet. A page refers to only two files outside its
own content: the boot loader, and the stylesheet for its document version. It
never links a release's hashed assets. An upgrade therefore cannot restyle old
markup or delete files that old markup needs.

Each `release.json` lists the document versions its client can mount on.
Making a release current, including by rollback, is refused unless it supports
every document version that is still published. A new document version goes
through these steps in order:

1. Publish the new version's stylesheet.
2. Release a client that supports both the old and the new version.
3. Set the publisher's target document version to the new version. From then
   on every publication, edit and removal generates under it.
4. Run a migration: one job for each published page still on the old version.
5. Remove the old version from later releases once no published page uses it.

The old stylesheet stays until no published page refers to it.

Publication rules:

- Generation is an idempotent job keyed by community, post, content revision
  and document version. A content job runs after the post record commits and
  uses the publisher's current target version. A migration job comes only
  from a migration run in step 4. It names the page's current content revision
  and the new target version. The post is visible in the client immediately;
  the public page follows.
- A removal is itself a content revision, and its document is a tombstone.
- Each stored document carries its content revision and document version. A
  write replaces it only when the job's pair is newer:
  - either the content revision is higher;
  - or the revision is the same and the job is a migration job with a higher
    document version.

  A job with a lower revision, or a lower or equal document version at the
  same revision, is stale or a duplicate. It is dropped without writing.
- Before rendering, a migration job re-reads the post record. If the revision
  has moved past the one it names, the job is stale and is dropped. The newer
  content job renders that revision under the target version.
- The comparison and the write are one atomic conditional update on the
  stored document, for example a conditional put on its ETag. On a conflict
  the job re-reads and re-evaluates. Newer content or a tombstone can
  therefore never be overwritten by an older migration.
- A failed job leaves the previous document in place and retries with backoff.
- An edit regenerates the page under its new revision and purges cached copies.
- A removal replaces the page with a minimal 410 tombstone that carries none of
  the removed content or metadata, purges cached copies and updates the
  community page. A migration also moves tombstones to the new version,
  under the same rules.
- Each page records `data-revision` and `data-generated-at`. After mounting,
  the client reads the current post record. If the revision differs, or the
  post was removed, it replaces `#public-content` with the current view or a
  removal notice.
- Generated pages are served with a short shared cache lifetime (60 seconds)
  and are purged explicitly on edit and removal.

## 4. Localization

Three language settings stay separate:

- interface language selects the client's own strings;
- content language is an attribute of each post and community, set by its
  author or community, and appears as `lang` and `dir` on that content;
- song and scoring language is an attribute of the song revision and scoring
  policy. It is never derived from the interface language, so switching the
  interface to Arabic leaves lyric matching and transcription unchanged.

Protocol values such as states, error codes, handles, identifiers, amounts and
chain values stay canonical in data, storage and signatures. They are
localized only when displayed.

The interface language is resolved in this order: an explicit `?lang=` value,
the saved preference, `navigator.languages`, the community's default language,
then English. An explicit choice is saved in localStorage; a language
preference is not a credential. This differs from the centralized client,
which never persists the locale because the server reads `Accept-Language` on
every request. A missing message falls back to the community default, then to
English.

Generated HTML ships the community default's `lang` and `dir` on the document.
A small inline boot script resolves the interface language and sets `lang` and
`dir` before the client mounts, so a right-to-left interface does not first
render left-to-right. The security policy allows that script by its hash. The
content region keeps its own `lang` and `dir`, so content direction does not
follow the interface.

Messages are written with plural and select forms and compiled at build time.
Formatting uses `Intl.PluralRules`, `Intl.NumberFormat`, `Intl.DateTimeFormat`
and `Intl.RelativeTimeFormat`. `Intl.PluralRules` picks the category; the
catalog supplies the translated text for each category. While the startup
catalog is small, all supported languages are bundled with it. Larger route
catalogs are split by language once a measurement shows a benefit.

Layout uses logical CSS properties only. User-generated text, handles and
names inside localized strings are isolated with `dir="auto"` or `<bdi>`.
Icons that imply direction mirror in right-to-left. Menus, tabs and lists are
checked for keyboard order and arrow-key behaviour in right-to-left.

Components copied from the centralized client move their hard-coded text into
catalogs during the copy. Most centralized component files do not use
catalogs yet.

## 5. Startup

After the HTML is parsed, three tracks run independently:

```text
HTML + locale script  -> readable public content
                      -> cached public feed shown, network refresh in parallel
                      -> session check (GET /api/session)
user action           -> wallet, composer, karaoke or reward module loads on demand
```

Public reading never waits for the session check. A failed or slow session
check leaves the reader signed out with content visible. Signed-in controls
appear when the check resolves.

The public cache is keyed by community. Private cache entries are keyed by
community and account. Logout or an account change clears that account's
private entries and aborts its in-flight requests. Each request carries the
community and account generation that issued it, and late results from an
older generation are dropped.

The wallet SDK, verification widgets, recording and audio code, transaction
and chain-write code, and QR generation are loaded only on demand. They are
never part of the public reading path.

The provisional initial JavaScript budget is 100 KB gzip. It counts everything
loaded without user action on a public page: the boot loader, the entry, its
static imports, preloaded modules and inline scripts. On-demand modules do not
count. The client build fails above the budget. Each release candidate gets
one recorded measurement on a mid-range Android phone over a throttled mobile
profile, using Core Web Vitals' "good" thresholds as targets: largest
contentful paint at most 2.5 seconds on a generated post page and interaction
to next paint at most 200 milliseconds. The cached feed helps returning
readers only, so the measurement uses a cold cache. There is no separate
benchmark suite.

## 6. Deployment contract

| Mode | Operated by | Origin | Sign-in | Data |
|---|---|---|---|---|
| Community deployment | the community, or Pirate for a community it hosts | verified Web2, HNS or both application origins | separate host-bound cookie sessions | the same community API, storage and keys |
| Independent installation | another operator, from the same release format | its own selected application origins | that community's origin-bound sessions | its own API, storage, keys and configuration |
| IPFS mirror | anyone pinning a release | a gateway origin | none; links to an enabled application origin | a snapshot of public pages |

An application release consists of:

- `release.json`, listing the release version, source commit, supported
  protocol versions, supported document versions, entry path, and every asset
  path with its SHA-256;
- content-hashed, immutable assets;
- build instructions pinned to the lockfile and toolchain, so the same commit
  rebuilds to the same asset hashes.

The same signed community configuration is served at
`/.well-known/pirate-community.json` from every enabled application origin.
Version 2 uses `pirate.community-config/2` as specified in the
[origin configuration amendment](community-signup-and-domains.md#4-wizard-and-alchemy-domain-management).
It holds:

- the community ID, access mode, preferred origin, exact typed application origins and same-origin API base (`/api`);
- supported protocol versions;
- the default and supported languages;
- chain IDs and contract addresses;
- the ticket issuer and feed signing keys;
- the origins operators accept for this community;
- known mirrors.

Authenticated transport to a verified application origin delivers the
configuration, whose bytes and revision must match the controller-authorized
directory reference. The community feed key signs it for aggregators and
mirrors. A manifest alone cannot authorize a new origin or its own signer.
HNS origin authentication follows the [ingress contract](hns-community-ingress.md).
When the client does not support configuration v2 or shares no protocol version,
it shows public content read-only and explains that a newer client is required.
Do not interpret v2 as a v1 canonical-origin manifest for authentication.

Each release's hashed assets are retained for at least 30 days after it is
superseded, for tabs that are already open. Generated pages do not depend on
them, because they refer only to the boot loader and their document-version
stylesheet (section 3). Document-version stylesheets, and any image or media a
published page refers to, are retained for as long as any published page
refers to them. A rollback repoints `/app/boot.js` and the current
`release.json` to an earlier release. It never needs a rebuild. It is refused
if the earlier release does not support every published document version.

Routing uses paths. Requests for generated documents are served from storage.
`/api/*` goes to the community service. Any other path without a file falls
back to the client shell. Cloudflare Workers Static Assets supports this
pattern, a single-page-application fallback with selected paths routed to the
Worker first. Cloudflare is the first host, provisioned by Alchemy.run, but the artifact
remains plain static files that any static server can serve. Hash routing is
an opt-in build only for a read-only mirror whose gateway cannot rewrite deep
links. Such a mirror cannot serve per-post preview pages, because the
fragment never reaches the server.

Every enabled application origin sends these security headers:

- `Content-Security-Policy`:
  - `default-src 'self'`;
  - `script-src 'self'` plus the boot script's hash;
  - `connect-src` limited to the origin and the configured operator, RPC and
    wallet origins;
  - `frame-src` limited to the configured wallet origin;
  - `frame-ancestors 'none'`;
  - `base-uri 'none'` and `object-src 'none'`.
- `Strict-Transport-Security`.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: strict-origin-when-cross-origin`.
- `Permissions-Policy: microphone=(self)`, for karaoke.

A mirror that cannot set headers carries the policy in a meta element. Meta
policies cannot express `frame-ancestors`, which is another reason mirrors
stay read-only.

An IPFS mirror contains one immutable release plus a snapshot of the public
pages. Path gateways put every site on one shared origin, so mirrors are
published for subdomain or DNSLink gateways. Even so, an ordinary HTTPS
gateway is trusted to serve the right bytes unless the reader verifies the
content. A stable DNSLink name keeps one origin across releases. It does not
let different gateway hostnames share storage or credentials. A CID guarantees
integrity, not availability. A mirror counts as published only when two
independent pinning services or nodes hold it and two different gateways
retrieve it. Its CID is recorded in the community configuration's mirror list,
because a release cannot contain its own CID.

An independent installation needs more than these static files. Remaining
work:

- deploy the community service and its storage: session and record state,
  object storage for media and generated pages;
- generate and hold the community's keys, with documented recovery;
- install secrets through the host's secret store;
- back up records and objects, with a tested restore;
- rebuild public pages from records after a restore.

The plan so far proves container portability only for the operator service,
and only partially. Recovering a complete community stack from another host
is unproven, and a second Cloudflare installation does not prove it.

## 7. Renderer decision

Solid is the selected renderer. It is client-rendered, with no request-time
server rendering and no hydration. Server rendering survives only as
publication-time HTML (section 3). The reasons are its small browser runtime,
fine-grained updates, and the existing centralized components, Storybook and
design files.

The comparison that informed this was narrow. Equivalent three-button
counters were bundled for production with Bun and with esbuild:

- the Solid 2 rc.16 sample was about 13 KB gzip. It was hand-written in the
  form the Solid compiler emits, so it bypassed a real JSX pipeline;
- the Foldkit 0.170 sample, on Effect 4.1, was about 214 to 221 KB gzip,
  depending on whether it used Foldkit UI's button.

These are sizes of samples. They are not framework minimums or application
sizes, and no device load times were measured. Foldkit's explicit commands,
cancellation, resource management and inspectable transitions are real
strengths. The bundle cost and the existing Solid work decided it.

The client starts on the combination the centralized client already runs and
tests:

| Package | Version |
|---|---|
| `solid-js` and `@solidjs/web` | 2.0.0-rc.0 |
| `@solidjs/router` | 2.0.0-next.16 |
| `@solidjs/vite-plugin` and `vite-plugin-solid` | 3.0.0-next.27 |
| `vite` | 8.3.1 |
| `@kobalte/core` | 2.0.0-alpha.0 at a892187, the centralized client's patched vendored tarball |
| `tailwindcss` | 4.3.3 |

Moving to a newer Solid release candidate is a separate change. That change
must pass the client's checks and the copied components' tests. Nothing
tracks the newest release candidate automatically.

Boot, session, sign-in, ticket handshake and reward claim are written as plain
TypeScript state machines, tested without the DOM, like the machines in
`packages/protocol`. XState is added only where its actors or inspection
tooling are needed.

## 8. Acceptance matrix

These checks belong to the implementation tasks that follow. None has run.

| ID | Check | Method |
|---|---|---|
| A1 | The session cookie is `__Host-`, Secure, HttpOnly, SameSite=Lax and host-only. It carries `Max-Age` equal to the server record's remaining lifetime at sign-in and on renewal, and survives a browser restart | automated against the local service |
| A2 | An unsafe request with a missing or foreign Origin is refused with 403 `origin_refused` | automated |
| A3 | Logout ends the session in every tab and clears the cookie with `Max-Age=0`; an expired session shows public content signed out | automated browser |
| A4 | After sign-in, no credential appears in localStorage, sessionStorage, IndexedDB or the Cache API | automated browser |
| A5 | A sign-in message whose domain or URI differs from the request's verified origin is refused; a nonce, signature or copied cookie from the other enabled origin is refused | automated |
| A6 | A mirror shows no sign-in and links authenticated actions to an enabled application origin, including HNS in HNS-only mode | automated against a mirror build |
| A7 | Both enabled origins share one community/persona/content state with independent sessions; unknown hosts and spoofed forwarding headers fail | automated browser and trusted ingress |
| A8 | HNS-only setup requires no ICANN domain or public Web2 alias and login never redirects to one; the actual HNS client completes the flow | wizard and actual client acceptance |
| A9 | Revoking an origin ends its sessions/nonces/sockets without changing the NFT or the other origin; unsupported config v2 stays read-only | automated |
| K1 | The handshake reaches `ready`, and a reconnect with the same key resumes | automated, real WebSocket |
| K2 | A missing `hello`, a replayed challenge signature, a wrong key, an expired ticket or a conflicting ticket closes with the listed code | automated |
| K3 | An Origin outside the allowlist gets 403 before upgrade. An allowed Origin without a valid ticket is refused. An Origin allowed only for community A that presents community B's ticket closes with `origin_mismatch` | automated |
| K4 | No ticket or proof appears in any URL | automated, request logging |
| P1 | A generated post page shows its content and preview metadata with JavaScript disabled | automated browser |
| P2 | An edit regenerates the page, a removal serves the 410 tombstone, and a failed job keeps the previous page | automated |
| P3 | A stale page is replaced by the current view after mount | automated browser |
| P4 | A content publish does not rebuild the client, and a client release does not regenerate content | automated |
| P5 | A post at revision 7 on document v1 migrates to v2 without a content change. With the migration job for (7, v2) racing an edit to revision 8, and racing a removal, in both orders, the stored document ends as revision 8 under v2: the edited page or the tombstone. A repeated (7, v2) job, a (7, v1) job after migration and a (7, v2) job after revision 8 are all dropped without writing | automated |
| L1 | An Arabic interface has `dir="rtl"` before the first paint; English content inside it keeps its own direction | automated browser |
| L2 | Plural and select messages are correct in Arabic for 0, 1, 2, 3, 11 and 100 | unit |
| L3 | Changing the interface language does not change the song or scoring language | automated |
| S1 | Public content renders while `/api/session` is failing or slow | automated browser |
| S2 | An account switch clears private caches and drops late results | automated browser |
| S3 | The client build fails above the 100 KB gzip initial budget | build check |
| S4 | One cold-cache measurement on a mid-range Android phone meets the section 5 targets | manual, per release candidate |
| D1 | Rebuilding the release commit reproduces `release.json` hashes | automated |
| D2 | An unchanged post page published under release N still renders with its styles and mounted controls after an upgrade to N+1 and after a rollback to N. Both moves need no rebuild. Making current a release that lacks a published document version is refused. Superseded hashed assets stay available for 30 days | automated against a test host |
| D3 | A second installation runs the same release with its own configuration, keys and storage | manual, testnet |
| D4 | An IPFS mirror is held by two pinning services and retrieved from two gateways | manual |
| D5 | The security headers in section 6 are present on the primary deployment | automated |
| D6 | The community loads over its HNS route in the intended resolver and browser setup, kept separate from the HTTPS test-domain results | manual |
| D7 | A post link shared in Telegram shows its card and opens in the Telegram in-app browser on iOS and Android | manual |

## 9. Remaining implementation work

The client does not exist yet. The community service still uses bearer tokens,
an `http://` SIWE URI and local debug routes. The operator still uses the fixed
`connect:<ticketId>` proof in the URL, with a secp256k1 session key. The
publisher and generated pages, the boot loader, the release manifest,
community configuration, the budget check and every row of the matrix remain
to be built. So do the backend and storage work for a complete independent
installation, and mirror authentication if it is ever wanted.
