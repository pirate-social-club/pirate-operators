# Learning results version 3

This freezes the local implementation format for the Study testnet successor.
It does not describe a deployed contract. Version 2 remains deployed and its
historical contract, consent, manifests and reader remain independently valid.

## Contract and consent

LearningResultsV3 uses EIP-712 name Pirate Learning Results, version 3, the
actual chain ID and its own verifying address. Enrollment and revocation fields
retain their V2 shapes. Activity 1 is Karaoke, activity 2 is say-it-back Study;
the corresponding enrollment bits are 1 and 2. Only masks 1, 2 and 3 are valid.
No V2 signature or grant transfers to V3. Enrollment generations, nonce replay
protection, ERC-1271 validation and revocation of pending initial publications
retain the V2 rules. Corrections to already public evidence remain possible
after revocation; revocation cannot erase an existing public result.

The Result tuple retains V2's field order and types. linesTotal denotes the
number of selected exercises for Study. Keeping the envelope does not make
the outcome bytes interchangeable: the activity determines their encoding.
The initial result must reference the current enrollment generation, start
after its issue time, finish no later than the block time, and be published
before enrollment expiry. Source community identity must equal this contract's
immutable community. Song source chain/contract/revision are authenticated by
the independent reader against the configured public publication history.

Qualification activation is per activity. activatePolicy accepts activity,
policy hash, URI and a future learning period. policyFor accepts activity and
period. PolicyActivated includes indexed activity. A Study activation cannot
replace the policy for Karaoke. The original 17:00 UTC learning clock and
original completion period remain unchanged. Policies are prospective; absent
policy means public evidence without a qualifying day.

## Typed outcomes and source binding

Karaoke keeps V2's five-byte entries: uint16 one-based ordinal, uint8 status,
uint16 score. It requires every lyric line in manifest order, up to 500 lines.
Its assessed/silent/unpaid/unmeasured/unattempted semantics are unchanged.

Study entries are three bytes: a big-endian uint16 one-based ordinal in the
full published lyric manifest, followed by uint8 first-pass status. Codes are
1 correct, 2 incorrect, 3 unpaid, 4 unmeasured and 5 unattempted. Correct and
incorrect are binary outcomes, not numeric pronunciation scores. A graded
empty transcription is an incorrect answer; provider failure is unmeasured,
never an incorrect answer. An exercise without a dispatched first pass is
unattempted. No missing status is a fabricated numeric zero.

There are four to ten Study entries. Source ordinals are unique, between 1 and
2000, and appear in the immutable lesson selection order, which need not be
source order. exercisesHash is keccak256 of the concatenated two-byte source
ordinals in that exact order. The contract recomputes it from outcome entries.
Corrections cannot change that hash, the count or the source manifest, so they
cannot omit, reorder, duplicate or replace exercises. A completed Study result
must have a correct/incorrect first pass for every selected exercise.

The reference vector selects source ordinals 7, 2, 10, 4, with first-pass
statuses incorrect, correct, correct, correct. Its outcome bytes are
`0x000702000201000a01000401`. The ordered ordinal bytes are
`0x00070002000a0004` and their keccak256 is
`0xf7930735c7334e84c22370fafba26c8d0a608fcd751db170ac3f1eb6e4a32efa`.
This is three correct first passes out of four, regardless of later mastery.

For Study, contentRevision is SHA-256 of the canonical complete
pirate.song-lyrics/1 manifest, not a favorable subset or private lesson document.
The reader obtains its IPFS URI from hash-bound media in the historical
published post; it does not assume that a multi-block CID is derivable from the
file digest. It validates the complete manifest, matches its identity to
Result.song, and authenticates its digest through the historical published post
and directory configuration. Selected
entries must reference eligible non-cue lines of at most 512 characters, use
the first occurrence of normalized repeated text and contain distinct text.
Their exact line IDs, versions, language and text come from that manifest.

Selection is frozen privately before assessment, including the full source
digest and enrollment generation. The grader attests that selection and the
first-pass outcomes. The public chain and source reader cannot prove private
practice-history ranking or honest performance; no opening transaction or
claim of trustless speech grading is introduced.

## Terminal state and qualification

Terminal status codes remain 1 completed, 2 abandoned, 3 expired, 4 payment
missing and 5 invalidated. An active lesson cannot publish. The adapter must
read a durably closed snapshot before constructing a terminal bundle. It keeps
already graded first passes and records missing measurements or unreached
exercises explicitly for non-completed sessions. The local runtime now closes
abandoned and expired lessons with a fixed one-hour deadline, bounded takes,
optimistic state checks and an atomic database closure. Saved grades survive
closure; late provider responses cannot add grades or start new dispatches.
Submitted ungraded work is unmeasured, while unreached work is unattempted.
The live routes, expiry sweep and publication queue still need integration and
deployed acceptance; local runtime checks do not establish deployment.

The scoring policy binds say-it-back grading script*aware_token_phonetic_v4,
lesson queue pirate.study.lesson-queue/1, the frozen four-to-ten selection,
three graded presentations per line, the min(20, 3 * count) total cap and
first-pass public outcomes. A correct retry never overwrites a first-pass miss.
Qualification requires completed status, all selected first passes graded and
correctCount \_ 10 >= selectedCount \* 7. Missing outcomes remain in the
denominator and disqualify the lesson. Completion and later mastery are not
substitutes for first-pass qualification. The qualification policy must also
authorize the grader and exact scoring policy; no funded reward follows merely
from a qualifying lesson.

Corrections authenticate the current commitment and preserve learner,
enrollment generation, selected set, source, original timestamps and policies.
They replace the whole outcome bundle and increment its revision. An invalid
newest revision cannot restore an older favorable result. Only the controller
may restore an invalidated result. The reader deduplicates canonical logs and
rechecks its head; it does not infer finality from a cached head or merge records
from different verifying contracts solely by private session identifiers.

## Rollout

Deploy a reader/application that understands V2 history and the new V3 format
before selecting V3 in the directory configuration. Obtain fresh V3 learner
enrollment, preserve the existing service budgets and state, and keep published
V2 evidence readable. Existing in-flight V2 sessions and unknown transactions
must retain their original contract, enrollment generation, signing data and
transaction destination. A new preferred contract cannot retarget them to V3
or reset their reservations. New sessions must persist their selected contract
and protocol version before work starts. Then activate the new configuration and verify both
activities. Full deployment, recovery, real-provider acceptance and complete
cost measurement remain gates, separate from this local format freeze.
