# Community web client: static release and IPFS mirror slice

This is the first slice of the browser client specified in
[docs/community-web-client.md](../../docs/community-web-client.md). It builds
one application release plus a snapshot of public pages for a fixture
community, packs them into a deterministic CAR, and tests the result through
an offline IPFS subdomain gateway and a local canonical fixture host.

Everything it shows is fixture data, labelled as such in the data and in the
rendered pages. It has no sign-in, no wallet, no community service and no
provider upload. It is a separate npm project with its own lockfile and is not
part of the repository's root install or checks.

## Commands

Install Node.js 24, Docker, and Chromium for `@playwright/test` 1.63.0
(`npx playwright install chromium`).

```sh
npm ci --ignore-scripts
npm run typecheck
npm test                    # unit tests
npm run build               # dist/site, dist/car, dist/host, dist/budget.json
npm run test:e2e            # needs the build; starts Kubo and the fixture host
npm run check:reproducible  # two clean builds of the committed tree
```

`npm run build` fails when the initial JavaScript exceeds 100,000 bytes gzip
or when the frozen document stylesheet changes.

## What the build produces

`dist/site` is the CAR's content. The release owns `/app`: the unhashed
`/app/boot.js` loader, hashed assets, the client shell for client-only routes,
and `/app/release.json`, which lists the source commit, protocol and document
versions, entry, and every release asset's SHA-256. The snapshot owns the
rest: the generated community and post pages, the removal and not-found
documents, `/public/document-v1.css`, the snapshot data under `/public/data`
that mirror navigation reads, the community configuration copy at
`/.well-known/pirate-community.json`, `_redirects`, and
`/public/snapshot.json`, which digests the snapshot files.

`dist/car/car.json` records the root CID, the CAR's SHA-256 and the packing
settings. Packing uses the IPIP-499 `unixfs-v1-2025` profile, so another
implementation can recompute the same root: Kubo 0.43.1, under that profile,
reproduced it. The release manifest cannot contain its own digest or the CID
of the CAR around it, so both live in `car.json`.

`dist/host/_headers` holds the primary-host response headers in the
Cloudflare Workers Static Assets format. It is host configuration and is not
in the CAR: an IPFS gateway is not bound by it. Generated pages carry the
mirror policy in a meta element instead, which cannot express
`frame-ancestors`.

## Routing and statuses

Generated pages are files, so every host serves them before redirect rules.
`_redirects` then maps a removed post to a content-free tombstone with a real
410, maps the client-only route `/about` to the shell with 200, and gives
every other missing path a real 404. There is no catch-all 200 fallback.
IPFS gateways evaluate `_redirects` only on subdomain or DNSLink origins, so
the mirror tests use Kubo's subdomain gateway, not a path gateway.

## Modes

The client is canonical only on the configured canonical origin. On any other
origin it is a read-only mirror. It reads only the snapshot, makes no session
or mutation request, and links sign-in and actions to the same path on the
canonical origin. In canonical mode it reads `/api/public/*` and the
snapshot shipped with the same release in parallel. Each read is bounded to
four seconds and aborted when navigation moves on, so a stalled API never
blanks the page. It also checks `/api/session` without delaying public
content.

A per-page record store keeps the newest revision of the community and of
each post, whichever source delivered it. A removal is itself a revision, so a
failing API, an older snapshot or a lagging source cannot bring removed or
superseded content back. Navigation renders the stored record at once and
replaces it only when a newer revision arrives. A generated community or post
page is replaced after mount only when the current record is newer than the
page's `data-revision`. Every view follows changes to its record in the
store, whichever read delivered them, and an unchanged view is not rebuilt,
so focus survives. Content that no source could return shows an
"unavailable" state rather than "not found". The API's 404 counts as
authoritative and is remembered, so the snapshot's copy cannot reappear
during a later outage; the snapshot's 404 is not authoritative.

One limit is deliberate. On the canonical origin a post removed after
publication can show its snapshot body until the API answers, up to the
four-second bound, which is the same exposure the generated page itself has
until the client reconciles it. Reads join the caller's abort signal and the
timeout by hand, so no browser needs `AbortSignal.any`. Mirror action links are built on the
canonical origin with any leading slashes or backslashes collapsed, so a
`//other.example` path cannot redirect them. The read interface is in
[src/model.ts](src/model.ts). Sign-in buttons are present but disabled:
cookie sessions belong to the community service, which this slice does not
change.

## Design-system packaging

`@pirate/web-solid-ui` and the patched Kobalte tarball are vendored from
pirate-web-solid at c7cb8783. [vendor/PROVENANCE.json](vendor/PROVENANCE.json)
records the sources, digests, the one manifest transformation, what a
consumer must supply, and why `package.json` overrides align the Solid
runtime and compiler closure with the upstream lockfile.
`scripts/vendor-solid-ui.sh` rebuilds the tarballs byte for byte.

## Document versions

`src/document/content.tsx` is the markup contract for document version 1, and
`/public/document-v1.css` is built only from it and the solid-ui components it
renders. `document-versions.json` freezes that stylesheet's digest. A markup or
class change therefore needs a new document version, as contract section 3
describes, and cannot restyle published pages by accident.

## Contract rows

This slice exercises, against fixture data and local hosts only:

- P1: a generated post page shows its content and preview metadata with
  JavaScript disabled.
- P3: a stale post or community page is replaced after mount, and so is a
  post removed after publication. A known removal survives a later API
  outage, and an older or equal record leaves the generated page in place.
- P4, structurally: the client build and the page generation are separate
  outputs. It is not a separately deployed publisher.
- A6: a mirror offers no sign-in and links actions to the canonical origin.
- S1: public content renders while `/api/session` is slow or the API is down.
- S3: the build fails above the initial JavaScript budget, measured over the
  boot loader, entry, static imports and inline script.
- D1: two clean builds reproduce the release manifest, CAR and root CID.
- D5, on the fixture host only: the generated headers are served.
- L1, partly: `?lang=ar` gives an RTL interface while content keeps its own
  direction. The test checks the result after load, not paint order.

It does not claim P2 or P5 (publication jobs and migration races), A1 to A5
(sessions), K1 to K4 (karaoke), L2, L3, S2, S4, D2 to D4, D6 or D7. In
particular, nothing has been uploaded to Filebase, Filecoin or any other
provider, and no registry content record has been set.
