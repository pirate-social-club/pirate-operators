# Karaoke integration handoff

This branch connects Karaoke to the first published song and proves one
complete learner journey locally. It is the slice recorded in the control-plane
task pirate-karaoke-integration-20261106. Its base is main 462c425 with two
unchanged merges: feat/karaoke-capture 5c4d210 (draft PR 30, which contains the
display slice of draft PR 28) and feat/moss-consent eb67bc9 (draft PR 21, the
MOSS consent lane). Neither source branch was changed.

No real provider was called, no account was activated, nothing was deployed and
no funded or public-chain transaction was sent. Every test uses simulated
ElevenLabs, local anvil and generated stand-in stems.

## The journey

A signed-in learner opens a published song in the live community page and taps
Sing. The page loads the song's timed Karaoke manifest and its instrumental,
asks the community for a ticket, and opens the operator's audio socket with
that ticket's connection proof. While the instrumental plays, the microphone is
streamed to the operator, which transcribes it through its own ElevenLabs
connection. Each line is bought shortly before it starts: the page asks the
community to sign the purchase and sends it on the socket, and the operator
redeems it on chain from the community's deposit. When the instrumental ends,
the operator closes the ticket on chain and signs a per-line result. The page
shows the score and the number of lines sung, and one "Save your score" tap asks
the learner's wallet to sign the LearningRecords consent. The operator then
opens the attempt, records every line and completes it on chain under the
published song's real key.

A reload during a take asks the community for the learner's open attempt. The
page gets the same ticket and proof, reconnects, and resumes the instrumental
at the elapsed time the server measures, so line purchases stay inside their
windows. A reload after the take shows the signed result, and the consent can
still be given then.

## The published song

The fixtures are byte copies of the published documents. The lyric manifest is
`fixtures/first-song/lyrics-manifest.json`, 6188 bytes, SHA-256
0xbcd257bb76454c08b80e0b08f998397e277648a299420f076bace9c0d7593c21, CID
bafkreif42jl3w5sfjqelqdqlbd4zqol6e53eriuziihqo25m5hanowj4ee. The post manifest
is `fixtures/first-song/post-manifest.json`, 2022 bytes, SHA-256
0xa3169a242aa531ceb9d3225dfabbd121e4264ac58bf607ec3dd1f0282c204726, CID
bafkreifdc2ncikvfghhltuzclx5lxujb4qtevrml6yd6ypor6aucyichey. Both were fetched
from the public Pinata gateway and match the digests in
`docs/deployments/first-song-managed-20261105.first-song-acceptance.json`.

The local harness publishes that post through a simulated posts contract under
the published revision-2 configuration, with only the controller, publisher and
contract addresses replaced by local keys and anvil deployments. The
application's own post index then reads it, validates it and serves it, as it
does in production. The lyric manifest has 29 lines: 23 sung lines and six
section cues, each with its random bytes32 occurrence ID.

Those IDs are kept end to end. The Karaoke manifest built from the lyric
manifest keeps each sung line's `lineId` and `lineVersion`; scoring, the signed
result, the consent's lines root and every LearningRecords line record use
them, and the independent reader maps them back through the public Karaoke
route. The protocol's line ID check now also accepts bytes32 IDs. Section cues
are not scored.

The Karaoke manifest carries the published song's LearningRecords key: chain
6343, posts contract 0xa5c155058dd8c6befae7dcb6562277dad77f6045, community
0xd3f69af98a60cbebb54e77b4306115cfcd8f33d122da9d02e782972a6debea0f and post
0x2ce682013277b160a830fad5fa70734f19831edebce908ea3f8457867355b31e. Its
`songHash` is that key, so the ticket's signed manifest digest also binds the
identity the operator records. `standInSong` remains only for the local
skeleton songs of the older tests.

## Timings and the centralized fallback

The published lyrics carry no timing. Timing comes from one forced alignment of
the private vocal stem against the exact lyric text, through the existing
alignment operation, which allows one provider call per community, post and
lyric revision. The community controller authorizes it with a short-lived
signed request to `POST /api/operator/song-alignment`, naming the lyrics and
vocal digests. Pirate's key for it is `ALIGNMENT_ELEVENLABS_API_KEY` on the
community application. Without it the request fails as
`alignment_key_unavailable` and nothing is sent.

The parser now has the centralized fallback. If the provider's words do not bind
to its character timings, or no words are returned, the character timings are
grouped into words at whitespace. Each line then runs from its first word to
its last, and its words must reproduce its text. A section cue is a single
bracketed annotation or a parenthesized instrumental direction, as in the
centralized rule. Nothing is interpolated or invented: a sung line without
usable timing, or longer than the operator's 10-second segment limit, leaves
the song unavailable for Karaoke rather than guessed.

