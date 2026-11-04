# LearningRecords on-chain encoding, version 1

This document freezes the byte-level encoding used by
`contracts/LearningRecords.sol`. The record semantics come from the staged
learning-records specification (draft 3). This document covers only how those
records are encoded, so that the contract, the operator's publisher and an
independent reader agree byte for byte.

`fixtures/learning-records-v1.json` holds the shared test vectors. They were
computed with Foundry's `cast` and Python, without calling the TypeScript or
Solidity under test. `test/solidity/LearningRecords.t.sol` asserts the
contract against them, and `test/learning-records-encoding.test.ts` asserts the
TypeScript module `packages/protocol/records.ts` against them. A change to any
rule below needs a new version, new vectors, and a new contract deployment.

## 1. Text identifiers

`activity`, `scoringPolicy` and `lineKey` are `keccak256` of the UTF-8 bytes of
a text identifier, with no prefix or length.

| Field | Text | Example |
|---|---|---|
| `activity` | `karaoke` | `0xb638…61cb` |
| `scoringPolicy` | `karaoke-scoring/<KARAOKE_SCORING_VERSION>` | `karaoke-scoring/5` is `0x0527…f89d` |
| `lineKey` | the manifest line's `lineId` | `line-01` is `0x81b5…1f5e` |

## 2. Song key

```text
songKey = keccak256(abi.encode(uint256 chainId, address posts, bytes32 communityId, bytes32 postId))
```

The posts contract does not exist yet. Until it does, the publisher uses a
stand-in: `chainId` is the records chain, `posts` is the zero address,
`communityId` is `keccak256` of the community's `COMMUNITY_ID` text, and
`postId` is the manifest's `songHash`. The stand-in is not a stable song
identity, because `songHash` changes when the song's content changes. Song
boards must not treat it as one, and the first posts deployment replaces it.

## 3. Manifest commitment

`contentRevision` is the karaoke manifest's `manifestSha256`: the SHA-256 of
its JCS canonical JSON, the value the operator's ticket and result already
carry.

Each manifest line contributes one leaf:

```text
leaf = keccak256(abi.encode(uint256 ordinal, bytes32 lineKey, uint256 lineVersion))
```

`ordinal` starts at 1 and follows the manifest's line order. The leaves, in
ordinal order, form a binary Merkle tree. Each parent is `keccak256` of its two
children concatenated, with the smaller value first (sorted pairs). A level
with an odd number of nodes promotes its last node unchanged to the next
level. The root is `linesRoot`, and `linesTotal` is the number of lines, from
1 to 500. A proof lists the sibling at each level from the leaf upward. A
level where the node was promoted contributes no sibling.

The vectors include the four-line fixture's leaves, root and proofs, and the
root of its first three leaves, which exercises promotion.

## 4. Consent

The learner signs EIP-712 typed data once per attempt. The domain is
`{ name: "Pirate Learning Records", version: "1", chainId, verifyingContract }`.

```text
Consent(address learner,bytes32 attemptId,bytes32 songKey,bytes32 contentRevision,
        bytes32 linesRoot,uint16 linesTotal,bytes32 activity,address grader,
        bytes32 scoringPolicy,uint64 expiresAt)
```

`attemptId` is the operator's attempt identifier from its signed attempt
start. `openAttempt` checks the signature once: ECDSA with low `s` for an
account without code, ERC-1271 `isValidSignature` for an account with code.
`expiresAt` bounds only when the attempt may be opened on chain; it does not
expire records already written.

## 5. Line records

Line status codes:

| Code | Status |
|---|---|
| 1 | `assessed` |
| 2 | `silent` |
| 3 | `unpaid` |
| 4 | `unmeasured` |
| 5 | `unattempted` |

Only `assessed` carries a score, an integer from 0 to 10000 basis points. Every
other status must carry `scoreBps = 0`, and `LineAssessed.hasScore` is false.

Each line has its own revision counter, starting at 1. A provisional record
may be followed by a provisional or a final one. A final record may only be
followed by another final record, which is a correction. Each record's hash is

```text
recordHash = keccak256(abi.encode(bytes32 attemptId, uint16 ordinal, bytes32 lineKey,
             uint32 lineVersion, uint8 status, uint16 scoreBps, bool final, uint32 revision))
```

and `LineAssessed.supersedes` is the previous record's hash for that line, or
zero for revision 1.

## 6. Completion

Completion status codes:

| Code | Status |
|---|---|
| 1 | `completed` |
| 2 | `abandoned` |
| 3 | `expired` |
| 4 | `payment_missing` |

