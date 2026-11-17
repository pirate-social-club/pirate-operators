# Publication consent application boundary

The application service implements purpose-specific consent commands for
LearningResultsV5 and PublicationConsentV1. Login remains independent of public
consent. Private practice requires its own capture, privacy and speech-budget
admission; a publication grant supplies none of those permissions.

The authenticated browser interface is:

| Method | Resource                                                  | Input                              |
| ------ | --------------------------------------------------------- | ---------------------------------- |
| GET    | `/api/publication-consent/v1/state`                       | `purpose` query parameter          |
| POST   | `/api/publication-consent/v1/grants/prepare`              | `purpose`, `requestId`             |
| POST   | `/api/publication-consent/v1/withdrawals/prepare`         | `purpose`, `requestId`, `sourceId` |
| POST   | `/api/publication-consent/v1/withdrawals/stop`            | `purpose`, `requestId`, `sourceId` |
| POST   | `/api/publication-consent/v1/commands/<commandId>/submit` | `signature`                        |
| GET    | `/api/publication-consent/v1/commands/<commandId>`        | None                               |

All resources require the community session and return uncached responses.
Writes also require the existing same-origin and CSRF checks. Browser input
cannot select an RPC endpoint, registry, replacement message, payer or fee.
Preparation retains the first server nonce and exact request before remote
reads. Retry resumes that original rather than extending its validity window.

A source ID identifies a retained registry source. Withdrawal prefers the
current account, binding, author and learner. A single historical subject may
still be stopped locally after a binding change, but signing requires its
original subject. Ambiguous historical subjects are refused rather than
silently choosing one wallet. The local stop survives wallet cancellation and
remote acknowledgement loss.

The purpose view prefers the newest recorded grant within the active release
and current subject, ordered by immutable creation time and then command ID.
An unsigned preparation does not replace recorded permission. With no recorded
grant it reports the newest pending command. A selected grant that is denied,
expired or unavailable never revives an older grant. Each command resource
independently reports its original receipt and current usability. A successful
historical receipt can remain readable after withdrawal or a wallet change.

A current observation checks the generated contract interfaces, selected code,
Directory configuration, descriptor, epoch and original receipt block on the
canonical chain. Opening the local head additionally compares the exact
recorded command, latest observation, withdrawal generation, authenticated
rows and database-clock lease in one accepting SQL update. The resulting GET
projection is observation-only; it does not create an activity-start binding.

Migration 0020 adds the D1 command/outbox journal without backfilling V4 consent
or activating a profile. The operator Store remains the sole payer nonce and
transaction journal. Signed issuer transport connects the two stores; no
cross-store transaction is assumed. Recovery preserves the original command,
accepted signature, calldata, nonce and transaction identity. Unknown execution
remains charged and does not authorize a replacement send.

## Qualification and remaining integration

The local application checks exercise real loopback HTTP, sessions, CSRF, D1,
SQLite, typed EOA signatures and issuer signatures. Chain responses and policy
documents are explicit fixtures. They cover acknowledgement loss, restart,
reorg contradictions, withdrawal races, session loss and database-clock expiry.
They do not qualify deployed contracts, real MOSS signing or live providers.

The services are not yet mounted in the deployed application. Runtime profile
selection, retained-source transport, restart/alarm composition, actual
Study/Karaoke/Dance starts and producer publication remain integration work.
Linked-wallet generation synchronization between the account-scoped app fence
and learner-scoped operator fence also remains unqualified. The sender stays
closed. The first-song profile keeps learning publication and Dance disabled;
its plain login does not acquire public consent.
