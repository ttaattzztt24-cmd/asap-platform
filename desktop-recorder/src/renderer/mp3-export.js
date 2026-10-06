// Converts a recording (WebM/Opus) to MP3 without holding the whole file in
// memory: read a piece -> demux -> decode with WebCodecs -> encode with lamejs ->
// write a piece. Needs window.WebmDemuxer and window.lamejs.
(function (root) {
  const READ_BYTES = 1024 * 1024;
  const WRITE_BYTES = 512 * 1024;
  const MP3_KBPS = 128;
  const MAX_DECODE_QUEUE = 64;

  // io: { size, read(offset, length) -> Promise<Uint8Array>, write(Uint8Array) -> Promise }
  async function exportToMp3(io, { onProgress = () => {} } = {}) {
    const demuxer = new root.WebmDemuxer();
    let encoder = null;
    let decoder = null;
    let failure = null;
    let samples = 0;
    let sampleRate = 48000;

    let pending = [];
    let pendingBytes = 0;
    let writeChain = Promise.resolve();
    const queueWrite = (bytes, force = false) => {
      if (bytes && bytes.length) {
        pending.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
        pendingBytes += bytes.length;
      }
      if (pendingBytes >= WRITE_BYTES || (force && pendingBytes)) {
        const out = new Uint8Array(pendingBytes);
        let o = 0;
        for (const part of pending) {
          out.set(part, o);
          o += part.length;
        }
        pending = [];
        pendingBytes = 0;
        writeChain = writeChain.then(() => io.write(out));
      }
    };

    // Recordings are mixed in stereo but are speech, so the MP3 is mono.
    const onAudio = (audio) => {
      try {
        const frames = audio.numberOfFrames;
        const channels = audio.numberOfChannels;
        const mono = new Float32Array(frames);
        const plane = new Float32Array(frames);
        for (let c = 0; c < channels; c++) {
          audio.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
          for (let i = 0; i < frames; i++) mono[i] += plane[i] / channels;
        }
        const pcm = new Int16Array(frames);
        for (let i = 0; i < frames; i++) {
          const v = Math.max(-1, Math.min(1, mono[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        samples += frames;
        queueWrite(encoder.encodeBuffer(pcm));
      } catch (err) {
        failure = failure || err;
      } finally {
        audio.close();
      }
    };

    for (let offset = 0; offset < io.size; ) {
      if (failure) throw failure;
      const chunk = await io.read(offset, READ_BYTES);
      if (!chunk.length) break;
      offset += chunk.length;

      const { track, frames } = demuxer.push(chunk);
      if (track) {
        if (track.codec && track.codec !== 'A_OPUS') throw new Error(`対応していない音声形式です: ${track.codec}`);
        sampleRate = Math.round(track.sampleRate) || 48000;
        encoder = new root.lamejs.Mp3Encoder(1, sampleRate, MP3_KBPS);
        decoder = new AudioDecoder({ output: onAudio, error: (e) => (failure = failure || e) });
        decoder.configure({
          codec: 'opus',
          sampleRate,
          numberOfChannels: track.channels || 1,
          ...(track.codecPrivate ? { description: track.codecPrivate } : {}),
        });
      }
      for (const f of frames) {
        if (!decoder) continue;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: f.timestampUs, data: f.data }));
        // Back-pressure so a long file does not queue up in memory.
        while (decoder.decodeQueueSize > MAX_DECODE_QUEUE && !failure) {
          await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
        }
      }
      onProgress(Math.min(0.99, offset / io.size));
    }

    if (!decoder) throw new Error('録音の中に音声が見つかりませんでした');
    await decoder.flush();
    decoder.close();
    if (failure) throw failure;
    queueWrite(encoder.flush(), true);
    await writeChain;
    onProgress(1);
    return { durationSec: samples / sampleRate };
  }

  root.exportToMp3 = exportToMp3;
})(window);
