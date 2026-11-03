# Local fixtures

original-tone.mp3 is a generated 250 ms 440 Hz tone, paired with the synthetic
lyrics "sing together". It exercises upload-byte binding; the recorded word
stream exercises scoring independently. It is not a recording of a singer.

Created once with FFmpeg using a lavfi sine source and libmp3lame at 32 kbps,
with metadata stripped. The acceptance run reads the committed bytes and does
not need FFmpeg. The performance fixture is packages/scoring/fixture-score.ts.
