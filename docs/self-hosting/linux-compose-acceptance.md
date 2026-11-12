# Linux community delivery acceptance

This maps the required Linux delivery behavior to evidence that implementation must produce. It is not an executed acceptance report. The source baseline is 3d21abf6bc2b0e32b6126fe0aef39faacaf1287d; each later run must bind its exact source, images, configuration and selected feature profile. The [delivery contract](linux-compose-delivery-contract-v1.json) and [service inventory](linux-compose-service-inventory.md) define the composition and remaining choices.

## Required scenarios

| ID | Operator scenario and required behavior | Evidence needed |
| --- | --- | --- |
| L01 | A fresh operator follows the supported Linux bootstrap, starts the versioned deployment and reaches browser setup without repository knowledge or undocumented commands. | Exact Linux/architecture, Docker/Compose and image digests; complete documented commands; actual clean-host execution and browser capture. |
| L02 | Create selects hosting, community/public address, primary controlled-TLD import with separate authority proof, features, required credentials, storage/backups and review/deploy. Technical IDs are generated/discovered, verified profiles reused and spending explained. | Actual complete browser journey, saved/verified/ready states and feature-specific credential requests. Hosting an SLD must not infer control of its TLD or bind issuance to that hosting namespace. |
| L03 | Deploy launches the real community app and selected operator/managed/processing services. Saved Learning settings reach an actual deployment. Unsupported compositions stay unavailable with a reason. | Built entrypoints and assets, exact selected migrations, complete service graph, readiness checks and actual service requests. A setup placeholder or an infrastructure health response is insufficient. |
| L04 | An operator and learner authenticate through real HTTPS, use the community, publish/use media under selected policy and play decoded media in a browser. | Host-bound cookies/session/CSRF behavior, actual server handlers and storage, playable media, route refresh and relevant positive/refusal evidence. A Request reconstructed as HTTPS over HTTP does not prove browser TLS or cookie behavior. |
| L05 | Stop and restart every application and state service; acknowledged data, identities, media, sessions subject to policy, jobs, budgets and configured services remain consistent. | Process identities, complete stop/start, durable-store and namespace metadata, database integrity and actual application readback. Restart does not prove power-loss durability. |
| L06 | Interrupt upload, processing, delivery and external-effect boundaries. Reconcile and resume the same operation without duplicate effects or changing identity to escape uncertainty. | Actual persistent job/outbox/lease journals, injected interruption/lost replies, restart recovery, duplicate delivery and bounded cleanup. An in-memory diagnostic queue is insufficient. |
| L07 | Apply a supported runtime/schema upgrade and exercise failure/recovery. Preserve acknowledged state, constraints and pending operations. | Exact source/image/schema versions, migration outcome, interrupted-upgrade state, recoverability and reconciliation. Image rollback alone does not reverse database changes or external effects. |
| L08 | Make an encrypted recoverable backup and restore through browser setup on a distinct clean host/VM with independent storage. | Original/down/uploaded/restored bytes and hashes, separate recovery key, version/namespace/config identities, consistency boundary, restoration order, login/use/playback readback and job recovery. No shared original state directory or provider metadata may be required to recover archive contents. |
| L09 | Failed setup/deployment can be corrected and retried safely. Explain the actionable error and retain the same deployment identity until uncertain effects are reconciled. | Corrected configuration, read-only reconciliation, journal transition and actual successful retry. A saved secret is not a verified service, and verified infrastructure is not whole-app readiness. |
| L10 | Selected feature combinations have complete services, migrations, privacy/retention and recovery behavior. Unselected features request no unrelated credentials. | A supported profile matrix and actual per-profile checks, including managed publication, Learning/Karaoke audio, optional creator, private media/Dance and Telegram wherever selected. Verify every upstream provider and credential owner; a provider-independent label requires qualified alternatives, not only a local container. |

## Recovery inventory

The backup/restore contract must cover application SQL and migration ledger; object bytes and metadata; Durable Object namespaces, object identities and alarms; queue delivery, outboxes and leases; uncertain external-effect journals; session/revocation state; configuration history; grants and operator budgets; setup/deployment journals; recoverable secret references/stores; and HTTPS certificate keys.

Choose and document a consistent cross-store snapshot boundary and restoration order. Define handling of stale sessions and revocations explicitly before accepting restored sessions. Reconcile existing signed or uncertain external effects before allowing new writes. Do not claim that public chain data reconstructs private account mappings, grants or pending work.

Public Filebase IPFS media, private objects and encrypted backups are separate roles. A pinning token is not S3 credentials. A successful upload, object name or client construction does not prove encryption, bucket privacy, retention or recoverability. Backups must recover from authenticated archive bytes and a separate key.

## Supported scope

The release must identify the Linux distributions/architectures, engine/runtime/backend pairing, image versions and persistent-state compatibility actually exercised. Empty support fields in the proposed contract mean unqualified, not universal compatibility. Akash is a separate later qualification. Current experimental native workerd/localDisk and development-derived backend probes do not establish a supported production matrix.

Primary controlled-TLD import remains separate from the application's hosting origin. This contract establishes no authority over parent or sibling names and does not select namespace-free community bootstrap. Ordinary HTTPS application acceptance does not establish general Handshake/DNSSEC/DANE/registry-browser acceptance; that requires its own real resolver/browser proof without a special client implementation.

## Existing supporting evidence

The [storage boundary](../storage-provider-boundary.md) validates role profiles and a Node Files SDK transport against real SDK protocol fixtures. It does not replace the application's R2 bindings or complete L01 through L10. Native component diagnostics are supporting qualification inputs; complete runtime and recovery evidence must be bound to the actual selected deployment.

This independently owned community application contains its Solid frontend, decentralized API, MOSS and local cookie-session issuer. Earlier centralized implementations supply behavior and pure-source provenance, not required runtime containers. Keep the actual owning entrypoints and session boundary explicit in the deployment contract.
