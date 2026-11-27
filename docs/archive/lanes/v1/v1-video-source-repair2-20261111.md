# Bounded media auth and device source repair

Exact base: `da6da41469323bcee850d83e3276afa61f736f7b`. This packet addresses
only the two P2 findings in `owner-media-source-repair-exact-review.final.txt`
and the actual-path regressions needed to review them. Earlier coordinator
typecheck/123-case evidence applies to that base, not this unexecuted successor.

Canonical status GET 401/403 now persists `authenticationHold` while preserving
the pending command, dispatch witness, immutable intent/digest, File and existing
canonical status. It does not reinterpret a refused read as a definitive refusal
of the earlier mutation. Non-auth read failures retain their existing behavior.
Successful canonical reconciliation still clears the hold through the existing
receipt-acceptance path, with the same account/community and media bindings.

Background `refresh()` performs no network work while held. VideoFlow restores
with `restore({ reconcileHeld: false })`, so a persisted reconnect hold survives
remount without automatic retry. The existing explicit retry/submit path, or an
explicit default `restore()`, can reconcile the same identity after reauthentication.
The original VideoFlow polling guard and copied XState chart remain the flow
owners. No command, screen, session provider or request identity was added.
Withdrawal retains the earlier DELETE-only/identity-only recovery path; an auth
hold does not make withdrawal resume recording bytes or processing.

The four adopted constructors now use explicit fields and assignments instead
of TypeScript parameter properties: `VideoComposerMedia`, `VideoCaptureError`,
`SongSourceError` and `ServiceRefusal`. Argument order, readonly/optional field
contracts, messages, error names and the original options-object identity are
preserved. Capture, refusal mapping and resource behavior remain the copied
implementations. Node flags, package scripts and test globs are unchanged.

## Prepared evidence

`media-source-repair2-device.test.ts` statically imports the actual production
device module under the unchanged strip-only Node loader. It constructs and
drives that class with explicit preview, capture-session, guide and resource
doubles. Cases cover preview handoff, guide start, cancel/cleanup, successful
File finish, late camera/guide completion after abort or disposal, late preview
permission, eligibility loss, refusal constructors/projection and asynchronous
capture-source failure cleanup. It does not substitute the prior memory-only
control helper for the device class, and does not transform the device import.

Applicable original cases come from exact `pirate-web-solid`
`c7cb87835a1858a1955c820b03d566365e6d42db`,
`src/features/posts/video-submission/video-composer-media.test.ts`. Their original
immutable `.reference` witness and prior provenance receipt remain unchanged.
The new cases adapt the original abort/dispose, late preview and eligibility
sequences to Node assertions and the admitted required guide-source seam.

`media-source-repair2-auth.test.ts` exercises the actual media HTTP adapter and
controller with lost upload acknowledgement followed by status 401/403, durable
restore, background hold, explicit positive reconciliation and DELETE-only
withdrawal. It also runs the actual VideoFlow function and adopted actor with
the pinned Solid 2 browser reactive runtime in-process. Following the preserved
capture regression pattern, only the Solid-owned function/hook bodies are type
erased for dependency binding. The production device module is directly imported
before this harness, without alternate loader flags. Controlled interval callbacks
drive the actual copied poll actor/guard, rather than a replacement reducer.
The flow cases cover hold after a real poll tick, silent later ticks, held remount,
explicit same-owner retry, resumed canonical polling and a ready receipt without
publication/exit. This is not DOM rendering or a physical-device capture test.

There are 17 prepared cases; **none have run in this source turn**. Only pinned
Prettier and `git diff --check` are permitted here. The coordinator owns all
execution, typecheck, mounted Solid/DOM/render, physical-device, provider,
integration and release gates. In-memory storage does not prove File serialization
or cross-context storage exclusion/CAS. Source doubles do not qualify encoder,
microphone/camera timing or provider acceptance.

Public creation remains denied, the default composer remains unmounted, public
clips stay independently 3–15 seconds, and private Dance/backend/retention remain
unchanged. Real text/song/storage/account-lifetime producers are still required
ports. No ready receipt is converted into a publication claim, and no provider,
manifest, lockfile, backend, shell or earlier evidence was changed.
