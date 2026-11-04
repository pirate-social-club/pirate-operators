# First-song runtime

The first-song branch owns its community application state and processing code.
The application migration is `apps/community-wizard/infra/migrations/0002_first_song.sql`;
`0003_publication_journal.sql` retains reconciliation proofs. The current wizard
provisioner still packages only the setup Worker and first migration. Application
packaging, live adapters and managed-community qualification remain integration
work until their reviewed successors are recorded.

Private accounts, credential bindings and public author identities are separate.
Upload reservation captures the authenticating wallet and verified native
creator binding. An idempotency key reopens the same reservation with its
original authority, post ID and lyric occurrence IDs. Changing its input or
publication profile returns a conflict. New reservations require fresh creator
verification and have an atomic unfinished-upload limit.

Each upload attempt owns a private R2 object key. The declared SHA-256 is an
R2 checksum condition. A lost upload response is reconciled from that object;
an expired writer has a different key from its successor and cannot overwrite
the object selected for sealing. Sealing atomically creates one publication
job. MP3 structure and moderation are admission checks after storage.

The Effect publication runner performs one bounded step per wakeup. Its order
is admission, retained audio pin, retained lyrics pin, registration, retained
post-manifest pin and MegaETH publication. The driver supplies a stable request,
read-only preparation, execution, reconciliation and result validation. Runtime
adapters must validate current authority, provider evidence, public content and
canonical chain receipts under the captured operation request.

An operation's request hash and preparation are persisted before sending.
Preparation must persist all external transaction identifiers, nonces and signed
bytes needed for recovery, without causing a billable call or broadcast. A
confirmed operation's receipt is reused after interruption. A running operation
is reconciled before another send. Re-execution requires both provider-specific
proof of absence and persisted replay safety: the identical signed transaction,
or a provider contract that enforces the immutable operation idempotency key.
An HTTP idempotency header alone does not establish such a guarantee. Without
enforced replay safety, an ambiguous send remains uncertain even when a lookup
currently finds nothing: a delayed original request may still arrive. A creator
retry cannot authorize a second paid call. A user-facing resume request only
reopens reconciliation.

Job leases fence stale preparers and state advancement. Immutable operation
results can be retained after a lease expires, but cannot change an already
saved receipt. Held and rejected admission stops before pinning, registration
or publication. Provider details remain private in operation records; public
manifests carry the permitted admission summary and receipt references.

Local qualification uses actual Miniflare D1/R2 and simulated external providers.
It exercises concurrent reservation, checksum rejection, lost R2 responses,
duplicate wakeups, each persisted interruption boundary and unresolved provider
results. These tests establish storage/orchestration behavior. Live managed
moderation, actual registration/publication and browser playback have separate
acceptance evidence.

The managed processor has a server-to-server HTTP boundary, a private D1
admission journal and private R2 input and sample retention. Every action
requires a publisher signature and a fresh canonical configuration check under
the independently configured community pairing. Before each new provider
purchase, it checks current authority again. Inputs are bounded capabilities
on the paired community origin and are verified by SHA-256 and byte length.
Renewing their transport tokens preserves the immutable job inputs.

Provider calls reserve both service and community request quotas and durably
enter running before sending once. Raw responses are retained before parsing;
recovery interprets those receipts without repurchasing them. An unknown send
retains its reservation and remains uncertain through authenticated resumes.
Held work may be explicitly resumed to recheck readiness, with all retained
provider intents and receipts preserved. Quotas count provider requests, not
currency; the selected classifier also has a fixed output-token bound.

The processor's local composition tests exercise actual HTTP authorization,
D1, R2, MP3 extraction, provider receipt handling, signatures and the release
gate with explicit simulated providers. They establish admission, rejection,
holds, capability renewal, changed-authority refusal and uncertain-response
recovery. They do not establish live provider acceptance or service deployment.
