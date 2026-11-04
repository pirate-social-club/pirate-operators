# Community uploads and media publication

Use private R2 for uploads, sealed source media and restricted evidence. Use
Filebase's IPFS service for admitted public media and immutable publication
manifests. Keep sessions, authorization, job state and account mappings in the
community's D1 database. Contracts hold the public references and hashes.
This is the proposed community publishing path, not an implemented uploader.

Frontend release deployment is a separate job. The community operator needs an
authenticated API accepting user content throughout the day, independent of any
frontend redeploy or frontend-hosting tool. Public IPFS content can be mirrored
by another provider later without changing its identity. Pinning availability,
retention and ongoing cost remain the pin operator's responsibility.

## Ownership and provisioning

The community operator owns the upload API, D1 jobs, quotas, retention and the
publication account. A Pirate-hosted installation may operate these for the
community; an independent installation supplies its own resources. Admission
providers keep their own credentials. Filebase keys belong to the service
performing the pin, with community allocation and cost accounting if shared.
They are never exposed to browsers or embedded in manifests.

Alchemy remains the infrastructure reconciler for Workers, R2, D1 and job
transport. Infisical remains the service-secret source. `cf` is available for
diagnostics; this repository does not introduce Wrangler or a second deployer
for Alchemy-owned resources. Existing Wrangler projects retain their own tool.

## Durable publication sequence

1. Authenticate the community-local user and authorize a submission. For a
   song release, complete the existing creator Sui/Ika activation and recipient
   binding before enabling upload. Use the selected capped operator-funded setup
   with no creator checkout; prove the current allowance before spending. Reserve
   storage/provider budget and allocate
   submissionId, revision, postId and idempotency key in D1.
2. Issue a short-lived upload capability for a unique private R2 staging key.
   Use a bounded Worker upload or a server-generated S3 presigned PUT with
   explicit CORS. Do not give the client bucket-wide credentials. For large
   uploads, track multipart sessions, quotas, expiry and abort cleanup.
3. Complete and seal the upload. Check actual length, format and SHA-256 of the
   received bytes; MIME headers and multipart ETags are not content proofs.
   Create a server-owned key for this artifact revision, with conditional writes
   and a rule forbidding subsequent replacement. Admission, pinning and hashing
   must all read that same sealed object. If staging changed during finalization,
   fail or reseal and rehash before admission. Never keep evaluating a key the
   user's upload URL can overwrite.
4. Run required admission jobs through the selected real operators. Supply
   expiring read capabilities for sealed inputs. Retain signed evidence and
   restricted provider details privately. Run the existing pure publication gate
   against current source hashes and policy; block, hold or needs_evidence stops
   publication. Preserve the specific MP3 frame-window identification rule.
5. After admission and explicit public-release consent, upload the allowed public
   assets to Filebase IPFS, or import a deterministic CAR. Record the returned
   CIDs, pin completion and retrieval/hash checks. Pinning occurs before the
   MegaETH publication event so the feed never intentionally advertises missing
   content. It may already make bytes public even if a later step fails.
6. Complete the configured DATA testnet registration job with the admitted media
   and verified creator recipient. Persist intent before submission, reconcile
   uncertain transactions and retain the confirmed network/asset receipt. The
   current release gate is not bypassed by local publishing. Song registration
   is distinct from media storage; a future Sui migration needs its own adapter
   and supported ownership/registration rules.
7. Assemble the final public post manifest, pin it and verify its exact JCS bytes
   and SHA-256. Submit its reference through the current community publisher to
   the MegaETH post contract. Save intent, config revision, nonce/transaction and
   target post revision. Confirm the canonical event before marking chain
   publication complete. A separate registration failure state never becomes
   registered merely because an upload succeeded.
8. Index the event, verify manifest and asset references, and make the admitted
   release readable in its direct community feed. For the disposable first-song
   test, verify playback after reload on ordinary HTTPS. The community remains
   permanently unlisted; aggregate discovery and app.tld are separate acceptance
   on a deployment that can verify/list communities. Track pin health and renew
   or replicate under the operator's retained storage budget.

D1 records separate upload, sealing, admission, pinning, registration, chain
publication and indexing states. There is no atomic transaction across those
services. Persist provider operation identifiers and content hashes, reconcile
before retrying and keep uncertain effects pending. Retries must not double
charge, mint, publish or assign a new post ID. Orphan pins and expired staging
objects need retention-aware cleanup; never delete a referenced sealed object
just because a queue message timed out.

## First-song identity and lyric boundary

Freeze the reviewed community-account format before persistent account state:
the private account ID and its wallet binding are distinct from the public
community-scoped author ID. A signed wallet operation retains its captured
wallet authority across retries; a later session does not redirect it.

Freeze the versioned lyric-manifest format and stable line/occurrence identities
at publication. Use the existing occurrence-based `lineId` and `lineVersion`;
repeated chorus lines retain separate identities. First-song completion does
not require line/word timings, forced alignment or a speech provider. Missing
timing data means karaoke is not ready.
Add validated timings through a later post revision while retaining
`(chainId, postsContract, communityId, postId)` as the song key. Do not replace
occurrence IDs merely because timing data or an external registration changes.

Use the [disposable deployment profile](disposable-first-song.md) for the
permanently unlisted HTTPS test. Creator activation, capped setup funding,
real admission, registration, idempotent recovery and fresh-browser playback
remain required. This document does not claim that any of them has passed.

## Public and private content

Public song/video assets and their safe display metadata can be pinned after
the applicable gate. Private Study attempts, raw recordings, Dance review
uploads, provider details, signed capabilities and session/account data remain
access-controlled. A public Dance post is a separate consented publication;
human review does not itself imply that its video should go to IPFS.

LearningRecords draft 3 recommends public wallet-linked assessments with
per-attempt consent. That recommendation is separate from the earlier three-item
approval. Public grades do not authorize public pinning of raw recordings or
provider evidence. IPFS unpinning does not guarantee
erasure of copies held by others. Content removal changes discovery and serving
policy; it cannot retract a CID already disclosed. Avoid irreversible public
pinning of material still awaiting admission or a publicity decision.

## Provider-specific integration facts

Cloudflare supports operation/object/expiry-scoped S3 presigned URLs and browser
uploads with CORS. Generate them with a signing client in the trusted service;
an R2 Worker binding alone is not a presigned-URL generator. Such URLs are bearer
capabilities reusable until expiry, which is why sealing uses a distinct key.
See [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

Filebase's IPFS S3 endpoint is `s3.filebase.com`, with region `us-east-1`.
Read the CID from `x-amz-meta-cid` or the object's metadata. Import a CAR with
`import=car` and verify the returned root matches the locally computed root.
Its pinning API can repin an existing CID only when the content is available;
it does not discover private R2 bytes by magic. Use the actual upload path.
See [Filebase pinning](https://filebase.com/docs/ipfs/pinning/pinning-files).

No account, price quote, upload, provider credential or retrieval acceptance
was exercised by this specification slice. Resource sizing and costs must be
measured in the actual implementation; an existing frontend pin is not proof
that the dynamic user-upload path works.
