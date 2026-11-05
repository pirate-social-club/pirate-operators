# Managed community creator connection

The first-song community uses the existing dedicated wallet origin and passkey
RP. Its private account UUID becomes a community-scoped opaque account reference
for the native service. It does not become the public author ID. The community
stores the connection state and PKCE verifier in private D1, tied to its session.
No authentication or verifier is stored in browser local storage.

The community publisher signs a short-lived, domain-separated request for the
wallet service. The service accepts only its curated disposable community and
resolves that community's canonical directory configuration before accepting
the publisher. Launch identity includes the community, account reference,
connection, state and PKCE hash. Repeated requests preserve the same native
request ID and cannot change that identity. A native connection lasts one day;
there is one pending connection per community account and session.

The wallet shows the requesting community and purpose. The creator uses their
saved passkey and explicitly confirms the connection. An existing Active wallet
is reopened and checked before any new activation is considered. A pending
activation cannot silently switch credentials or attach to another account.
The service checks the current native cap owner, wallet, encrypted share and
Active state, and derives the EVM address from the native public output.
The chosen operator-paid Aeneid mint requires no new Ika transaction signature.
The fixed pilot signing exercise is hidden for this release connection.

The service retains its signed binding receipt before consuming the grant.
Receipt delivery is idempotent, including a lost response. Only the community
publisher holding the matching server-side PKCE verifier can exchange it.
The community verifies the Sui operator's personal-message signature and the
entire receipt scope, including its five-minute age. D1 commits the binding and
connection atomically, erases the verifier after success and rejects a changed
creator. A completed retry returns the retained result without another service
operation. A new upload requires a fresh verification; resuming an existing
immutable submission keeps its original creator.

If a native receipt was persisted but delivery takes more than five minutes,
the community authenticates and preserves that original expired receipt and
retires its connection. It does not bind the stale wallet verification or
refresh that receipt's timestamp. A new connection requires explicit native
approval and a fresh ownership read, reusing the existing Active wallet without
another DKG. This prevents a lost response from trapping a session behind the
one-day connection lifetime.

Native credential claims also enforce one private account per credential within
a community before recording a permanent binding. A rejected account cannot be
pinned to a credential already claimed by another account. The community
retires that refused request and permits a new connection for an unclaimed
credential. Another community retains its independent claim namespace.

Popup delivery checks the wallet origin, source window and connection state.
The wallet sends only to the captured community origin. A same-window return
contains the connection and state; the server retains the verifier and approval.
No return URL is selected by the caller. Reload can recover the pending
connection through the authenticated community session.

The community requires migration `0004_creator_connection.sql` in addition to
its publication schema. The native wallet requires the signing, encrypted
activation recovery and scoped-community migrations through
`0004_community_connections.sql` before the updated Worker serves traffic.
These source changes do not themselves establish a deployed wallet update,
live MOSS sign-in, passkey acceptance, registration or publication. The existing
wallet pilot and explicit cryptographic/D1 fixtures remain separate evidence.
