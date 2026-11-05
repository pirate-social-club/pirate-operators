# Supplemental song alignment

The current foundation is offline source, not a deployed alignment service.
It prepares ElevenLabs forced alignment of the actual private vocal MP3 and
the exact accepted lyric text. The independently inspected centralized adapter
is api-next f017e8014001a31d07b9e2de891e0907ad194b50, particularly
media-providers/elevenlabs-alignment-{request,response,types}.ts and
media-processing-runtime.ts. This repository owns its adaptation and has no
runtime import from that source. The official provider contract is
https://elevenlabs.io/docs/api-reference/forced-alignment/create.

Alignment follows publication. It must preserve the original recording hash,
vocal hash, published lyric revision and stable occurrence IDs. Supplemental
timings do not replace the immutable lyric manifest or authorize another
registration, post or song pin. Section cues do not become sung-word timings.
The parser requires exact transcript coverage, validated character and word
intervals, and words bound to their actual character spans. Standalone CR
remains within its retained lyric occurrence; CRLF/LF follow the manifest's
existing boundaries without normalization.

The current parser requires valid word timing evidence. The centralized
character-only fallback is not implemented, so a character-only response is
unavailable rather than fabricated word timing. General browser/device
acceptance and the authenticated runtime, scoped provider binding and reviewed
deployment/execution package remain outstanding. No provider call is established
by local tests or by this document.

The durable operation identity is community, post and lyric revision. A new
grant cannot replenish it. Status for a missing operation creates nothing;
denied authority cannot reserve its unique slot. Execution records running
before the one upstream send. Raw receipts persist before interpretation, and
unknown sends remain uncertain through repeated resumes. A late receipt from
the original execution can still complete the same operation. An unavailable
alignment never unpublishes the song.

The selected-song transport allows at most 192 KiB of raw response. The complete
captured request is at most 64 KiB, canonical receipt at most six times the raw
limit plus 16 KiB, and interpreted result at most 256 KiB. Their combined UTF-8
fields plus 4096 bytes of fixed metadata must fit within 1,800,000 bytes. This
stays below D1's documented 2,000,000-byte row limit even under worst-case JSON
escaping. A larger response or result cannot authorize another paid send.
Actual-D1 tests retain and reconstruct the near-budget receipt and result.

Provider redirects use manual handling supported by Workerd. A bundled runtime
test proves that a redirect response is retained and the API key is never
forwarded to its destination. The remaining source tests cover multipart vocal
bytes, digest/probe checks, transcript and occurrence integrity, concurrent
wakes, unknown outcomes, and restart after receipt retention.

The private vocal helper is also offline. Its five-minute-maximum read capability
is signed by the existing managed evidence signer and bound to the exact current
configuration, both origins, published post/revision and vocal seal. It requires
the published private job and fresh canonical public-post/configuration reads
before lookup and again at delivery. Expiry is checked after the D1 lookup before
starting R2 access, and synchronously after the final authority read. Changes
during awaited D1/R2 operations cannot return private bytes under stale authority.

Future runtime wiring must keep the expected origin, current configuration and
signing role server-controlled, gate capability issuance by the exact finite
post/lyric grant, and hash/probe downloaded vocal bytes before the provider send.
A read capability, community session or provider key alone cannot authorize an
alignment purchase. No route or deployed service currently imports this helper.
