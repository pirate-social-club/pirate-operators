# Testnet Very reward attester

This adds a real attestation path alongside the existing fake service. The
attester is a Worker with SQLite-backed Durable Object state, run locally by
Miniflare. It checks wallet authentication, the configured pool and Very's
hosted verifier before signing RewardAttestation. The default offline flow
continues to use its explicit fake; it never contacts Very or a public chain.
The Worker class is included in packaging, but no Cloudflare endpoint is
deployed or enabled by this change.

The live path is not yet an observed result. It needs a new proof for the actual
derived scope and a confirmed Base Sepolia registration. Local tests simulate
the external verifier; they cannot establish provider acceptance. No M3 or
production readiness is claimed.

## What the attester binds

One durable object is addressed by chain and pool, never by app ID or policy
version. Its first configuration pins the app ID, chain, pool, drawing, deployed
code hash, attester address, version-1 scope mapping and broad query policy.
Every request checks the saved configuration hash. Restarting with another app
ID refuses the request rather than creating a new identity namespace. The
operator must preserve this state and manifest for the pool's lifetime; deleting
storage is not an authorized way to change the configuration.

The configured RPC must report the expected chain. All pool reads use the same
block: code hash, scope, drawing, attester, winning/settled state and registration
deadline. Claimants may have empty code or the exact EIP-7702 delegation marker.
Other contract wallets are refused. The only chain IDs are 31337 and 84532;
public fixture signing keys are refused on Base Sepolia.

A challenge lasts at most five minutes and never beyond the pool deadline.
The claimant signs EIP-712 VeryAuthentication, covering chain, pool, full scope,
configuration hash, claimant, nonce, 128-bit pseudonym and expiry. The returned
proof must match that scope, pseudonym and fixed query fields. The service then
asks the pinned hosted verifier to validate it and rechecks the pool before
issuing a permit for that claimant. The broad timestamp and credential-expiry
predicates retain the diagnostic policy; they establish neither recent capture
nor a currently unexpired credential. The policy is explicitly testnet-only.

The contract remains responsible for qualification, its registration deadline,
the claimant's separate payout authorization and duplicate nullifiers. Paying
gas or obtaining an attestation does not create a qualifying entry.

## State, retries and privacy

Related SQLite writes are synchronous. Before external verification, the
challenge receives a 60-second lease. Concurrent requests cannot verify under
the same lease. After a crash, a retry can take an expired lease; a late earlier
request cannot overwrite the new result. The signed permit is stored before
returning it. An authenticated retry receives that same permit without another
provider call, including after restart. Expiry is checked again after network
work. At most 256 challenges are created per pool in this bounded experiment.

The service stores challenges, lease state and signed permits. It does not
store raw proofs, candidate provider identifiers, wallet authentication
signatures or bridge keys. The separate loopback ceremony holds a temporary
bridge key in memory and clears it when the request ends. JavaScript memory
clearing is not a secure-erasure guarantee. Error responses use controlled
codes; provider bodies and private request material are not logged.

App pinning is a configuration rule, not proof of app origin. The observed
proof has no explicit app-ID signal, and the hosted response used here makes
no app-ID assertion. Cross-app identifier behavior remains unknown. The
[assurance notes](very-assurance.md#app-scope-and-linking) describe substitution
and linking risks and the sixth, unsent provider question. No secret is mixed
into the frozen reward identifier, and no unlinkability promise is made.

## Manual Base Sepolia run

Use the same existing public Very app ID, supplied as a text file outside the
repository. No Very API secret is required. Existing dedicated testnet keys
must already exist in the private harness store; these commands never create
them. The process takes the same exclusive wallet lease as the other testnet
harness.

```sh
npm run very:reward -- prepare --live --app-id-file <private-text-file>
npm run very:reward -- serve --live --manifest <private-manifest-json>
```

Preparation deploys a test token, mock Jackpot and pool, creates one explicitly
synthetic qualifying entry and settles a mock win of 10,000,001 token units.
The pool keeps the default seven-day registration window. The existing Base
adapter bounds preparation spending and funds only the executor and relayer.
It prints the private manifest path. That manifest contains the fixed app ID
and pool configuration and must never be committed.

Serving starts the real attester locally and shows a loopback page for one
human ceremony. Start issues the wallet-authenticated request using the
dedicated test wallet managed by the harness. It does not connect or prove
ownership of the human operator's personal wallet. Only the human scans, using
the existing enrollment. Do not screenshot, trace or share a real QR.

After verification, the relayer submits registerFor with the claimant-signed
payout address. The registration exposes the scoped reward identifier and test
wallet on Base Sepolia; the page explains that before Start. Gas is capped at
350,000 units and an estimated execution fee below 0.00005 test ETH; the Base L1
data fee is additional. A lost transaction response moves the ceremony to
read-only reconciliation. It does not automatically submit another transaction.

The page recovers from interrupted polling and the process stops after 30
minutes. Shutdown cancels pending pre-submission work and drains an already
started operation before releasing the wallet lease. A successful page result
means registration was observed. It does not mean finalization or withdrawal:
the seven-day deadline must pass first. These are test tokens, not USDC or a
real Megapot win. The original song admission, karaoke and payment flows remain
separate tests.

## Validation

The Node tests cover authenticated scope binding, exact proof predicates,
provider failure, expiry, concurrency, late responses and restart recovery.
The Worker test uses real SQLite bindings and a real local RewardPool. It
restarts the runtime, rejects a changed app ID, recovers the saved permit,
registers and withdraws the synthetic allocation. Only the external proof
verifier is faked. UI tests check polling recovery, expiry, controlled errors
and unknown transaction outcomes. Provider support and a real registration
remain live gates, reported separately from these offline tests.
