# Telegram persisted publication fence proposal v1

This is a concrete integration proposal, not implemented support. It follows
read-only inspection of the existing Telegram lane's
`services/telegram-linked-study.ts`, `services/telegram-grants.ts` and
`packages/telegram/contracts.ts`, plus lane 6's connected-learning contract.
Their working-tree snapshot hashes are retained in the latest private packet.
The coordinator must bind their checkpointed successors before integration.
No mutable worktree source is imported by this application.

The inspected `TelegramPublicationFence` v1 supplies `grantId`, `actor`,
`accountId`, `authorityVersion` and `check()`. The actor contains community,
bot, generation, user and chat identities. Telegram's adapter checks the
returned `telegramGrantFenceVersion: 1`, and independently verifies that the
frozen Study offer carries `speechChannel: telegram-linked`. The current
learning implementation supplies no support marker. A channel alone is speech
accounting provenance, not persisted grant authorization.

## Serializable binding

The proposed private metadata has exactly this shape:

```ts
interface TelegramPublicationFenceFactsV1 {
  schema: "pirate.study.telegram-publication-fence/1";
  version: 1;
  grantId: string;
  actor: {
    communityId: string;
    botId: string;
    generation: number;
    userId: string;
    chatId: string;
  };
  accountId: string;
  authorityVersion: string;
}
```

The trusted factory copies these explicit fields from the verified Telegram
adapter's fence. It validates the existing canonical actor identifiers and
bounded strings and rejects unknown versions. It never serializes the input
object wholesale, persists `check`, accepts a function from JSON, or derives
authority from a URL, request body, learner-selected channel or browser state.
`digest(facts)` is a private `telegramFenceHash`.

The frozen lesson's internal context stores the facts and hash alongside its
exact `lessonId`, `startedAtMs`, account, wallet, community, source revision and
V4 authorization/target. The signed operator offer includes the same facts and
hash with server-selected `speechChannel: telegram-linked`. They therefore
participate in `offerHash`. D1 `study_publications.binding_json` retains that
binding; the operator's `StudyBinding` and `PublicationJob` retain the same
private context. Checks compare all copies, including wallet/result learner,
authorization and target. A replay cannot substitute a new grant or authority
version for an existing lesson or publication job.

Private fence facts do not enter `StudyTerminalFacts`, public result calldata,
public manifests, logs or URLs. Telegram IDs are not additional on-chain
attribution. Existing public result and account/offer uniqueness remain intact.
Coordinator-owned schema/migration work must reserve final ordinals if storage
changes are needed; this proposal reserves none.

## Trusted resolver and enforcement seams

The coordinator injects a versioned resolver at service construction, using
checkpointed Telegram grant services and lane 6 account authority. After every
restart it reconstructs a checker from persisted facts and the frozen lesson
context, not from a saved callback or fresh client input. The resolver calls
the current grant assertion with the exact actor and grant ID, checks account,
wallet and authority-version equality, verifies enabled bot/current generation,
unblocked chat and unrevoked grant, and applies connected-learning authorization
with the original lesson start. It re-reads after awaited account authorization,
matching the inspected Telegram adapter. An unavailable resolver denies new
work with a retryable error; it never falls back to a website or trial channel.

