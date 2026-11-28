# Pirate operators

Pirate operators is the standalone, pre-launch implementation of independently operated Pirate communities. It contains the Solid community client, Linux/Web2 installation path, Worker services, MegaETH testnet contracts, publication pipeline, and local acceptance harness.

The current product authority is the [Web2 release and optional HNS delivery plan](docs/self-hosting/checkpoint-1-pilot-delivery-20261114.md). The first invited pilot is deliberately narrow: a fresh Linux host, ordinary HTTPS, automatic community enrollment, plain member sign-in, one owner-published song, playback, and persistence through an ordinary restart. HNS is optional later attachment work, not a registration or gas prerequisite. Study, Karaoke, Dance, the shared feed, and rewards are expanded Web2 scope. Spaces are deferred beyond the MVP; Nostr is not product scope.

This is testnet software for disposable data. Nothing here is production qualified, backup/restore is unavailable in the pilot profile, and selected-host acceptance remains open even where source and hosted CI are green. Do not use real funds, production credentials, mainnet chain IDs, or irreplaceable content.

## Repository layout

- `apps/web` — Solid community client and static/IPFS release tooling.
- `apps/community-wizard` — operator setup wizard for the Linux/Web2 journey.
- `apps/creator-spike` — isolated creator-wallet testnet spike; not a pilot dependency.
- `services` and `packages` — community runtime, publication, learning, media, reward, and protocol implementation.
- `contracts` — MegaETH application contracts and interfaces.
- `deploy` — Linux installation and ingress packaging.
- `docs` — current contracts, deferred designs, evidence, and archived lane history; start with [docs/README.md](docs/README.md).
- `harness` and `test` — local integration and acceptance harnesses.

## Development

Use Node.js 24.15 or a later Node.js 24 release, Foundry 1.9.0, and ffmpeg/ffprobe. The root integration tests also require a pinned Caddy 2.11.9 executable, private `TMPDIR` scratch space, and a private `PIRATE_TEST_RUN_PARENT` directory under `/run`. `.github/workflows/local.yml` contains the verified Caddy download and hash-check commands; the required executable SHA-256 is `a563843e11cbce39c557bd429ebb787d56f49d51d9bbb3292cd9b36b37a60cdf`.

From the repository root, the unsharded local check is:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix apps/web
npm ci --ignore-scripts --prefix apps/community-wizard
forge build
(
  set -eu
  runtime_dir=${XDG_RUNTIME_DIR:?XDG_RUNTIME_DIR must be set}
  case $runtime_dir in
    /run/*) ;;
    *) echo "XDG_RUNTIME_DIR must be under /run" >&2; exit 1 ;;
  esac
  if [ ! -d "$runtime_dir" ] || [ ! -O "$runtime_dir" ] || [ ! -w "$runtime_dir" ]; then
    echo "XDG_RUNTIME_DIR must be a writable user-owned directory" >&2
    exit 1
  fi
  TMPDIR="$(mktemp -d)"
  PIRATE_TEST_RUN_PARENT="$(mktemp -d "$runtime_dir/pirate-root-tests.XXXXXXXX")"
  export TMPDIR PIRATE_TEST_RUN_PARENT
  PIRATE_CADDY_BINARY=/path/to/caddy \
  PIRATE_CADDY_SHA256=a563843e11cbce39c557bd429ebb787d56f49d51d9bbb3292cd9b36b37a60cdf \
  npm run check
)
```

If `XDG_RUNTIME_DIR` is absent, provision a user-owned mode-0700 directory under `/run` and use that path in place of `$runtime_dir`. Do not use a root-owned parent for the ordinary local check.

Hosted CI does not run that unsharded command in its network namespace. It runs four root-test shards through `harness/ci/run-root-tests.mjs`; each shard creates both private scratch directories inside the namespace. The CI-shaped command for one shard is:

```sh
TEST_SHARD=1/4 \
PIRATE_CADDY_BINARY=/path/to/caddy \
PIRATE_CADDY_SHA256=a563843e11cbce39c557bd429ebb787d56f49d51d9bbb3292cd9b36b37a60cdf \
sudo --preserve-env=PATH,HOME,TEST_SHARD,PIRATE_CADDY_BINARY,PIRATE_CADDY_SHA256 \
  unshare --net bash -c '
    set -euo pipefail
    ip link set lo up
    TMPDIR="$(mktemp -d)"
    PIRATE_TEST_RUN_PARENT="$(mktemp -d /run/pirate-root-tests.XXXXXXXX)"
    export TMPDIR PIRATE_TEST_RUN_PARENT
    node harness/ci/run-root-tests.mjs
  '
```

Set `TEST_SHARD` to `1/4`, `2/4`, `3/4`, or `4/4`. The shard runner writes `.local/root-tests-<shard>.xml`. The image-runtime container probe is a separate scoped CI job, not part of those root shards.

The root check runs TypeScript, root integration tests, Solidity tests, and the repeatable acceptance harness. Hosted CI additionally runs the Web, Study, Karaoke, Wizard, and Creator suites before `release-ready` can pass. Local acceptance uses real handlers, cryptography, WebSockets, SQLite persistence, and Anvil; external providers and payment services are explicit simulations. Fixture keys are public test material only.

## Current documentation

- [Documentation index](docs/README.md)
- [Web2 release plan](docs/self-hosting/checkpoint-1-pilot-delivery-20261114.md)
- [Linux Web2 first-song installation](docs/self-hosting/linux-web2-first-song.md)
- [Hosted Wizard contract](docs/web2-onboarding-linux-wizard.md)
- [Application contract inventory](docs/contracts/inventory.md)
- [First-song runtime](docs/first-song-runtime.md)
- [Owner-only MegaETH song publication](docs/megaeth-song-publication.md)

Alchemy.run owns selected managed Cloudflare resources; Infisical is the service-secret source. Use `cf` for diagnostics only where it does not change Alchemy-owned resources. Do not add Wrangler configuration.

PROVENANCE.json records copied source provenance. There is no runtime dependency on api-next or the previous React application. No license grant has been added to this repository.
