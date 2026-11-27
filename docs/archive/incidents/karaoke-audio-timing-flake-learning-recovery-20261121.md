# Karaoke audio-timing flake: learning recovery, 2026-11-21

PR #85's karaoke suite failed once on this test while every other suite passed:

```
karaoke-e2e/learning.spec.ts:322
✖ persistent missing feedback stops after one automatic recovery and can retry the same open take
Error: expect(received).toBeGreaterThan(expected)
Timeout 5000ms exceeded while waiting on the predicate
at learning.spec.ts:436-437, waiting on audio currentTime
```

Failed job: run 44924478754, job 136907542380.

Evidence it is a flake rather than a regression from that PR: main's latest
run passed the same suite at the same base commit 63daca3 (run 44132119247);
the PR changes apps/web CSS colors, npm scripts, web.yml and deletes two
unmounted frontend files, none of which the standalone karaoke audio path
touches; and the failure is timing-shaped, a five-second predicate on audio
playback position in a 34-second browser session.

The failed job was rerun on the same run. Like the recognition-reservation
flake recorded the same day, the next step on recurrence is a bounded look
at the test's timing assumptions, never a weakened assertion. This is the
second distinct timing flake observed on the PR suites; if a third family
appears, a shared timing-margin review across the browser suites is the
proportionate response. No test change is proposed here.
