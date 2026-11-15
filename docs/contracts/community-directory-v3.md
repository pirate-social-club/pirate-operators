# Web2-first Directory V3 — checkpoint 1a

This successor implements the
[owner-approved Web2 release plan](https://github.com/pirate-social-club/pirate-operators/blob/a163fc15ed85d7ebc59041f057cfc713347f6430/docs/self-hosting/checkpoint-1-pilot-delivery-20261114.md).
The plan is also available in this branch at
[the current delivery specification](../self-hosting/checkpoint-1-pilot-delivery-20261114.md).
V1/V2 contracts, manifests, profiles and history remain unchanged. V3 must be
selected explicitly; no existing deployment is upgraded or silently reinterpreted.
The normative ABI source is `ICommunityDirectoryV3.sol`; generated artifacts must
come from the actual compiled implementation. No deployment is selected here.

## Identity and configuration

`communityId = keccak256(abi.encode(keccak256("pirate.community/2"), chainId,
communityKey))`. The nonzero random portable key and installation ID are immutable.
The ID is independent of registry, address, controller, publisher and listing.
It retains the V2 formula, not V1's registry-derived formula. Reusing a key does
not migrate a deployment or its history; directory address and deployment remain
part of every source profile and canonical publication identity.

`registerHostedCommunity(binding, configuration, originSha256, registrarRevision)`
creates revision 1 with no HNS registry/TLD and no verification/listing approval.
Only the current bounded registrar may call it. `CommunityRegistered` uses zero
registry/TLD until optional attachment; `CommunityBound`, `OriginConfigured`,
`ConfigurationPublished` and `RegistrarConsumed` bind the exact enrollment.
Existence is configuration revision, never a nonzero registry address.

Configuration retains V1's tuple and event for Posts. `configureHostedCommunity`
updates the canonical origin commitment with the controller's expected config
revision. Ordinary `configure` keeps the origin. Controller changes retain the
two-step exact-configuration transfer. An origin change increments origin revision;
a controller change increments both origin revision and controller revision.
For an existing community it also clears listing, increments listing revision
even if already unlisted, and emits `ListingChanged` with `listed=false` and
`reasonSha256=keccak256("pirate.directory/controller-transfer")`. Initial
registration keeps listing revision zero and emits no delisting. A transfer
back requires fresh proofs and a new listing approval; neither revives.
Origin/controller round trips cannot resurrect old proof. Observations cannot predate the
address/controller binding update, even when supplied with its new revision. Publisher or content-only changes
increment config revision without needlessly revoking valid address proof.
Origin bytes are canonical HTTPS origin UTF-8; `originSha256 = SHA256(bytes)`.
Clients check the public manifest against this commitment. The EVM validates a
nonzero commitment, not URL syntax, DNS, TLS, or ownership.

## Separate authority and discovery

Admin uses two-step handover, selects verification/listing roles, admits immutable
registry source pins, and configures the registrar. Registrar authority has an
absolute expiry, expected revision, positive lifetime count cap and cumulative
consumption preserved across rotation/reconfiguration. Disable with zero account
and zero expiry; a cap cannot drop below consumption. Registrar may not equal
admin, pending admin or any verification/listing role, including on rotation.
It cannot attest, list, change existing communities or seize controller authority.
The Pirate enrollment service must authenticate controller control, bind invite,
installation and original request, enforce rate/fee caps and reconcile original
transactions. These service checks are not performed by the contract.

Listing approval is separate and can be recorded before verification. Discovery
requires existence, listing approval, and either valid Web2 proof or valid HNS
proof. Renewing either proof never restores a delisting. Delisting or expiry does
not stop the community's own publication, erase identity or mutate past records.
Indexers must evaluate validity at query time; expiry need not emit an event.

Web2 proof binds the current origin revision and controller revision. Only the
configured Web2 verifier can attest/revoke using expected proof revision. An
attestation has nonfuture monotonic observation time, nonzero evidence digest,
future exclusive expiry, and at most 30 days from observation. Daily service
rechecks do not imply daily transactions. Confirmed loss permits early revocation;
observer unavailability retains existing bounded validity and cannot extend it.
Revocation preserves the observation and separately records a revocation-time
watermark, consuming a revision. Reapproval requires an observation strictly
after revocation and the previous observation. Address proof is not personal identity or brand ownership.

Evidence preimage v1 is canonical JSON (sorted keys, no whitespace) with schema
`pirate.web2-address-evidence/1`, chainId, directory, communityId, installationId,
controller, controllerRevision, origin, originRevision, method (`dns-txt` or
`https`), challengeDigest, observationDigest and observedAt. Digests and addresses
are lowercase exact hex; integer revisions/timestamps are canonical decimal
strings. Evidence is SHA256 of those UTF-8 bytes. The verifier must validate a
fresh single-use challenge, exact address/control and current binding; hashing
caller-supplied assertions does not establish external proof. The future service
owns safe DNS/HTTPS fetching and original challenge storage, not this contract.

## Frozen optional HNS boundary

`attachHns(id,tld,expectedRevision,attachment)` is restricted to the namespace
verifier and requires an admin-admitted registry with matching current code hash,
canonical registry-compatible label/namespace, current controller revision,
nonzero namespace authorization hash/epoch and canonical HNS evidence commitment.
Its maximum lease is 24 hours. Source commit and ABI digest are immutable in the
registry source admission. HNS observations must prove exact registry, community,
installation and controller delegation. This is a trusted attestation boundary;
the Directory does not itself prove Handshake consensus or grant naming rights.
V4 scope activation, gateway, proof production and service integration are separate.

Attachment/revocation only change HNS state and the legacy read tuple's HNS
description. They never change community/configuration/post IDs, Web2 proof,
origin, listing approval or ownership. HNS expiry removes HNS-derived eligibility;
valid Web2 evidence plus listing keeps discovery. Revocation retains history and
the observation and revocation-time watermarks. Label rules match accepted registry Labels, including
rejection of two hyphens at byte positions 2 and 3. The inherited V1
`verifyNamespace`, registry-based registration and ID selectors explicitly refuse.

## Consumers and acceptance

PostsV1 retains its exact source and ABI: current publisher and config revision
authorize publishing. Canonical song/Dance references use chain, posts contract,
community ID, post ID, revision and content commitment, never an origin URL.
Consent design stays separate: no learner-consent epoch is added to Directory.
Current roles/revisions plus learningRecords remain available; the consent
successor owns withdrawal epochs, nonce and purpose/target binding. First-song
configuration omits learning records; source existence does not enable learning.

V3 typed callers must explicitly pin schema, actual compiled Directory code and
deployment, bind original signed enrollment bytes, retain safe-block recovery,
and reject V2 profile fallback. Config/address changes need explicit validation;
existing V1/V2 readers and histories are not rewritten. Wizard/backend/indexer
adoption, real address proof service, invites/top-ups, deployment and browser
acceptance remain later integration gates. The attachment tests use a named
stand-in verifier/registry, not claimed live HNS interoperability.

Routine `setVerificationRoles` rotation immediately removes old-role write access. Existing bounded
attestations remain valid until expiry or explicit per-community revocation by
the new verifier. Rotation does not silently re-list, erase history or assert
that all earlier observations were false. Registrar separation is checked in
both rotation directions.

An emergency uses `invalidateWeb2Proofs(replacementVerifier)` or
`invalidateHnsProofs(replacementVerifier)`, restricted to admin. The action
atomically replaces only the affected verifier, increments only that proof
type's generation and records `block.timestamp` as its invalidation time.
Zero, current-verifier and registrar addresses refuse without mutation. There
is no same-key invalidation exception. Listing, configuration, community proof
revisions, stored proof tuples and the other proof type remain unchanged.

Each proof type starts in generation 1. Acceptance stores that current generation
beside the unchanged proof struct; a community with no accepted proof has
generation 0. Validity additionally requires accepted generation equal to the
current generation. Emergency invalidation therefore removes all old proofs of
that type immediately without walking communities or deleting evidence.
`getWeb2ProofAuthority()` and `getHnsProofAuthority()` return
`(verifier,generation,invalidatedAt)`; `getWeb2ProofGeneration(id)` and
`getHnsProofGeneration(id)` return the last accepted generation. Existing proof
getters retain their exact return shapes. Each acceptance emits
`Web2ProofGenerationAccepted` or `HnsProofGenerationAccepted` with community ID,
proof revision and accepted generation beside its existing proof event.
`Web2ProofsInvalidated` and `HnsProofsInvalidated` identify previous/new verifiers,
new generation and cutoff; role observers must consume these emergency events
as well as the routine `VerificationRolesChanged` event.

After emergency invalidation, a newly accepted proof must have `observedAt`
strictly later than that proof type's invalidation time, in addition to all
existing observation, binding, revocation and expiry rules. This also applies
to a community's first proof. Old-verifier pending calls lose authority; a new
verifier cannot resubmit their old observations. An observation at the cutoff,
including one in the same block, refuses. Returning to an earlier verifier
never resets the generation or cutoff and cannot revive earlier proofs.
Recovery requires a later observation from the then-current verifier, and
never restores a delisting. Routine role rotation does not reset these emergency
watermarks or generations.

## Concrete source selection and joins

The explicit profile is `pirate.web2-directory/3`; configuration is
`pirate.community-config/4` with no registry/TLD requirement. The Directory
profile remains `/3`; manifest version and contract version are separate.
Main already uses configuration `/3` for retained shared-directory catalog
configurations with registry/namespace fields. Web2 refuses that schema and
those fields, including the earlier undeployed Web2 `/3` candidate. No decoder
fallback, automatic rewrite of signed enrollment, or history reinterpretation
is permitted. The retained shared parser refuses Web2 `/4`.

The catalog-owner policy requires the exact public `pirate.recognition-profile/1`
pin (schema, namespace, origin, signer, providerBindingSha256 and sha256), using
the existing recognition validator and canonical digest. The recognition signer
must differ from the controller, publisher and moderation signer. Noncatalog
policies keep their original exact keys and refuse a recognition field. Parsing
the pin does not prove service availability or authorize a publication. The
first-song configuration still requires no learning target at enrollment.
`web2-directory.ts` pins the actual generated ABI/runtime and validates deployment
and community binding. Source commit syntax alone is not release approval; the
installer must select the independently reviewed source/deployment profile.
`web2-registration-chain.ts` prepares a registrar-revision-bound call and freezes
the exact signed original transaction for safe-block receipt reconciliation. Its
first-song enrollment refuses a nonzero learning target. It never signs, sends
or chooses fees. `web2-address-evidence.ts` commits exact typed evidence but does
not observe or authenticate DNS/HTTPS facts.

`web2-directory-reader.ts` replays authenticated configuration events in bounded
pages at a canonical safe block. Every configuration's manifest is checked
against its same-transaction OriginConfigured event, including ordinary configure
and controller transfer. The current manifest is also checked against current
OriginState. It retains cumulative publisher revocations and stable Posts identity.
V3 initially uses cold replay, without applying or silently reusing the proposed
V2 cache tables. This is bounded-memory processing, not a claim of constant-cost
reads; a versioned authenticated V3 cache remains separate optimization work.

The reader requires an explicit `Web2EligibilityPolicy` as its third argument:
`{ now: () => bigint, maxSafeBlockAgeSeconds: bigint }`; optional IPFS transport
is now fourth. The clock supplies trusted service Unix seconds, not browser
input. The maximum safe-block age is an explicit nonnegative uint64 service
policy. No production value or refresh interval is selected by this source.
Missing/invalid inputs refuse; the clock and age policy are captured before
awaits, and the clock is sampled again after all reads and the canonical recheck.
A clock regression during the read refuses the result.

There are no bare `discoverable`, `web2Verified` or `hnsVerified` fields on the
reader result. `verificationSnapshot` uses `pirate.directory-verification-snapshot/2`
and is an immutable, versioned historical fact
bound to the source profile, safe block number/hash/timestamp, capture time,
listing state/revision, both verification revisions, each proof type's current
verifier/generation/invalidation time, each proof's accepted generation, and the complete Web2/HNS proof
tuples (including original observation and expiry). `verifiedAtBlock` and
`discoverableAtBlock` describe that block only. All proof/state reads use the
same captured block; the final recheck also requires its unchanged timestamp.
Claimed at-block validity with a mismatched generation or observation at/before
an emergency cutoff refuses as an inconsistent snapshot. There is no `/1`
snapshot adoption or cache fallback.

`eligibility` is evaluated at completion. When the snapshot age is within the
explicit maximum (inclusive), each proof requires its original at-block validity
and `evaluatedAt < validUntil`, matching accepted/current generation and a
post-invalidation observation where an emergency has occurred. Discovery requires listing plus either proof.
Expiry of one proof leaves the other independently usable; delisting or a false
at-block verification cannot be undone by a future deadline. A stale safe block
or a clock behind the snapshot yields `status: "unavailable"` with a reason,
without eligibility booleans. This is not a revocation or permission to fall back
to latest. Unsupported/missing safe blocks, inconsistent proof snapshots and
reorgs still refuse. A bounded safe view does not establish unobserved changes
after that block; deployment must explicitly select its freshness policy.

Use `evaluateWeb2Eligibility(snapshot, trustedNow, maximumAge)` at every subsequent
use of a retained in-process snapshot. Eligibility is only a decision at its
`evaluatedAt`, not a cacheable perpetual badge. Reevaluation neither replaces
the original block timestamp nor extends a proof's expiry. Rereading a frozen
safe head also cannot reset its age. The helper does not authenticate serialized
or untrusted snapshot JSON; persisted evidence needs canonical reauthentication
before use. This source adds no persistent cache or background refresh service.

The only existing helper changes narrow required profile fields and return the
already-authenticated receipt. V1/V2 callers keep their existing behavior.

| Consumer                      | Required explicit adoption                                                             | Current boundary                                               |
| ----------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Wizard / hosted registrar     | V3 profile, no HNS enrollment input, original transaction journal                      | Interface supplied; no Wizard/service edits in this lane       |
| Config publisher / controller | Revisioned origin commitment plus exact canonical manifest                             | Contract and validator; controller retains execution authority |
| Backend routes / discovery    | V3 safe reader; listing and either proof; query-time expiry                            | New reader only, no default flip or shared mount edits         |
| Indexer / shared feed         | Community/Configuration/Origin/Web2/HNS/Listing/Post events; canonical reorg handling  | Event interface; no Goldsky deployment                         |
| HNS verifier/gateway          | Pinned registry, current controller revision, external evidence; separate naming scope | Stand-in contract tests; live join unqualified                 |
| Learning/Dance                | Stable ID/current roles/config revision; separate consent successor                    | No consent-specific Directory field or activation              |
| Existing deployments/history  | Retain V1/V2 profile and readers                                                       | No automatic migration or source replacement                   |

Regenerate with the pinned offline Forge build, then
`node harness/megaeth/generate-directory-v3.ts`. The generator checks compiler
0.8.30+commit.73712a01, Cancun, optimizer 200, viaIR false/absent, target, no
immutable substitutions and EIP-170 size. It emits the ABI, source metadata,
ABI SHA-256 (compact JSON bytes), runtime Keccak and actual runtime into
`packages/community/generated/directory-v3.ts`. A second generation must be
byte-identical. Formatting source changes metadata and requires regeneration.
The generator also checks every current source hash against compiler metadata
and refuses stale compiler artifacts before writing generated pins.

## Qualification

Local qualification on November 15 passed the complete Directory V3 file
(27 tests), all community Solidity suites (113 tests, including those 27),
and the complete consent caller suite (11 tests), with no skips or failures.
The pinned offline Solidity 0.8.30/Cancun/optimizer-200 build generated identical
output twice. Independent artifact checks confirmed the ABI, source metadata,
runtime identity and EIP-170 size: 20,171 bytes, with 4,405 bytes of headroom.

| Generated pin      | Value                                                                |
| ------------------ | -------------------------------------------------------------------- |
| Runtime Keccak-256 | `0x79e29292b6b6108646c977e795ef2c1670f543e24c3dad0b47d846fe6a4e1973` |
| ABI SHA-256        | `0x4fba8e677f4acd83f77151dde8f5cc39900b2b427f809892dfea8369f6972935` |

Full root types passed with the existing root and web dependencies. A combined
12-file reader/service run passed 131 of 133 cases; the first-song case reached
its 120-second limit and the paired Wizard case hit its fixture HTTP deadline.
Both cases then passed unchanged when run serially, in 61.765 and 34.827 seconds,
with their original limits and assertions. All five new authority-reader cases
passed. The failed combined run is retained and is not reported as green.

Earlier confined-run failures were `listen EPERM` on loopback and missing web
dependency resolution. Correcting runner access and dependency links required
no behavioral source change. Retained commands, outputs, artifacts and exact
source hashes distinguish those failed attempts from the successful checks.
Independent source and generated-artifact review found no blocking finding.

Complete current-base CI with all six suites and release-ready, downstream
deployment selection and real proof/service acceptance remain required. These
local results do not qualify a deployment or upgrade an existing Directory
instance. Run heavy local first-song and Wizard fixtures serially when sharing
this development host; their existing time limits remain unchanged.
