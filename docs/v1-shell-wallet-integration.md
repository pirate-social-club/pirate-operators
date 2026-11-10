# Shell and wallet integration

The first slice combines the established community shell with the learner wallet.
Its base is b2f15cbd685e310b623da96f4fe0f840425527c3, whose tree equals the
reviewed deployed67cbe11. The original shell and wallet checkpoints are retained
as merge parents. No media, Dance, new grader, onboarding or production activation
is included in this slice.

The independent author-source review found two wallet defects. Hosted Send
navigation previously retained a journal that could never clear after success.
The integrated version coordinates an in-flight opening and preserves honest
uncertainty/history guidance while allowing a later deliberate visit. It never
automatically retries a transfer. The separate guarded-payment lifecycle and
server reward ledger are unchanged.

Receive previously generated its QR only once while displaying a reactive
address. The integrated view keys its immutable address/QR snapshot to account,
chain and token and discards late work after cleanup. A wallet identity change
closes the sheets, clears claim/verification context and reloads the account
session before creating new CSRF-bound data.

Close readiness lives in the shared pure rewards package. The operator API uses
an optional confirmed-cutoff clock; absence, invalid data or an unavailable read
cannot unlock closing or hide balances/liabilities. Normal runtime supplies
the same chain-checked safe-head client used by qualification. Explicit fixture
ports do not silently contact a public RPC. The existing Close handler remains
authoritative. The UI waits at cutoff until safe-head confirmation and exposes
the reason and refresh path.

Focused unit and fixture-browser checks are local/simulated evidence. Full
required checks, exact integrated-source review, hosted CI, dry plan, fresh live
preflight and serial release/readback remain separate gates. No real MOSS,
personhood, provider, song-upload or physical-device acceptance is inferred.

The final integrated review additionally found that a stalled confirmation
refresh could leave Close enabled beyond the evidence lifetime. The successor
adds a reactive expiry clock, a click-time freshness check, a bounded overview
request and a bounded refresh that releases polling after failure. Regressions
exercise expiry without another response and a stalled polling request.

The shell restores direct activity routes on reload. Karaoke acceptance must
resume the already restored screen rather than click the covered background
Sing action. The delayed-metadata test installs interception before reload; its
same-ticket, generation, clock, new-audio and later-grade checks remain.

The release source map now includes every owned client source directory,
including shell and wallet. The new v27 predecessor pin copies the exact
previously executed plan at live profile0x3099aa2c. It does not execute a release
or activate another feature. Initial full-root verification reported1020 passes,
37 failures within three fixed-port suites, and one skip while an unintended
Telegram broad run overlapped. That non-green log is retained; isolated retries
and remaining Solidity/acceptance gates are required. The initial separate
Karaoke route failure and stopped obsolete delayed-reload suite are also
retained. Corrected complete suites, independent final review and exact-head
CI remain release gates.
