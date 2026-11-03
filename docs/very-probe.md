# Very credential diagnostic

This manual probe prepares the next identity experiment. It does not replace
the fake reward attester, issue a reward attestation, authenticate a wallet or
call a chain. One live four-request run passed on 2026-11-03, as recorded below.
M3 remains incomplete.

## Observed live result

The [redacted observation](evidence/very-probe-2026-11-03.json) records a run of
source `7b8a4eb702ab21fe125f34702385d1fac3033d7c` with one existing enrollment.
All four proofs matched the requested fields and received `valid` from Very's
hosted verifier. The candidate nullifier stayed the same across the first three
requests, including the changed participant binding, and differed in the fourth
request's other scope. No raw proof, nullifier, application ID or bridge secret
is included in the artifact.

This is an unsigned operator observation, not a cryptographically replayable
proof transcript. It supports the tested credential's stability and scope
separation. It does not establish unique enrollment per person, cross-device
or recovery behavior, real-wallet authentication, production pool-scope
derivation or direct verification on Base. The real reward attester is still
unimplemented, and the pool continues to use the fake credential in its harness.

## Run

After installing dependencies, use an existing Very application's public ID:

```sh
npm run very:probe -- --live --app-id <existing-public-app-id>
```

Open the printed loopback URL on this computer. The process binds only to
127.0.0.1 and stops after 30 minutes. It contacts Very only after pressing
Start, then polls the bridge and independently asks the hosted verifier to
check the completed proof. No API secret is requested. Do not create another
enrollment to run this experiment. Use the same existing enrollment throughout.
An optional `--port` keeps the URL stable across restarts; the previous process
must release that port first. A restart still discards its in-memory comparisons.

Complete the four requests in order using the Very app. Each QR expires after
five minutes. A failed request can be retried; clearing the run discards all
observations. A new request always has a fresh random 128-bit pseudonym. The
QR includes a temporary AES key, so scan privately and do not share it.
Download the redacted report after all four requests finish, then stop the
process. The tool writes no proof files or browser storage.

The Start button is disabled while a request is pending. Interrupted browser
polling retries automatically, including after a reload during verification.
Refreshing preserves the running process's observations; clearing or stopping
the process does not. Failure messages identify the failed stage and a fixed
error code, without displaying provider bodies or proof values. Phone success
alone does not mean the server accepted that request.

The cases are the same participant and scope twice, another participant label
in the same scope, and the original participant label in another scope. These
are diagnostic labels, not connected or authenticated wallets. All four
requests use fresh challenge values, including the repeat. This tests whether
the candidate nullifier stays independent of the challenge used to bind a
request to a participant. It does not test whether the app accepts a literal
160-bit wallet address as its pseudonym.

The two external scopes are numeric diagnostic constants 1000001 and 1000002.
They are not real pools or the production pool-scope encoding. Never reuse this
tool's scope or timestamp policy as a rewards policy.

## What a result means

A completed report records four successful hosted-verifier responses and three
comparisons. The first three candidate nullifiers should agree; the fourth
should differ. False comparisons are evidence against the proposed semantics,
not a successful integration. A transport or binding failure records no
observation. The report distinguishes live and fixture modes explicitly.

Even four matching observations cannot prove one credential per person. They
only describe the one enrollment used by the operator. Duplicate enrollment,
account recovery, multiple devices, issuer rotation and revocation remain
unestablished. The fixed timestamp range is a format probe, not a fresh scan or
liveness requirement. The operator's assertion that one enrollment was used
is not independently verified by this tool.

Very's hosted verifier remains trusted for proof validity and issuer policy.
No Very-specific Base verifier, verifying key or equivalent issuer/revocation
policy has been established from the reviewed sources. A generic Groth16 or
Galxe Solidity verifier is not sufficient evidence of that compatibility.

The observed run supports proceeding to a real attester: authenticate the
claimant, apply the [versioned chain/pool/drawing mapping](very-reward-scope.md),
bind a one-use challenge to that claimant and request, verify Very, then
sign only that exact scoped registration. The RewardPool already trusts an
attester key; this probe deliberately has no such key. The mapping has frozen
vectors but still needs provider acceptance in the real registration flow.
The [assurance notes](very-assurance.md) separate this result from freshness,
liveness and enrollment deduplication, with a controlled test plan.

