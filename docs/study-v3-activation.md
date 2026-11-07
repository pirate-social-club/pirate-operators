# Bounded V3 directory activation

`harness/megaeth/study-activation.ts` performs one separately reviewed transition:
the existing first-song directory revision three becomes revision four, changing
only its learning-records address from retained V2 to the deployed V3 contract.
The complete prior three-manifest history and the derived successor manifest,
CID and digest are frozen. This does not change discovery, rewards, quotas,
operator identities or learner authorization. The application must offer fresh
V3 disclosure and enrollment; a V2 signature does not authorize V3 publication.

Default `node harness/megaeth/study-activation.ts --profile PUBLIC.json` prepares
the exact public plan. It reads no private inventory or readiness record, creates
no client or execution state, and makes no request. Public profile references may
point to records not yet materialized. The plan binds the local compiler artifact,
activation source graph and package lock, old/new manifests and pin, fixed calldata,
controller nonce, fee ceilings and an execution window no longer than fifteen
minutes. Preparation never allocates the supplied reviewed nonce.

Construct the profile only from refreshed release facts. `history` contains the
three validated public manifests; `historyHashes` and `manifestSha256` use the
repository's canonical JSON SHA-256. `pin` is `preparePin` of the canonical revision
four bytes. The source graph comes from `studyActivationSourceHash`; the contract
artifact comes from `compileStudyDeployment`. The contract runtime hash must be
the actual deployed V3 runtime, including its immutable values. All identity and
window fields are review inputs, never inferred from an old nonce observation.

The pilot pins both qualification-policy effective periods to six. It verifies
the exact configured policies at period six, both enabled activity graders,
contract code, controller, community and current disclosure hash. Activation during
period five is allowed; a run before policy six becomes effective has no current
qualifying-policy day credit. Another period requires explicit successor source
and profile review. The existing contract reader validates every prior directory
event, CID, document and state projection, including retained V2 history.

Explicit modes use `node --experimental-transform-types` with this entrypoint.
`--observe` checks public chain/IPFS and existing private readiness, custody and
inventory without creating a journal or loading a managed credential. `--status`
checks the exact durable transaction, canonical receipt and shared controller
catalog. A confirmed activation also requires complete revision-four directory
and manifest readback. Status works after execution-window expiry and does not
require a signing key, managed pin secret or current fee-price permission.

Execution additionally requires `--execute --expect-profile HASH --key-file PATH`.
The key file is an existing private controller record with `chainId: 6343` and a
`privateKey`; public fixture keys are refused. No key is loaded until the same
controller registry has durably registered this operation and its unsigned fee
reservation has been recorded. Raw bytes are durably stored before broadcasting.
Pending sends are observed, and unknown dropped sends reuse only the exact same
bytes, nonce and reserved fee. Reverts consume their nonce. Unrelated unresolved
profiles, missing prepared journals and orphaned namespace files fail closed.

Before managed pin access and again before signing/broadcast, an independently
accepted readiness record must match the operation scope and pinned release
identities. Its observed live-state review must be within the activation window,
and its validity must cover that window. Underlying deployment receipts may
predate the window. Raw application, operator, migration, reader, V2 readback and
retention evidence is individually hash-bound. Required checks include deployed
compatible app/operator and history-aware readers, migrations 0009/0010, existing
Karaoke V2 reads/recovery, private history, fresh V3 enrollment, unchanged Durable
Objects/native accounting, zero speech quota and rewards remaining inactive.

Readiness uses schema `pirate.study-activation-readiness/1`, decision
`accept-activation` and role `independent_reviewer`. Its `scopeHash` comes from
`activationReadinessScope`: the complete profile except readiness-reference and
custody-reference digests, retaining custody role/exclusions. Generate readiness
first, then the existing full-profile controller custody receipt. The latter
must also declare an expiry covering the execution deadline. All six underlying
evidence files must remain private, distinct, regular and byte-identical. A
checkbox record does not establish deployment facts: the independent coordinator
review must qualify the captured raw evidence and fresh physical identities.

The pin uses the existing managed Filebase reference. One stable private pin
journal is keyed by exact content digest outside the signer namespace, under
`~/.local/state/pirate-learning-results-testnet-20261106/study-activation-pins`.
The existing controller lease excludes concurrent activation attempts. A durable
pin dispatch marker precedes its sole add. Every replay, including a new reviewed
window with the same CID, only reconciles. A missing pin lookup never permits
another add. Native catalog registration occurs only after retained pin and fresh
admission, so a lost pin response does not create an empty native allocation.
A recovered signed native transaction needs no further pin secret or add.

The native operation uses the existing shared signer directory, registry and OS
lease at `~/.local/state/pirate-controller/6343/<controller>`, and the accepted
`deployment` journal key. It creates no competing signer namespace. Retain signed
transactions, uncertain pin outcomes, source, evidence and the catalog. No
automatic retirement, nonce replacement or expired-window signing is provided.
A new window after a native allocation requires independently reviewed recovery,
not deletion of the old journal. Successful activation still needs ordinary live
Study acceptance, independent public readback and measured costs; this tooling's
local simulations do not establish those release gates.
