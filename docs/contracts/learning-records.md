# Public learning records and streak boards, draft 3

This draft specifies the public records from which anyone can rebuild a
community's learning history and its streak leaderboards, without calling a
community's private API. It is a design contract, not an implementation.
`docs/operator-payments.md` defines payments and the operator's signed
karaoke result; this document defines what of that result, and of other
activities, becomes public and how boards derive from it.

Status: staged specification, not implemented. It follows the owner's
direction for public per-line grades on MegaETH and an aggregator whose
database is a rebuildable index. The recorded approval on 2026-11-04 covered
the shared epoch, prospective
policy activation and terminal records for abandoned attempts. It did not
separately settle wallet identity or Dance streak timing. After review, the
owner asked for the simplest identity and most robust timing. Draft 3 recommends
wallet-linked records with per-attempt consent and first on-chain owner-review
time for Dance. These are proposed v1 defaults, not additional historical owner
rulings or authorization to publish live grades. Section 9 separates these
recommendations from settled rules and implementation checks.

## 1. Where each fact lives

| Data                                                             | Authoritative home                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Community identity, controllers and contract addresses           | the shared community registry                                                                                        |
| Deposits, purchases and ticket closure                           | the community's `OperatorPayments`                                                                                   |
| Per-line assessments, attempt completions, eligibility changes   | the community's `LearningRecords` contract on MegaETH                                                                |
| Lyrics, translations, timings and other substantial content      | content-addressed media/manifests on IPFS; DATA registration remains a separate referenced receipt                   |
| Qualification and streak policies                                | public content-addressed documents, with activation hash, locator and effective period recorded by `LearningRecords` |
| Sessions, jobs, pending transactions, temporary processing state | the community's and operator's operational databases                                                                 |
| Leaderboard rows, current and best streaks, search, feeds        | a rebuildable indexer database; a community may cache them in D1                                                     |

Provider credentials live in deployment secrets and never in a record. No
database may hold the only copy of a fact from which a board is built.

The shared community registry is distinct from each community's name
registry. It is specified separately; this draft assumes it maps a community
to its controller and its `OperatorPayments` and `LearningRecords` addresses.

## 2. Identities

- Learner: proposed v1 identity is the wallet used in that community. It matches
  consent and rewards without a second identity mapping. Its public history can
  be linked across applications and communities that use the same wallet.
  Section 8 defines the consequence and consent; the earlier approval of three
  other clarifications must not be cited as approval of this identity choice.
- Song: the stable local publication identity
  `songKey = (chainId, postsContract, communityId, postId)`. A community song
  streak uses this tuple across metadata edits and external registration changes.
  `communityId` and `postId` alone are its shorthand within a pinned chain and
  posts deployment. Aeneid, DATA or Sui asset IDs are optional grouping references
  with protocol/network namespaces, never the local streak primary key. Keep
  directory/posts addresses stable during ordinary signer rotation. A future
  contract or namespace migration needs an explicit authenticated alias/history
  migration; this draft does not promise IDs survive arbitrary redeployment.
  The local skeleton's `songHash` is a content revision digest, not song identity.
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
  community, learner, attemptId, songKey, contentRevision,
  activity            // line-based karaoke or study; Dance uses its categorical adapter
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

### 3.2 Line-based attempt completion

