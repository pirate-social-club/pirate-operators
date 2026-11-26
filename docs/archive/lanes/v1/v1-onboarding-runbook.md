# Community setup and open onboarding v1

This runbook applies to the decentralized community MVP on ordinary HTTPS.
Source base: 67cbe118ade39790bc1539999ca75d0d7ff10b6d. Implementation lane 6
prepares source and review packages only. It changes no deployed resource,
credential, contract permission, funded account or production activation.

## Bounded proposal

For a separately reviewed testnet cohort, propose at most 20 first-use accounts,
0.04 test ETH in worst-case activation plus authorization gas per account,
0.8 test ETH total first-use gas and 1 test ETH total lifetime transaction gas.
These are conservative maxima, not measured costs or funding instructions.
The transaction maximum is gas limit 2,000,000 times maximum gas price
10,000,000,000 wei plus an explicitly reviewed data-fee bound. The initial
proposal has zero additional data fee; increase that bound if fresh chain
inspection requires one, before admission. Raising a budget requires a reviewed
configuration update and preserves every prior charge and reservation.

Propose 200 speech units per day, 100 reserved for website Study, 20 per account
per day and, when Telegram is enabled, at most 50 Telegram units drawn from the
unreserved 100. A unit is defined by lane 5's admission contract, not an asserted
ElevenLabs billing unit. Require a $10 monthly provider-side ceiling or an
operator alert/stop procedure if that provider cannot enforce it. The wizard's
monthly value is a proposal and must never be described as a provider-enforced
cap. Refusals and unknown provider outcomes follow lane 5's reservation rules.
These values await spending review; they activate nothing by themselves.

## Prepare a second community

1. Use a distinct private runner state directory and the community's own
   Cloudflare account. Keep the first community's state, database and journals.
   Managed Cloudflare authentication belongs to the runner. Do not copy tokens
   into this manifest, chat or source. Run the wizard only on its printed
   loopback origin, with its Host, Origin and session-token write protections.
2. In Learning, save the community ID, deployment ID, ordinary HTTPS app origin,
   a separate learning Worker HTTPS origin, the reviewed V4 testnet contract,
   owner address and dedicated grader address. The app and learning Workers
   must reside in that community account. This uses service bindings rather
   than a cross-account shared speech Worker. HNS is optional; Spaces remains
   Coming soon. No registry, DNS or Spaces operation runs in this step.
3. Select a community Infisical project, environment and existing dedicated
   folder. Use managed CLI login or a folder-scoped machine identity on the
   runner. Connect and check that exact scope. Save ELEVENLABS_API_KEY through
   the password field. The local state and plan contain references and saved
   names only. Never request a key in chat. Reconnect after restart or scope
   change; saved flags are not trusted across sessions.
4. Optionally enable Telegram with its bot ID and generation and save
   TELEGRAM_BOT_TOKEN in the same community scope. This token belongs to the
   community bot. Platform login credentials and any broker credential belong
   to separately managed platform services. Settings expose saved/masked status
   and unverified health; the Telegram owner supplies real bot/webhook status,
   replacement/unlink generation handling and notification controls. Moderators
   receive no credential-management controls from this loopback runner.
5. Review the bounded cohort, per-account/lifetime gas budgets and speech
   reservations. Prepare the immutable community-setup/v1 review package.
   Changing the scope or limits invalidates it. A partial/uncertain secret save
   clears confirmation; reconnect and recheck existing values before retrying.
   No values or raw provider errors appear in responses. Deployment through the
   old scaffold path is held when learning is configured so an incomplete
   learning plan cannot be mistaken for a working community.
6. The coordinator integrates the plan with Alchemy-owned Worker, D1, R2, job
   and service bindings, lane 5 speech admission and reviewed release profiles.
   Bind the operator's activation caps explicitly and remove the old address
   approval binding. Do not run cf or Wrangler to mutate Alchemy-owned resources.
   Dedicated grader/publisher secrets remain managed deployment bindings, not
   wizard-exported private keys. Existing legacy result targets, where present,
   retain their historical contracts. Contract deployment, grader permission
   writes and policy activation require their separate admitted execution task.
