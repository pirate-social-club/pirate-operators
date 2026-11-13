# Release shared recognition implementation

Pirate owns one logical ACRCloud recognition service and fresh catalog per release
environment across all communities. Communities use signed, scoped service
requests and retain their own publications. No legacy bucket inventory, import,
migration or backfill belongs to this release implementation.

## Current additive source

packages/recognition contains the fresh service schema, recording/publication
store, authorization, catalog transport, verification/recovery and known-match
resolution. services/shared-recognition.ts composes signed enroll/status/withdraw
HTTP handlers, bounded worker advances and durable recovery scheduling. Required
publication-authority, object-capability, quota and queue ports have no default
success implementation. This is additive source; existing community publishers,
configuration, policy and deployment recipes have not been cut over.

A recording is scoped to its release namespace and canonical audio hash. Its
creator identity is verified service-owned authority. Community publications have
separate revision-bound associations. A different creator cannot replace that
recording; replay cannot reactivate a withdrawn association. New publication
revisions withdraw only the previous revision of the same community/post.

Enrollment persists before queue delivery. The worker records an upload intent
before transport, reconciles exact opaque provider metadata after an unknown
outcome, and never automatically uploads again because a lookup finds nothing.
It verifies the expected custom recording through the identification API before
ready. It journals identification intent too: a retained response can finish
verification after restart without another call; an unknown verification send
without a retained response stays unresolved. Known inconclusive responses can
return to processing under the existing quota port, without resetting allowance.

Removal withdraws only its association and retains provider recognition while
another active association exists. Last-reference deletion fences new enrollment
before deleting that exact provider file; an uncertain delete reconciles through
idempotent deletion of the same file. Failed and deleted records cannot be
reactivated by an old enrollment request. Reactivation needs an explicit reviewed
successor rather than a fallback or hidden new upload.

The service accepts publication identifiers, not caller-supplied creator, media
or licensing facts. Pirate's verifier must load current canonical publication,
creator and license authority. A community publisher signature authenticates a
request; it cannot itself prove somebody else's creator identity or rights.
Recognition evidence, community moderation, publication signing and creator
wallet authority remain separate concerns.

The source successor adds a separately signed catalog-status contract and a
community server client. Both publisher requests and replies bind the pinned
service-profile hash. Replies also bind the exact signed request, community,
configuration, publication facts, association and canonical recording. The
recognition signing key is an explicit service input; the client obtains its
public pin from owned deployment/configuration inputs. It never accepts a key
or profile chosen by a response.

Each status poll uses a fresh signed nonce. A previously ready response cannot
answer a later request after withdrawal. Status receipts expire within sixty
seconds, and client.ready performs a new request and requires a verified ready
state. These receipts are scoped observations, not offline publishing permission
or an original-work/catalog-completeness proof. The publication driver must
still recheck its own captured authority and durable obligation before sending.

The service obtains association and recording state in one D1 read, then checks
current canonical publication facts, pairing, expiry and the retained binding
after asynchronous signing. It will not expose a ready response if withdrawal,
terms or authority changes during that signing boundary. The client checks
authority again after reading and verifying the response. Its required
beforeSend port is the final durable publication/outbox lease gate immediately
before HTTP transport, and may retain the scoped signed wire only in private
job storage. It has no success default. No ACRCloud credentials or bucket choice
exist in the community client.

Root typecheck and all thirty-four focused service/client tests pass for this
successor, including eleven new receipt and signing-race cases. Provider and
publication-authority transport remain explicit simulations. Independent review,
actual publisher/configuration mounts and live qualification are still required.
The earlier full check timed out, and no completed full-gate pass is claimed.

## Required integration before release

The shared publication writer needs a durable intent/outbox and explicit catalog
readiness boundary, including recovery between a chain receipt, stored operation
confirmation and job advancement. It must not finish a new-policy job while its
required catalog obligation can be lost. The current SQL phase constraint and
captured-policy job sequence require a coherent reviewed migration/producer/
consumer change; do not rewrite existing job policies or hashes.

New original enrollment captures the service catalog revision before its fresh
recognition check. The enrollment transaction rejects an intervening revision or
another unresolved recording, including an unknown upload without active references.
Recording state changes advance that revision. This prevents a stale no-match
from authorizing a second recording after concurrent enrollment becomes ready.
The production resolver must still verify actual no-match and catalog coverage;
the community writer must durably register every required publication intent.
The known-match resolver deliberately
returns hold for empty, unknown or ambiguous candidates. It does not authorize an
original on no-match, and cannot substitute for the missing completeness gate.
It loads fresh source terms and rechecks the active association after that read.
The current release remains owner-only; derivative helpers do not enable general
creator posting or invent permissive terms.

The deployment/configuration owners must supply the fresh catalog namespace,
project/bucket and identification association, scoped credentials, separate
recognition trust, actual service/publisher authority verifier, media capabilities,
durable quotas, queue/scheduler and migrations. No community receives ACRCloud
keys. Linux's reviewed deployment-profile interface must select the shared
connection coherently. A reachable endpoint is not proof of catalog readiness.

Provider receipt retention stays in the private service database. Secrets never
enter request bodies, public status, source or logs. Catalog URLs are fixed by
the service profile; credential-bearing requests reject redirects. Provider file
processing status is distinct from same-project recognition verification. See
[ACRCloud audio files](https://docs.acrcloud.com/reference/console-api/buckets/audio-files)
for the upstream upload/list/delete contract and
[D1 batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
for the atomic schema/store execution boundary.

## Qualification

The prepared shared-recognition tests use actual D1, signed service HTTP requests,
request builders and response parsers with explicitly simulated provider and
publication-authority transport. They cover cross-community shared enrollment,
restrictive licensing, wrong publisher/community, nonce/body replay, atomic
conflicts, lost upload response, journaled verification recovery, lease expiry,
queue wake loss, unknown sends, last-reference cleanup and post-read source
withdrawal. They are not an acoustic or deployed-provider qualification.

The actual community admission/publication/queue routes must still be connected
and tested with two independently configured communities and one shared service.
Only then run the separately bounded real-provider qualification on authorized
content and the exact reviewed release package. Source presence, a passing
known-match function, a ready fixture row or a historical provider check cannot
establish working release coverage. No deployment or feature-completion claim
is made by this additive source.
