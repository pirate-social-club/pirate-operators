# Creator wallet and song registration, version 4

Status: owner-selected design, 2026-11-04. The browser pilot demonstrated
activation, reopening and a verified signature. Full acceptance, the sponsored
service integration and song registration remain incomplete. Creator payments
are deferred for this milestone. This is a testnet integration, not a
production launch.

Version 2 follows the owner's simplification: use saved passkey access and a
normal reopen-and-sign check. The separate recovery key, multisig account,
standalone recovery client and device/site-outage drills from version 1 are
deferred. They are not MVP prerequisites.

Version 4 applies the later owner-confirmed first-song decision: the operator
covers test fees within a capped allowance and creators see no payment screen.
The [funding and wizard contract](creator-wallet-payments.md) owns that service
pairing and readiness. It supersedes version 3's creator-upfront recommendation;
commercial pricing remains undecided. Infisical remains required for the wizard's
service secrets. Saved passkey and cryptographic requirements are unchanged.

## Scope and authority

Ordinary participation uses the existing MOSS/community session flow. Reading,
karaoke, study and ordinary dance posts never create an Ika wallet or require
a creator passkey. Only the first attempt to release a song starts this flow.
Subsequent releases reuse the activated creator wallet.

This is the narrow exception to the earlier blanket exclusion of Ika in the
MOSS/MegaETH MVP handoff. Privy and WaaP are not introduced. MOSS remains the
ordinary wallet; Ika supplies the creator's EVM signing capability. Do not
assume MOSS supports arbitrary EVM chains or Sui. An EIP-7702 account is an EOA
with delegated execution; receiving at its address does not prove that its
user can control assets on another chain.

The creator owns the Sui control account, Ika capability and EVM recipient.
There is no operator holding address or deferred custodial claim. Use Ika's
zero-trust mode. Shared mode is outside this proof.

The only public networks in this proof are Sui testnet with its supported Ika
testnet deployment, and DATA/Story Aeneid, EVM chain 1315. Chain 1514 and every
mainnet deployment are refused. Local simulated tests run without external
networks. Dedicated test credentials and opt-in execution belong to a separate
implementation task; this documentation task creates none.

Existing centralized Aeneid registration is a reference for operator-paid
minting to a creator recipient, not a production DATA integration or a runtime
dependency. Production registration remains undecided until DATA publishes a
supported deployment and migration terms. Ika supplies signing; it does not
guarantee that an EVM asset will migrate to Sui, retain its rights, or retain
its royalty behavior.

Ordinary dance posts do not register IP in this MVP. Keep their source-song
reference for attribution. This is a product scope decision, not a legal claim
about all choreography or a promise of on-chain derivative royalties.
Rights and derivative licensing for remixes need their own release policy;
this wallet proof does not authorize registering arbitrary copyrighted media.

## Responsibility and payment

| Role | Responsibility |
| --- | --- |
| Creator | Controls passkey and Ika encryption material; approves account linking and verified acceptance. |
| Community | Authenticates its local account, requests a bounded setup authorization, records the creator recipient binding and submits admitted releases. |
| Wallet site | Runs creator cryptography in the browser and presents the requesting community and intended action. Never sends secrets to either server. |
| Registration operator | Supplies native fee tokens, enforces the capped test allowance, submits transactions, reconciles results and mints test assets to the verified creator recipient. |
| Ika/Sui and Aeneid | Supply their respective execution, public state and finality. Their availability remains an external dependency. |

Pirate is the default registration-operator choice. Communities selecting it need
no SUI, IKA, DATA signer or creator-wallet treasury. An independent operator
must provision its own test treasury and registration signer. Both need a
verified service connection and capped test allowance before enabling releases;
the default choice does not claim a commercial service is already available.

The operator pays IKA protocol fees, SUI protocol reimbursements and Sui
transaction gas for setup, plus Aeneid gas for registration. A creator needs
no native SUI or IKA and sees no faucet or native-token deposit screen. In
this milestone, `community_sponsored` binds a verified operator test allowance;
creators are not charged. Creator checkout is deferred. Ordinary Sui gas
sponsorship does not itself supply IKA; here the operator is the
transaction sender for the creation stages and supplies the fee coins.

The prior fee quote is a dated estimate, not a price promise or a budget.
Read the selected testnet's fee table and reserve upper bounds before each
paid operation. Record actual IKA, SUI and Aeneid gas separately. A normal
operator-paid mint to the creator needs no Ika transaction signature from
that creator; verify this with the actual Aeneid adapter. Owner-initiated
transfers, claims and licence changes are separate signing operations with
separate fees. Their production sponsorship is not part of this flow.

