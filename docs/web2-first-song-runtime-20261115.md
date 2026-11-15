# Web2 first-song application adoption

This slice starts from the reviewed V3 candidate at `607a047`. It connects the
registry-free configuration/4 to actual application and managed-service handlers.
Authenticated history uses bounded RPC log pages but materializes the complete
configuration sequence for the feed. Total memory grows with history; this is
not a bounded-total-memory replay or a new persistent cache.
It does not qualify installation, native-profile authority, public deployment,
credentials, funding, learning consent, naming or Dance.

## Failure cases written before implementation

The existing configuration/3 must remain the historical shared catalog shape.
A Web2 profile must not be accepted by that decoder or acquire fabricated
registry/TLD fields. Deployment/2 must select the V3 reader explicitly, require
freshness policy, and reject a wrong chain, code, ABI, identity or origin.

The reader must retain every authenticated configuration revision. Returning
only the current revision would make earlier songs disappear or validate them
against later authority. Publication and feed must preserve publisher revocations,
exact media hashes, canonical receipt provenance and existing owner grants.

Listing and address-verification expiry control discovery, not ordinary sign-in,
direct feed or publisher authority. Stale or unavailable safe state must remain
explicitly unavailable, authorize no fresh role-sensitive effect, and never
fall back to latest or manufacture a current verification badge.

The first-song profile must create plain SIWE challenges and refuse retained V4
challenges without consuming them or writing learning authorization. Injected
learning, names or Dance bindings must not activate HTTP, queue or scheduled
work. The managed service must authenticate a real registry-free pairing and
fresh V3 authority before pinning; changing controller, owner, publisher, origin,
grant or canonical intent must refuse effects.

Lost acknowledgements and runtime reconstruction must retain the original job,
provider-operation and signed transaction identities. They must not purchase or
broadcast twice. The integration proof uses real D1/R2, actual handlers and a
disposable local RPC with DirectoryV3 and PostsV1; external provider/content
transport simulations are named. It emits receipt/configuration/media hashes
and operation counts. No behavior-preserving refactor should change assertions.

## Qualification

The initial six actual-application cases passed in 108.54 seconds. The recovery
case was then strengthened and passed in 28.93 seconds: the external pin receipt
and the real RPC broadcast acknowledgement are both lost after their effects.
Two runtime-object reconstructions retain the original operations and signed
transaction; the chain receives one broadcast and the catalog one upload.

Root and web type checks pass. The focused offline V3/Posts build passes with
the existing contract lint warnings. The direct signed managed-handler
stale/unavailable authority negative passes through the actual handler, with
no additional provider effects. The browser membership regression passes in
1.9 seconds against the actual live build: the owner can open Post/composer
while membership is disabled and no join/name request is sent. Its screenshot
and request attachment are under `apps/web/test-results/`. Full repository
qualification remains unrun and needs the serialized coordinator runtime slot.

The first fixture attempts are retained as failures: the registrar initially
conflicted with the admin role; the registration lacked safe confirmations; and
Anvil's default one-gwei suggested fee exceeded the unchanged production cap.
The fixture now uses distinct roles, actual safe confirmations and an explicitly
low-fee disposable chain. No production cap or refusal assertion was weakened.
Failed publication journals and preparation stacks are under
`.local/web2-first-song/failed-*.json`.

The coordinator also allocated `packages/moderation/admission-store.ts` to reject
Web2 before legacy moderation writes, and the web API contract, live entry and
community browser fixture/spec to make membership explicitly disabled. No fake
joined state or receipt is supplied. The only historical harness edits are type
imports in `harness/megaeth/owner-policy-activation-plan.ts` and
`harness/megaeth/study-activation-plan.ts`.

Repeat from the repository with `forge build --offline`, then
`node --test --test-concurrency=1 test/web2-first-song.test.ts`. The ordinary and
recovery cases write `.local/web2-first-song/{ordinary,recovery}.json`, binding
configuration/media hashes, actual registration/publication transaction hashes,
operation commitments and provider/broadcast counts. Fresh chains produce fresh
transaction and receipt hashes; repeatability means the same verified behavior,
not byte-identical receipts across separate chain instances.

Independent source reviews found the old moderation/registration closure gaps,
a missing configured IPFS transport, stale readiness/queue reads and a missed
public Karaoke route. These were corrected; the reviewers found no remaining
blocker in the inspected production branches. Final committed-source review and
required hosted CI remain open. Existing tests and their negative assertions
remain required.
