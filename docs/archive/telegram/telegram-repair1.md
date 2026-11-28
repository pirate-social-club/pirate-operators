# Telegram repair 1

This delta repairs the seven source blockers reviewed at preserved commit
`8d7fe66dd8c45e95164a56cf113e825552ecfdb7`. It adds no feature, widget, coach,
provider integration, runtime mount or design approval. Earlier handbacks,
provenance and interruption receipts remain historical evidence.

## Durable authority and completion

Link transactions snapshot community bot incarnation and per-user/per-account
unlink counters. Every post-await binding check and atomic completion checks the
snapshot. Completion re-reads the current transaction before transitioning: a
completed transaction never returns to redeeming. Unlink increments its durable
account fence even if no grant has yet been committed. A paused completion cannot
undo another completion followed by unlink, including after controller restart.
Existing account/browser/session/community/bot/state/PKCE/nonce checks remain.

Bot replacement increments one durable community incarnation in the same
transaction as registration. Grant reads, assertions, account indices and new
commits check it. This invalidates every old grant without enumeration, including
grants beyond row 1,000 and after restoration of an earlier bot ID. Same-bot
credential rotation preserves a completed current-incarnation grant. Fresh
journals initialize the lineage explicitly. Existing unversioned journals fail
closed: they cannot prove that an old partial revocation did not omit a grant.
Their migration needs coordinator review rather than silently blessing old rows.

## Proven-unsent and unknown work

Speech jobs use durable worker tokens and a write-ahead `submissionStarted`
boundary. The boundary is set in the synchronous turn immediately before calling
the provider or linked Study port. A paused worker must still own its token at
that boundary. A restart can reclaim an explicit unsent snapshot. For legacy
trial snapshots, an admission reservation still in `reserved` proves no provider
dispatch and permits reclaim. Already-dispatched admission can be reused only
with the explicit local unsent proof and a successful worker-token claim.

Once submission may have started, only exact receipt/status recovery is allowed.
No receipt, or no linked attempt, does not prove non-submission. Legacy linked
snapshots lacking the new proof remain unknown. A crash between writing the
boundary and invoking the external call is deliberately uncertain; it is never
made safe by a blind repeat. The persisted shared publication fence remains a
separate required enforcement gate; a version marker supplies no enforcement.

## Preferences and private copies

Preference buttons carry the chosen value. Its application and receipt are one
SQLite transaction, so a lease retry cannot toggle it twice. Old buttons lacking
a chosen value get one recorded choice. Superseded controls cannot apply a stale
choice. Notification delivery rechecks local preferences, current binding and
grant after external authority reads and again at the atomic unsent claim.

Private history exports carry a lesson guard. A bounded cursor also finds expired
unindexed legacy documents without relying on session or trial rows. Cleanup
scrubs their body while retaining minimal send state/digests. Late enqueue,
authority failures and delivery receipts cannot restore a captured expired body.
This does not erase copies already retained by Telegram or an external provider.
Delivery recovery ports must retain only the necessary receipt/effect evidence,
not another durable exported-history body.

Linked voice handles expire after application or 24 hours. Bounded persistent
cursors cover linked sessions, jobs and outbound copies beyond the first page.
Open local session copies close at the existing 30-day bound; terminal copies
expire after the additional 30-day history window. Orphan jobs use a bounded
fallback from acceptance. Cleanup replaces expired jobs with minimal replay and
unknown-outcome evidence, removes ready/index entries, and never sends speech.
Shared Study retains ownership of its authoritative recovery and public records.
Paused resume/submission results cannot restore an expired local session/job.
Trial recovery safeguards remain separate from linked-copy cleanup.

## Evidence and holds

Controlled interleavings, journal snapshot restarts, more than 1,000 grants,
more than 1,000 private copies, and bounded-page cleanup are covered by the
focused Telegram regressions. Restart fixtures now copy SQLite journal snapshots
between in-memory databases; they require no filesystem database, Worker or port.
All external account/provider/delivery ports in these regressions are simulated.
The exact commands, results and source manifest are in
`.local/handback-telegram-repair1.json`.

The interrupted broad gate remains non-green (exit 143). No broad, Worker,
fixed-port, browser, build, forge, fork or provider check was started for this
repair. Coordinator controls the heavy slot, source preservation, independent
review and full integrated exact-candidate gates before publication. Runtime,
login origin, broker/account provisioning, actual shared publication-fence
enforcement and real native-phone acceptance remain held. Paper remains
unapproved. No additional writer was created.