## Community operator wizard

Follow the [wizard contract](creator-wallet-payments.md#wizard-contract).
Select and pair the registration service, connect its capped operator test
allowance and verify the capability before enabling releases. There is no
creator payment-policy selection or checkout in this milestone. Independent
operators additionally configure their service signer, SUI/IKA inventory, registration gas and finite budgets.
Direct creator SUI/IKA self-funding is deferred, not a v1 option.

The owner-selected wizard requires Infisical for service/operator secrets;
creator plaintext secrets never enter it. Alchemy remains the provisioning
owner. Use ordinary HTTPS first, with HNS optional later and Spaces deferred.
An incomplete release capability does not block site provisioning or ordinary
MOSS participation. Show activation and song-registration readiness separately,
and require the relevant acceptance evidence before enabling either live path.

## Creator onboarding

1. The signed-in user selects “Release a song”. Before opening the upload
   control, look up an existing activated creator binding. Reuse it after
   verifying the selected network and recipient; otherwise explain the
   separate creator wallet and saved passkey access.
2. Open the dedicated wallet site as a top-level popup from that user action.
   Use a top-level redirect when popups are unavailable. Display the community,
   testnet status, creator ownership and the actual payer/price policy. Create no media
   draft or upload while setup is pending.
3. Create and save the creator passkey. Derive its native Sui account address
   locally; this needs no chain transaction or fee. Persist the PRF-wrapped
   Ika seed and public wallet metadata described below before charging or DKG.
   Obtain the bounded activation quote, then verify its payment or reserve
   the community allowance under the payment contract. No paid chain stage
   starts before that authorization and the following creator consent.
4. Obtain an authenticated setup intent from the operator. It binds the
   requesting account and community, attempt ID, nonce, expiry, exact Sui
   control address, encryption public key, curve, package/network manifest,
   operator sender and maximum fees. It also binds the quote, payer policy
   and verified payment or allowance authorization.
   The wallet checks these against its locally derived account and selected
   manifest, then signs domain-separated consent with that Sui passkey
   account. The operator verifies the signature, account binding, nonce and
   expiry before spending; a community session alone cannot choose another
   creator's control address.
5. Load Ika's cryptographic code on this screen only. Prepare DKG locally using
   that exact operator sender in the session identifier. Keep the browser's
   own output in memory for the acceptance check. The creator signs the
   encryption-key registration material locally; the operator submits it.
6. The operator submits the DKG transaction and pays its fees. Transfer the
   returned DWalletCap to the creator's exact Sui passkey address in that
   same transaction. The operator must never retain the cap for acceptance.
7. Before producing an acceptance signature, the browser reads confirmed
   chain state through the configured Sui client. Check transaction success,
   cap type and owner, dWallet ID, encrypted-share ID, registered encryption
   key, selected network/curve and result binding. Verify the network result
   against the locally retained DKG output using the pinned Ika SDK.
8. Only after those checks pass does the browser sign acceptance. Use the
   browser's verified material; never replace it with output supplied by the
   operator. The operator submits acceptance and pays. Stay on the setup
   screen until the chain confirms the dWallet is Active.
9. Both browser and operator verify Active and cap ownership. Derive the EVM
   recipient from the verified secp256k1 public key and finalize the account
   binding and saved encrypted wallet record. Verify its persistence before returning.
10. Return a single-use result to the originating community. The community
    validates it and independently verifies activation before enabling upload.
    Upload, admission and an idempotent Aeneid registration job follow. The
    operator mints to that creator address and records a verified receipt.
    Display “Registered on testnet” only after confirmed registration and
    recipient ownership; never label it production ownership.

Later releases skip setup. A recipient change requires a fresh authenticated
binding and creator proof, not an editable destination supplied in a post
body. Recheck cap ownership and the binding when preparing registration so a
stale or transferred wallet is not silently reused.

## Acceptance ordering and protocol invariants

The required order is:

```text
saved passkey + encrypted wallet record -> bounded quote + verified payment/allowance
-> creator consent to setup intent -> operator-bound DKG preparation
-> confirmed DKG + atomic cap transfer to creator
-> browser ownership/result verification -> creator acceptance signature
-> successful acceptance transaction + confirmed Active
-> recipient binding -> upload -> admission -> registration -> confirmed receipt
```

The operator's promise, a returned transaction digest, an acceptance signature
and a local “accepted” flag are each insufficient to cross the Active gate.
If a transaction fails, remains unknown or never lands, registration stays
blocked. An unavailable or inconsistent chain read fails closed.

Ika's acceptance entrypoint takes the wallet/share identifiers and the user's
encryption-key signature; it does not need the DWalletCap. This makes the
early cap transfer possible. Validate that behavior against the actual
testnet package before spending, rather than treating published mainnet source
as proof of the testnet deployment.

Changing the sender, package/network, control address or encryption key
invalidates the setup intent and prepared DKG. Do not repair the mismatch by
silently using a different operator result. Wrong ownership or mismatched
public output stops before the creator signs anything.

The application does not expose a general operator transaction-signing API.
It accepts only the bounded setup operations and the admitted asset
registration request. Registration retries bind the same post, revision,
media/metadata digests, network and creator recipient.
Persist the registration transaction identity before broadcast. Resolve an
unknown submission and inspect its receipt before allocating another mint;
an RPC timeout must not create a second asset. A failed registration leaves
the release pending with a recorded retryable job, never falsely registered.

## Saved passkey access

The wallet service is hosted by Pirate on one dedicated stable HTTPS origin.
Choose and record the actual origin and RP ID before creating persistent pilot
credentials. Communities connect to that origin. Use a native Sui passkey
account as the DWalletCap owner; no multisig or separate recovery key is
required for this MVP.

Use a cryptographically random 32-byte Ika encryption root seed, encrypted
under a WebAuthn PRF-derived key. Persist that ciphertext and the public wallet
record at the wallet service, retrievable after passkey authentication. The
record includes the credential identifier, public key/address, RP ID, PRF salt,
versioned derivation/encryption parameters, Ika network/package identifiers,
dWallet/cap/share IDs and verified EVM public key/address. Update it as setup
assigns the on-chain identifiers. Save only ciphertext and public metadata;
the service never receives the plaintext seed or decrypted user share.

A saved passkey supplies the authenticator credential. Ika's zero-trust user
share still needs its encryption seed. Our integration connects those using
PRF and the persisted encrypted record. An authenticated session or a seed
held only in the current tab is insufficient. Use reviewed authenticated
encryption, fresh nonces and context binding. Verify the record was durably
saved before paid setup and its final identifiers before enabling upload.

Keep plaintext seed/share material in short-lived browser memory and clear it
on completion, cancellation and logout. It must not enter community D1,
operator logs, URLs, source control or public storage. Missing PRF or an
unreadable encrypted record stops setup/access without a silent weaker mode.

The access check is ordinary integration acceptance: create and activate a
wallet, close it and clear its in-memory secrets, then reopen using the saved
passkey, load the stored record, decrypt the Ika share and produce one valid
EVM test signature for the same address. Run it on the selected Android
browser. It checks that our app saved and reloads the required material;
it is not an investigation of Ika's MPC protocol.

For that signature, the test fee payer supplies the required presign and fee
coins to the cap-owning account and sponsors its Sui gas. The creator signs
the cap-using transaction. Record this signing cost separately from setup and
minting; this test funding does not define production signing sponsorship.

The MVP relies on the wallet origin, encrypted-record storage and the user's
passkey provider remaining available. Passkey sync follows the provider's
normal behavior; saving a device-bound credential does not make it synced.
Cross-device and site-independent recovery are later work, with no custom
recovery ceremony or standalone recovery tool in the MVP setup.

## Cross-community connection

Use popup or redirect by default. Cross-origin iframe creation is not the
compatibility baseline. The wallet site refuses framing. Android Chrome and
Telegram's Android in-app browser each need a real run; when Telegram requires
a system-browser redirect, record that path and the return behavior rather
than claiming inline support.

Bind the exchange to an exact community origin, authenticated local account,
requested operation, random state, expiry and PKCE-style verifier. Popup
messages check both origin and source window and never use a wildcard target.
Redirect return URIs are exact allowlisted HTTPS routes. Transfer a short-lived
single-use authorization code, not credentials, seed material or an acceptance
signature in a URL. Exchanging the code requires the initiating session and
verifier; expired, replayed or cross-account exchanges fail.

Link only with explicit creator consent in that community. Keep the mapping
private to the necessary community/operator services. A community-scoped
author ID remains the post identity; do not publish the MOSS-to-Sui-to-EVM map
in the community registry or post index. Reusing a public EVM recipient can
link registered songs across communities; show that consequence when linking.
This is a creator account binding, not a new mandatory global learner login.

## Durable attempts and budgets

Persist a nonsecret attempt ledger before any paid submission. A useful state
set is reserved, key_registered, dkg_submitted, awaiting_verification,
acceptance_submitted, active, interrupted and failed. Store confirmed chain
facts separately from user-interface state so late completion can reconcile
an interrupted attempt.

Each attempt binds an idempotency key and the immutable setup intent.
Persist submission identity before broadcast and reconcile a known digest
before retrying. A network timeout is not evidence that the operation failed.
Polls and duplicate requests return the existing attempt; they must not
purchase another DKG.

There is one activated operator-submitted wallet per local account and proof
network. Reserve at most one in-flight attempt for that account atomically.
This is an account limit, not a one-human guarantee; unrelated communities
may have different accounts.

Failed/interrupted paid attempts have their own limit: at most three per
account in a rolling 24 hours for this proof, with no automatic paid retry.
Also enforce community quotas, request rate limits and an operator-wide
daily budget in native fee units. Configure finite budgets before enabling
the feature; missing limits disable paid creation. Reserve estimated exposure
atomically before sending and reconcile actual cost afterward. Apply the
global budget across communities so account creation cannot bypass it.

Only confirmed activation consumes the successful-wallet allowance, even if
the return to the community fails. Interrupted setup leaves any already
created wallet and cap on chain. Record their IDs, ownership, costs and last
confirmed status. Do not describe them as discarded or deleted. Clear only
ephemeral browser material.

If local DKG output is lost before acceptance, do not reconstruct it from an
operator response or add a DKG resume feature. Reconcile the earlier attempt,
ensure no submitted acceptance can still activate, then permit a fresh attempt
within the limits. If acceptance was already submitted, resolve it first.
If it activated, recover that wallet and complete its binding instead of
funding a replacement. Retrying the same valid acceptance while the original
verified material remains available is not a new DKG.

These ledger and encrypted wallet records are required security/accounting
state. They do not create saved media drafts or a song-composer resume feature.
Link allowance reservations and actual native costs to the same attempt under
the [funding contract](creator-wallet-payments.md#sponsored-execution-and-native-funding).
Polling, a lost callback or an existing Active wallet never causes duplicate
creation spending. Reconcile an uncertain attempt before authorizing a retry.
There is no creator charge or refund in this sponsored test.

## Storage and chain boundaries

| State | Location |
| --- | --- |
| Passkey private key | Creator's authenticator/sync provider. |
| PRF-wrapped Ika seed and public wallet record | Wallet service, encrypted seed; authenticated retrieval only. |
| Setup attempts, quotas, fees, private account bindings and registration jobs | Operator/community database with restricted access and retention policy. |
| DWalletCap and Sui ownership | Sui testnet; owned directly by the creator's native Sui passkey address. |
| Encrypted Ika share and activation state | Ika's selected on-chain protocol state. |
| Song media, metadata and previews | Existing publication/storage boundary; no secret material in public pins. |
| IP asset and owner/registration receipt | Aeneid registry plus verified application receipt. |
| Community authority and public post index | Existing MegaETH architecture; independent of IP registration. |

D1 therefore holds jobs and private operational/account-link data as well as
community records. It is not “no user data”. Store session tokens as hashes,
make nonce consumption atomic, and keep secret keys in the relevant secret
store. Public IPFS copies are retrievable by others; unpinning a copy does not
recall theirs.

No new Pirate wallet-ownership contract, mapping registry or fee contract is
required for the wallet proof. A settlement/refund adapter is not needed for
the sponsored first-song test. Creator billing remains deferred.
Use Sui's native account authentication and Ika's existing capability.
Keep generic registration receipts with network/chain
identifier, registry, asset ID, owner, transaction, confirmation reference and
media/metadata digests. Receipt types must accommodate Sui identifiers without
pretending a future migration adapter already exists.

## Build order and acceptance

Start with the sponsored wallet and first-song integration. Existing post
index work can proceed independently; the wallet proof needs no new contract.
The sponsored test grant is explicit and capped. Its S1–S8 integration gates
apply; deferred creator billing and its P1–P12 gates do not block this milestone.
Complete these steps in order:

1. Freeze the test manifest: wallet origin/RP ID, SDK/WASM versions/hashes,
   Sui network, Ika package/objects/curve, Aeneid RPC chain check and
   registry/collection, operator sender and finite fee budgets.
2. Build the top-level connection, native Sui passkey account and persisted
   PRF-wrapped seed. Check that the selected browser supplies PRF before DKG.
3. Build the durable sponsorship/attempt state machine and browser DKG checks.
   Exercise failure cases locally, then perform the bounded testnet setup.
4. Reopen the activated wallet with its saved passkey, produce one EVM test
   signature and mint an admitted test song to that creator address on Aeneid.
5. Record source/manifest hashes, device/browser versions, transaction/object
   references, ownership/Active reads, actual fees, timings, prompt count and
   lazy-loaded byte sizes. Do not build a separate recovery test programme.

| ID | Required evidence |
| --- | --- |
| C1 | Ordinary sign-in, karaoke, study and dance paths create no creator wallet, send no Ika requests and load no Ika WASM. |
| C2 | A creator holding no native SUI/IKA completes setup with every creation stage submitted and paid by the operator, backed by the capped operator test allowance with no creator checkout. |
| C3 | DKG and cap transfer are in the same successful transaction; creator ownership is verified before acceptance signing. |
| C4 | Wrong cap owner, sender/network, key/share ID, operator-swapped output and mismatched local public output each prevent acceptance signing. |
| C5 | Acceptance signed but unsubmitted, failed or unknown leaves upload and registration disabled; confirmed Active enables them. |
| C6 | Cancellation, tab loss and network timeouts retain accurate chain records; retries do not duplicate paid creation or consume successful allowance incorrectly. |
| C7 | Concurrent attempts and cross-community traffic respect the in-flight reservation, activated-wallet limit, failed-attempt limits and global budget. |
| C8 | Two community origins connect through the same wallet site; replayed codes and wrong origin/account/verifier are refused. |
| C9 | Android Chrome and Telegram's chosen popup/redirect flow complete; any required external-browser step and return are recorded. |
| C10 | After closing and clearing in-memory secrets, the saved passkey reopens the same Sui account, reloads the encrypted record, decrypts the Ika share and completes a verifiable EVM test signature for the same address. |
| C11 | Aeneid mint confirms the exact creator recipient and matching asset digest. Timeout/retry cannot create an untracked duplicate registration. |
| C12 | Mainnets and local public fixture keys are refused; no private material appears in API payloads, logs, URLs, D1 or public pins. Encrypted records reject tampering and wrong-context decryption. |
| C13 | Encrypted seed persistence is verified before paid setup and wallet identifiers are saved before upload; missing PRF, failed persistence and incompatible signatures fail without a weaker fallback. |

The 2026-11-04 browser pilot demonstrated activation and the core C10 reopen
and same-address signing behavior. Its verified signature transaction is
`5FkKRCZvr6hVjqdyUPLWQf1Rc9eLfr7vuubZFJUaf9w3`; implementation and evidence
are recorded in [PR 13](https://github.com/pirate-social-club/pirate-operators/pull/13).
The device/browser/provider matrix was not recorded, and no song upload or
Aeneid mint was exercised. This does not mark the complete C1–C13 suite passed.
Sponsored-service gates S1–S8 remain pending. Billing gates P1–P12 are deferred
and do not block this test. Documentation review, a local mock or an existing centralized mint cannot substitute for
those checks. A device limitation stops that part of the proof and is reported
explicitly; it does not reopen custody or silently enable shared mode.

Production needs a separate supported DATA deployment/migration decision and
the completed proof. There is no automatic mainnet switch, Sui asset migration,
KOR adoption or royalties launch in this contract.

## Source basis

The Ika source reviewed for the creation/acceptance shape is commit
`0c7a1ce7443c7f40893f86968180d424f148e4ef`. Its
[coordinator source](https://github.com/dwallet-labs/ika/blob/0c7a1ce7443c7f40893f86968180d424f148e4ef/deployed_contracts/mainnet/ika_dwallet_2pc_mpc/sources/coordinator_inner.move)
contains encryption-key registration, DKG and encrypted-share acceptance.
Its
[session manager](https://github.com/dwallet-labs/ika/blob/0c7a1ce7443c7f40893f86968180d424f148e4ef/deployed_contracts/mainnet/ika_dwallet_2pc_mpc/sources/sessions_manager.move)
binds session identifiers to the transaction sender. These source reads are
not a deployed-bytecode audit or an executed testnet proof.

Ika documents the [zero-trust flow](https://docs.ika.xyz/docs/sdk/ika-transaction/zero-trust),
[user encryption keys](https://docs.ika.xyz/docs/sdk/user-share-encryption-keys)
and [fee handling](https://docs.ika.xyz/docs/move-integration/core-concepts/payment-handling).
Sui documents [passkey origin binding](https://docs.sui.io/develop/cryptography/passkeys)
and [gas sponsorship](https://docs.sui.io/develop/transaction-payment/sponsor-txn).
Web platform references cover [PRF](https://developer.mozilla.org/en-US/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf)
and [cross-origin iframe compatibility](https://web.dev/articles/webauthn-within-iframe).
Source support motivates the test plan; it does not replace device evidence.

