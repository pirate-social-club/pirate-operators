# First-song configuration bootstrap

The community operator registers its already verified new registry with the
disposable directory. This step retains one exact public configuration manifest
and publishes revision 1. It creates no registry, post or discovery authority.
The fixed first-song origin and TLD remain unchanged. The c22 community is
outside this workflow.

The manual command defaults to a local source-bound plan and does not read a
credential or send a public write:

```sh
apps/community-wizard/node_modules/.bin/tsx harness/megaeth/configure-community.ts --write-plan
apps/community-wizard/node_modules/.bin/tsx harness/megaeth/configure-community.ts --preflight
```

The preflight reads the controller nonce, balance, exact directory runtime
and gas estimate on chain 6343. Independent review binds the generated profile
before `--execute --expected-profile HASH` may run. Execute with a 600-second
parent timeout and a 15-second termination grace. The coordinator retains
exclusive custody of the dedicated controller during execution and recovery.
The transaction journal identity uses fixed reviewed limits. A shorter absolute
deadline bounds each invocation without changing that identity, including when
an interruption left an empty journal before signing.

The original profile permitted one 1135-byte Filebase pin add; it succeeded
and its exact response is retained. The gateway-recovery successor permits zero
additional adds and one revision-1 registration using nonce 17. The gas limit is 1000000, price ceiling 30000000
wei and aggregate transaction fee ceiling 30000000000000 wei, or 0.00003 test
ETH. The fresh preflight estimated 457770 gas. These bounds cannot expand on
retry. No material payment deposit, native wallet funding or song registration
belongs to this bootstrap.

The first execution stopped before EVM signing because both original public
gateways returned 429. Their operator announced the backend-traffic change in
the [August 2026 IPFS post](https://blog.ipfs.tech/2026-08-beyond-sponsored-gateways/).
Pinata independently returned the original exact manifest bytes. It is the
qualified independent retrieval endpoint for this disposable acceptance;
4everland timed out and is not configured as a qualified fallback.

The new execution requires `--adopt-existing-pin`. It verifies the exact
predecessor plan, raw receipt file and body digests, request ID, CID and size,
and refuses any existing EVM journal. Only retrieval/source metadata may differ;
the manifest, calldata, nonce and spending limits remain bound. Current pin
retention and independently matching bytes pass before local adoption. The
original pin state is backed up, its receipt stays unchanged, and the successor
enters confirmed without an upload. Missing or changed evidence stops recovery.

The reviewed zero-add recovery completed at 2026-11-05 05:52 UTC. Transaction
`0x2228bf3a52ee5f54b5a7e90d8c3d8b8f8a9a99241d8fcdf8b714dde4a67221da`
confirmed revision 1 at block 34147465 using nonce 17. Actual gas was 448318
at 1000000 wei, a fee of 0.000000448318 test ETH. The exact pinned configuration
passed the canonical event and public readback checks. The public deployment
record contains the retained pin and transaction evidence. This establishes
configuration registration; it does not claim song publication or playback.

The operator reads its existing Filebase credential through the established
Infisical workflow. The community receives the public manifest reference. The
token never enters its configuration, browser or private journal. A read-only
Filebase version request returned 200 before this plan was prepared.

The pin intent is persisted before sending. Its raw response, digest and
provider request ID are persisted before interpreting the returned CID or
checking retention. A lost or uncertain result can only reconcile the original
expected CID; an absent result cannot authorize another add. Recursive pin
retention and independently downloaded matching bytes are required before
the directory transaction. Failure retains the private pin journal.

The existing transaction journal persists exact signed bytes, hash and nonce
before broadcast, and requires canonical receipts with two confirmations on
fresh and recovered transactions. A retry cannot allocate a replacement nonce.
After registration the reader verifies complete directory event history,
canonical manifest bytes, current state and block hash. The evidence records
the original pin identity and transaction. Interrupted completion reuses those
same journals rather than returning an untracked success or registering again.