```text
AttemptCompleted {
  community, learner, attemptId, songKey, contentRevision, activity,
  grader, scoringPolicy, qualificationPolicy,
  completedAt         // Karaoke: signed performanceEndedAt; Study: signed endedAt; Dance adapter: first final owner decision block time
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

Delayed Study/Karaoke publication uses the policy covering `completedAt`, not
the policy active when the transaction lands. Dance's first on-chain decision
sets completedAt and selects that review period's policy. Grade corrections
retain the original
`completedAt` and `qualificationPolicy`, so they recompute the original
period under its original rules. Time corrections are outside this version.
A purchase receipt never qualifies anything: buying lines proves spending,
not singing.

Dance's categorical review needs an activity-specific assessment/terminal
record with owner, pass/fail, submission reference and contract-recorded review
time. It must not fabricate numeric line grades or apply a karaoke linesHash
coverage check to a video. Non-line Study also needs its own adapter. The
line-coverage rules below apply to line-based activities; freeze and test the
other typed record shapes before their implementation. The clock/identity
rules apply to all of them.

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
  selected from the on-chain activation history. For Dance, the contract sets
  completedAt from the first on-chain owner decision; it does not trust a
  client-supplied timestamp for that field. Later grade revisions
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
- Karaoke belongs to the period containing its signed `performanceEndedAt`,
  stored as completedAt: when singing stopped, not when abandonment was
  decided. A performance ending at 16:59:58 UTC belongs to the earlier period
  even if the operator decides abandonment at 17:00:20 UTC. The operator's
  `endedAt` remains the operator decision/payment-lifecycle clock. Study belongs
  to the period containing its signed endedAt. Delayed publication moves neither
  learning day. This mapping does not change the separate reward entry window,
  which currently checks endedAt and acceptance time.
  The signed performanceEndedAt field and its validation are defined in the
  payment specification at 412c098; the repository's payment source manifest
  pins the exact documentation copy. That runtime branch remains unpublished
  at this observation. Implementations must consume and validate this field;
  substituting lastAudioAt or endedAt would change the rule.
- Proposed Dance rule: the first final owner decision records reviewedAt using
  the canonical transaction block timestamp, and sets completedAt=reviewedAt.
  A passing decision earns credit for that period, never for the upload day.
  A failing decision earns none. Submission time remains provenance and cannot
  backdate credit. Both review delay and publication delay affect the credited
  day: an owner approval at 16:59 whose transaction lands at 17:01 counts in
  the next period. A service backlog, wallet/gas failure or chain outage can
  therefore break a streak even after a timely off-chain approval. The UI
  distinguishes awaiting owner review from approved but awaiting publication,
  shows the 17:00 UTC boundary, and explains that credit starts at canonical
  inclusion. This proposal provides no outage grace period or backdating.
  The contract checks owner authority and rejects a reviewer account address
  equal to the learner wallet. It cannot establish account-level self-review
  exclusion across different addresses.
- The community service enforces account-level self-review exclusion before
  accepting/publishing a Dance decision, using its private account-to-wallet
  associations. It rejects the owner reviewing submissions from any wallet
  linked to the owner's account. No public wallet linkage is introduced. A
  second wallet not linked to that account can evade this service check; a
  direct owner contract call can also bypass the service gate. The on-chain
  address check is not proof that two people are distinct. Pirate-funded Dance
  eligibility must separately specify trusted review/account assurance and its
  enforcement; this draft does not grant that eligibility.
- A Dance correction retains the first final decision's completedAt and policy. A
  corrected pass can repair that review period; repeated corrections cannot
  manufacture days. A new performance needs a new attempt. Delayed submission
  of a signed review counts only when its first decision lands on chain, so
  there is no separate trusted off-chain approval timestamp to reconcile.
  A reorg rolls back the orphaned decision before the canonical one is applied.
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

Local boards group by the immutable songKey publication tuple. A registration
change, a second registration or a migration from Aeneid to another network
must not create a new local streak. A distinct repost has a distinct postId
and is a different local streak unless a future explicit merge policy says so.

A board spanning communities may group selected songKeys through optional
external asset references or an explicit alias set. Its public, versioned
policy identifies accepted protocols/networks, registration receipts, aliases,
communities, graders and qualification policies. Never infer that two assets
are the same merely because their title or media hash matches. A registration
migration changes that grouping only through a published alias/policy update;
local period sets remain unchanged. Absent that policy, boards stay per community.

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

The shared fixtures include an Aeneid registration replaced by a Sui reference
without splitting the same local songKey's streak; identical postId values on
different communities/deployments remaining distinct; an upload before 17:00
with a passing Dance decision after 17:00 earning the later period; singing
ending at 16:59:58 with payment decision/finalization after 17:00 retaining the
earlier Karaoke period; off-chain Dance approval at 16:59 with publication at
17:01 earning the later period, including publishing backlog/outage; a failed
Dance decision corrected without changing its original review period; and
repeated attempts in one period; five songs
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

Under the proposed wallet-identity default, records are public and permanent,
linked to the learner's address. This is the simplest interoperability model,
not a privacy-preserving one. The existing reward flow separately exposes
claimant wallets; private grades would not make those entries private. Unpaid,
silent, unmeasured and unattempted lines carry no score, so missing data never
reads as inability. Recordings are never published. A Telegram guest's
attempts are published only after the learner attaches a wallet and consents.
Erasure is not possible once published, which needs a counsel read before
mainnet.

## 9. Remaining implementation checks

The protocol-wide clock, on-chain policy activation and publication of failed
and abandoned attempts are decided. Wallet-linked learning identity and Dance
credit on first on-chain review day are the recommendations in this revision,
responding to the owner's request for simplicity and robustness. They are not
relabelled as part of the earlier three-item approval. No real public records
may be emitted merely because this draft exists; implementation must establish
its accepted publicity policy and actual per-attempt learner consent.
Qualification is derived initially;
storing leaderboard calculations on chain is not required. Events publish the
full history, with contract storage driven by enforcement and identified
contract readers as section 4 specifies.

Dance acceptance must separately test same-address rejection on chain and
linked alternate-wallet rejection in the service. Include the distinct-address
case the contract cannot reject and the direct-call bypass of service checks;
do not report either as account-level on-chain enforcement. These are required
implementation tests, not tests run for this document.

The MOSS integration must demonstrate learner-controlled consent verification
on chain, through a supported account signature or an account transaction.
A community attestation is a different trust model and is not an automatic
fallback when verification fails.

Before implementing `LearningRecords`, define its manifest commitment and
membership checks, exact stored fields and contract read methods, then measure
their gas on MegaETH. The two-indexer acceptance in section 7 remains to be
built and run. Practice mode remains an optional proposal and is not assumed
here.
