# Community onboarding and media storage

The November 28 owner decision applies to new Linux communities. Each community controls and pays for its public media storage. Filebase is the initial provider. Another provider such as Pinata can use the same publication boundary once it has a qualified adapter. The initial wizard offers one storage integration.

## What the operator does

1. Open the paired setup helper from a desktop browser. The current bootstrap requires someone with SSH access to start the helper on a supported VPS, forward the loopback listener and enter its short-lived pairing code. After authenticated startup, the launcher must print one exact, copyable SSH forwarding command and its matching loopback URL. That pairing authenticates a private setup session. Ordinary community registration is permissionless.
2. Give the community a name. In Addresses and names, establish the canonical HTTPS address. Show a host-assigned address when the selected provider can supply one. For a custom domain, show the exact host-bound TXT proof and routing records for the selected server. Keep control, routing and installed-site checks independent. HNS preparation is optional, returns to the hub and grants naming rights only after verified attachment. The ENS read-only mirror also returns to the hub and requires a published release. Show availability at each entry point.
3. In **Connect media storage**, create or choose a dedicated IPFS bucket in the community's Filebase account. Under **Access Keys → IPFS RPC API**, select that bucket and copy its **Secret Access Token**. Paste it into the single masked **Filebase IPFS RPC API token** field and choose **Check and save token**. The community pays its Filebase storage and bandwidth charges. The wizard needs neither S3 keys nor a separate bucket-name field. The operator confirms the intended bucket in Filebase unless the API can reliably identify it.
4. Connect the controller wallet, review publication authority and the exact installation, and approve setup. Retain any applicable disposable-pilot acknowledgement. An optional network-fee subsidy has its own eligibility and allowance. After installation the registrar independently verifies the exact application and installation identity at the DNS-proven HTTPS origin before submitting the authorized contract write. Reconcile the original operation and read back the accepted registration. Offer **Open community** at the verified origin. Discovery and naming have their own statuses.
5. After launch an authorized owner can choose **Community management → Telegram** when available. The design reuses the existing owner settings panel from the Solid catalog. The standalone community product must supply its own authenticated settings route and verify bot readiness before enabling the handoff. The owner creates or selects the community bot with BotFather, enters its token privately and connects it. Offer **Open bot** when the bot and webhook are ready. Skipping, deferring or failing Telegram has no effect on launch. Member account linking, guest study and channel posting have separate flows.

## Who holds the Filebase token

The paired browser delivers the token to the community VPS. The VPS stores it in its scoped encrypted credential store. Only its local publication component resolves the active credential generation and authenticates directly to Filebase. Pirate receives no token, secret reference or delegated storage access. Shared recognition remains Pirate-operated and adds no operator step. Linux setup needs no Infisical account or CLI. Private objects and backups have separate storage requirements.

The local pinner accepts authorized release work bound to the community, grant and expected content. Journal the operation before submitting it, bind the Filebase result to the approved bytes, verify the CID and retrieve the expected content. Downstream publication consumes that authenticated result. A lost reply resumes the original operation. Publication pauses on missing, revoked or unconfirmed access. There is no shared Pirate token fallback.

## What the checks prove

| Event | Evidence and user-visible outcome |
| --- | --- |
| Setup check | A successful read-only RPC pin list and a committed vault save for the same token generation support “Token saved. The token could list pins.” This check creates no test object. |
| Check failed | Clear the submitted value. Show whether Filebase declined it or the check was unavailable. Keep any previously active generation intact. |
| Save reply lost | Recover through the original save and its token generation. Show an unresolved state until there is durable evidence. Do not request another secret or repeat the mutation while the result is unknown. |
| First authorized publication | The local VPS adds the approved bytes, reconciles the pin and verifies retrieval. Only that evidence establishes successful upload. |
| Rotation | Check and commit the replacement for the intended community before switching generations. Keep the previous generation on failure. The owner revokes the old credential in Filebase. Never echo credentials into responses, URLs, logs, telemetry or Storybook. |

## Release evidence still required

The delivery contract’s external dependency inventory describes the existing managed services and their provisioning credentials. The existing managed publication service uses a service-wide Filebase token. That implementation needs replacement for new communities. Qualify an installed VPS with the exact console-issued RPC token, direct local upload of approved bytes, independent CID retrieval, failure and lost-response reconciliation, rotation and revocation. Verify isolation with a second disposable IPFS bucket in the same account. The first bucket’s token must be unable to list the second bucket’s pins or change its pin set. Determine the actual scope of destructive RPC operations and any expiry behavior. The November 5 qualification covered an SDK-format pin-list read and a separate S3 CAR import and retrieval. Neither establishes console-token RPC writes or bucket isolation. The preview exercises UI states without provider calls.

Provider references: [Filebase IPFS RPC API](https://filebase.com/docs/ipfs/rpc-api) and [Telegram BotFather](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
