# Community package custody proposal

This is an unselected after-image proposal against exact source
`fca70d0a514f70fbf284c2b09965f291d2de9698`, whose tree equals merged
`47a11eea50727a6dc7a0b6b753a6f49479c5e5f2`. It changes no live source,
selection, credential, state directory, resource, migration or release.

The predecessor has nine selected assets and seven additional retained/served
files. Those extras remain evidence in the historical directory. The successor
does not absorb them into its public asset selection.

## Preparation and adoption

The runner authenticates the recorded current execution. Its bound package is
resolved from private execution metadata. Only the exact recorded predecessor
execution digest permits legacy `deployment` resolution without a binding.
New executions without a binding fail. No arbitrary-directory CLI option,
changed HOME, full-directory link, loader hook or restore fallback is added.

Before creating a successor, `preserveReviewedPackage` preserves the exact
predecessor, including its current encrypted state. `prepareCommunitySuccessor`
then prepares `deployment-<full profile hash without 0x>` using exclusive mkdir.
The root and all new regular files are owner-private. A partial directory is
left visible; no preparation overwrites it. A completed but unadopted directory
can be reused only if its complete ready record, source state and artifacts
still match. Changed source or state requires review, never recopy-over-retry.

Current authentication covers App, Database, Media, Jobs, Consumer and stack
output, not the original wizard five-file subset. It checks ownership/modes,
regular files, exact state paths, status, FQN, instance and fixed resource IDs.
Worker bindings are inline in the pinned Alchemy ResourceState. Required DB,
Media, Jobs, learning-service and SpeechBudget targets must match; missing,
foreign or ambiguous targets fail. Ordinary literal/secret binding records are
authenticated as part of ciphertext and structurally checked without logging
or freezing their values across an intended update. Resource identity remains
pinned while legitimately changing env values remain mutable engine state.

Ciphertext is copied with identical paths below `.alchemy/state`, retaining
the encryption wrapper's relative associated data. Source/destination digests
and authenticated identities must match. Backup digests must include the
current six records before preparation. No credential value is exported into a
receipt. This turn reads only supplied nonsecret metadata; real current state
authentication is an unrun coordinator gate.

The full immutable ready inventory binds worker bytes, exact selected asset
names/bytes, selected migration names/bytes, generated package JSON and all six
infrastructure source copies. Missing, extra, altered, linked, hard-linked,
special or substituted paths fail. The sole dependency link is checked against
its recorded real path/device/inode; existing retained-tree verification remains
required. The ready record binds profile hash, full artifact map, dependency
identity, captured state identities/digests and predecessor preservation hash.
It is published durably only after complete copying, verification and syncing.

Community adoption adds that binding to execution metadata atomically after
readiness and preservation checks. Generic creator-update functions and their
existing source/test bytes remain unchanged; a community-only function is
appended. Public profile fields and canonical hashing semantics are unchanged.
Changed owned source naturally requires a newly reviewed profile/artifact hash.

## Execution and recovery

Both actual Alchemy commands use `runCommunityPackageCommand`. Immediately
before handing cwd to the command callback, it rechecks execution binding,
immutable inventory, dependency link and current authenticated state identity.
The retained dependency verifier still runs before each command. An idempotent
private attempt-intent marker records the same binding. That marker is not
proof a command succeeded or even reached Alchemy.

Once adopted, retries use the evolving state in that same directory. They never
restore the ready snapshot or wizard state. Unknown/interrupted state fails
closed if identity is ambiguous. Preflight, Consumer checks and diagnostics
resolve the same binding. Completed reconciliation additionally requires the
result's package binding and full terminal ciphertext inventory to match fresh
state and existing live checks, and returns without plan/apply. Drift after
completion is a hold, not permission to replay.

## Qualification still required

All new cases are UNRUN. They cover stale input/installed extras, changing copy
inputs/state, missing or foreign Consumer/bindings, preparation and adoption
interruptions, path/profile/manifest substitution, command cwd, evolving-state
retry, dependency/link rejection and completed zero-apply reconciliation.
Fixtures use local simulated records and actual fixture encryption; they do not
authenticate private operator state or qualify a provider/engine.

Pinned Alchemy 2.0.0-beta.85 `LocalState` anchors its state root to initial cwd,
`Entrypoint` resolves/imports the selected entry, and the owned encryption
wrapper authenticates relative paths. Unrun regressions exercise the actual
wrapper with a local filesystem port and native import of exact infrastructure
copies from a fresh linked directory. No stack evaluation, plan or apply is
claimed. The actual retained execution tree's loader, generated `.alchemy`
files/private modes, lease/atomic-write behavior and engine relocation remain
concrete qualification seams. Unknown generated links/files are rejected;
there is no permissive exception or replacement-state fallback.

The optional v28 after-image is not included. Its public selection remains
unapplied, as do migration18/19 and all other release decisions. Coordinator
must reconcile the exact predecessor plan/receipt, authenticate current state,
run source/type/focused/loader/engine/full/CI checks under its custody, obtain
independent review and select a source successor explicitly. No after-image
from this packet may silently enter the merged checkpoint or a release.