## Proof and transport boundary

The parser accepts only the observed Groth16/bn128 JSON envelope and ten
canonical decimal public signals. Coordinates are bounded by the BN254 base
field; public signals by its scalar field. Signal 2 is the nonzero candidate
subject/nullifier. The parser checks type, context, external scope, pseudonym,
expiry bound, equality-check result and condition bounds against the request.
The hosted verifier is responsible for cryptography and issuer key policy.

The observed external-scope signal is SHA-256 of the UTF-8 numeric query scope,
reduced modulo the scalar field. Launch context is the previously working
`VeryAI - Palm Verification Timestamp`; proof context remains the legacy
numeric context. Public docs instead show a `Veros` launch context. A mismatch
fails closed; the probe does not silently relax fields or try alternate contexts.

The transport follows the published widget: AES-256-GCM with a 12-byte IV,
POST to the fixed bridge sessions endpoint, a `veros://verify` QR, polling the
fixed session endpoint, and POST `{proof: <JSON string>}` to the fixed verifier.
Only a successful HTTP response with top-level status `valid` is accepted.
Redirects, oversized responses and unknown states fail closed. Provider errors
are replaced with fixed messages so handles and proof bodies cannot enter logs.
The bridge's normal pre-scan status is `initialized`, observed in an unscanned
transport-only diagnostic on 2026-11-03. It is a waiting state alongside
`pending`, `received` and `processing`; none establishes a verified observation.

The loopback page requires the exact Host, Origin and a random CSRF token for
every action. It loads no remote scripts, images or fonts. Provider URLs cannot
be changed through the browser or CLI. Overlapping calls are single-flight;
late results after reset or expiry cannot become observations. The provider
may retain whatever its own service receives; local redaction is not a claim
about provider retention.

Raw proofs, nullifiers and bridge data are not written to reports or logs.
Temporary keys are cleared when a request ends. Nullifier strings are released
after comparison or reset; JavaScript garbage collection does not guarantee
secure memory erasure. The browser necessarily sees the QR's bridge handle and
temporary key. Do not capture a real QR in screenshots or browser traces.

## Provenance and validation

Reviewed on 2026-11-03: [Very's ZK integration documentation](https://very.org/docs/developers/zk-integration)
and the published [@veryai/widget 1.0.22 package](https://www.npmjs.com/package/@veryai/widget/v/1.0.22).
Its tarball SHA-256 is
`03e5393794a5cd454db4fc6ada4798548b98be13ee2e60d5301ea061170e55c4`;
the inspected dist/index.js SHA-256 is
`f07e255ce2ced85717ab0cd0d2f0f86f771f765a5841d4c3d20fb460a04152b1`.
The package is a read-only protocol reference, not an installed dependency.

Proof-field checks are independently implemented from the observed api-next
adapter, source commit `a5c63b8db01d4359344d33c31d294a00fbeadb20`, path
`packages/platform-cf/src/verification/providers/very-web.ts`, SHA-256
`4422a82c389c03dc0887fff398eda6fee33e9555e330692cfeadc6f72c67df16`.
There is no runtime import or workspace dependency on that repository. Its
historical evidence recorded stable indices 1 and 3, which are context and
scope, not candidate nullifier index 2. It therefore does not establish the
reward-nullifier property this probe investigates. No historical identity
capture or application ID has been copied into this public repository.

Focused tests use an injected fake transport and invalid cryptographic fixtures
that a real verifier must reject. They cover strict binding, encrypted transport,
verifier failure, redaction, expiry boundaries, reset races, concurrent calls and
the loopback HTTP boundary. They run in the normal offline suite. A fake-provider
browser walkthrough checks the page independently; neither is live Very evidence.

```sh
node --test test/very*.test.ts
unshare -Urn sh -c 'ip link set lo up && npm run check'
```
