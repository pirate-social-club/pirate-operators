# Karaoke testnet stabilization

This follows PR 33 and the workspace_owner's post-launch review. It leaves the centralized Karaoke presentation and deployed LearningResultsV2 unchanged. Mainnet and funded rewards remain outside scope. The original finished run and enrollment are not evidence that the remaining live terminal scenarios have passed.

## Request latency

The deployed feed already uses the durable public posts index. The repeated directory history reconstruction was the request-path problem. The successor reuses the existing public_configurations and chain_scan_state tables, with no new migration. Cached configuration bytes remain bound to transaction receipts, canonical blocks, their content digests and the current pinned directory contract. A configuration revision change scans only from the last checkpoint. An unchanged revision needs no historical log scan. A reorg discards this derived configuration cache and reconstructs canonical history. Concurrent requests cannot move its checkpoint backwards.

Independent RPC reads at one confirmed head run concurrently, and creator readiness overlaps public readiness. No request-owned promise or authority state is cached globally in a Worker isolate.

Before deployment, the observed health request took 33372 milliseconds and the feed took 24330 milliseconds. Tests cover an extra simulated day of chain blocks with no new log scan, new revisions, database reuse, changed or missing checkpoints, tampered cached evidence and concurrent checkpoint updates. These fixtures establish request-count behavior; measured live latency is recorded separately after deployment.

The standalone readCommunityPosts and sourceAuthenticator functions are public reconstruction paths, rather than scans performed by every application request. Their eventual hosted indexer layout is not a prerequisite for this request-path fix. Two independent public-result reconstructions are still required before official board acceptance.

## Owner-operated MVP

The workspace_owner approved increasing the testnet native sponsorship allowance from 50000000000000 to 500000000000000 wei. An explicit operator configuration increase preserves previous charges and outstanding reservations. It keeps the transaction gas ceiling and gas-price ceiling. Neither a restart nor a new day refills the lifetime allowance. Correction-reservation optimization is deferred.

The later workspace_owner direction drops additional application speech-budget machinery for this MVP. The existing provider-start counter remains available for usage observation, with zero in SPEECH_DAILY_LIMIT disabling the app quota. It preserves current-day usage and basic session/retry bounds. The operator will monitor the provider bill. No provider-account billing, top-up or subscription setting is changed. This replaces the briefly approved proposal for a new 100-start daily quota.

## Remaining live evidence

The prospective qualification policy starts at 17:00 UTC on 2026-11-06. The remaining cases are a genuine completed performance that qualifies, browser abandonment with unreached lines unattempted, an authenticated controller correction, and revocation of a separate test identity before initial publication. Read public cases back from chain and IPFS, and verify the revoked case stays private. A replayed vocal track or a synthetic assertion is not an honest learner performance. These cases remain open until observed.

The active Study task owns the successor contract. Its deployment must retain Karaoke, bind the actual ordered selected Study exercises and preserve V2 public history. It is a potential mainnet candidate after qualification, not mainnet authorization. Testnet rewards are not a learning-launch dependency. Draft PR 31 was closed after its final relay fixes were compared with current source; its published branch remains preserved.
