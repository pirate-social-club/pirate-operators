# Linux Compose service inventory

This inventory describes the community implementation at commit `3d21abf6bc2b0e32b6126fe0aef39faacaf1287d`. It prepares Linux delivery; it does not establish a supported image, operating-system matrix or complete deployment. The [versioned delivery contract](linux-compose-delivery-contract-v1.json) records the graph and open choices. The [acceptance map](linux-compose-acceptance.md) defines the required evidence.

## Application ownership

This community owns its Solid frontend in `apps/web/src/live`, HTTP API in `services/community-application.ts`, and cookie-session issuer in `packages/community/accounts.ts`. The existing packager builds `apps/web/dist/live` and bundles that application entrypoint. It retains the decentralized backend and MOSS account model.

The community [web-client contract](../community-web-client.md), [account portability contract](../community-accounts-portability.md) and [application shell](../v1-shell-interface-v1.md) describe this boundary. Earlier centralized applications supply behavior and pure-source provenance; they are not required runtime services for this deployment.

## Complete service graph

| Component | Existing source | Delivery and state requirements |
| --- | --- | --- |
| Community app and assets | `services/community-application.ts`, `harness/community-package.ts`, `apps/web/vite.live.config.ts` | Real fetch/queue/scheduled handlers, built Solid assets, complete selected migrations and all required bindings. |
| Community identity | `services/first-song-profile.ts`, application configuration/public-read composition | Replace fixed disposable deployment composition with validated community inputs across origin, history, public reads, managed routing, queue dispatch and recovery. Preserve community, signer, profile and authority checks. |
| SQL | D1-based community repositories; `apps/community-wizard/infra/application-alchemy.run.ts` | Selected migration ledger, private accounts/sessions, configuration, journals and feature state. Choose and qualify the production backend/runtime pairing. |
| Objects | R2 bindings in actual community handlers | Private bytes, metadata, checksum/ETag/range behavior, capability identity and loss/retry reconciliation. The Node Files SDK factory is not an R2 replacement. |
| Delivery and scheduling | `communityQueue`, `communityScheduled`; managed-service queue/scheduled handlers | Durable intent, retries, duplicate handling, leases, outboxes, recovery and retention scheduling. An in-memory diagnostic queue is insufficient. |
| Learning and Karaoke | `services/karaoke-audio-runtime.ts`, `services/speech-budget.ts`, `harness/study-operator-package.ts` | The default worker exports its audio implementation as ServiceState for STATE and SpeechBudget for SPEECH_BUDGET. Include audio/operator processes, internal bindings, public WebSocket routing, object/namespace identity, SQLite state, alarms, budgets and pending operations. |
| Managed publication | `services/managed-moderation.ts`, `harness/managed-package.ts`, `apps/managed-moderation/alchemy.run.ts` | Separate DB, objects, jobs, scheduler, grants, pairings and provider journals. An external service must remain an explicit verified dependency if it is not packaged. |
| Creator registration | `apps/creator-spike/src/worker.ts`, `harness/creator-package.ts` | Conditional database, wallet and external-chain services. Owner-only unregistered publication does not require the creator service. |
| Private media and Dance | `services/community-private-dance.ts` and its renderer/authority ports | Default application dependencies do not construct this composition. Include its processor, queues, review state and recovery when selected. |
| Telegram | `services/telegram-connected-community.ts`, `telegram-connected-mount.ts`, `telegram-alarm.ts` | Native SQL/transactions/alarms, authority wiring, outboxes and privacy/retention recovery. The mount remains a proposal without a selected live entrypoint. |
| Browser setup and deployment control | `apps/community-wizard/server/start.ts`, `provision.ts`, `state.ts`, `learning-setup.ts` | Trusted host runner, authenticated browser control, persistent settings/deployment journals and safe interrupted-deployment reconciliation. |
| HTTPS, secrets and backups | Target-specific composition remains to be implemented | HTTPS/certificate recovery, separate secret scopes, consistent encrypted snapshots, recovery keys and second-machine restore. |

No Cloudflare Workflows binding or `WorkflowEntrypoint` was identified in this graph. External registration workflow contracts are conditional chain dependencies; they are not a portable Cloudflare Workflows implementation.

## External services and credential ownership

The following dependencies exist at this source baseline. Credentials stay in
separate server-side scopes; these names describe ownership, not values to
store in browser state or fields to request universally.

