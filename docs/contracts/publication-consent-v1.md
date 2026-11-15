# Publication consent V1 and learning results V5

This is the inactive source successor to origin-bound LearningResultsV4, under
the [approved Web2 plan](../self-hosting/checkpoint-1-pilot-delivery-20261114.md).
It does not activate learning or Dance, change login, select a deployment, or
replace old grants/results. The first-song profile still has no learning target.
The implementation lives in new paths only. PR56 has merged the Directory
foundation; this consent successor uses its own review branch and independent
qualification. It does not change the first-song release profile.

## Deployment and authority

`LearningResultsV5` inherits the abstract `PublicationConsentV1` and implements
`ICommunityPublicationConsentV1`. It is the single consent/results deployment
for one stable community. Dance V2 consumes that registry; there is no additional
standalone consent deployment or Directory field. Constructors admit testnet
6343 or local 31337 only and pin community, Directory address and runtime hash.
Every execution checks the current Directory configuration and its exact expected
revision. Current `learningRecords` must select this registry. A replaced registry
denies new grants/publications but still permits withdrawal and historical reads.

The current controller configures purpose descriptors and graders. A learning
publisher must be both the current Directory publisher and explicitly admitted
grader for the result's activity; a new publisher does not become a grader by
rotation. Controller, publisher, origin, listing and HNS changes do not alter
consent epochs or descriptors by themselves. This is a mandate to current
community-appointed roles, not to one permanently named publisher. No browser
origin is stored or signed in these consent contracts.

All purposes start disabled. The four exact strings are `karaoke-results`,
`study-results`, `dance-verdict` and `dance-review-attribution`. Karaoke/Study
target this results deployment; Dance purposes target the separately admitted
Dance V2 deployment. No wildcard, media, spending, transfer or login authority
exists. Reviewed target code and final policy/timing/retention values are explicit
activation requirements, not defaults supplied by this source.

## Exact typed messages

The EIP-712 domain has name `Pirate Publication Consent`, version `1`, the
executing chain ID and the LearningResultsV5 verifying contract. Its separator
uses the current chain ID. Purposes are strings hashed by EIP-712, not JSON or
an opaque envelope. Each ordered primary type below is normative.

```solidity
struct PublicationGrant {
    address learner;
    bytes32 communityId;
    string purpose;
    address publicationTarget;
    bytes32 publicationTargetRuntimeHash;
    uint64 permissionRevision;
    bytes32 policyHash;
    uint64 withdrawalEpoch;
    bytes32 nonce;
    uint64 issuedAt;
    uint64 validAfter;
    uint64 expiresAt;
    uint64 submitBefore;
}
struct PublicationWithdrawal {
    address learner;
    bytes32 communityId;
    string purpose;
    uint64 expectedEpoch;
    bytes32 nonce;
    uint64 submitBefore;
}
struct PublicationCorrection {
    address learner;
    bytes32 communityId;
    string purpose;
    address publicationTarget;
    bytes32 publicationTargetRuntimeHash;
    uint64 permissionRevision;
    bytes32 policyHash;
    uint64 withdrawalEpoch;
    bytes32 resultId;
    bytes32 originalGrantId;
    bytes32 previousCommitment;
    bytes32 correctedCommitment;
    bytes32 reasonHash;
    bytes32 nonce;
    uint64 issuedAt;
    uint64 submitBefore;
}
```

`reasonHash` is inserted immediately after `correctedCommitment`, the explicit
accepted delta from the original design record. It is zero for correction and
the exact nonzero invalidation reason for invalidation. Both require a fresh
single-use learner permit. There is no controller-only invalidation bypass.

EOAs use low-s ECDSA; an account with code uses ERC-1271 exclusively. A reverted
or wrong-magic contract response is refused. These contracts never initialize
accounts or reinterpret SIWE/V4 personal signatures as consent. Actual MOSS
fresh/initialized wallet acceptance remains a separate integration gate.

JSON transport uses exact keys, lowercase canonical addresses/digests and
canonical decimal uint64 strings, converted to bigint for signing. Unsafe
numbers, suffixes, milliseconds, unknown fields and old schemas are refused.
The selected release owns chain/contract/community inputs. A browser-supplied
domain is not authority. Grant ID is the EIP-712 digest, independent of signature.

## Descriptor, epoch and time state

`configurePurpose(purpose, expectedPermissionRevision,
expectedConfigurationRevision, descriptor)` requires the current controller.
The descriptor is `{target, runtimeHash, policyHash, maxGrantDurationSeconds,
maxSubmissionDelaySeconds, enabled}`. Every configuration, including disable and
A-to-B-to-A, increments its revision. Enabled descriptors require nonzero policy,
positive uint64 duration/submission bounds, and current matching target code.
Karaoke and Study cannot target another contract. Code pins must name reviewed
non-upgradeable implementations; codehash alone does not prove absence of proxies.

