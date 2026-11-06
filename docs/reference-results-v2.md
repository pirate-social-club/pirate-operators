# Independent V2 public reconstruction

This is an offline acceptance program, not another hosted indexer or application
dependency. Both implementations start empty with the same raw public logs,
receipts, block metadata, contract code/views and IPFS document bytes. No private
community database, history export, transcript or service API is an input.

The original path uses the existing JavaScript result/source/board readers and
its own policy and eligibility assembly. The reference path separately checks
the raw evidence, source membership, complete ordered coverage, outcomes,
enrollment history, corrections and completion policy. It derives days and
streaks using in-memory SQLite grouping and windows, and ranks with SQL RANK.
It calls none of the original reduction or source-verification functions. Raw
transport, ABI/type facts and cryptographic primitives are shared. Neither path
receives the other's normalized or filtered learning rows.

Invalidation preserves the original wire grades but removes the active score
and qualification. Controller restoration keeps the original completion day and
policy. An unavailable activated policy remains unresolved instead of falling
back. Unmeasured outcomes have null grades and leave the fixed denominator;
silent, unpaid and unattempted outcomes have null grades and remain in it.
The learning epoch stays at 17:00 UTC. Evaluation time is explicit and can move
forward without another performance. Replaying a replacement chain starts with
an empty database and cannot retain orphaned days.

Capture and replay are manual read-only operations:

```sh
node harness/reference-results-v2.ts --read --output .local/public-capture
node harness/compare-results-readers.ts --snapshot .local/public-capture/raw.json --output .local/public-comparison
node --test test/reference-results.test.ts
```

The capture command is fixed to MegaETH testnet. It accepts an explicit confirmed
block with --head and Unix evaluation time with --evaluate-at. Output directories
must be new so earlier evidence is never replaced. The comparison retains source
hashes, both independent outputs and the raw-input digest. It compares individual
statuses/grades, revisions and commitments as well as period sets and boards.

The retained pre-policy public input reproduces all 23 outcomes and score 7800,
with no qualifying day. Twelve tests cover that real input and explicitly
synthetic correction, policy, clock, eligibility, reorg and malformed-coverage
cases. The separate five-song SQL unit verifies one community day and five song
days. Synthetic traces are not live honest performances. The scoped independent
[review](evidence/reference-results-v2-20261106/review.md) and frozen file manifest
are retained alongside the qualification evidence.

This implementation understands V2 Karaoke only. It refuses an unconfigured or
unsupported historical result contract. V3 Study selected-exercise semantics,
cross-version reconstruction and the intended post-policy live cases still need
their own qualification before any corresponding official-board claim. Matching
results establish deterministic reconstruction from the evidence; signatures and
events still do not establish honest singing or unique personhood.
