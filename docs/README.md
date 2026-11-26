# Pirate operators documentation

This index is the reading entry point. Documents in the active surface are either current contracts or current implementation/runbook references. Documents under `deferred/` are approved or retained future work and must not be read as pilot scope. Documents under `archive/` are point-in-time evidence, lane handoffs, superseded designs, repair notes, and review records; they are preserved for provenance and are not maintained as current documentation.

Spaces and Nostr are not product scope. Historical documents in the archive may mention them because they record earlier exploration; those mentions do not describe the current product.

## Release authority and pilot path

Start here. When another document conflicts with these, the release plan wins.

- [Web2 release and optional HNS delivery plan](self-hosting/checkpoint-1-pilot-delivery-20261114.md) — authoritative scope, checkpoints, service responsibilities, funding policy, storage limits, and acceptance boundaries.
- [Hosted Wizard contract](web2-onboarding-linux-wizard.md) — current operator onboarding behavior and remaining implementation joins.
- [Linux Web2 first-song installation](self-hosting/linux-web2-first-song.md) — native Linux installation profile and host evidence.
- [Linux runtime foundation candidate](self-hosting/linux-foundation-v1.md) — foundation Compose/runtime boundary.
- [Linux Compose service inventory](self-hosting/linux-compose-service-inventory.md) — service inventory and ownership boundaries.
- [Linux Compose acceptance](self-hosting/linux-compose-acceptance.md) — acceptance contract for Compose delivery.
- [Managed first-song services](self-hosting/managed-first-song-services.md) — managed publishing, recognition, and admission service composition.
- [Pirate-hosted enrollment](self-hosting/pirate-hosted-enrollment.md) — invited enrollment and capped initial-gas service.
- [Paired Web2 operator signing](self-hosting/web2-operator-signing.md) — controller/owner signing and publishing review boundary.
- [Canonical community service transport](web2-canonical-service-transport.md) — authenticated service transport.
- [Web2 first-song runtime adoption](web2-first-song-runtime-20261115.md) — application/runtime adoption record.

## First-song publication runtime

- [First-song runtime](first-song-runtime.md) — current runtime state, recovery, publication ordering, and provider boundaries.
- [Owner-only MegaETH song publication](megaeth-song-publication.md) — active owner-publication contract.
- [Owner-curated first song](owner-curated-first-song.md) — owner-curated policy and moderation deferral.
- [Owner-curated rollout](owner-curated-rollout.md) — rollout evidence and limits.
- [Managed first-song service](managed-moderation-first-song.md) — managed admission service behavior and retained history.
- [First-song configuration bootstrap](configuration-bootstrap-first-song.md) — configuration transaction evidence and recovery constraints.
- [MegaETH testnet deployment](megaeth-testnet.md) — testnet deployment evidence and rerunning constraints.

## Contracts and protocol surfaces

- [Contract boundary index](contracts/README.md) — contract ownership and selection rules.
- [Application contract inventory](contracts/inventory.md) — current source inventory, retained predecessors, and exclusions.
- [Web2-first Directory V3](contracts/community-directory-v3.md) — current directory foundation.
- [Community posts V1](contracts/community-posts.md) — publication records and revisions.
- [Publication consent V1 and learning results V5](contracts/publication-consent-v1.md) — inactive separate-consent foundation.
- [Dance V2 publication admission](self-hosting/dance-v2-publication-reader.md) — publication admission reader boundary.
- [Publication consent application boundary](self-hosting/publication-consent-application.md) — application API boundary for future consent.
- [V5 command journal foundation](self-hosting/v5-command-journal-foundation.md) — journal foundation, not an enabled feature.
- [Operator payments](operator-payments.md) — payment specification retained for operator billing.

The remaining files in `docs/contracts/` are narrower specifications for retained directories, media publication, feed indexing, governance accounts, listing authority, migration, learning records, assessments, rewards, and historical source boundaries. Read the inventory first so retained and inactive contracts are not mistaken for selected deployments.

## Browser application

- [Community web client and deployment contract](community-web-client.md) — browser session, mirror, static publishing, localization, and deployment contract. Its service-custody and second-community acceptance rows are older design context; the release plan and current Wizard documents govern the present pilot.
- [apps/web README](../apps/web/README.md) — implemented builds, commands, packaging, and current test boundaries.
- [Storybook catalog](../apps/web/docs/storybook-catalog/README.md) and [coverage map](../apps/web/docs/storybook-catalog/coverage-map.md) — component catalog rules and gaps.
- [Community wizard README](../apps/community-wizard/README.md) — operator-facing wizard contract and development commands.
- [Creator spike README](../apps/creator-spike/README.md) — isolated deferred test spike, not a pilot dependency.

## Evidence and review records

`docs/evidence/` and `docs/review-checkpoint-20261114/` contain immutable point-in-time review evidence. They are not operational instructions. JSON evidence under `docs/deployments/` is not Markdown and therefore is not indexed here, but it remains the cited deployment evidence for the first-song documents.

## Deferred design shelf

[deferred/README.md](deferred/README.md) indexes creator-wallet, HNS, learning-results, reward, alignment, storage, and protocol-expansion designs. These documents are retained because they describe approved future directions or historical test spikes. None is a first-song pilot prerequisite.

## Archive

[archive/README.md](archive/README.md) indexes the archived CI records, lane handoffs, implementation contracts, incident notes, superseded designs, Telegram lanes, study coordination records, and unselected proposals. Archive documents are preserved read-only as history. Do not update them to look current and do not treat their status claims as present-tense product truth.

## Maintenance rules

A current document must describe present scope or an explicit future contract without relying on stale pull-request status. Immutable evidence must keep its original meaning and be moved or clearly marked rather than rewritten as current. When implementation status changes, update the smallest current document and this index; do not duplicate volatile status across broad design documents.
