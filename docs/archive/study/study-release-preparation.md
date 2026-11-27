# Study release preparation

`node harness/study-release.ts --profile PUBLIC_SELECTION.json` prepares public
metadata without reading keys or private journals, contacting any service,
creating state or deploying. With no arguments it prints usage. There is no
execution option. The output explicitly says `executionReady: false`; candidate
addresses and hashes do not prove a deployment. No live selection is checked in.

The strict `pirate.study-release-selection/1` schema admits only chain 6343,
the retained community and controller, exact historical V2 address/code hash,
and a distinct V3 address/code hash with the immutable V3 disclosure. It also
requires an exact completed application predecessor: public plan path, profile
hash and private execution/result file digests. Only digests are public; private
files and credential values do not belong in the selection. Unknown fields,
custom RPCs, keys and alternate resources are refused. Input is bounded at 64 KiB.
Refresh these fields from actual deployment and handback evidence before review;
the synthetic test fixture is not an execution profile.

The existing application release runner accepts `--study-profile` explicitly.
Its ordinary plan still builds and inspects retained local application state;
use the separate public preparer when no private-state access is wanted.
Preflight/execution additionally reads the fixed MegaETH testnet endpoint and
checks both code hashes, V3 version/community/controller/disclosure and both
grader permissions at one rechecked canonical block, before managed credential
access. This is contract identity checking, not proof of policies, custody,
independent source/artifact review or learner acceptance. The existing exact
profile, predecessor, inventory, preservation, resource ownership and finite
execution gates remain necessary. This work does not supply a new live profile.

The application upgrade guard permits precisely migrations `0009_study.sql`
and `0010_study_retention.sql` after the existing Karaoke migration. It preserves
V2 recovery, the provider credential reference, internal accounting, thirty-day
history and speech limit zero. It rejects resource, spending, credential,
namespace and retention changes. After V3 is admitted, removal or replacement
of its target is also refused even when the generic resource intent is equal.
The historical initial Karaoke upgrade guard remains unchanged.

Both Alchemy configurations consume the same self-contained binding module.
Explicit `LEARNING_PROFILE=pirate-learning-testnet-v3` requires distinct
`LEARNING_RESULTS_CONTRACT` (retained V2) and `LEARNING_RESULTS_V3_CONTRACT`.
The application receives `STUDY_RESULTS_V3_CONTRACT`. Default V2 behavior stays
explicitly separate, and supplying a V3 address without selecting V3 fails.
The physical stack/Worker remains `pirate-learning-testnet-v2`; the existing
ServiceState and SpeechBudget object bindings, shared speech counter and native
accounting remain in place. The application packaging copies and hashes the
binding module alongside its Alchemy entry, so no source-checkout path is needed.

The old `learning-testnet-stack.ts` runner remains V2-only and loads managed
secrets even in plan mode. It is not the public preparer or an admitted V3
execution path. A separately reviewed exact operator upgrade runner and a bounded
V3 contract/graders/policy deployment are still required. They must preserve the
actual live namespaces and finite controller inventory rather than reuse a
closed correction window or reset accounting. No deployment was run here.

`node --experimental-transform-types harness/study-policy-pin.ts` prepares the
fixed 297-byte public Study qualification document without credentials, network
access or execution state. It prints the expected CID and SHA-256. Explicit
`--execute --expected-sha256 HASH --not-before UTC --deadline UTC` permits one
managed Filebase add in a UTC window of at most fifteen minutes. The private
SQLite journal and lock are separate from controller signing. Preparation is
durable before dispatch; every subsequent invocation only reconciles the same
CID, including a lost response or a prepared entry with no known receipt. An
absent lookup never authorizes another add. This pins public policy content;
it neither deploys a contract nor changes the active qualification policy.

Complete honest Karaoke acceptance and explicit resource/custody handback first.
Then deploy and independently qualify the successor contract and prospective
policies under their own reviewed bounds. Refresh source, artifacts, predecessor
and inventory. Upgrade the retained operator and deploy the compatible app,
migrations and readers. Verify old songs, V2 recovery and the exact versioned
disclosure before changing the directory configuration. Only after that switch
capture ordinary-MOSS consent, real speech, public publication, independent
readback, failure/recovery and full costs. Testnet rewards and the separate
mainnet MOSS/USDm proof retain their own gates.
