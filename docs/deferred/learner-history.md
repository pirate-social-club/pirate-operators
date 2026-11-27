# Learner-held language history

Specification direction, 2026-11-06; no encrypted vault or storage integration
is claimed as implemented. This is the private counterpart to
[compact public learning results](learning-results-v2.md). English learning
and useful tutoring require richer evidence than public grades alone.

## Ownership and useful records

The learner controls access to their portable history and any backup decryption
keys. A community account identifies local membership and service access; it
does not own the learner's cross-community language profile. An operator may
retain the minimum session, billing, fraud and pending-work state it needs,
under disclosed retention rules. Community database export is not a substitute
for a learner-readable history export.

Use versioned, documented records for activity and language, source/exercise
revision, private session and attempt IDs, timestamps, expected and recognized
text where useful, alignment/word evidence, feedback, retry outcomes, hints,
scoring/provider versions and confidence or measurement limitations. Distinguish
measured outcomes from inferred tutor summaries. Keep vocabulary/grammar and
pronunciation observations with their evidence and dates so another tutor can
recompute or revise a profile instead of inheriting an unexplained score.

Keep provenance and signed assessment receipts where available. The learner
may edit goals, annotations and tutor memories, but those edits do not rewrite
an issuer's signed assessment or official public grade. Imports do not confer
leaderboard or reward credit. Cross-community joining is learner-authorized;
do not introduce a public global account identifier to implement private sync.

Raw audio retention is optional and separately chosen. Do not retain every
recording indefinitely just because it could help a future agent. Define the
minimum transcript/alignment detail needed, retention duration and storage cost.
Public grade events remain public even if the private history is later deleted.

## Local history, export and optional backup

The target is usable local history plus a documented export/import format and
optional encrypted backup. Local browser storage alone can be lost; show the
backup/recovery state accurately. Declining cloud backup must not itself block
practice. Do not present community-scoped D1 history as an implemented local
vault; delivery and verification of this capability remain future work.

Keep vault decryption in a client/origin the learner explicitly trusts, with a
permission boundary from community-served code. Giving a community page the
vault root key would let a malicious community update extract it. Encryption
protects stored backups; it does not protect plaintext from compromised vault
client code or a tutor already granted access. Document that trust boundary
and qualify export/recovery with a replacement client.

Encrypt backup bundles on the learner's device before upload, using reviewed
authenticated encryption and versioned key wrapping. The service or community
must not hold the learner's decryption root as the only recovery path. Specify
key recovery, device migration and export before advertising user ownership.
Passkey support for encryption/key wrapping needs platform qualification; an
authentication signature alone is not a guaranteed portable encryption key.
No new Ika wallet, Sui credential or paid wallet signature is required merely
to save a learner's history. Changing community, wallet or storage provider
must not strand an otherwise recoverable vault.

Walrus and Lighthouse are candidate storage providers for ciphertext, not
ownership mechanisms. Provider-specific access policies, including Seal, are
optional future integrations and must not silently introduce a second learner
credential. Pick no storage vendor through this amendment. Qualify upload/read
costs, minimum billing units, renewal/expiry, availability and export before
selection. Upload occasional bundles with a versioned manifest rather than
one object per utterance. Sync frequency and maximum bundle size must balance
cost against recoverable progress; backing up every attempt is not an on-chain
requirement.

The encrypted manifest and keys must be enough to locate and restore the data
without a private community database. Do not expose plaintext learner identities
or tutor summaries in public storage metadata. Replacing or deleting a backup
can remove controlled copies, but cannot guarantee erasure from third-party
copies or an agent that already received plaintext. Key destruction does not
erase public grades or invalidate a copy previously decrypted.

## Tutor access and processing boundaries

The learner explicitly authorizes which tutor receives which history, for
what purpose and duration. Prefer selected context or derived observations
over sending the entire vault. Avoid giving a remote agent the master vault
key. A learner can stop future disclosures and replace access grants; that
cannot revoke plaintext an agent has already copied. Model-provider retention
and any model-training use require their own disclosed choices.

Backup encryption does not make live speech processing end-to-end private from
the processing provider. ElevenLabs receives the audio needed for the chosen
transcription/alignment flow. Audit the selected logging/retention settings and
the operator's temporary copies separately. Current enable_logging behavior
must not be described as zero retention without verified configuration and
provider terms. This amendment does not replace ElevenLabs or authorize a real
provider call.

## Acceptance

A learner must be able to export, restore on another supported client and grant
a different tutor useful context without permission from the original community.
Test recovery after local cache loss, lost access to a community, storage-provider
replacement, optional-backup refusal and unavailable/expired backup blobs. Missing
keys or unavailable data must produce an honest recovery state, never an empty
profile presented as successful restoration.

Test that community administrators and storage operators cannot decrypt the
backup without learner authorization, that public events exclude private tutor
details, that corrupted bundles fail authentication, and that imported or edited
history cannot mint official grades or rewards. Provider-selection, cryptographic
format, recovery UX and retention defaults remain implementation decisions; this
document defines their required outcomes rather than claiming them delivered.
