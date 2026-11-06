# Karaoke testnet stabilization

This follows PR 33 and the workspace_owner's post-launch review. It leaves the centralized Karaoke presentation and deployed LearningResultsV2 unchanged. Mainnet and funded rewards remain outside scope. The original finished run and enrollment are not evidence that the remaining live terminal scenarios have passed.

## Request latency

The deployed feed already uses the durable public posts index. The repeated directory history reconstruction was the request-path problem. The successor reuses the existing public_configurations and chain_scan_state tables, with no new migration. Cached configuration bytes remain bound to transaction receipts, canonical blocks, their content digests and the current pinned directory contract. A configuration revision change scans only from the last checkpoint. An unchanged revision needs no historical log scan. A reorg discards this derived configuration cache and reconstructs canonical history. Concurrent requests cannot move its checkpoint backwards.

Independent RPC reads at one confirmed head run concurrently, and creator readiness overlaps public readiness. No request-owned promise or authority state is cached globally in a Worker isolate.

Before deployment, the observed health request took 33372 milliseconds and the feed took 24330 milliseconds. Tests cover an extra simulated day of chain blocks with no new log scan, new revisions, database reuse, changed or missing checkpoints, tampered cached evidence and concurrent checkpoint updates. These fixtures establish request-count behavior; measured live latency is recorded separately after deployment.

The standalone readCommunityPosts and sourceAuthenticator functions are public reconstruction paths, rather than scans performed by every application request. Their eventual hosted indexer layout is not a prerequisite for this request-path fix. Two independent public-result reconstructions are still required before official board acceptance.

The workspace_owner's 13:28 UTC samples were slower: health took 11.3–12.8 seconds and feed took 5.0–7.9 seconds. The earlier three warmed samples do not establish typical latency. The follow-up removes health's second verification of the same song index and overlaps independent cache and receipt reads. It retains current authority, canonical checkpoint and content verification on every request. No shared authority cache or freshness grace period is added. Server-Timing exposes request-local elapsed time and aggregate RPC, IPFS and creator durations and call counts. Overlapping durations can add up to more than total elapsed time. Arguments and response contents are never included. Startup prerequisite request timings are distinct from the time to microphone readiness and audible playback.

The temporary diagnostic sign-in exposed an old deployment assumption that no learner accounts could be added after first-song publication. Release qualification now permits additions to the two sign-in tables while requiring their original account and credential-binding rows to remain byte-identical. Every other retained table, including spending and publication evidence, still matches its exact historical digest. No account or retained state is deleted to make a release pass.

## Owner-operated MVP

The workspace_owner approved increasing the testnet native sponsorship allowance from 50000000000000 to 500000000000000 wei. An explicit operator configuration increase preserves previous charges and outstanding reservations. It keeps the transaction gas ceiling and gas-price ceiling. Neither a restart nor a new day refills the lifetime allowance. Correction-reservation optimization is deferred.

The later workspace_owner direction drops additional application speech-budget machinery for this MVP. The existing provider-start counter remains available for usage observation, with zero in SPEECH_DAILY_LIMIT disabling the app quota. It preserves current-day usage and basic session/retry bounds. The operator will monitor the provider bill. No provider-account billing, top-up or subscription setting is changed. This replaces the briefly approved proposal for a new 100-start daily quota.

After an uncapped claim, changing back to a nonzero speech quota in the same UTC day fails closed with speech_budget_changed until midnight. This operational limitation remains documented; the current deployment stays uncapped.

## Remaining live evidence

The prospective qualification policy starts at 17:00 UTC on 2026-11-06. The remaining cases are a genuine completed performance that qualifies, browser abandonment with unreached lines unattempted, an authenticated controller correction, and revocation of a separate test identity before initial publication. Read public cases back from chain and IPFS, and verify the revoked case stays private. A replayed vocal track or a synthetic assertion is not an honest learner performance. These cases remain open until observed.

Use an existing dedicated EOA test wallet for the separate-account contract revocation check. It does not require activating another MOSS account and does not establish live MOSS revocation. The single approved learner activation cannot authorize another account. Before mainnet, sponsored enrollment admission still needs an explicit decision about arbitrary wallets exhausting the finite allowance. That decision adds no new gate to this unlisted testnet community.

The active Study task owns the successor contract. Its deployment must retain Karaoke, bind the actual ordered selected Study exercises and preserve V2 public history. It is a potential mainnet candidate after qualification, not mainnet authorization. Testnet rewards are not a learning-launch dependency. Draft PR 31 was closed after its final relay fixes were compared with current source; its published branch remains preserved.

## Deployed result

The first stabilization deployed community profile dcc1f8ba97a9c86fa3bef786d448e44c13f9a06c9b8f0ca41c565cb6a34796b4. Its three warmed requests per endpoint gave median health latency of 2629 milliseconds and feed latency of 1301 milliseconds. The [original sample receipt](deployments/karaoke-testnet-stabilization-20261106.json) remains historical evidence; the later review found slower requests from another vantage point.

The profiling successor is live with profile 52175c558c976aeabde7b1ab416bd98c5fbaafe5d617c0d7cb01798e22daa253. At 14:04 UTC, three local requests per endpoint gave health of 1589–2385 milliseconds (median 1625) and feed of 1172–1304 milliseconds (median 1183). Server processing was about 1.0–1.4 seconds. Public chain verification still dominates the measured work: health and feed each make 23 RPC calls, including four receipt reads, with independent reads overlapping. These observations do not establish latency from the reviewer's location. The instrumental response took 2093 milliseconds to retrieve 4398452 bytes; its timing header measured 547 milliseconds before streaming the response body. No ticket, socket, microphone or speech provider was started, so actual audible-startup latency remains open.

All six public frontend assets matched their unchanged package hashes. Resources, migrations, learning limits, operator deployment and the result contract remain unchanged. The [new deployment and timing receipt](deployments/karaoke-testnet-latency-20261106.json) includes the raw timing headers, scope and remaining cases. The complete local check passes 383 Node tests, 150 Solidity tests and local-skeleton/1 acceptance; the browser enrollment, repeated publication, export and revocation journey passes. The four live terminal cases and independent reader remain unfinished.

## Updating an already published community

The original song-publication grant can expire while the community remains live. A source update must not renew that grant or require permission to publish the same song again. Both preflight and execution now qualify the creator and managed peer profiles. Only an explicit reviewed update of the exact pinned published-state snapshot can accept an expired, disabled publication grant. The runner first verifies the retained database evidence and exact previous execution/result receipts. Contradictory grant, operator or expiry fields are rejected even when release health says disabled. New and held publications still require their original active-grant checks.

This distinction changes deployment qualification only. It does not enable a new publication, reset a budget or reservation, change credentials, or alter the existing runtime, UI assets or resource identities. The blocked b38c48 candidate was never deployed; the operator's defensive 90db034 artifact did deploy. A successor application profile must bind the reviewed validator source before the client update proceeds.
