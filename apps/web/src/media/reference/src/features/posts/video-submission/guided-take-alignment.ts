import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";

/** Aligning a guided take to the song.
 *
 * The encoder starts before the guide is audible, so the captured video's
 * first moments happen before the song does. The server renders the song at
 * video time zero, so those leading milliseconds would appear as the author
 * moving ahead of the music. Measuring the delay is not compensation; the
 * take is trimmed by exactly that delay so its first frame is the first frame
 * after the guide started.
 *
 * Both tracks are kept. The server never maps the captured audio for a
 * song-backed render, but the sealed admission probe still requires a video
 * file with an audio track, so discarding it would make the aligned take
 * unuploadable. The audio is carried through the same trim.
 *
 * The removed duration reported back is measured from the output container,
 * not copied from the request: the number that reaches the plan is evidence.
 */

/** Below this the offset is inside measurement noise and no trim is applied. */
export const MIN_ALIGNMENT_MS = 40;

/** How far the measured removal may differ from the requested offset before
 * the conversion is treated as not having done what was asked. */
export const ALIGNMENT_TOLERANCE_MS = 150;

export interface GuidedTakeAlignment {
  readonly file: File;
  /** The leading milliseconds actually removed, measured from the output
   * container; zero when nothing was removed or alignment failed. */
  readonly trimmedMs: number;
  /** The offset the trim was asked for. */
  readonly requestedMs: number;
  /** False when the take could not be aligned and must not be published with
   * the song: the original file is returned untouched so nothing is lost. */
  readonly aligned: boolean;
}

const refused = (file: File, requestedMs: number): GuidedTakeAlignment => ({
  file,
  trimmedMs: 0,
  requestedMs,
  aligned: false,
});

/** AAC frames hold 1024 samples at 48 kHz. Snapping the trim to that grid
 * lets the audio packets be copied instead of re-encoded, which matters
 * because a browser that can record AAC is not guaranteed to be able to
 * encode it in a conversion. The shift is under 11 ms and the audio is not
 * part of the published mix. */
const AUDIO_FRAME_MS = (1024 / 48_000) * 1_000;

const mp4 = () =>
  new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 });

