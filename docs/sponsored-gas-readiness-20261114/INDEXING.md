# Aggregate feeds, leaderboards and streaks: isolated read-model plan

Goldsky documents Subgraphs and Turbo support for MegaETH testnet/mainnet. This establishes a candidate, not an existing configured pipeline, free account or D1 sink. Pin the actual testnet network/dataset version, project, ABI, contract start blocks and supported destination before provisioning. Choose one ingestion route first: Subgraph entity queries, or Turbo canonical events into a supported query store. Do not claim the SQL below is Goldsky's supplied schema. [Goldsky MegaETH](https://docs.goldsky.com/chains/megaeth), retrieved 2026-11-14.

Use an isolated project and test deployments. Public source references are [feed-indexing.md](https://github.com/pirate-social-club/pirate-operators/blob/af70dc7e744c2f4b4886802e4b78125d3eb79444/docs/contracts/feed-indexing.md) and [board.ts](https://github.com/pirate-social-club/pirate-operators/blob/af70dc7e744c2f4b4886802e4b78125d3eb79444/harness/reference-results/board.ts), both pinned to pirate-operators af70dc7e744c2f4b4886802e4b78125d3eb79444. Neither is newly executed or audited by this documentation publication. Feed existence and reducer existence are not product acceptance.

## Proposed model

Raw log identity = chainId + contract + blockHash + transactionHash + logIndex. Preserve canonical block ancestry and removed/orphaned status. Every projection carries source/deployment profile, reducer version and safe high-water hash. A query chooses a canonical safe head and evaluation timestamp; no mixing old materialization with a newer unexplained head. Backfill and live ingestion share idempotent ordering and undo semantics.

Directory projection indexes stable community ID/key, chain-specific directory instance, installation/origin and namespace/source binding, current configuration and verification revisions, listed state and verification expiry. Shared registry projection indexes namespace authority, full-name/generation, permanent claims, transfers, records and locked expiry. NFT history is distinct from current resolution eligibility.

Feed projection follows canonical current configuration and authenticated public post manifests. Reconstruct publisher revocation/history as defined by the actual configuration chain; never trust only the latest publisher list. Verify manifest bytes/hash/schema/size and URI fetch policy before exposing content. Unknown or missing revisions fail closed, not silently truncated. Local source joins must reconcile the newly corrected paged cache/migration gates.

Discoverability is evaluated at query time: listed, matching verified configuration revision, required flags, current verification validity and admitted profile. Resolver eligibility separately needs current registry authority and name lifecycle. Do not conflate directory discoverability with every registry condition, or claim an expiry event exists. A scheduler may refresh projections, but query-time expiry remains mandatory.

## Concrete queries to qualify

These are contracts for OUR proposed read model, not a deployed GraphQL API:

- Aggregate feed: select authenticated public posts whose community is currently discoverable under the selected safe projection; order by (blockNumber, transactionIndex, logIndex, contract) descending; keyset cursor includes safe-head hash and filter digest.
- Community feed: same canonical post history scoped to community/install. Distinguish direct access policy from aggregate discoverability; a delisted community must not silently lose its immutable history.
- Name view: show holder and generation separately from active/grace/released and fresh-authority resolution status. Transfers do not erase the original consumed claim.
- Daily qualification: reduce latest non-invalidated session revision, canonical contract/community, policy effective at that period/activity, authorized graders/scoring policy, terminal status, measured outcomes and learner eligibility. Do not count arbitrary ResultPublished events.
- Streaks: on qualified DISTINCT (board, learner, period), compute islands with period - row_number ordered by period; current streak ends in current or previous period, best is max island length. Match existing reducer's scoped eligibility and ties.
- Leaderboard: use the existing versioned ranking metric/tie semantics and policy, not an invented raw “number of logs.” Never infer cross-community learner identity beyond the explicit wallet/consented mapping.

LearningResultsV4 fixes epoch 1793552400 and period length 86400 seconds: a 17:00 UTC boundary. Do not substitute midnight or local time. Test exact boundary minus/at/plus one second, corrections/invalidation, late arrival, policy changes, eligibility revocation, multiple events in one period, missing periods and shared ranks. Cross-community/song views need explicit duplicate/identity semantics; compare the independent reducer before claiming parity.

## Minimal acceptance dataset

Two admitted test communities with distinct namespaces/installations; a repeated label under different namespaces; two posts per feed plus one revoked publisher; learners with duplicate sessions, gaps and tied ranks; one invalidated/corrected result; configuration change requiring re-attestation; authority and name expiry without logs; one reorg and duplicate/backfill delivery. All proposed, UNRUN.

Compare queries against canonical receipts plus existing reducer outputs at fixed evaluation timestamps. Measure ingestion lag, reorg repair, RPC calls, manifest fetches, storage growth and query latency separately from gas. No member secrets, private training data or payment signatures belong in the public index. Failure of this optional exploration adds no new rollout gate.
