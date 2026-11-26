# Wallet composition correction, November 11

This correction implements the direct owner instruction in
`owner-shell-rejection-20261111.json`, starting at reviewed main
`af714492e1065970652d24f0644b32829d38b8ea`. The coordinator preserved the earlier
lane at `811336a`. Its private handbacks, proposals, manifests and evidence are
historical records and are preserved byte-for-byte.

`LiveRewardWallet` remains the mount in `apps/web/src/live/rewards.tsx`.
Its existing props and `/wallet` and `/verify/very` behavior remain available.
The optional `identity` prop accepts existing session display metadata only
when its address equals the actual MOSS address. Without it, the original
address-label formatter displays that address; no profile facts are invented.
Shell, profile authoring, navigation and outer page assembly remain with the
shell actor. No shared entry, stylesheet, API contract, server, lock, release
pin, contract or operator page is modified here.

## Actual source reuse

The selected pure Solid source is `pirate-web-solid`
`c7cb87835a1858a1955c820b03d566365e6d42db`, named in the coordinator's source
pins. `apps/web/src/wallet/established/` independently owns copies of:

| Composition and behavior                                    | Exact source under `src/features/`                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| WalletPortfolio, wallet selection and page cards            | `wallet/wallet-portfolio.tsx`                                         |
| WalletHub, action placement and sheet ownership             | `wallet/wallet-hub.tsx`, its model, view model and types              |
| ReceiveSheet, responsive dialog and chain/address selection | `wallet/wallet-receive-sheet.tsx`, its model, view model and types    |
| Send Flow and its dependency boundary                       | `wallet/wallet-sponsored-send-sheet.tsx`                              |
| Claim rows and claim/resume transitions                     | `rewards/wallet-winnings.tsx`, `winnings-model.ts`                    |
| Checksum/recipient policy                                   | the pure `checkRecipient` section of `rewards/winnings-send-model.ts` |
| Token and chain visual composition                          | `wallet/wallet-visuals.tsx` and its five local assets                 |

The Very claim presentation uses the rendering hierarchy of
`src/routes/verify/very.tsx`; its existing decentralized intent and QR/app-link
port remains responsible for the testnet ceremony. The source's centralized
community-join, identity-creation and widget services are not introduced.

The old hand-built wallet cards, separate Send/Receive card layouts, page
heading and lottery section are replaced by this organized hierarchy. Icons
are part of the copied compositions, rather than the extent of the reuse.
Original Card, Avatar, TextField, Modal, typography and icon primitives resolve
through the already pinned local Solid UI package. Relative module extensions
are made explicit for this repository's native Node TypeScript tests.

The other pinned references were inspected read-only. At the admitted
`pirate-web-reference` pin `dca054847b3d48237780dcf834b7924c5fede0af`, the old
composition tree imports React, so it is not a runtime source. Its
`packages/solid-ui` remains a primitive reference. The protected design-system
pin is `10f3760f82507690c0894355733682df801648e9`. No reference checkout is a
runtime import. The available upstream AGPL license is preserved verbatim as
`established/LICENSE.upstream`; this lane does not edit the root license.

Exact source commits, paths, Git blob IDs, SHA-256 digests, copied assets,
source tests/stories and destination digests are bound in the new private
packet's inventories and source manifest. Raw source transition tests and
stories are retained as `.source.txt` beside the adapted tests. They are not
runtime modules or a claim that those tests have passed here.

## Necessary service adaptations

The component hierarchy, action ordering, card structure, responsive sheet
layout, source copy and applicable transitions are retained. Backend-specific
changes are explicit:

- The actual community response supplies its one MOSS account and test USDm
  section on MegaETH testnet 6343. The centralized persona loader, static
  multi-chain catalog, USDC/Base actions and network switch are not mounted.
  The accepted `renderAssetSupplement` seam receives that exact token row.
- Total balance and token amounts come from the existing integer formatter;
  earned and pending rewards remain separate. Exact small amounts may wrap
  in the existing display element instead of overflowing a phone. Source
  receive-address copying also rejects a late completion for another identity.
- The source Rewards summary and WalletWinnings row composition consume real
  credits and drawing status. No prospective prize is rendered as a credit.
  `subject_conflict` is a held support state. Fully paid credits cannot claim
  again. Onward send comes from the real wallet balance, not an assumed prize.
