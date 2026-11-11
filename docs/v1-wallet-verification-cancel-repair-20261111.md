# Wallet verification cancellation repair — 2026-11-11

This bounded repair addresses the P2 source finding against exact base
`715bf60b629e7853c4139c9c700f5c33d6dc3015`: an outstanding scheduled palm
verification poll could restore the verification presentation and restart its
timer after Cancel. This is the same original wallet lane/thread
`01a1c6cb-a9b5-7581-9ed1-a2686244c9d6` and worktree. The controller remains the
existing decentralized claim/session port behind the copied Solid composition.

`use-reward-wallet.ts` now captures a verification generation before requesting
an intent, generating its QR image, polling, refreshing after a terminal result,
or returning a row-claim result. Cancel, replacement verification, explicit
same-intent retry, an observed wallet identity change, and disposal invalidate
the generation and clear its timer. Every response/error and every subsequent
timer scheduling decision checks that generation. Refresh checks it before
validating or publishing returned wallet/credit data and terminal conflict
notices check it again after refresh.

Each busy action also owns a serial ticket. Verification takes a fresh ticket
even when entered through the existing `run()` wrapper. An older wrapper's catch
or finally cannot clear the newer action's busy state or publish an old error.
Cancel releases busy state explicitly; disposal invalidates it without writing
signals. An observed account change clears the current QR, intent, credits and
return URL before the existing account-change callback/reload. Calls on that
old controller cannot initiate another verification/claim or expose an old
row-claim response. Identity detection still uses the existing testnet wallet
identity guard; this local lifetime check supplements server ownership checks.

Cancellation changes local presentation lifetime only. The original server
intent, original owner binding, claim qualification and accepted/pending/needed
rules stay authoritative. A current verified result still hands the original
credit ID to the copied WalletWinnings resume flow; it does not start another
controller-level claim. Financial/payment/nonce/SDK/Max/adapters/backend,
default token-only MOSS navigation, API guards and all source compositions
remain unchanged. There is no new dependency, API, storage bridge or entry
mount change. Cancelling does not delete or revoke the durable server intent.

## Prepared regression cases — all unrun

`apps/web/test/reward-wallet-verification.browser.ts` uses the existing wallet
fixture loader, intercepted local build and Playwright fake clock. The only
fixture-entry delta adds a `verification-race` mode. Its new fixture module
mounts either the actual `useRewardWalletController` or the actual
`LiveRewardWallet`; it does not copy the transition implementation. Deferred
service promises let the cases settle a request after the relevant lifecycle
change. Synthetic records stay bound to their original fixture owner across
Cancel, replacement and unmount/remount. They are test data only.

The sixteen queued cases cover:

- Desktop and mobile Cancel after a scheduled poll starts, followed by pending,
  late error or verified responses: no verification view, QR, return claim,
  extra claim or restarted polling.
- Replacement during an old poll, with its result/error arriving while a new
  intent request is held: the new busy state survives; only the new QR/intent
  appears when its current response arrives.
- Late initial intent success/error after Cancel and a new request: stale
  QR work, errors and finally blocks cannot publish or release new busy state.
- Actual wallet identity replacement while a poll is outstanding: old results
  cannot restore private state, and old-credit claim/retry calls are refused
  before another data-port request. An already-requested old claim response is
  discarded rather than returned after replacement.
- Disposal with a late result/error: no subsequent signal/URL/timer changes;
  remount on the wallet route preserves server records without replaying them.
- Cancel during the refresh awaited by a terminal conflict result: late
  wallet/credits and conflict notice do not mutate cancelled presentation.
- The five-failure limit and explicit Check palm scan still resume the same
  original intent; Cancel then stops that timer.
- A current simulated verified response still reaches the genuine source
  resume transition and claims the same original credit exactly once after
  the initial qualification request. No Send or payout occurs in this case.

The fake clock and deferred ports exercise local lifetime behavior. They do not
establish real Very/MOSS behavior, real authorization or payout acceptance.
The owner-change cases prove suppression by the old controller. Actual
cross-session ownership remains enforced by the unchanged server. The existing
`test/manual-rewards-api.test.ts` account-cookie/Origin/CSRF case and
`test/manual-rewards.test.ts` duplicate-subject case are queued as their real
handler/store counterparts; no backend code or assertions are changed here.

## Coordinator integration and evidence limits

The new private packet contains a pinned proposal for the existing wallet
Playwright config and fixture helper. It adds the new test file and redirects
build/results to the new packet. Those shared harness/config files are not
edited by this actor. The coordinator must apply/adapt the proposal before
running; the existing helper otherwise reads the historical build, which must
not be overwritten. No alternate loader or package change is introduced.

All prior tracked source-story/assertion witnesses, protected source, historical
`.local` seals/manifests/logs/captures and external evidence bindings are
snapshotted and rehashed for this handback. Earlier 22 source-story browser
cases, 4 mounted cases and the e76 visual comparison remain dated evidence of
their recorded revisions. They are not evidence that this repair passes.

Only the mandatory scope probe, existing pinned formatter and
`git diff --check` may execute in this actor lane. All tests, typechecks,
builds, browser comparisons and release gates are queued for serial coordinator
execution after seal. Real MOSS/palm/native-device behavior, combined-app and
all-page rendered parity, full checks/CI and release acceptance remain
unqualified. No provider, key, resource, financial or deployment action is
performed or requested for evidence. The next genuine approval remains an
owner/coordinator decision.