The consent `policyHash` is SHA-256 of the exact canonical UTF-8 JSON policy
manifest (`pirate.publication-policy/1`), with no trailing newline. Keys are sorted
lexicographically recursively, strings use JSON escaping and valid Unicode,
and durations are canonical decimal strings. The closed manifest binds `purpose`,
`termsSha256`, `disclosureSha256`, `privacySha256`, `retentionSha256`,
`maxGrantDurationSeconds`, `maxSubmissionDelaySeconds`, and
`dancePublicityPolicyHash`. The latter is zero for Karaoke/Study. For Dance it
must equal the selected Dance V2 deployment's `publicityPolicyHash`, which is
**Keccak-256 of ABI encoding** of `keccak256("pirate.dance-policy/2")` and its
six-document Policy tuple. These are distinct hashes; never compare them for
equality. Activation checks the manifest's duration values against the descriptor
and its Dance hash against the selected deployment. On chain, the descriptor and
signed grant bind the SHA-256 digest; the contract does not fetch the manifest.

The immutable disclosure document must enumerate the purpose-specific public
fields and explicitly state the public audience, mandate to current community
roles, fresh exact correction/invalidation consent, and withdrawal's refusal of
new publication while retaining historical public evidence. Terms, privacy and
retention documents are separately hashed exact UTF-8 bytes. Activation must
retrieve and verify those exact bytes and required disclosures against the
selected generated event fields; a matching opaque hash alone is not disclosure
validation. The pure encoder/binding helper is not that application activation
service. Final approved document bytes remain an activation requirement.

A grant checks current descriptor/revision, target/code/policy, learner epoch,
nonzero learner/nonce, signature and all of:

```
issuedAt <= validAfter < expiresAt
issuedAt <= block.timestamp < submitBefore
submitBefore <= issuedAt + maxSubmissionDelaySeconds
submitBefore <= expiresAt <= issuedAt + maxGrantDurationSeconds
```

Arithmetic is widened before addition. The effective start is
`max(recordedAt, validAfter)`. Publication requires that original grant to cover
both the captured attempt/review start and execution time; a newly recorded grant
does not authorize an earlier attempt. Expiry is exclusive. General renewal is a
new grant for new work and cannot replace the grant captured by an old attempt.

Nonce use is scoped by primary type, learner, purpose and withdrawal epoch.
Grant replay is refused. Withdrawal requires the exact expected epoch and either
a direct learner transaction or its valid typed signature, then advances the
epoch once. It also fences signed but unrecorded grants, even in the same second.
Withdrawal remains usable after descriptor disable or registry replacement and
does not depend on the controller/publisher. Relogin never changes this state.

`checkGrant(id,learner,purposeHash,target,policyHash,boundAt)` uses contract time,
not caller-supplied now. It checks original identity, source admission, current
descriptor/code/revision/epoch and `effectiveStart <= boundAt <= now < expiresAt`.
It returns an explicit reason for denied state. RPC failure is unavailable to a
caller, not false consent or permission. It cannot prove a grader's off-chain
timestamp. Receipt recovery proves historical consumption separately from
whether a grant is currently usable.

## Results, corrections and Dance

V5 retains the baseline Song/Result scoring, coverage, qualification-period and
revision-chain fields, replacing `enrollmentId` with `grantId`. Its result
commitment has an explicit V5 domain and new events. Current publisher/grader and
expected Directory revision are checked at execution. Policy activation remains
prospective. The learner's grant does not certify a grade or performance.

Initial publication requires `result.grader == msg.sender`, the current publisher
and explicitly admitted activity grader. Corrections retain `Result.grader` as
the originating grader. `ResultPublishedV5.publisher` and `configurationRevision`
identify the current admitted publisher/grader executing the correction. Readers
must preserve both: a corrected result's original grader need not equal its event
publisher. Rotation A to B requires explicit grader admission for B and a fresh
exact learner permit; it never changes original attribution.

Correction/invalidation reconstructs the previous committed result and proposed
next commitment. It preserves original learner, song, source, activity and grant,
consumes a current-epoch correction permit for precisely that next revision, and
emits its separate digest. A fresh permit may authorize this one correction after
withdrawal; a fresh general grant, old permit or controller call cannot. A second
correction needs another permit. Inactive/replaced targets cannot be revived by a
permit. Original grants and already emitted results remain historical evidence.

