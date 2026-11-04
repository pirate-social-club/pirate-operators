# Creator wallet testnet spike

This isolated app tests MOSS sign-in, Release a song, Ika wallet activation,
then reopening and signing with the same creator address. It does not upload,
publish or register a song. It has no runtime dependency on the fixture app or
the production application. The workspace_owner selected these testnet steps
and authorized a dedicated funded operator on November 4, 2026.

The community URL is https://pirate-creator-spike.piratesocialclub.workers.dev.
The wallet URL and permanent passkey RP are
https://pirate-wallet-test.piratesocialclub.workers.dev. Do not rename the wallet
Worker or move its RP after creating a passkey.

## Try it

1. Open the community URL in a full browser with WebAuthn PRF support. Sign in
   with MOSS on MegaETH testnet and approve its sign-in message.
2. Choose Release a song. Allow its wallet popup, save a creator passkey, and
   approve creation. Keep that window open while Ika activates the wallet.
3. Choose Return to community, then Reopen wallet & sign. Select the same
   saved passkey and approve the fixed test signature. Return to community to
   see all three steps complete.

An unsupported PRF provider stops before wallet funding. The first pilot is a
desktop browser test. Real-device Android Chrome, Telegram, popup blocking and
cross-device passkey behavior remain acceptance work; there is no redirect
fallback yet. An activation interrupted after submitting DKG but before local
verification requires the original open page. The app intentionally does not
reconstruct the lost local DKG output from the operator. Keep that page open
and use Retry this step for temporary provider failures. Pending attempts are
retained and cannot automatically spend again.

## Boundaries

Community login verifies a fresh MOSS message through the MegaETH testnet RPC
and sets a host-only HttpOnly session. Login does not create an Ika wallet.
The separate wallet origin uses a native P-256 Sui passkey and verifies its
origin, RP and user-verification flags. Both origins enforce same-origin JSON
writes. The popup return binds the initiating session, origin, state and PKCE
verifier to a single-use exchange code.

The browser wraps a random root seed with AES-GCM using HKDF over a WebAuthn
PRF result. D1 stores only its encrypted record and public metadata. The PRF,
decrypted seed and user share never go to the server. SDK derivation and network
packages are pinned in the lockfile and public evidence manifest. Browser
code confirms capability ownership, encrypted-share identity, retained local
DKG output and Active status before reporting activation. The creator's
native Sui account owns the dWallet capability.

Before spending, the creator signs an intent binding the account, encryption
identity, network key, package set, expiry and fee ceiling. The dedicated
operator sponsors testnet transactions. Signed transaction bytes and digests
are persisted before broadcast; retries reconcile those exact bytes. A durable
operator lock prevents overlapping gas-object use. One active attempt is
allowed per account and credential, with three attempts per day globally.
The budget per attempt is at most 22 IKA and 0.6 SUI; the IKA sub-budgets are
4 for DKG, 13 for global presign and 5 for signing. Fees must fit those fixed
coins or the transaction fails. There is one fixed EIP-191 signing test per
wallet, with no arbitrary transaction or message endpoint.

Reopening requires fresh passkey authentication after activation. Before
native signing, the browser reconstructs and compares the complete allowed
Sui transaction command graph, including message, partial proof, objects,
refund recipient and gas sponsor. The backend verifies the returned ECDSA
signature against the saved creator public key.

## Checks and evidence

Run `npm ci` and `npm run check` here with Node 24 or newer. The check builds
both browser and Worker bundles, then runs six tests covering encryption,
origin guards, actual P-256 WebAuthn registration/authentication and replay,
database limits, native passkey consent, and altered signing transactions.
The repository root also requires `npm run check`. The dedicated GitHub job
does not provision or use funded accounts.

`evidence/testnet-smoke-20261104.json` records a successful real Sui/Ika DKG,
cap transfer, acceptance, reopen, global presign and verified signature. Its
passkey and PRF are software fixtures in a local Miniflare D1, not a bypass
in the public deployment. The live flow preceded the final activation-consent
check; that check has cryptographic unit coverage but still needs the real
browser pilot. Public browser QA confirms the MOSS embed opens and the mobile
layout fits. A completed real MOSS sign-in and hardware/provider PRF flow have
not been claimed.

The manual smoke script requires `RUN_CREATOR_LIVE_SMOKE=1` and the dedicated
Infisical environment. It reuses its private saved attempt on retries. It never
runs in default CI. Do not clear its state or swap its fixture seed to rerun a
paid test. `scripts/fund-operator.ts` defaults to a plan; `--execute` performs
the bounded 2.2 SUI to 22 IKA exchange using the official testnet faucet
contract. Its first and `--pilot` receipts are persisted before submission.
Both funding allocations have already been executed.

## Deployment

Alchemy owns one D1 database and two Workers, all dedicated to this spike.
Build this package, then install the separate `infra` package with `npm ci`.
Use the existing `cf` login for diagnostics and deployment credentials.
Do not introduce a second resource owner or deploy directly through Wrangler.

From `infra`, run the plan with:

```sh
infisical run --projectId 43d2261a-f739-428f-92f2-5f907db24c07 --env dev --path / -- node deploy.mjs
```

After reviewing the plan, add `--execute` to deploy the fixed testnet stage.
Infisical supplies `SUI_OPERATOR_SECRET_KEY`; `SMOKE_TEST_SEED` is only for the
manual local fixture. The dedicated operator address is
`0xe80513f6f72a375ef3fc279f74e904ba4ab244554abbd468559a13a811a82ea6`.
The current funds cover one additional complete pilot, subject to live fees.

Infisical is the credential source of truth. This pinned Alchemy version also
caches resolved Worker secrets in its local deployment state. The wrapper uses
a private 0700 directory under
`~/.local/state/pirate-creator-wallet-testnet/alchemy`, private file creation,
and an ignored `.alchemy` symlink. Preserve that state across checkouts; do not
publish it, its logs, smoke state, browser sessions or environment files. The
deployed Workers disable observability, and production never enables the
local diagnostic binding.

This is an owner-operated spike with finite testnet funding. It does not
implement device recovery, credential replacement, session renewal, operator
rotation, abandoned-attempt cleanup or production service guarantees.
