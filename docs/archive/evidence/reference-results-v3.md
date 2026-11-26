# Independent V2 and V3 public readback

The manual `harness/reference-results.ts` program captures raw public chain and
IPFS evidence or replays an earlier capture offline. It uses no wallet, private
application API, speech provider or chain write. No live Study contract/profile
is supplied by this source work. Public deployment and actual acceptance remain
separate gates.

Run `node harness/reference-results.ts` for usage without network or output
creation. `--read --profile <public-profile.json>` explicitly captures MegaETH
testnet 6343. `--snapshot <raw.json>` replays offline. Optional `--head` pins an
earlier confirmed head, and `--evaluate-at` chooses a Unix-second evaluation at
or after that head. `--output <new-directory>` writes raw.json, reference.json
and exact SHA-256 digests, refusing an existing directory. The historical V2
entrypoint and its retained snapshots remain available. A live successor profile
must include every configured historical V2 and V3 contract.

The public profile contains only chainId, communityId, registry, directory, posts
and results. Each contract has address, fromBlock and codeHash. Result profiles
add version 2 or 3; an omitted version means historical V2. Unknown profile
fields, including credentials or custom RPC URLs, are rejected. Live reads use
the fixed MegaETH endpoint and public IPFS gateways. The profile and captured
runtime hashes must come from reviewed deployment evidence. Capture verifies
V3 VERSION and records activity-specific policyFor values at its pinned head.

Wire ABIs and transport can be shared. The reference implementation does not call
production source, result, Study codec, grading, qualification or board reducers.
It independently reconstructs controller/grader changes, versioned enrollment
digests and activity masks, revocation, terminal results, ancestry, invalidation,
prospective policies and canonical receipts. An unverified latest revision cannot
revive an earlier favorable result. Corrections preserve original completion day,
source, selection, learner and enrollment generation. Controller restoration
remains possible after revocation; a grader cannot restore an invalidation.

Study uses four to ten distinct selected source ordinals, retaining selection
order and the complete published lyric source. Source checks include historical
community configuration, authorized publisher, revocation/quarantine, publication
before lesson start, full lyric occurrences and normalized first occurrences.
A selected section cue or duplicate text is not an eligible exercise. Large
sources are fetched through their published media URI; the SHA-256 digest cannot
invent a UnixFS CID. The transport test uses a real locally calculated multiblock
CID and more than 262144 bytes, with explicit fake chain and IPFS peers.

Each selected outcome remains correct, incorrect, unpaid, unmeasured or
unattempted. Absence has no numeric grade. Qualification requires completed
status, every first pass graded, the exact pinned Study scorer and at least
seventy percent correct over the full frozen selection. Retries cannot replace
first-pass misses. Unknown or weakened policy documents provide no qualifying
day. Incomplete Study has no aggregate score. Karaoke retains its own score and
absence rules. SQL selects prospective policies separately by contract/activity,
then deduplicates one community day across Karaoke and Study. Song days, streaks,
shared ranks and eligibility history remain separate projections.

Raw synthetic tests extend retained public song documents; they are not a live
MOSS/provider journey. They compare Study reduction with the production V3
reader and actual public-source authenticator over an offline evidence client,
while the SQL implementation independently authenticates those bytes and logs.
Existing V2 agreement tests remain part of the gate. Qualification output is
not funded drawing, payout, personhood or honest-performance authorization.
Actual deployment, finality, costs and full testnet rewards acceptance remain
required by their owning records. This work changes no application flow,
enrollment disclosure, contract method, credential or live configuration.

The reference independently validates complete supported community configuration,
post, admission, registration-receipt, media and lyric schemas. The post's
admission version and digest must match its cited configuration. Registration
metadata must have the supported Aeneid shape and bind the audio digest; this is
validation of published metadata, not an additional Story RPC or mainnet proof.
Media roles, types, canonical CIDs, declared byte bounds and cover declarations
remain binding. Both activity adapters validate every lyric occurrence, including
unselected identifiers, text, language and version bounds. Unknown nested fields
or a changed immutable community label refuse the history.

Each raw log must agree with its canonical receipt copy on address, transaction
hash/index, block number/hash, log index, removal state, bytes and topics. The
block's declared number must match its lookup key, and the head's identity and
timestamp must agree with its stored block. These checks preserve event and
eligibility order rather than trusting internally inconsistent capture positions.
