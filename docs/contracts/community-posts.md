# Community post index V1

[CommunityPostsV1](../../contracts/community/CommunityPostsV1.sol) implements
[ICommunityPostsV1](../../contracts/interfaces/community/ICommunityPostsV1.sol)
locally. See the [implementation profile](community-implementation.md) for its
constructor, reference checks and remaining service/deployment acceptance.
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
publisher can forge new publications and append a new revision to every existing
post in its community, replacing any manifest while keeping the fixed author
and kind. The controller can rotate it, which stops further writes by that
account but does not undo its earlier edits or mark them untrusted on chain.
The recovery procedure below supplies that missing feed policy.
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

## Publisher compromise and recovery

This procedure assumes the community controller remains trusted and usable.
It requires no new ABI: the controller's `configure` transaction both replaces
the publisher and commits a JCS config manifest containing the cumulative
`publisherRevocations` array defined in the [directory spec](community-directory.md).
Use a different publisher account address. Rotating a signer inside the same
publisher address does not end an address-based revocation. Refresh namespace
verification separately because any configuration change stales it.

For each affected post deployment, add the compromised publisher and the first
block whose publications can no longer be trusted. The cutoff is inclusive:
all that publisher's post events at or after fromBlock are quarantined,
including legitimate writes inside the uncertain window and earlier writes in
the same block as the rotation. If the compromise start is unknown, use "0"
to quarantine its entire history rather than claim a safe boundary. This is a
controller-issued conservative trust decision, not cryptographic proof of the
compromise time. It does not quarantine other publishers' events in that block.
The cutoff uses canonical block height, not a timestamp or service receipt.

Illustrative config fragment; these are not deployed account addresses:

```json
{
  "publisherRevocations": [
    {
      "postsContract": "0x1111111111111111111111111111111111111111",
      "publisher": "0x2222222222222222222222222222222222222222",
      "fromBlock": "1000"
    }
  ]
}
```

A post event does not contain its submitting publisher. Readers derive that
account from the directory's canonical ConfigurationPublished event for the
post's exact communityId and configurationRevision. Do not use the outer
transaction sender, authorId, latest publisher or untrusted manifest metadata.
A shared publisher's incident in one community cannot revoke another's posts.
Apply the current cumulative policy to the entire retained canonical history,
not only events arriving after the revocation transaction.

Retain quarantined raw events, hashes and revisions for audit, but do not hydrate
or render their media as trusted feed content. The normal post projection uses
the highest non-quarantined, otherwise validated revision and exposes a recovery
marker whenever it differs from the on-chain latest revision. If none exists,
withhold the post from the normal feed and report it as quarantined in history.
This read policy does not change `getPost`, delete chain/IPFS content or repair
already-issued grades, external registrations or reward allocations.

The new publisher restores each legitimate post from independently retained
admitted inputs, creator consent and evidence, applying the normal publication
gate. It must read the current on-chain revision, even if that revision is
quarantined, and submit its successor. Do not roll the contract counter back to
the last trusted revision. Build a fresh manifest with the new post revision,
current configurationRevision and correct hash; reusing an old manifest with
stale identity fields is not restoration. Keep the existing postId, author and
kind so a genuine restoration preserves publication identity. A forged new post
with no legitimate author/kind cannot be reassigned: withhold it, and create a
separate correctly attributed post if needed.

For example, revision 1 at block 990 is trusted; revisions 2 and 3 from publisher
A at blocks 1000 and 1002 are quarantined by its inclusive cutoff of 1000.
After rotation, the feed displays revision 1 with the recovery marker while the
contract still reports revision 3. Publisher B repairs it by publishing revision
4 using expectedRevision=3 and the new config revision. The feed then selects
revision 4, while preserving revisions 2 and 3 as quarantined history.

If the trusted controller is unavailable, this procedure cannot manufacture its
authority. Pirate can delist for containment but cannot replace the config,
repair post history or recover the controller. The directory's EOA recovery
limits then apply. A controller can itself censor through this policy, just as
it can choose its publisher; the rule is a transparent community decision,
not a new independent truth or moderation authority.

## Required implementation tests

Prove old/arbitrary publishers cannot publish, stale configs and revisions
revert, identical retries cannot create duplicates, IDs cannot change author or
kind, independent communities cannot overwrite each other's posts, and delisting
does not give Pirate publication authority. Reconstruct the latest post from
events and compare its getter. Service acceptance must cover wrong manifest
bytes, admission failure, overwritten upload attempts, stale evidence, uncertain
transactions, reorg replay and playback from the published CID after reload.
Recovery acceptance must exercise forged edits and forged new posts, inclusive
cutoffs and same-block ordering, repeated publisher tenures, cumulative rules,
shared publishers across communities, a missing config body, and restoration
from the actual on-chain revision. These service/indexer cases are requirements;
the existing Solidity tests do not implement the recovery projection.
