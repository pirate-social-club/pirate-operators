# Dance recovery successor: integration boundaries

Source base: `6e1d20c240d54cb8634031675dcb3fcf92fe60d7`. The reference
composition remains `pirate-web-solid` at
`c7cb87835a1858a1955c820b03d566365e6d42db`. This bounded repair keeps the
original recorder statechart, preparation/recorder/recording/upload/review
controllers, explicit take preview and Submit for review, observation and
cancellation surfaces. It introduces no public posting, renderer or uploader.
The original source provenance packet and original assertions remain retained.

| Established flow                                 | Necessary private backend departure                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Select song/reference, accept objectives, camera | Freeze the exact account/song/revision/reference/offer before dispatch; an unresolved original keeps its UUID and request bytes.                                                 |
| Review a selected recording                      | An explicit route review ID overrides the current local journey. The separate local review path has no review ID.                                                                |
| Retry the saved original                         | Command preparation commits before journey uncertainty. Both databases retain the original preimage; a deliberate retry rereads it.                                              |
| Record again after completion                    | Archive the original, acknowledge the exact accepted receipt, and require fresh safe canonical completion before retiring an accepted capture belonging to another target.       |
| Private preview                                  | Restore the actual retained original Blob, check current capture permission before and after storage awaits, and revoke the owned URL on denial, expiry, background or disposal. |
| Auth refusal                                     | Known 401/403 headers synchronously mask loaded content before any body decoding. The typed policy error code may still be decoded later.                                        |

These are source-level mappings, not a new rendered parity result. This actor
did not open Storybook, a browser, camera or microphone, and ran no tests,
typechecks or builds. The additional real page fixtures and assertions remain
unrun. The historical 41 cases at 463 do not qualify this successor.

## Concrete ports

The owned client now implements `pirate.dance-command-preparation/1`:
`prepareCapture`, `prepareSubmission`, `dispatchPrepared`, `command`,
`acceptedCapture`, `releaseCompletedCapture`, scoped `acknowledgeRecovery`,
and synchronous `onAccessLost`. Preparation stores `commandId`, `bodyJson`,
the exact HTTP `requestJson` and frozen `targetKey` without HTTP. Dispatch
rereads that preimage and commits its attempt marker before sending. Reload
observation never dispatches a prepared command. Explicit recovery may send
only the same bytes. An accepted original returns its stored receipt without
sending again. A rejected/expired original stays in history.

The HTTP contract here has no command signature field. Fresh same-origin
session/CSRF authentication is separate from these immutable command bytes;
no signature or canonical authority is fabricated. If the coordinator adds a
signed MOSS envelope, its producer must durably reserve the exact envelope,
signature and command UUID together before journey uncertainty, and recovery
must retrieve those original bytes. That composition is a held integration
port, not implemented signing support.

The journey copy retains the same command, including its original target;
immutable preimages cannot be replaced while active. Missing legacy UUID/body
data is explicitly held. A fresh review read cannot reconstruct a lost UUID.
Safe reset archives the old journey and retires only the matching accepted
capture and related latest submission/withdrawal receipt; unrelated active or
accepted originals remain intact. Canonical facts remain coordinator-validated
DTOs; this module is not a chain verifier.

`DanceCaptureLease.release(): Promise<void>` invalidates the handle
synchronously and resolves on the actual `navigator.locks.request` completion.
Recorder reclamation waits for that native completion. Duplicate-owner refusal
remains `ifAvailable: true`. No timer, fake lock or queue bypass is used.

The coordinator's native gate at W1
`6a22a2c3d45c94d73508bbd6cbf76666ff5fd65b` records
`Error:dance_recording_busy`. The source previously signaled a held callback
then immediately reclaimed without waiting for request completion. This is a
specific race candidate, not a claim that the observed failure reached that
stage. The browser case now adds exact boundary context, awaits release and
keeps all original File/Blob, stale-account and duplicate-owner assertions.
Its next execution and the new command-ordering native case are held.

## Coordinator proposals only

- Mount only the frontend delta from this base, or independently select the
  frontend union against `ae30f8597bb43fa52111c5f89cf51ae1c43bdb94`.
  Do not join this branch's held backend or select a renderer/source/publisher.
- The authenticated owner profile producer remains the sole `accountId`
  producer. Wallet/public author IDs never substitute. Keep the account/session
  fence across capture-context, private JSON, catalogue and every await.
- The existing capture-context producer must implement the exact captured
  authorization tuple and return denial before accepting camera or private
  Blob playback. Its fetch boundary must invalidate the mounted private scope
  synchronously on 401/403 headers, including a body that never terminates.
  The same event must reach account subscribers and this client's
  `onAccessLost` consumers; a body-decoding callback alone is insufficient.
- Media playback GET/HEAD/range still requires the reviewed current permission
  producer. Local retained playback obtains `captureAccess` twice; neither an
  object URL nor expiry timer grants permission. Shared media/profile/API files
  are unchanged and their mounts remain held.
- Retire a mismatched accepted capture only using the exact prior capture,
  current private review read, matching source/receipt, `canonical=true`,
  `finality=safe`, and the journal's atomic no-active/expected-pointer guard.
  Production trust still depends on the coordinator's reviewed canonical reader
  and source/ABI pin. Current booleans without that producer are not proof.
- No package/schema/migration changes are required here. Exact XState 5.33.2,
  mediabunny 1.55.5 and the pure Solid components remain the admitted external
  dependency proposals; this actor installed nothing.

The new packet contains exact protected blob hashes and proposed integration
touch points. There is no mounted authority, physical/native success,
browser parity, provider, public clip policy, full-check, CI or release claim.