export async function alignGuidedTake(
  file: File,
  offsetMs: number,
): Promise<GuidedTakeAlignment> {
  const requested = Math.round(Number.isFinite(offsetMs) ? offsetMs : 0);
  if (requested < MIN_ALIGNMENT_MS)
    return { file, trimmedMs: 0, requestedMs: requested, aligned: true };
  const snapped = Math.round(requested / AUDIO_FRAME_MS) * AUDIO_FRAME_MS;
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS,
  });
  let videoInput: Input | undefined;
  try {
    const inputDurationMs = Math.round((await input.computeDuration()) * 1_000);
    if (!Number.isFinite(inputDurationMs) || inputDurationMs <= requested)
      return refused(file, requested);
    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;

    // Pass one trims the video to a clean, zero-based timeline. The video is
    // re-encoded from the trim point so the first frame is the first frame
    // after the guide started, with no edit list or pre-roll.
    const videoTarget = new BufferTarget();
    const videoConversion = await Conversion.init({
      input,
      output: new Output({ format: mp4(), target: videoTarget }),
      video: { codec: "avc", forceTranscode: true },
      audio: { discard: true },
      trim: { start: snapped / 1_000 },
    });
    if (!videoConversion.isValid) return refused(file, requested);
    await videoConversion.execute();
    if (!videoTarget.buffer) return refused(file, requested);

    // Pass two remuxes that trimmed video with the captured audio copied
    // packet for packet: trimming the audio would force a re-encode, and a
    // browser that can record AAC is not guaranteed to be able to encode it
    // again. The track exists for admission and is never mapped by the song
    // render, so its content offset does not matter.
    videoInput = new Input({
      source: new BlobSource(
        new File([videoTarget.buffer], "trimmed.mp4", { type: "video/mp4" }),
      ),
      formats: ALL_FORMATS,
    });
    const trimmedTrack = await videoInput.getPrimaryVideoTrack();
    if (trimmedTrack === null) return refused(file, requested);
    const videoSource = new EncodedVideoPacketSource("avc");
    const audioSource =
      audioCodec === null ? null : new EncodedAudioPacketSource(audioCodec);
    const finalTarget = new BufferTarget();
    const finalOutput = new Output({ format: mp4(), target: finalTarget });
    finalOutput.addVideoTrack(videoSource);
    if (audioSource !== null) finalOutput.addAudioTrack(audioSource);
    await finalOutput.start();
    const videoDecoderConfig = await trimmedTrack.getDecoderConfig();
    const videoSink = new EncodedPacketSink(trimmedTrack);
    const firstVideoPacket = await videoSink.getFirstPacket();
    if (firstVideoPacket === null) return refused(file, requested);
    // Timestamps must be non-negative in the container; a source whose edit
    // list starts slightly before zero is rebased so its first packet is zero.
    const videoOffset = firstVideoPacket.timestamp;
    let firstVideo = true;
    for await (const packet of videoSink.packets(firstVideoPacket)) {
      const shifted =
        videoOffset === 0
          ? packet
          : new EncodedPacket(
              packet.data,
              packet.type,
              packet.timestamp - videoOffset,
              packet.duration,
              packet.sequenceNumber,
              packet.byteLength,
              packet.sideData,
            );
      await videoSource.add(
        shifted,
        firstVideo && videoDecoderConfig !== null
          ? { decoderConfig: videoDecoderConfig }
          : undefined,
      );
      firstVideo = false;
    }
    videoSource.close();
    if (audioSource !== null && audioTrack !== null) {
      const audioDecoderConfig = await audioTrack.getDecoderConfig();
      const audioSink = new EncodedPacketSink(audioTrack);
      const firstAudioPacket = await audioSink.getFirstPacket();
      if (firstAudioPacket !== null) {
        const audioOffset = firstAudioPacket.timestamp;
        let firstAudio = true;
        for await (const packet of audioSink.packets(firstAudioPacket)) {
          const shifted =
            audioOffset === 0
              ? packet
              : new EncodedPacket(
                  packet.data,
                  packet.type,
                  packet.timestamp - audioOffset,
                  packet.duration,
                  packet.sequenceNumber,
                  packet.byteLength,
                  packet.sideData,
                );
          await audioSource.add(
            shifted,
            firstAudio && audioDecoderConfig !== null
              ? { decoderConfig: audioDecoderConfig }
              : undefined,
          );
          firstAudio = false;
        }
      }
      audioSource.close();
    }
    await finalOutput.finalize();
    if (!finalTarget.buffer) return refused(file, requested);

    const aligned = new File([finalTarget.buffer], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    });
    const probe = new Input({
      source: new BlobSource(aligned),
      formats: ALL_FORMATS,
    });
    try {
      const videoTrack = await probe.getPrimaryVideoTrack();
      const outputVideoDurationMs =
        videoTrack === null
          ? 0
          : Math.round((await videoTrack.computeDuration()) * 1_000);
      const firstFrameMs =
        videoTrack === null
          ? -1
          : Math.round((await videoTrack.getFirstTimestamp()) * 1_000);
      const removed = inputDurationMs - outputVideoDurationMs;
      // The plan is only allowed to carry a removal the output supports.
      if (
        !Number.isFinite(removed) ||
        removed <= 0 ||
        firstFrameMs !== 0 ||
        Math.abs(removed - snapped) > ALIGNMENT_TOLERANCE_MS
      ) {
        return refused(file, requested);
      }
      return {
        file: aligned,
        trimmedMs: removed,
        requestedMs: requested,
        aligned: true,
      };
    } finally {
      probe.dispose();
    }
  } catch {
    return refused(file, requested);
  } finally {
    videoInput?.dispose();
    input.dispose();
  }
}
