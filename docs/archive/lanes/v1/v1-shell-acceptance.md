# Shell verification and integration acceptance

The source slice is an independently owned Solid adaptation of the retained
shell reference. It consumes the existing community feed and MOSS session.
It adds no server route, provider runtime, credential or release configuration.

Focused routing checks run with:

```sh
node --test apps/web/test/shell-routing.test.ts
```

From `apps/web`, `npm run check` runs typecheck, unit tests, static and live
builds, static/mirror browser checks, then live browser checks. The shell
scenarios are in `live-e2e/community.spec.ts`. They cover native navigation,
keyboard skip focus, direct links, back/refresh, decodable fixture playback,
lyrics, failed audio retry, feed failure/recovery, authorization boundaries,
320/390/767px viewports, publisher upload recovery, Study lesson identity and
Karaoke song-route retention. The existing account, V4 sign-in, rewards and
Study scenarios remain part of the broad gate.

The separate Study and Karaoke workflow sequences are also necessary. After
the shared web build, build `vite.study.config.ts` and `vite.karaoke.config.ts`
before their corresponding Playwright suites. The shared static build clears
`dist`, so running it concurrently with those screen builds invalidates their
artifacts. The learning browser suite additionally exercises real local
handlers, storage, WebSockets and anvil with simulated speech/wallet peers.
These checks do not establish real provider or physical-device acceptance.

Run repository `npm run check` before publication and retain every non-green
result. The lane packet's `.local/handback.json` binds the exact changed paths,
test logs, reproduced baseline failures and source digests. Local pass counts
do not replace coordinator independent review or required hosted CI.

Coordinator integration still needs the real public video feed, authorized
public composer, private Dance and Telegram settings components mounted through
`ShellIntegrations`. Use fresh server permissions. A video song callback and
an upload selection must resolve exact published revision, audio digest and
segment bounds through the media adapter; the current public song projection
does not expose those facts. Do not guess revision 1, derive a digest from a
title, or silently point an old clip at a new revision.

Retain the shell's rejection of conflicting or duplicate learning selectors
when reconciling lane 5's route helper. The shell owns browser history and the
feature owns server attempt recovery. A camera overlay supplied by a feature
must portal outside inert page content and coordinate capture ownership before
the shell navigation is made unavailable; ordinary file uploads do not acquire
the microphone. Do not add an inert recording action to fill a navigation slot.

Remaining live acceptance is a fresh visitor finding and playing a real
published song, starting Study/Karaoke, reaching the wallet and completing the
accepted reward journey in the new shell. Verify video playback on another
phone and private Dance isolation after the feature/API integration. Check
notched-device safe areas, keyboard and permissions on physical browsers.
Public video posting rights remain an owner decision. Independently reviewed
source, exact-head required CI, release pins and live served-asset readback are
coordinator release gates; this lane does not deploy.
