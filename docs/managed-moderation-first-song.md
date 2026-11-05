# Managed first-song service

The disposable managed service belongs to the standalone operators repository.
It has its own Worker, D1 admission journal, private R2 retention, Queue and
consumer. Alchemy owns those resources. The ordinary community receives the
service origin and a publisher-scoped signed request capability; provider
credentials and the moderation evidence signer remain in this separate service.
The c22 community and its independent configuration are outside this deployment.

The manual plan is generated with the pinned wizard `tsx` runner:

```sh
apps/community-wizard/node_modules/.bin/tsx harness/managed-service.ts --write-plan
apps/community-wizard/node_modules/.bin/tsx harness/managed-service.ts --inventory
```

The initial create completed under the preserved revision-one plan. The current
plan is an update of those same resources for the qualified public gateway.
After independent source and plan review, execution adds `--execute --update`
and `--expected-profile` with that exact plan hash. It refreshes the selected
cf login and verifies the account, all four exact resource identities and all
five encrypted Alchemy resource records. Missing, replaced or unrelated
resources stop execution. The source package, encrypted predecessor state and
deployment result are durably preserved before the update. Existing backups
are verified before reuse; an incomplete backup requires reconciliation.
`--preflight --update` performs ownership, current-profile and idle checks
without applying or changing credential bindings. The original and successor
health profiles are the only accepted live states. Zero admissions and provider
calls are required for this retrieval-only update; it never migrates active jobs.
The coordinator owns the 900-second apply and recovery window. An interrupted
apply retains its encrypted Alchemy state and private diagnostics; inspect
ownership and reconcile those resources before a reviewed retry. No default
command creates a resource, sends a provider request or broadcasts a transaction.
Every package plan first starts the isolated pinned Alchemy CLI with its Node
runtime peer and a credential-free environment, checking the exact version.

Only the existing staging ACRCloud and OpenAI credentials are rebound from
the approved managed store into the service's own Infisical folder. The existing
testnet signer is checked against its recorded public identity before binding.
Existing target values must match; this workflow cannot rotate them. The
state password comes from the already established managed-community runner
folder. Credentials are passed in the child's environment, state and diagnostics
are encrypted, and generated files are scanned for plaintext after each phase.

The operator curates the exact registry, directory, controller and both HTTPS
origins. Runtime resolution independently checks the chain ID, directory runtime
hash, complete configuration event history, retained public manifest hashes,
current state and canonical block hash. Manifest bytes must be exact JCS;
historical revocations must be valid at their own publication block. Every new provider purchase rechecks
that authority against the immutable job capture. Joining or namespace discovery
does not grant publication authority in this profile.

The first acceptance period permits at most 24 provider requests, with both a
service-wide and community-specific quota. These count upstream calls, not
currency; each classification also has a 256-token output bound and bounded
input. Unknown requests retain their reservation, and a resume cannot buy them
again. This deployment enables no payment deposit, registration transaction or
fund transfer. Those application steps have separate bounded qualification.

The public `/health` response establishes startup and the exact service profile.
Real signed admission, managed provider semantics, public pin retention, Aeneid
registration, MegaETH publication and browser readback remain separate acceptance
steps. Local workerd and explicit simulated-provider tests establish their
recorded handler and persistence properties only.

The IPFS adapter fixes CIDv1 UnixFS, raw leaves, 262144-byte chunks and a balanced
174-link layout. It computes the expected root before an add and reconciles
unknown responses by that identity. A retained recursive Filebase pin and an
independent public gateway download must both match the original file bytes.
It does not repurchase an add after an ambiguous result. Provider protocol
references are the [Filebase RPC documentation](https://filebase.com/docs/ipfs/rpc-api)
and [Kubo RPC documentation](https://docs.ipfs.tech/reference/kubo/rpc/).