- Source Send's seven steps remain `loading`, `unavailable`, `details`,
  `authorization`, `verification`, `review` and `status`. Its `begin`,
  `confirm`, `authorize`, `refresh`, `signIn`, `requestClose`, `shutdown` and
  `startNew` behavior is reused through `WalletSponsoredSendDependencies`.
  No replacement state machine or XState dependency is introduced: this pinned
  wallet flow is signal-based.
- `moss-sponsored-send.ts` supplies the serving wallet's chain, token,
  precision, account and fees. The source's claim that Pirate covers gas is
  replaced with the real MOSS reserve/estimate disclosure. No Base explorer
  URL is fabricated. A transfer link requires an explicit trusted port;
  otherwise its real hash is text.
- Hosted MOSS owns recipient, amount, Max and durable wallet history. This is
  the reviewed base's token-only `mega.send` navigation, not a client-created
  payment intent. The page never infers confirmation or repeats a transfer.
  History remains reachable without initiating another Send. MOSS's external
  iframe owns focus, so the source Modal yields focus custody for this port;
  source story doubles retain their normal modal behavior.
- The optional existing guarded adapter retains its server intent, frozen
  nonce, exact sender/token/recipient/amount and quoted gas cap. Quote and
  prepare are separate. The durable dispatch precedes the actual MOSS call.
  A lost prepare response reads the original intent, and an unknown outcome
  never allocates a replacement. Manual retry uses the same guard; cancellation
  consumes that guard or cancels an intent that was never dispatched. Only
  server reconciliation establishes completion. This correction does not
  mount or activate held newer backend work.
- Centralized payload signing, Privy, API-client/auth imports, global sign-in
  hooks and tab-storage authorization are replaced with explicit MOSS and
  decentralized data ports. The source continuation seam stays optional and
  grants no authority. Ordinary MOSS Send gains no new palm requirement;
  existing reward claim verification remains required.
- The reviewed decentralized claim controller retains request serials,
  account-change fencing, intent IDs, same-origin return validation, bounded
  polling and stale-verification handling. After verification, the copied
  WalletWinnings resume machine consumes the return URL and claims once;
  there is no competing page-level resume claim.

All operator payout, settlement, chain-safe close, authentication and API
guards remain unchanged. No financial recovery is replaced by UI state.

## Source cases and queued gates

The pinned Send `.test.tsx` transition fixture and `.stories.tsx` review double
are adapted in `reward-wallet-owner-flow-doubles.ts`. They drive the copied
component in browser cases, including body-portal lookup. These preserve the
source tests for reservation-before-signing, lost reservation response,
uncertain submission across reopening, changed server records, authorization
holds and late restoration after disposal. Source Mainnet/Base host selection
cases are replaced by explicit MegaETH-testnet-only refusal cases. Centralized
Palm-to-Send continuation is not enabled; actual claim intent recovery is
covered separately.

The owned queued tests additionally cover desktop/mobile WalletPortfolio and
Receive geometry, source Send review/change-details, actual actions, separate
hosted and guarded adapters, payout-closed credit presentation, no invented
identity data, unknown balances, exact sub-cent amounts, account changes,
clipboard races, Max fee/recipient review, lost prepare recovery, frozen-nonce
retry/cancellation and MOSS external focus. Fixture storage contains only test
doubles and counters. Product adapters import none of it. New browser outputs
go under the new private packet and cannot overwrite historical captures.

By direct owner instruction, this actor ran no tests, typechecks, builds,
Storybook, browser, package, Forge, install or provider commands. Only pinned
formatting and `git diff --check` are allowed here. The coordinator owns the
manifest/lock proposal, all serial gates, rendered comparisons and independent
review. No rendered candidate, physical acceptance or working-flow success is
claimed from file provenance or from preparing these cases.

## Authoritative pilot closure and limits

The coordinator's `pilot-reconciliation.json` closes the original payout:
0.03 test USDm, 18 decimals, accepted and fully paid, reserved zero. The prior
0.03 classified outgoing cost is unrelated to gas. The retained genuine Max
Send reserved `24325200000000016`, delivered `5674799999999984`, paid fee
`1120649801400000` and refunded `23204550198600016`. These are preserved read
evidence, not new actions or invented provider quotes. A queued regression uses
that closure to keep pending rewards zero; it does not treat historical cost
as a learner fee.

The exact c7 wallet desktop/mobile captures and the parent's completed Send
Details/Review receipts are reference fixtures. Candidate comparisons at the
same viewports remain the coordinator's gate. No duplicate Send, claim, wallet
approval, key export, fixture funding, deployment, provider change or release
was performed. The next genuine approval is coordinated with the owner;
no redundant approval is requested for evidence.