7. Before release, run `verifyCommunityAuthority` with the expected publicity
   policy and a read-only reader pinned to one block. It checks chain ID,
   deployed code, community ID, immutable app origin, controller and Study plus
   Karaoke grader permission. Verify source/codehash, canonical policy version,
   exact community directory and app profile independently as release gates.
   This helper alone does not attest the contract code or publisher identity.
8. Through the community's admitted song-publishing path, publish its own real
   songs. Retain exact post IDs, content revisions and audio digests. Record
   them as `songs` in the review/acceptance manifest; the wizard's empty list
   cannot establish first-song acceptance. Show publication, playback after
   reload and usable lyrics/timings in a fresh browser.
9. Prepare fresh live preflight and the independently reviewed exact source;
   require all release CI, including separate Study and Karaoke browser jobs.
   The coordinator owns one bounded testnet execution, served asset/health
   readback and the resulting second-community acceptance evidence. Production
   activation remains a separate gate.

## Authority and retries

Website Study/Karaoke and verified linked Telegram learning use the same
`practiceAuthorization` authority. It admits only a recorded sign-in belonging
to the account and bound wallet, issued before the activity, still valid in a
fresh operator read and still current after a second local withdrawal check.
Slow/unavailable/malformed reads yield pending; revocation or restarted
permission refuses the old authorization. Plain login can proceed without
restoring publication. A concurrent local withdrawal wins over a slow login
observation. The contract rechecks authority at publication and qualification;
an RPC observation can never eliminate a later on-chain revocation race.

`connectedPracticeAuthorization` additionally checks the database's community
identity and resolves the current verified link twice, fencing unlink, bot
replacement and account changes during admission. The link must precede the
activity. The Telegram service owns authentication of that resolver. Never
pass pre-signup trial history to this interface or backdate linked work.
Reward uniqueness remains the existing one-share-per-account/offer rule.

A new ERC-8010 account keeps the approved delegate/initializer, chain, signature
and nonce checks. Before either first-use transaction is signed, one account
slot and both transaction maxima are reserved atomically in the existing
operator journal. Exact retries return the retained transaction. New sign-ins,
key changes, reverts, unknown outcomes and restarts cannot reset the slot.
No automatic refund of uncertain activation is implemented. Exhaustion refuses
new first-use work while previously signed work can reconcile. Operator-relayed
activation uses the operator's gas journal: MOSS user-transaction sponsorship
has not been proven to cover this path, and no external sponsorship subsidy is
assumed. Per-account caps bound cost; they do not identify one human or prevent
Sybil accounts from consuming the entire finite cohort.

## Evidence required after source handback

Local fixtures establish real handler/crypto/storage/chain behavior only at the
named local subset. Real Infisical authorization and secret writes, community
Cloudflare ownership, Alchemy deployment, current provider billing controls,
MOSS first-use on a public testnet, real song playback, linked Telegram/mobile
and second-community Study/Karaoke remain acceptance work. Owner body/key
operations occur only as part of that concrete reviewed release package.

Cloudflare service-binding reference checked for this design:
https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
No centralized application source was copied into this implementation; it uses
existing decentralized V4 account and transaction services from the stated base.

The setup plan's source digest covers the runner packaging input list. It is
not an executed community release attestation. The coordinator must bind the
complete community/operator bundle and reviewed commit separately before
execution. Lane 6 handback includes per-file SHA-256 values for exact preservation.

SQLite transaction semantics reference checked for the local journal proof:
https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

A fresh community uses `communityLearningBindings` to prepare its own operator
and application bindings and service name. It proposes the V4-only runtime
profile `pirate-community-learning-v4`. The existing runtime requires V2/V3
addresses, so the coordinator must review and adopt the accompanying profile
proposal before using these fresh bindings. Never point fictional historical
versions at V4 or copy the first community's contract addresses to satisfy that
gate. The proposal is checked locally; shared source is unchanged.
