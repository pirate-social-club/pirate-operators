# Public learning records and streak boards, draft 2

This draft specifies the public records from which anyone can rebuild a
community's learning history and its streak leaderboards, without calling a
community's private API. It is a design contract, not an implementation.
`docs/operator-payments.md` defines payments and the operator's signed
karaoke result; this document defines what of that result, and of other
activities, becomes public and how boards derive from it.

Status: staged specification, not implemented. It follows the owner's
direction for public per-line grades on MegaETH and an aggregator whose
database is a rebuildable index. Draft 2 records the owner-approved review
clarifications of 2026-11-04. Section 9 distinguishes settled rules from the
remaining implementation checks.

## 1. Where each fact lives

| Data | Authoritative home |
|---|---|
| Community identity, controllers and contract addresses | the shared community registry |
| Deposits, purchases and ticket closure | the community's `OperatorPayments` |
| Per-line assessments, attempt completions, eligibility changes | the community's `LearningRecords` contract on MegaETH |
| Lyrics, translations, timings and other substantial content | content-addressed manifests, through the data protocol and IPFS, referenced by hash |
| Qualification and streak policies | public content-addressed documents, with activation hash, locator and effective period recorded by `LearningRecords` |
| Sessions, jobs, pending transactions, temporary processing state | the community's and operator's operational databases |
| Leaderboard rows, current and best streaks, search, feeds | a rebuildable indexer database; a community may cache them in D1 |

Provider credentials live in deployment secrets and never in a record. No
database may hold the only copy of a fact from which a board is built.

The shared community registry is distinct from each community's name
registry. It is specified separately; this draft assumes it maps a community
to its controller and its `OperatorPayments` and `LearningRecords` addresses.

## 2. Identities

- Learner: the wallet address the learner uses in that community. Publishing
  links that address's history across every application that reads the
  chain; that is the interoperability chosen, and section 8 covers consent.
- Song: `songId`, the data-protocol asset identity, which survives metadata
  edits. The community's publication ID and the content revision are separate
  fields. The local skeleton's `songHash`, a digest of the whole song object,
  is not a stable identity: editing a title would reset its streaks.
- Content revision: the manifest hash the attempt was scored against.
- Line: the occurrence ID and version from that manifest.
- Attempt: `attemptId`, as in the operator's result.
- Grader: the operator address that signed the assessment, with its scoring
  policy version.

## 3. Record types

These are proposed shapes. Each is an event; the contract also keeps the
minimal state needed to enforce the rules in section 4.

### 3.1 Line assessment

```text
LineAssessed {
  community, learner, attemptId, songId, contentRevision,
  activity            // "karaoke", "study" or "dance"
  lineId, lineVersion,
  grader, scoringPolicy,
  status              // "assessed" | "silent" | "unpaid" | "unmeasured" | "unattempted"
  scoreBps            // integer 0..10000, or none
  finality            // "provisional" | "final"
  revision, supersedes
}
```

Lines may be submitted one at a time or in batches; the contract accepts
either. A provisional record may be superseded by a final one, and a final
record only by an explicit correction with a higher revision. No numeric score
is published for a line before it is paid, as `docs/operator-payments.md`
section 5.6 requires.

`unattempted` means the learner never reached that line before the attempt
ended. It carries no score and is distinct from silence during a reached
line, a missing payment, or a grader measurement failure. It is not an
operator-failure exclusion from the reward denominator. For this public
record, an unreached line is `unattempted` even if it was paid ahead of time;
the purchase remains independently visible in `OperatorPayments`.

### 3.2 Attempt completion

```text
AttemptCompleted {
  community, learner, attemptId, songId, contentRevision, activity,
  grader, scoringPolicy, qualificationPolicy,
  completedAt         // the operator's endedAt, pinned on first completion
  status              // "completed" | "abandoned" | "expired" | "payment_missing"
  linesHash           // JCS hash of the final line revisions that make up the attempt
  linesTotal, unmeasuredCount, rewardScoreBps
  revision, supersedes
}
```

A completion names exactly the final line revisions it covers, so an indexer
can check it against the line records. It is accepted only after every line of
the manifest has a final record.

