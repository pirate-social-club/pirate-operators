# Root-integration flake: recognition reservation recovery, 2026-11-21

PR #85's Root integration shard 1/4 failed once on this test while every
other suite passed:

```
test/recognition-reservation-recovery.test.ts:14
✖ shared process death: upload intent before provider send (5578ms)
AssertionError: The expression evaluated to a falsy value: (message?.id === id)
at SynchronousFetcher.fetch (miniflare)
```

Failed job: run 44921567934, job 136898521461.

Evidence it is a flake rather than a regression from that PR: main's latest
run passed the same suite at the same base commit 63daca3 (run 44132119247);
the PR changes only apps/web frontend source (CSS, stories, npm scripts,
web.yml) and deletes two unmounted frontend files, none of which this root
Workers-harness test imports; and the test passes locally on the PR branch
with a fresh root `npm ci --ignore-scripts` mirroring CI's install
(`node --test test/recognition-reservation-recovery.test.ts`, 8/8 pass,
about 168 seconds). The failure signature is timing-shaped: a 5.5 second
test window and a message-identity assertion inside miniflare's
synchronous fetch path.

The failed job was rerun on the same run. This document tracks the flake
itself: if it recurs, the next step is a bounded look at the test's timing
assumptions, the process-death timing against the reservation window, never
a weakened assertion. No test change is proposed here. The repository has
issues disabled, so this dated document is the filing place.
