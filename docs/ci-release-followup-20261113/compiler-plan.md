# Compiler memoization review

This is a read-only design for Operators. The audited source is canonical a88ae60. The previous audit branch is chore/ci-test-signal-audit-20261113 at 98f8542; its Testing behavior instructions were read through Git. Its retired worktree no longer exists. No compiler, test suite, network operation or repository mutation was run during this continuation review.

## Decision

Use transparent, process-local memoization of the last successful complete compiler input, with compiler version included. Do not add a test-only option, environment switch, export or persistent cache.

Every compile call must read all eleven contract files and serialize the complete compiler input before considering reuse. Compare the full serialized input and solc.version() directly against one retained entry; a cryptographic hash is unnecessary for one bounded entry. Keep serialized artifact JSON in that entry and parse a fresh result for each caller. This prevents caller mutations to nested ABI arrays or bytecode fields from poisoning the next result. Only successful compilation and artifact extraction can update the entry.

Preserve the current output side effect on every invocation: create .local/artifacts and write contracts.json from the current result. A repeated call after the directory is removed must recreate it. Keep the exact emitted JSON formatting if preserving artifact bytes is part of acceptance. Do not read that file as cache input.

The current file is also used by three manual testnet deploy scripts. Each imports compile and calls it once in a fresh process, so its first compile remains fresh. Exact-input reuse on a later same-process invocation is deterministic and does not weaken source binding. Acceptance runs in two separate Node processes also remain independently compiled. No persistent artifact can influence a future invocation.

## Callers and expected benefit

harness/chain.ts calls compile once for every local chain it creates. test/payments-fixture.ts merely forwards startChain to that function. Manual callers are harness/megaeth/deploy-payments.ts, deploy-records.ts and deploy-results-v2.ts, each with one call. Direct test callers are test/learning-records-encoding.test.ts and test/manual-rewards-guard-bytecode.test.ts.

The default Node runner isolates test files in separate processes, so a memory memo does not save the first compile in another file or shard. It does save repeated chains within a file. test/learning-authorization-chain.test.ts creates seven chains, so six identical compilations can be avoided. test/study-operator.test.ts creates five chains through learningBindingFixture. test/learning-direct-revoke-v3.test.ts has six studyPublicationFixture calls plus two learningBindingFixture calls, all eventually creating chains. test/study-community.test.ts creates four chains. test/study-publication-recovery.test.ts creates five. test/study-private-publication.test.ts creates four. Additional Study retention/revision/consent fixtures and parameterized withheld-result scenarios create more chains in their own files.

The earlier standalone baseline compiled all eleven exact source inputs into twenty artifacts in 7.233 seconds wall and 8.468 seconds process CPU. Its input SHA-256 was b447538209cdfcba0a3d7421c0cf14a753c353f9e429c75bfc25589e0e865dbf; artifact JSON SHA-256 was a40eb781897d97018f51f2ce5e499d1007c41bc340e2bf9842e1fa6b060c1632. This is dated evidence, not a new benchmark. Six avoided compilations suggest roughly 43 seconds saved in the authorization file; actual CI savings require before/after measurement on the same environment. This estimate excludes process startup, deployments, provider simulations and fixture setup, which remain unchanged.

## Failure modes, written before implementation

A source changes after a successful call, including an equal-length edit with unchanged timestamp. A cache based on file metadata, names or the first call would return stale bytecode. Full content must be read again.

A source disappears, loses readability or the caller changes working directory. Reuse must not hide the current read error or serve an artifact for a different current source tree. Output belongs to the current working directory.

Compiler version, optimizer settings, EVM target, metadata configuration, source names or requested output selection change. All must participate in the exact input identity. Never key only the main contract or its bytecode.

A caller edits the returned artifact map, replaces bytecode, mutates an ABI entry or adds/removes a contract. A later caller must receive an independent, valid result, including on the first successful return.

A changed source does not compile. The error must propagate rather than falling back to the last good artifact. A failed parse, missing compiler output or failed artifact extraction must not become a successful entry. Restoring the exact previous source may safely reuse its still-valid prior result.

A caller removes the output directory between calls, or output writing fails. Reuse must retain directory creation and write/error behavior. A memo hit must not silently skip a required artifact write.

Repeated variants must not grow a process-wide cache without bound. Retain only one entry. Do not add cache management exports solely for tests.

Different Node processes already write the same .local/artifacts/contracts.json path. The proposed memo does not share data between processes and does not resolve that existing file-write race. Current consumers use the returned object, and repository search found no reader of that path. An atomic-write improvement would be separate work with its own evidence; it is unnecessary to make process-local reuse correct.

## Real integration probes to write before implementation

Use a temporary contracts tree and import the real compile function. Run each probe in an isolated subprocess with its working directory set to that tree. Resolve solc from the real project. Keep private keys, remote RPCs and managed state out of the probe. Do not mock solc or add a compiler-call counter/export. Write a JSON receipt containing compiler version, exact input/artifact digests, outcomes and timings at the end.

First, compile the exact tree twice and compare complete returned artifacts to a direct independent standard-JSON solc invocation with the documented settings. Mutate nested ABI data and bytecode on the first returned object before the second call. The second result and the written artifact must still equal the independently compiled output. This protects the caller-visible ABI/bytecode contract rather than an internal cache shape. If stronger independence is preferred, deploy the returned TestPaymentToken to local anvil and read its decimals getter, which must be six.

Second, change contracts/test/PaymentToken.sol from decimals = 6 to decimals = 7 in the temporary tree, preserving file length and timestamps. Compile through the same already-imported function. Deploy returned token bytecode to local anvil and read decimals as seven, or compare the complete result with a fresh direct compiler result for that changed source. Then make the source syntactically invalid and require compilation to fail despite the prior successful result. Remove one required source and require the filesystem error. Restore the exact original tree and require a valid original artifact again. A single integration scenario can cover these transitions without a family of implementation-mirroring unit tests.

Third, remove only the temporary .local/artifacts directory between identical calls. The second call must recreate contracts.json with bytes matching its returned artifacts and the previous artifact. This protects the function's existing filesystem effect.

Run the same behavioral probes before and after memoization. They need not fail before a performance-only change; their job is to prevent changed behavior. Separately benchmark seven identical compile calls in a single fresh process before and after, retain each duration and artifact digest, and require digest equality. Report the measured difference without hard timing assertions in ordinary CI. A timing threshold would be flaky and would not protect product behavior.

Compiler version and settings identity can be reviewed directly in the small implementation. Do not install another compiler or mock its version just to manufacture a test. Existing chain/payment/sign-in integration suites remain the higher-boundary acceptance for deployable artifacts.