Failed, abandoned and expired attempts retain their paid assessments and
publish a terminal completion with the appropriate status. Before that
completion, each remaining line receives its final status; unreached lines
are `unattempted`, never a fabricated numeric zero. A completion-only record
cannot bypass the manifest coverage rule. Publication does not itself earn
streak credit: the pinned qualification policy explicitly lists accepted
terminal statuses, activities and coverage requirements.

### 3.3 Eligibility change

```text
EligibilityChanged { community, learner, eligible, effectiveAt, reasonCode }
```

Excluding a learner from a community's boards is a public event, so indexers
reproduce the official board. It never removes or hides their records.

### 3.4 Qualification policy activation

```text
PolicyActivated {
  community, policyHash, policyURI,
  effectivePeriod, clockVersion   // clockVersion is 1 in this draft
}
```

Only the community controller may activate a policy. `policyURI` locates its
public content-addressed document, whose bytes must match `policyHash`.
An activation must be included before its effective period begins.
`effectivePeriod` must increase strictly; an activation cannot replace an
announced policy or change a current or past period. The initial policy
follows the same rule. Earlier periods without a policy earn no qualifying
credit, although their learning records remain public. An unavailable or
hash-mismatched document leaves qualification unresolved; indexers must not
substitute a current policy or a private API response.

### 3.5 Derived qualification

Qualification is derived, not recorded: an indexer applies a published
qualification policy to final completions. A policy document states its
version, the terminal statuses, activities and grader policies it accepts,
the coverage and threshold rules
(for karaoke, the fixed-denominator reward score and unmeasured limit of
`docs/operator-payments.md` section 6), and the protocol clock in section 5.
For an attempt's completion period, select the activation with the greatest
`effectivePeriod` not greater than that period. `qualificationPolicy` in the
completion must match that policy hash, or be empty if no policy covers the
period. This differs from `scoringPolicy`, which identifies how the grader
produced its assessments.

Delayed publication uses the policy covering `completedAt`, not the policy
active when the transaction lands. Grade corrections retain the original
`completedAt` and `qualificationPolicy`, so they recompute the original
period under its original rules. Time corrections are outside this version.
A purchase receipt never qualifies anything: buying lines proves spending,
not singing.

## 4. Write rules

- Only graders the community has authorized for an activity may write line
  assessments and completions for it.
- A learner's publication consent covers one attempt and binds learner,
  community, attempt, song, content revision, grader and scoring policy, with
  chain and contract replay protection. The first record for an attempt checks
  it; later records must belong to that attempt and come from its grader.
- A completion is refused unless every manifest line has a final record, and
  its `linesHash` matches those records.
- The first completion binds `completedAt` and the qualification policy
  selected from the on-chain activation history. Later grade revisions
  cannot change either. A terminal status never substitutes for missing line
  records.
- Corrections supersede explicitly; nothing is rewritten in place. A reward
  already settled from an earlier revision stays settled; the correction is a
  new fact for future reads.
- Only the community controller writes eligibility changes.

The initial contract stores the state needed to enforce authorization,
attempt identity, revision order, manifest coverage, completion binding and
policy activation. Events carry the full public assessment and completion
history. Streak totals and rankings remain derived. Add stored assessment
fields when an identified contract consumer needs to read them; event-only
history is sufficient for an indexer but is not a substitute for contract
read methods. The implementation must specify how the pinned manifest's
line commitment is verified before claiming on-chain coverage enforcement.

## 5. Days and streaks

Every community and indexer uses one shared learning day, aligned with
Megapot's documented daily drawing at 17:00 UTC. No per-learner timezone is
published.

- Clock version 1 fixes `epochStart = 1793552400` (2026-11-01 17:00 UTC) and
  `periodSeconds = 86400` for every community and indexer. These are protocol
  constants, not per-community policy choices. A learning day runs from
  17:00 UTC inclusive to the next 17:00 UTC exclusive. For timestamps at or
  after the epoch, compute
  `periodId = floor((completedAt - epochStart) / 86400)`. With that epoch, a
  completion at 2026-11-04 16:59:59 UTC is period 2 and one at 17:00:00 UTC is
  period 3. Earlier timestamps are outside this version's streak clock;
  implementations must not allow unsigned subtraction to wrap.
