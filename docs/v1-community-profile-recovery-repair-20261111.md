# Profile recovery correction at 6e85419

This bounded continuation starts at `6e85419aa2e2f92fbe172315fce039de3f94328f`.
It addresses the two profile P2 findings in the independent frozen b94 audit,
`parent-profile-player-b94bcd1-audit/review.json`, SHA256
`4c49a2fe271f446fecd1cf74be40ed1c0ed4c5b091a01bbb0236898710b98a19`.
The audited client/controller blobs equal the admitted base bytes. The new
packet records those hashes and all prior/protected evidence before editing.

A receipt lookup is a read, not a verdict on an earlier PUT. Any failed lookup
(including transport failure, malformed success, 404, 408, 429, 401 or 403)
leaves the frozen original command body, mutation ID and expected revision
pending. It issues no PUT. A verified receipt settles that command; a verified
successful absent receipt permits replay of that same command. Another save
remains unavailable while recovery is pending. An actual PUT refusal is handled
separately; authentication, timeout, throttling and unknown outcomes keep the
command pending. Invalid receipt authority also stays unknown.

The HTTP client classifies 401/403 before reading their bodies. Empty, HTML,
malformed or unfinished error bodies cannot turn authentication loss into a 503
or delay masking private owner data. Controller owner reloads mask the previous
owner at their start; mutation/receipt authentication loss publishes an
unavailable view with no owner. The existing integration therefore returns no
ownerAccountId. A retry requires a fresh successful owner read in the same
captured session. An actual session/account change still aborts and drops all
private state, including pending commands; no command moves to another session.

No DTO, backend, profile authority, schema, migration, route mount, settings
workflow or dependency changes belong to this repair. The b94 Settings link in
the Profile fallback and the absence of its former Settings self-link are
preserved byte-for-byte. The original source composition remains ProfileLayout,
ProfileActivity and AccountPage from exact c7cb87835a1858a1955c820b03d566365e6d42db,
with the existing community client/integration underneath. No product editor,
persona metadata, identity claims or unsupported controls are introduced.

The extended Node cases use the actual client/controller and offline Response
objects. They model a committed save with a lost acknowledgement, failed receipt
reads, blocked new saves, original command replay and receipt recovery. New
ProfileRecoveryInput mounts the actual client/integration/CommunityProfilePage
with an explicitly offline transport. Component cases verify ownerAccountId
masking, the retained Settings recovery link, no private account ID in markup,
and one PUT after recovery. Harness buttons are test-only inputs. These cases
are UNRUN; prior coordinator passes at 6e do not qualify changed source.

No functional, component, browser, build, package or type gate ran in this turn.
The coordinator owns execution, independent review and actual public/private
authority validation. Earlier protected-entry/HTTP/chrome proposals and DDL
remain unchanged and unapplied, pinned to their historical 832 base; they must
be reconciled explicitly against the current integration before mounting.
Rendered parity, native behavior, all-page acceptance, full checks and release
remain held. Source inspection is the only new comparison evidence here.