Running the real lyrics through the simulated provider showed that the existing
request was sent as FormData. FormData serialization rewrites line breaks to
CRLF, so the provider's characters could never reproduce the published text,
and every multi-line song would have come back unavailable. The request is now
the centralized byte-exact multipart body.

| Source, api-next a5c63b8db01d4359344d33c31d294a00fbeadb20 | SHA-256 | Adapted in |
| --- | --- | --- |
| packages/platform-cf/src/media-providers/elevenlabs-alignment-response.ts | 84f8a458e2d977451c3dedfb19356bba35afa244ecfce7f07d809c8b5ccf4c49 | packages/alignment/elevenlabs-response.ts, mode selection |
| packages/platform-cf/src/karaoke-readiness-repository.ts | 87478be3aed243ef6c7fd8fca2a285d2b6f0430054d59f46eda86ab6f0981a81 | packages/alignment/elevenlabs-response.ts, character grouping; packages/karaoke/published-manifest.ts, line building |
| packages/platform-cf/src/media-providers/elevenlabs-alignment-request.ts | 39d6395b68ab47f5326bf289183f26da6df1c31017f2955ec7eb755c7658d591 | packages/alignment/elevenlabs.ts, multipart body |
| packages/domain/src/study/lyric-line-identity.ts | 111bef1b58201c4c241659788f1cef05fea2e5388afc8274c48fa1a146d2076f | packages/alignment/elevenlabs-response.ts, section cues |

The client-side whole-line fallback was already adopted with the lyric stage in
PR 28.

## Tickets, purchases and consent

The live community application gained these routes:

- `GET /api/public/posts/{postId}/karaoke`: the timed Karaoke manifest.
- `GET /api/karaoke/posts/{postId}/instrumental`: the instrumental, for signed-in learners.
- `GET /api/karaoke/attempt?postId=`: the learner's open take, or its result.
- `POST /api/karaoke/tickets`: a new or existing ticket.
- `POST /api/karaoke/purchases`: one line's signed purchase.
- `POST /api/karaoke/consent`: the learner's consent signature.

They reuse the existing community purchase code unchanged, on the application's
D1 database in a `karaoke_state` table (migration 0008, which also adds
`song_alignments`), with the real clock. One open ticket per learner and the
per-wallet sponsorship allowance still apply. A ticket is released when its
result is read or when it expires unused.

The community creates one session key per ticket, keeps it in D1, and gives the
signed-in learner only that ticket's connection proof. Any tab or reload of the
same learner can reconnect, and the browser needs no key material or signing
library. The key reaches only the ticket's operator socket. The records still
need the learner's own consent signature.

Consent is the existing LearningRecords Consent, signed once per take. The
attempt view returns it with its EIP-712 types. In the live page the MOSS
wallet signs it through `signData`, trying the standard `message` payload and
then the SDK README's `value` payload, as PR 21's probe does. The operator
checks a plain account's signature locally. A MOSS account's ERC-8010
activation is verified and executed with PR 21's code, unchanged. Both paths
are tested here. The operator has two new service routes: `/consent`, for
consent after the socket closes, and `/record`, for the record's state.

## A fix to the capture slice

The browser journey found a defect in PR 30. The audio relay handed recognized
words to the scorer only on finish or disconnect. In a real-time take, the
operator's song-end timer ends the attempt first, usually during the
instrumental's outro, so every word was refused and the take scored nothing.
PR 30's tests held the virtual clock still until finish and could not see it.

Commit e13235e on this branch fixes it in `services/karaoke-audio.ts` and
`packages/karaoke/audio-relay.ts`. Words now reach the scorer as each line's
transcript arrives. Words sung before the performance ended that arrive after
the timer ended it still count until the payment deadline. A seek applies the
relay's tolerance rule to words already with the scorer, and reopens the
failure marks of replayed lines, as the centralized host did.

That forwarding first ran through the words handler of the socket that carried
the audio. A reconnect during a provider send could then refuse the hand-over
as stale after the relay had drained it. PR 30's hosted reconnect scenario
lost one word that way. Words are now stored for the take whichever socket
carried them (99a4477), and a regression test covers a song-end timer that
fires before the learner's finish (0cddd57).

An independent review of that repair then found more, all fixed here as
25f30f6, 12ac8df and the cherry-pick of 7dc23d4:

- A backward seek erased failure marks, turning lines the provider had given
  up on into silent ones.
- The relay's word limit counted dropped words.
- The hand-over skipped the take's timers.
- A transcript returning after the learner's last frame, or after the socket
  closed, could be discarded by the idle timer.
- A superseded socket could finish the take.
- The relay's finish raced the last acknowledgement's follow-up commit and
  marked the last line unmeasured.
- A dead or reconnecting provider stream at finish left its lines silent
  instead of unmeasured.