- An attempt belongs to the period containing its signed `completedAt`.
  Transaction inclusion time never decides it, so a delayed publication does
  not move the day.
- The boundary follows Megapot's scheduled time, not its actual drawing
  transaction, so a delayed drawing neither stretches a learning day nor
  breaks streaks. Version 1 stays at 17:00 UTC even if Megapot changes its
  schedule. Any future protocol clock change must define a shared transition
  boundary and preserve consecutive period numbering with no gaps, overlaps
  or renumbering of history. A community policy cannot change the clock.
- A qualifying attempt earns one song day for its song and one community day.
  Repeated qualifying attempts in the same period add nothing. Qualifying on
  five songs in one period earns one community day and up to five song days.
- Current streak counts consecutive periods ending in the current or the
  previous period. Best streak is the longest run.
- Ranking orders current streak descending, then best streak descending.
  Equal scores share a rank and leave gaps. Ineligible learners take no rank
  position.
- Interfaces show the 17:00 UTC reset in the learner's local time; the
  boundary itself never varies.
- Study, Karaoke and Dance all qualify in the centralized app; each community
  policy says which activities it accepts.

The ranking and same-day rules match the centralized app, verified in
api-next at origin/main. The shared boundary does not: the centralized app
uses each account's timezone.

Reward eligibility has its own cutoff, set by the reward policy with enough
time to publish records and enter the intended drawing. A late-published
assessment can still repair a learner's streak for its period, but never
enters a drawing that has already closed.

## 6. Cross-community song boards

A song board spanning communities groups by `songId`. It needs an explicit
policy listing the communities, graders and qualification policies it
accepts, published by whoever runs the board. Absent that policy, boards are
per community.

## 7. Indexer contract

An indexer reads the community registry, then each community's
`LearningRecords` and `OperatorPayments` events and the referenced manifests
and policies, including the public policy activation history. It keeps only
rebuildable rows. A board snapshot identifies its chain head by block hash,
evaluation timestamp, clock version and board policy. Current streak and
time-dependent eligibility use that evaluation timestamp, not each indexer's
wall clock. Events are read in block, transaction and log order. An indexer
rolls back a replaced chain suffix before rebuilding against a new head.

Acceptance requires two independently implemented reducers, each starting
with an empty database and given only the same registry, chain history through
the same block hash, referenced public documents, board policy and evaluation
timestamp. They must produce identical qualifying period sets, current and
best streaks, eligibility and ranks for community and song boards. Canonical
comparison sorts rows by board identity and learner, without breaking shared
ranks. Neither reducer calls a community's private API or shares derived
rows or reduction code with the other.

The shared fixtures include repeated attempts in one period; five songs
earning five song days but one community day; completions at 16:59:59 and
17:00:00 UTC; publication after a policy change; a provisional grade replaced
by a final grade; a later correction that repairs a prior streak under its
original policy; an abandoned attempt with retained assessments and
unattempted lines; tied ranks; eligibility changes; and a replaced chain
suffix. Both reducers must reject retroactive policy activation and refuse to
invent qualification when the policy document is missing. Repeat the snapshot
at the next day boundary without new attempts to verify current streak expiry.
These are implementation acceptance requirements, not tests already run.

## 8. Privacy

Records are public and permanent, linked to the learner's address. Unpaid,
silent, unmeasured and unattempted lines carry no score, so missing data never
reads as inability. Recordings are never published. A Telegram guest's
attempts are published only after the learner attaches a wallet and consents.
Erasure is not possible once published, which needs a counsel read before
mainnet.

## 9. Remaining implementation checks

The protocol-wide clock, on-chain policy activation and publication of failed
and abandoned attempts are decided. Qualification is derived initially;
storing leaderboard calculations on chain is not required. Events publish the
full history, with contract storage driven by enforcement and identified
contract readers as section 4 specifies.

The MOSS integration must demonstrate learner-controlled consent verification
on chain, through a supported account signature or an account transaction.
A community attestation is a different trust model and is not an automatic
fallback when verification fails.

Before implementing `LearningRecords`, define its manifest commitment and
membership checks, exact stored fields and contract read methods, then measure
their gas on MegaETH. The two-indexer acceptance in section 7 remains to be
built and run. Practice mode remains an optional proposal and is not assumed
here.
