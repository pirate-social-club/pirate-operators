# First-song runtime

The first-song branch owns its community application state and processing code.
Its explicit application migrations now run through 0007: accounts, sealed
submissions, publication journals, creator bindings, private stem slots and
append-only policy amendments. The wizard setup and the subsequent application
package have separate reviewed Alchemy runners. The managed first-song community
and its registry/directory/posts contracts exist; the
[current rollout evidence](deployments/first-song-managed-20261105.owner-curated-rollout.json)
records the initial deployed profiles. [Actual first-song acceptance](deployments/first-song-managed-20261105.first-song-acceptance.json)
records the published owner-curated release and anonymous playback after reload.

Owner-only unregistered publication is the launch successor. Its contract is
[owner-only MegaETH song publication](megaeth-song-publication.md). A job
captured under policy pirate-owner-curated/2026-11-08/1 runs recognition-only
admission, the audio, lyrics and post-manifest pins and MegaETH publication of
a pirate.community-post/3 song. It has no registration step, creator binding,
registration signer, creator service or Aeneid, Sui or Ika client, and
readiness checks only the managed owner release. Owner reservations capture
the controller-signed owner authorization in place of a creator binding.
Spending is bounded by the owner budget grant. The job sequence is chosen from
the captured policy, so jobs captured under an earlier policy keep their
original sequence and are never rewritten into an unregistered job. The
registration, creator-binding and ROOT recovery text below describes those
registered jobs and stays accurate for them.

The completed owner-curated run follows
[the explicit policy successor](owner-curated-first-song.md). Automated content
moderation is deferred. Rating/language are operator declarations, and genuine
retained ACRCloud evidence keeps its original acquisition time. The old held
admission and classifier refusal remain historical records. A controller-signed
amendment can adopt only the exact sealed release, without replacing its original
job input, authority, lyric IDs or consumed quotas. The provider flow described
later in this document remains the historical automated policy implementation.

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
job. Private instrumental and vocal MP3s occupy immutable fixed slots on the
same submission; each has independent leases, checksum/probe validation and
lost-response reconciliation. They do not replace the master or lyric revision.

The Effect publication runner performs one bounded step per wakeup. Its order
is admission, retained audio pin, retained lyrics pin, registration, retained
post-manifest pin and MegaETH publication. The driver supplies a stable request,
read-only preparation, execution, reconciliation and result validation. Runtime
adapters must validate current authority, provider evidence, public content and
canonical chain receipts under the captured operation request.

ROOT recovery verifies the exact canonical mint transaction and calldata,
one registry IPRegistered event with the exact NFT metadata URI, and the ordered
ERC721 transfers from zero through the workflow to the captured creator. Every
expected log is bound to the transaction and block. A second receipt and the
canonical block must still agree after confirmation. This proves initial delivery
at transaction completion, without substituting current ownership for historical
ownership. Public Aeneid RPCs prune old state, so recovery cannot depend on an
archival ownerOf or tokenURI call. It never allocates another mint.

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
Evidence age begins at the earliest durably recorded provider acquisition,
not at enqueue or resume. Fresh processing of an old queued job remains valid;
stale retained facts hold before another purchase and cannot gain a new age.
The captured directory, controller, registry and both origins remain immutable
even if the service's curated pairing later changes.

The processor's local composition tests exercise actual HTTP authorization,
D1, R2, MP3 extraction, provider receipt handling, signatures and the release
gate with explicit simulated providers. They establish admission, rejection,
holds, capability renewal, changed-authority refusal and uncertain-response
recovery. Live service deployment is separately qualified in the rollout record.
The actual held submission obtained recognition and text-safety responses before
the classifier refused access. That is not completed automated moderation.