| Seam | Proposed enforcement |
| --- | --- |
| `services/study-community.ts` trusted factory and `ensureBinding` | Initial `fence.check()`, explicit facts validation, server-selected channel, then persistent frozen context before exposing any linked lesson API. Existing-lesson requests must load and compare the old context. |
| `services/study-lessons.ts` start/open/submit boundaries | Preserve context across idempotent retries. Recheck the trusted resolver for new linked work; immutable prompt/audio checks still apply. A web request cannot strip a linked lesson's fence. |
| `services/study-outbox.ts` / `study-publication-queue.ts` | Compare frozen lesson/binding facts and recheck at queue acceptance before accepting unsent publication work. Persist the context with the outbox before the operator call. Retried acceptance after unlink is denied. |
| `services/study-operator.ts` binding/speech paths | Validate signed private facts against community, learner, channel and V4 binding. Persist the exact context and recheck for new linked speech. Website/trial input cannot manufacture this offer. |
| `services/study-publication.ts` freeze/resume | Persist/compare the same context in the publication job, including after terminal freeze. Check before creating an unsent result intent. Never retarget an old job after unlink/relink. |
| `services/learning-transactions.ts` plus coordinator-owned `operator-tx.ts` | Compose grant denial with existing sign-in/withdrawal gates. Recheck on every actual unsent send, after other awaited fee/receipt reads, with a final synchronous recorded-denial check immediately before marking broadcast attempted and invoking RPC. A check only at `submitResultTransaction` is insufficient. |
| `services/study-publication-recovery.ts` and alarm/general transaction recovery | Reconstruct from stored facts on every restart. Pass the same composed gate into recovery and cancellation handling. Recovery must not use a permissive default or depend on a live Telegram request closure. |

The public `createStudy` result may expose `telegramGrantFenceVersion: 1` only
after the installed implementation supports all of these seams and verifies
the durable schema/resolver capabilities. The marker is a server capability,
not an acknowledgement copied from input. Until integration and its regression
tests pass, the marker remains absent and linked publication remains unavailable.

## Unlink ordering and already-broadcast work

An asynchronous `check()` alone cannot close a cross-service unlink/send race.
The proposed coordinator bridge must serialize grant denial with the operator's
actual send boundary. Before acknowledging unlink, bot replacement/generation
change or an authority-version invalidation, the trusted authority path durably
records the exact grant/version denial in the operator's gate journal and waits
for acknowledgement. This denial and `broadcast: attempted` are ordered by the
same operator store. The final synchronous check and the first RPC invocation
must have no intervening await. A fire-and-forget invalidation notification is
insufficient. Lane 6/coordinator own authority invalidation ordering; Telegram
owns unlink/bot ordering. If that shared ordering cannot be supplied, support
must remain unadvertised rather than claiming that repeated reads are atomic.

Work without a nonce and rows proven unsent (`broadcast: none`) are denied after
unlink; cancellation/release uses the existing chain-safe lifecycle. A signed
row whose first broadcast has not been attempted still requires the current
fence. Unknown dispatch outcomes are not proof of being unsent. For attempted,
unknown or already-mined rows, retain the same session, result commitment,
target, nonce, raw bytes and transaction hash and reconcile through canonical
receipt/commitment reads. Do not turn unlink into a new grant, fresh session,
duplicate result, regraded outcome or new reward entry. Reconciliation is
allowed after unlink; sending a new result or retrying under a replacement
identity is not. Any rebroadcast/cancellation remains subject to the composed
gate and existing conservative transaction policy.

Old linked rows missing metadata cannot be upgraded by attaching the user's
current grant. Deny new work and report the missing fence; retain only existing
receipt reconciliation where a broadcast identity already exists. Website
lessons keep their existing authorization semantics. Trial history never
becomes linked/rewarded history through this integration.

## Required successor acceptance

Pure memory tests should cover explicit serialization without a function,
missing metadata/unsupported version refusal, changed actor/account/wallet or
authority version, resolver outage, revoked/blocked/changed bot and generation,
unlink/relink during every awaited boundary, and exactly one frozen identity.
Controlled dispatch interleavings must cover unlink before queue acceptance,
after acceptance but before nonce/signing, after signing but before first send,
and after `broadcast: attempted`, including a lost first-send response. Restart
tests must discard every callback/cache and rebuild only from persisted facts.

Slot-controlled D1/Worker/chain tests must then prove metadata survives reload,
outbox and operator restart, every actual unsent send is denied after the ordered
invalidation, already-broadcast outcomes reconcile without a second publication,
and unchanged website/trial/economic uniqueness and revocation fences remain.
These checks are pending coordinator integration and the exclusive heavy slot;
none is run or claimed by this proposal. Shared mounts, transaction changes and
the marker require both exact source checkpoints and successor review.
