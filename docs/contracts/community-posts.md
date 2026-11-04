# Community post index V1

This is the proposed contract for
[ICommunityPostsV1](../../contracts/interfaces/community/ICommunityPostsV1.sol).
One shared MegaETH contract can index many communities. It refers to one fixed
directory deployment. A per-community deployment remains possible through the
same ABI, but the selected first implementation is the shared index.

## Authors, submitters and gas

The author is an opaque, random nonzero bytes32 ID scoped to one community.
The community service retains its local account mapping in D1. Do not derive
the public ID from an unsalted wallet hash or reuse the ID across communities.
Neither the directory nor the post calldata contains that mapping.

The community publication account is the transaction sender and pays MegaETH
gas from its bounded operational balance. It submits for authenticated users
after authorization and admission. The contract verifies the current publisher
and current directory config revision on every call. It does not independently
prove that the account behind authorId requested publication. A compromised
publisher can forge attribution and publication; the controller can rotate it.
A registry admin can self-register an unverified directory entry and publish
through its configured publisher before Pirate verifies or lists it. Only
Pirate discovery requires that verification; an independent community feed can
read its explicit deployment/community ID. Unverified namespace claims must
remain labelled as such. User consent and signed admission records remain
service audit evidence. The publisher remains trusted for attribution and
admission; the contract cannot independently prove either.

A shared publisher does not guarantee anonymity: content, timing, creator IP
registration and later reward evidence may identify or link people. In
particular, the existing reward policy deliberately publishes participant wallets.

## Publication records

`(chainId, postsContract, communityId, postId)` identifies a post. The service
allocates a random nonzero bytes32 postId once when it creates the D1 publication
job, before sending a transaction. `expectedRevision=0` creates revision 1;
an edit must supply the current revision and creates its successor. authorId
and kind are immutable. A different author or kind requires a new post ID.
There is no transaction sender field used as the author.

The same immutable tuple is the local song streak key. External Aeneid/DATA/Sui
registration references and content revisions may change without changing it.
Optional cross-community grouping uses an explicit registration/alias policy.
Ordinary verifier/listing signer rotation must preserve their governance account
addresses and the directory/posts deployments; replacing a deployment is a
separate identity migration, not ordinary key rotation.

The latest state contains the manifest URI and SHA-256, revision, author, kind
and directory configuration revision under which it was published. Events
retain every revision. Manifest URIs use the same immutable IPFS and 512-byte
limit as directory configuration. Require a nonzero manifest digest. Both kind
values are reserved in the ABI; only Song has a first-release admission policy.
An ordinary video requires its own approved admission/publication policy before
the publisher may emit it. A Dance submission for private owner review is not
automatically a public Video post.

The publication manifest is JCS JSON with schema `pirate.community-post/1`.
Its required identity fields are chainId, postsContract, communityId, postId,
authorId, kind (`song` or `video`), revision and configurationRevision.
`publishedAt` is service-declared metadata; block time/order comes from the
event and cannot be replaced by that value. Content fields include title,
language, rating and a media list. Each media entry has a role, immutable
`ipfs://` URI, exact-byte SHA-256, byteLength and mediaType. Displayed artwork
must satisfy the admission cover decision; withheld artwork is not pinned as
a public side effect. Lyrics/timed lyrics are revisioned assets, not calldata.

An admission summary carries the policy version/hash, publish decision,
rating, coverDisplayed and the digest of retained signed evidence. Provider
details, capabilities and private input metadata never enter this manifest.
An external registration reference, when present, contains protocol, network
identifier, asset identifier, transaction hash and confirmed status with the
specific adapter's receipt evidence. Absence is not success. A typed DATA
adapter must validate that reference against the admitted release; a generic
string is not a verified registration. No presumed Sui migration is encoded.

These are semantic field requirements, not a shipped JSON validator. Freeze
and test the wire schema alongside the publication service before rollout;
reject unknown schema versions. Check all identity/revision fields against the
event and verify the exact retrieved manifest bytes against its digest.

## Admission, edits and retries

The contract checks publisher authority, revision and reference shape. It
cannot run ACRCloud, fetch IPFS or establish that a gate approved the content.
The publisher must pass the real [operator publication gate](../operator-protocol.md)
over sealed current inputs, retaining the evidence. A pin receipt alone cannot
authorize publication. Source edits re-evaluate the gate; a terms-only edit
may reuse evidence under the existing protocol. Historical revisions persist.

A retry reconciles the event/state for the retained postId and target revision.
If that exact revision and hash already landed, finish the job without another
publish. If another revision/hash occupies it, report a conflict. If config
rotated meanwhile, reauthorize and re-evaluate against the new policy instead
of blindly substituting its revision. Unknown receipts remain pending.

The ABI deliberately has no comments, grade storage, deletion, moderator roles
or reward enrollment method. Comments' chain representation is still open.
Later hide/restore actions should be explicit revisioned community decisions
that indexers can replay; they cannot erase public chain history or IPFS copies.
Those actions and their UI are not prerequisites for the first admitted song.

## Required implementation tests

Prove old/arbitrary publishers cannot publish, stale configs and revisions
revert, identical retries cannot create duplicates, IDs cannot change author or
kind, independent communities cannot overwrite each other's posts, and delisting
does not give Pirate publication authority. Reconstruct the latest post from
events and compare its getter. Service acceptance must cover wrong manifest
bytes, admission failure, overwritten upload attempts, stale evidence, uncertain
transactions, reorg replay and playback from the published CID after reload.