Every change the relay persists now hands its new words over, commit requests
are serialized, and finish waits for commits in flight. Regression tests cover
each case that a test can reach.

PR 30 carries the same changes as 34d77aa, 9650c87, 4ade204, b1186df, e0a8000
and 7dc23d4, so it can merge on its own.

## Tests

`test/karaoke-live-song.test.ts` publishes the real post and runs one signed
alignment in word, character-only and unbound-word modes. It checks that all 23
published line IDs, their text and the real song key come through. It also
checks the refusals: a stranger's request, changed lyrics or vocal, an
over-long lifetime and a missing provider key.

`test/karaoke-live-journey.test.ts` runs two journeys through the application,
the operator, simulated ElevenLabs and anvil:

- A plain learner takes the instrumental, opens a ticket and reloads mid-take,
  then resumes and pays every line but one. Their singing is transcribed with
  one line mumbled. Each line gets the expected grade, with one line unpaid.
  The learner consents after the socket has closed. The grades are then read
  back from LearningRecords by the independent reader, under the real song key
  and line IDs, and a second take gets a new ticket.
- A MOSS-style account with no code consents with an ERC-8010 activation, is
  delegated, and its grades publish.

The browser journey is `apps/web/karaoke-e2e/live.spec.ts` with
`live-host.ts`. It serves the built live page through the application, as the
deployed Worker does, with two test-only substitutions: the MOSS wallet module
signs with local fixture keys, and the client configuration names the local
host as the canonical origin. One take sings the whole song with
character-fallback timings and saves the score to LearningRecords. Another is
reloaded mid-song and resumes at the song's position.

`test/song-alignment-response.test.ts` now asserts the fallback where it used
to assert a failure, and adds character-only, cue and refusal cases. The
Karaoke workflow runs all of these offline.

## Still open

The operator is still the local skeleton: its runtime refuses to start without
`LOCAL_ONLY`, and its clock, and so result signing and record publication,
advances only through `/__clock`. A deployment needs an operator profile and a
scheduler, such as a Durable Object alarm. Migration 0008 and the new bindings
are in no deployment plan yet. Those bindings are `KARAOKE_*`,
`ALIGNMENT_ELEVENLABS_API_KEY`, and the operator origin, which the content
security policy now admits for the socket.

The real alignment of the published song is a provider call under separate
execution authorization. Until it runs, the song's Karaoke route answers
`karaoke_timing_unavailable`. After it runs, check that no sung line is longer
than ten seconds.

Other open items:

- The instrumental is served only to signed-in learners. Whether stems may be
  public is not decided here.
- The shared daily speech-call cap is not implemented. The number is still open
  with the owner.
- Terms and Privacy at sign-in are not part of this branch, per the ruling that
  provider and retention wording belongs there and not in the flow.
- The results page shows the operator's one signed score and lines sung. It
  invents no separate lyric or timing score.
- Purchases run on the operator's clock. A learner who pauses past a line's
  window leaves it unpaid, and two unpaid lines in a row stop the take.
- Each line is recorded in its own transaction, which is N+2 transactions per
  attempt, paid by the operator.
- PR 21's live MOSS activation still waits on its own review and on owner
  approval.

## Existing files changed

Outside new files, the branch changes these:

- `services/community-application.ts`: routes, bindings and the socket origin
  in the content security policy.
- `services/community-public.ts`: the bound lyric loader is shared.
- `services/community-purchases.ts` and `services/community.ts`: the trusted
  quote check moved beside the purchase code.
- `services/runtime.ts`: the pure helpers moved to `services/service-call.ts`
  and are re-exported, so Node-run modules avoid Workers-only imports.
- `services/storage.ts`: `D1Store` takes a table name.
- `services/records.ts`: the real song key.
- `services/karaoke.ts`: the ticket's song hash is bound to its manifest, plus
  the `/consent` and `/record` routes.
- `services/karaoke-audio.ts` and `packages/karaoke/audio-relay.ts`: the relay
  fix.
- `packages/protocol/payments.ts`: bytes32 line IDs and the manifest song.
- `packages/alignment/`: the fallback and the multipart body.
- `packages/karaoke/capture-controller.ts` and
  `apps/web/src/karaoke/use-karaoke-capture.ts`: a send for purchase frames.
- `apps/web/src/karaoke/practice-surface.tsx` and `results-model.ts`: the
  operator results view.
- `apps/web/src/live/entry.tsx` and `style.css`: the Sing entry.
- `harness/karaoke-client.ts`: connection by proof.
- `harness/karaoke-elevenlabs-simulator.ts`: forced alignment.
- `test/community-runtime.ts`: migration 0008.
- `.github/workflows/karaoke.yml`.
- `docs/song-alignment.md`.