| Capability | Current provider or service | Credential owner and community setup behavior |
| --- | --- | --- |
| Existing Cloudflare deployment recipes | Cloudflare Workers, D1, R2 and Queues | The deployment runner holds Cloudflare account access. The Linux target needs its own runner implementation; the current wizard still requires Cloudflare access for Deploy. |
| Managed moderation and publication | ACRCloud identification, OpenAI moderation, Filebase IPFS pinning | The managed service owner holds ACRCLOUD_ACCESS_KEY/SECRET, OPENAI_API_KEY, FILEBASE_IPFS_TOKEN and MODERATION_SIGNER_PRIVATE_KEY. A community using an existing verified service supplies its connection/pairing and authorization, not those upstream provider keys. Operating an independent service requires its owner to supply them. |
| Learning/Karaoke operator | ElevenLabs speech and the selected chain | The operator holds the ElevenLabs API credential and operator signing key; the application holds its separately scoped issuer/publisher signing material. Resolve server secret references for the selected mode rather than exposing keys in browser state. |
| Setup secret management | Selected trusted HTTPS Infisical instance | The setup runner uses scoped CLI or machine authentication. An operator-operated instance remains a separate deployment/recovery dependency; a saved connection is not verification of recoverability. |
| Configuration, public reads and smart-account signature verification | MegaETH RPC and IPFS transport | The baseline uses its selected public chain and content-access profiles. These are network dependencies even when a hosted API key is unnecessary. Independently operated access needs actual configuration and qualification. |
| Registered creator publication | Conditional Story Aeneid RPC/workflow and creator wallet services | The selected service owns its wallet/registration credentials. Owner-only unregistered publication excludes this creator/registration service and its credentials. |
| Public media pinning | Filebase IPFS | The selected publishing service owns the pinning token. It is distinct from private object or backup credentials. |
| Private objects and encrypted backup transport | Filebase object storage by default where appropriate; B2/custom S3 alternatives | The community storage/backup service resolves explicit S3 access/secret credentials in its own scope. The current Node boundary is not already wired into application R2 bindings. |
| Optional Telegram | Telegram bot/API and public OIDC linking | The selected Telegram service owns its bot credential and protected authority wiring. This composition remains unavailable until connected and qualified; it is not a prerequisite for an unselected feature. |

The concrete provider requirements are visible in
apps/managed-moderation/alchemy.run.ts, the Learning deployment recipe,
apps/community-wizard/server/infisical-auth.ts, the default application
composition and packages/community/registration-chain.ts. Existing managed
services retain their upstream dependencies even when communities do not hold
the upstream credentials.

A provider-independent profile needs qualified replacements for proprietary
APIs used by its selected features, plus independently operated protocol access,
storage and recoverable secrets. No complete such profile is qualified here.
Container packaging alone does not replace OpenAI, ACRCloud, ElevenLabs or the
other service dependencies listed above. Keep these as explicit delivery gaps.

## Existing bootstrap gaps

The current wizard's provisioner copies a setup-only worker and migration `0001`, then invokes the Cloudflare Alchemy stack. That worker reports setup progress; it is not the complete community application. Saved Learning configuration remains review-only and reports deployment unavailable. Its binding helper refuses a fresh profile with `fresh_learning_requires_distinct_resource_recipe`; the existing recipe attaches existing testnet operator resources.

A Linux package must use the actual application and selected services. Renaming existing resources, serving the setup placeholder, or constructing a storage client cannot establish successful community deployment.

The application artifact boundary is `harness/community-artifacts.ts`. It bundles the real current application and inventories supplied live assets, selected migrations and owned-source provenance without predecessor deployment state or provider commands. The caller must first produce the real live assets. The source root must be the approved canonical Git worktree with a complete owned client inventory; archive copies, ancestor repositories and ambient Git redirection cannot supply provenance. The manifest also binds the migration-selection implementation. `harness/community-package.ts` retains Cloudflare release selections, Alchemy checks, fixed resources, provider state and authenticated prepared-package custody. Private temp and distinct empty npm configurations must be supplied to its genuine child build commands with HOME unchanged; actual toolchain and child behavior still require qualification.

## Profile selection and dependencies

Use `harness/package-migrations.ts` for migration selection. Owner publishing requires rewards; V4 requires owner publishing; reward closure and media require V4; Dance requires media and reward closure. The selected migration list and service graph must agree. Source presence does not activate an optional capability.

Request credentials only for selected capabilities. Saved credentials, verified services and application readiness are separate states. Record every required external provider or chain dependency rather than implying that self-hosted infrastructure removes them.

Keep hosting origin separate from primary controlled-TLD import and authority proof. A community may run at an SLD while issuing under another controlled namespace. Hosting alone supplies no parent or sibling issuance authority and does not select namespace-free community bootstrap. General Handshake/browser acceptance remains a separate real resolver/browser qualification.

## Storage and recovery

Keep three distinct roles: public Filebase IPFS pinning, private object storage and encrypted backups. Retain CID/pinning semantics; pinning tokens are not S3 credentials. Filebase defaults where appropriate, with B2/custom S3 alternatives and a self-hostable option. Transport construction supplies neither encryption nor privacy/recoverability proof.

Current profiles require HTTPS except on literal localhost/loopback. A Compose address such as `http://object-store:9000` fails that boundary. Use a compatible HTTPS endpoint or qualify a separately reviewed policy change.

Recovery must cover SQL/migration state, object bytes/metadata, namespaces/object identities, alarms, queues/outboxes/leases, uncertain-effect journals, sessions/revocations, configuration history, grants/budgets, wizard/deployment state, secret-store recovery and HTTPS keys. Define a consistent snapshot boundary and restore order. Image rollback cannot reverse schema migrations or external effects.

## Recommended qualification composition

Investigate the real workerd app/operator graph on a supported Linux host, with persistent SQL/object services, durable delivery/scheduling, a Node setup/backup runner and HTTPS ingress. This is a qualification candidate, not a supported production configuration.

Earlier native workerd/localDisk and development-derived backend probes establish limited component behavior. Production-supported storage/runtime pairing, upgrades, complete feature compositions and second-machine recovery remain open. Select actual supported Linux architectures and versions from evidence; Akash is a separate later qualification.

Artifact extraction still bundles the existing fixed community composition. It does not supply a fresh-community recipe, a supported Linux runtime or backend, or actual live-asset equivalence evidence. Validated community composition and complete runtime, wizard and recovery integration follow. Documentation and adapter tests do not complete the delivery.
