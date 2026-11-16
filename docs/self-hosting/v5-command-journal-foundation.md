# V5 command journal foundation

This slice preserves publication commands and their original outcomes before
the expanded Web2 application enables publication consent. It supplies D1
staging, authenticated community issuer transport, queue admission into the
existing operator journal and original receipt reconciliation. It does not
mount browser or operator routes, select a deployment, enable a profile or
admit a V5 transaction sender. All V5 sends, including cancellation and generic
recovery sends, remain closed. This is an integration foundation, not a working
consent feature.

Plain login and private practice remain independent of public grants. The new
practice variant distinguishes private work from work bound to an original
publication grant. Producers must persist that choice at actual start. The
variant alone does not connect Study, Karaoke or Dance to this journal.

## Persistence and retry

Stable source identity uses chain, community, registry and registry runtime
hash. Changing installation, Directory or release selection cannot reset a
withdrawal generation. Each command separately retains its full original source
and captured request. The scoped request identity has one command and one first
server nonce; changed requests under that identity refuse.

Withdrawal stages the local stop and captures its generation in the same D1
batch. A retry cannot increment that generation again. An unacknowledged stop
remains a public hold. Local stop and acknowledgement by the operator are
separate observations; no transaction spans the application and operator stores.

Prepared and accepted bytes are captured once. Compare-and-swap writes prevent
stale workers from replacing current progress. Verified older observations can
append to history without becoming the latest observation. Database constraints
protect original identity, first bytes and monotonic progress. Insert guards
also preserve existing rows during conflicting `INSERT OR REPLACE`, independent
of SQLite's recursive-trigger setting. The schema is currently unnumbered;
deployment migration and restart scheduling remain integration work.

## Issuer and payer boundary

The explicit publication issuer envelope binds method, path, source hash,
chain, community, installation, operator, body SHA256, command ID, nonce and a
60-second window. The authenticated body must be canonical and match that
command. Exact retries return the original job. The nonce is signed transport
entropy; command identity and the immutable body provide durable idempotency.
The installed route must resolve the currently admitted issuer through trusted
configuration and use authenticated transport.

Queue admission reserves and charges the captured sponsorship policy in the
existing operator store. It creates no second payer nonce allocator. A queue
response does not verify the learner's signature or record consent. Actual
wallet verification, current eligibility, final withdrawal fences and sender
admission must be joined before any broadcast is enabled. Historical recovery
does not depend on today's fee selection.

## Original recovery

Recovery verifies the original serialized transaction, payer, nonce, target,
calldata and hash. A successful receipt requires the exact generated grant or
withdrawal event. Runtime code is read using the receipt's canonical block hash.
Required headers, quantities and repeated observations are validated before
confirmation. A disposition revision prevents held pre-reorg work from
overwriting newer evidence. Reorg evidence removes confirmation and resumes
the same original operation; it does not allocate or resend a replacement.

Recorded history and current permission are distinct. An original grant receipt
can remain recorded after withdrawal or expiry. Unknown transactions retain
their original identity and charge. Enabling a later grant cannot silently
resume old work.

## Qualification scope

The retained checks use actual D1, SQLite operator storage, real fixture
signatures and serialized transactions, HTTP requests and explicit scripted RPC
responses. They cover competing replay, interrupted withdrawal, stale writes,
immutable storage, issuer failures, original event identity, reorg recovery,
cancellation holds and sponsorship accounting. Protocol vectors independently
retain the V5 publication arguments. These checks do not establish public-chain,
MOSS consent, installed-host or provider acceptance of the expanded profile.

The next join adds authenticated browser preparation and submission, actual
policy and source selection, durable outbox and restart discovery, wallet
verification and current grant readers. Study, Karaoke and Dance then consume
the captured private or publication-bound variant. Sender qualification remains
explicit. HNS is optional and does not gate this sequence.
