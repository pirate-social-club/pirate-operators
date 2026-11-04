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
is reconciled before another send. Re-execution requires provider-specific proof
of absence and uses the original preparation. Providers without a safe lookup
or idempotency mechanism remain uncertain; a creator retry cannot authorize a
second paid call. A user-facing resume request only reopens reconciliation.

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
