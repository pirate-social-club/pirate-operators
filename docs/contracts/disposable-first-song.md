# Disposable first-song deployment

Owner approval, November 4, following the independent review: the ordinary-HTTPS
first-song test does not wait for real governance accounts or the automated HNS
verifier. Use a disposable
MegaETH testnet 6343 directory and posts index that can never list a community.
The later deployment that can list communities retains all authority, recovery,
evidence-age and incident-response acceptance requirements.

The disposable deployment and deferred lyric timings below were review
recommendations until the owner explicitly approved both after the provenance
review. That later approval is the authority for this profile.

## Permanently disabled discovery

Deploy two distinct instances of
[DisabledDiscoveryAuthority](../../contracts/testnet/DisabledDiscoveryAuthority.sol).
Each has code but no callable functionality, owner, initialization, forwarding,
upgrade or destruction path. Use one as the immutable namespace verifier and
the other as the immutable listing authority when deploying CommunityDirectoryV1.
Deploy CommunityPostsV1 against that directory. These are intentionally inert
contracts, not generic executors controlled by a throwaway key.

No actor can make a call from either authority. Verification and listing remain
unavailable for the lifetime of this directory. A controller can register,
configure, hand over control and rotate its publisher; the current publisher
can append post revisions normally. None of those operations enables discovery.
Do not fabricate HNS evidence, bypass the aggregate filter or label this
directory verified. The community's direct feed uses this explicit deployment.

The approved factory, implementation, clone and registry-admin checks still
apply. Use a genuine registry from the reviewed testnet factory. The local
identity fixture is not evidence of that live acceptance. Pin and independently
retrieve/hash-check configuration and post manifests before publishing their
references. Admission, creator activation and registration gates also remain.

The constructor still requires a nonzero maximum evidence age. Record the test
value, but do not present it as a selected production security bound: this
profile cannot record any attestation. Do not use this exception for mainnet,
real-user onboarding or a deployment intended to enable listings later.

## Deployment receipt and replacement

Before executing, prepare a reviewed manifest naming chain 6343, source/compiler
artifacts, expected runtime hashes, factory/implementation and genuine registry,
both disabled authorities, directory/posts addresses and deployment blocks.
Bind the existing approved test deployer and finite gas allowance through the
managed credential workflow. No public fixture key may be funded on testnet.
No new key, gas transfer or public-chain execution is performed by this profile.

Read back exact bytecode and immutable addresses after deployment, reconcile
canonical receipts, and prove registration and publication against them. Label
the receipt and UI `disposable testnet, permanently unlisted`. If the controller
is an EOA, also show `recovery incomplete`. Include the actual source and
deployment identities in the first-song acceptance record.

The real authorities require a new directory and posts deployment. They cannot
be installed in these immutable slots. The new posts address changes every
song key `(chainId, postsContract, communityId, postId)`, even if the registry
and local post IDs are reused. Test content/history is disposable; no automatic
post or streak migration is promised. Keep old acceptance receipts as evidence.

## First-song completion

Freeze the community-account and lyric-manifest formats before storing their
state. Use a private community account ID and a separate public author ID under
the reviewed community-account boundary. Confirm MOSS-to-Ika creator activation,
recipient binding and capped operator-funded setup before upload; exhausted or
unavailable funding stops the action rather than opening creator checkout.

The path is private upload, sealing, real admission, permitted IPFS publication,
the selected DATA testnet registration, MegaETH post publication, direct-feed
reconstruction and playback after a fresh-browser reload. Rejected or unavailable
checks keep the upload unpublished. Persist and reconcile uncertain external
operations before retrying; retries cannot publish or charge twice.

Freeze the lyric format and stable line/occurrence identities at publication.
Use the existing occurrence-based `lineId` and `lineVersion`; repeated chorus
lines are separate occurrences. Adding timings does not allocate new line IDs.
First-song completion does not require line/word timestamps, forced alignment
or a speech provider. Karaoke can add validated timings in a later post revision
without changing the song key. Missing timings mean karaoke is not ready; do
not fabricate timings or claim karaoke acceptance from audio playback.

Real governance authorities and HNS listing can be developed independently.
Comments, reward pots, bridging and further Study/Dance policy remain later work.
This profile and its local tests do not establish provider, registration or
live playback acceptance.