`completeAttempt` is refused until every line has a final record. It then
records

```text
recordsHash = keccak256(recordHash(1) ‖ recordHash(2) ‖ … ‖ recordHash(linesTotal))
```

over the latest record of every line, in ordinal order. The first completion
binds `completedAt` and `qualificationPolicy`. Later completions follow
corrections, keep both, and increment the completion `revision`.

This `recordsHash` is not the off-chain result's `linesHash`. That one is the
JCS SHA-256 of the operator's signed `lines` array. The two commit to the same
outcomes in different encodings. The chain uses only `recordsHash`.

For karaoke, `completedAt` is the signed result's `performanceEndedAt`, when
singing stopped, not `endedAt`.

## 7. Periods

```text
periodId = floor((completedAt - 1793552400) / 86400)
```

`1793552400` is 2026-11-01 17:00 UTC, the shared day boundary, with clock
version 1. `qualificationPolicy` is the hash from the latest `PolicyActivated`
whose `effectivePeriod` is at or before `periodId`, or zero if there is none.
Activations must be announced before their period begins and must strictly
increase.

## 8. What a reader verifies

The completion's `unmeasuredCount`, `hasRewardScore` and `rewardScoreBps` are
the grader's claims. The contract checks only their ranges. A reader must
recompute them, and must not trust the claimed values.

A reader that rebuilds a learner's grades from chain events and public
manifests does the following for each attempt:

1. Fetch the manifest by `contentRevision`, and check its JCS SHA-256 equals
   `contentRevision`.
2. Recompute `linesRoot` and `linesTotal` from that manifest, and check both
   against `AttemptOpened`.
3. For each `LineAssessed` record, check that the line's key and version match
   the manifest line at its ordinal. Recompute `recordHash`, and check that
   `supersedes` names the previous revision's hash.
4. For each `AttemptCompleted`, take the latest record of every line as of
   that completion's position in the log (block number, then log index).
   Recompute `recordsHash` from those records, and check it.
5. Recompute the reward from those same covered records. `unmeasured` leaves
   the denominator. `assessed` adds its score. `silent`, `unpaid` and
   `unattempted` add zero. `rewardScoreBps` is the floor of the sum divided by
   the remaining denominator, and there is none when the denominator is zero.
   The reader uses the recomputed values and reports any claim that differs.

Line records written after the latest completion are corrections that have not
been completed yet. A reader reports them, but does not count them as grades.

`packages/records/reader.ts` implements these checks.

## 9. The operator's publisher

`services/records.ts` publishes karaoke results, and only when the learner
consented. When LearningRecords is configured, the socket's `ready` message
carries a `consent` object with the EIP-712 domain and the consent message.
The client signs it with the learner's wallet and sends
`{ "type": "consent", "signature": … }`. The operator answers `consented` or
`invalid_consent`. Consent is accepted at any time on the live socket,
including after the attempt ends. Its `expiresAt` is the attempt's start plus
seven days.

The operator checks consent locally before storing it. It accepts only a
low-s ECDSA signature that recovers to the ticket's participant. The contract
also accepts ERC-1271 signatures from contract accounts, but the operator does
not check those yet. That includes a MOSS account, which is an EIP-7702
account with code. A learner's MOSS account authorizing this consent is
therefore still unproven.

Once a consented result is final, each operator tick moves its publication
forward through three ordered stages. It opens the attempt, writes every line
as its own final record, and then completes the attempt with `completedAt` set
to `performanceEndedAt`. Every write is an intent in the operator's durable
sender (`services/operator-tx.ts`), persisted before any RPC call, so a crash
or an RPC outage resumes at the first write not yet mined. A stage starts only
after the previous one is mined, and recovery never sends record intents
itself, so their nonces stay in order. A write that reverts marks the
publication `failed` with the stage that reverted.

Several publishers can run at once, because a tick, a recovery and a socket
message may all reach the same attempt. A publisher ends its publication,
`published` or `failed`, only if the stored publication is still the revision
it started with and still pending. A publisher that resumes after a slow
receipt therefore cannot overwrite a correction saved in the meantime.

A correction is a new signed result revision, checked by the same verifier as
the original. It is accepted only once the previous revision is published. The
new result and its pending publication are saved in one transaction, and the
following ticks publish a final correction for the changed line, then a new
completion. The local skeleton exposes corrections only at `/__correct`, a
local control route like `/__fault`. A production correction needs an
authenticated operator path, which does not exist yet.