Dance V2 retains categorical fields, command receipts, one terminal verdict,
identity/group/media epochs, known-alias self-review checks and source pins. It
uses `publicationGrantId` and `reviewerPublicationGrantId`, consuming distinct
`dance-verdict` and `dance-review-attribution` scope checks at start and execution.
The publisher is resolved from Directory at each new execution, with captured
configuration/owner epochs. Source pins replace V4 fields with consentRegistry
and consentRegistryRuntimeHash, and fixedPublisher with execution rule
`directory-current-publisher/1`. Exact prior command replay still returns the
original receipt after state changes; it must not execute the effect again.
All changed wire/command/source hashes and events have V2 identities.
Dance deployment and source pins include distinct immutable
`learnerConsentPolicyHash` and `reviewerConsentPolicyHash` SHA-256 digests. Each
check uses its pinned digest, never an arbitrary grant or latest descriptor hash.
Release validation proves each canonical manifest binds the selected Keccak docs
hash; the chain enforces the admitted SHA-256 commitment, not a fetched document.

Private capture consent is still a publisher-attested authenticated browser
receipt under its exact private-media policy; it is not a wallet signature.
Neither learning nor Dance metadata permission authorizes public video. Existing
explicit media permission stays separate. No per-asset wallet permit or Posts
validation extension is introduced.

## Source, generated output and gates

The finite source owns the consent interface/abstract base, LearningResultsV5,
four Dance V2 Solidity successors, pure protocol encoders, V2 wire/ABI callers,
one generator, this spec and four focused proof files. V1/V4 contracts, existing
Directory/Posts, callers and deployment evidence are unchanged. Generated ABI,
tuple shapes and constructor/runtime metadata come only from actual compiled
artifacts. Immutable placeholders/reference ranges are retained; a template hash
is never presented as a universal deployed codehash. Constructor-instantiated
local fixture runtime needs its own matching proof.

Failure cases to exercise before activation: every signed binding/domain and
primary-type substitution; unknown purpose; duplicate/conflicting nonce; queued
grant after withdrawal; exact time bounds; effective start after delayed relay;
descriptor/target A-to-B-to-A; changed runtime; role/configuration/origin rotation;
contract replacement with retained withdrawal/history; ERC-1271 acceptance,
refusal/revert; exact correction/invalidation reason/revision/replay; unchanged
scoring and coverage; separate Dance learner/reviewer consent; private-media
boundaries; canonical historical receipt recovery. TS/Solidity vectors must be
independent and checked against the real compiler output.

## Local qualification and remaining joins

The focused suite passed 110 Solidity test executions: 31 unique new tests
(42 executions because 11 consent cases run under both compiler profiles) and
68 retained V4/Dance cases. Nine TypeScript cases and root TypeScript checking
passed. Fixed shared vectors cover all three typed consent messages, the V5
result commitment, and V2 command/capture/source hashes. Existing assertions
remain. Tests use real Directory/Posts/consent/Dance deployments and public local
fixture keys; they do not exercise production credentials or MOSS.

Compiled runtime templates are 23,300 bytes for V5 (optimizer 200/no IR), 23,306
for Dance V2 and 8,910 for its capture verifier (optimizer 1/IR), with solc
0.8.30+commit.73712a01/Cancun. These are templates, not a universal deployed
codehash. The real constructor/getter proofs emit actual runtimes. The verifier
matches every byte outside compiler-reported immutable ranges, checks repeated
immutable substitutions and exact creation input/output, and requires all three
contracts. V5 uses the exact default-profile artifact even from an IR test suite.
The capture verifier has no immutable substitutions and matches in full.

Reproduce from this exact source with the pinned dependencies/tools:

```sh
mkdir -p .local/publication-consent-proof
forge test --offline --ast --match-contract 'PublicationConsentV1Test|LearningResultsV5Test|DanceVerdictsV2Test|LearningResultsV4Test|DanceVerdictsTest|DanceAuthorityTest|DanceWireVectorsTest' -vv
node harness/megaeth/generate-publication-consent.ts
git diff --exit-code -- packages/protocol/generated/ packages/dance-chain/v2/abi.ts packages/dance-chain/v2/wire-shapes.ts
node --test test/publication-consent-vectors.test.ts
node node_modules/typescript/bin/tsc --noEmit
forge test --offline --ast --match-test 'testDeployedRuntimeEvidenceAndConstructorPins|testDanceRuntimeEvidenceAndAllConstructorPins' --json -vvvv > .local/publication-consent-proof/runtime.json
node harness/megaeth/generate-publication-consent.ts --runtime-proof .local/publication-consent-proof/runtime.json
```

The generator refuses stale compiler/interface/wire-AST source metadata and
wrong compiler profiles. Generated files contain actual ABI/AST data; four-output
regeneration is byte-reproducible. Runtime proof output identifies the specific
local constructor inputs and observed codehashes, not a public deployment.

Application/service/DB/UI integration, real MOSS fresh/initialized account flows,
canonical RPC recovery through those services, private-media browser journeys,
policy-document activation and public deployment remain UNRUN. Hosted full CI
and independent review qualify the separate successor commit; PR56's green CI
covers Directory, not this new source. No export/default selection, provider,
funding or deployment is included. Final retention text, policy hashes and timing
parameters gate activation. Current public field semantics retain the accepted
scoring/categorical baseline. No new consent grant comes from login.
