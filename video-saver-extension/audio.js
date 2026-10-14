// 動画の音声トラックを MP3 に書き出す。
// AAC の解読は Chrome の WebCodecs（AudioDecoder）、MP3 への変換は lamejs で行う。
// ブラウザでは window.AudioExport として、Node（テスト）では module.exports として使う。

(function (root) {
  const MP3_KBPS = 128;

  function readU32(b, p) {
    return b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
  }
  function typeAt(b, p) {
    return String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
  }

  // MPEG-4 記述子の長さ（1〜4 バイトの可変長）を読む。
  function readDescriptorLength(b, p) {
    let len = 0;
    let i = 0;
    for (; i < 4; i++) {
      const c = b[p + i];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { len, size: i + 1 };
  }

  // esds ボックスの中から AudioSpecificConfig（AAC の設定データ）を取り出す。
  function findAudioSpecificConfig(b, start, end) {
    let p = start;
    while (p < end) {
      const tag = b[p];
      const { len, size } = readDescriptorLength(b, p + 1);
      const body = p + 1 + size;
      if (tag === 0x03) {
        // ES_Descriptor: ES_ID(2) + flags(1) + 任意項目
        const flags = b[body + 2];
        let q = body + 3;
        if (flags & 0x80) q += 2; // dependsOn_ES_ID
        if (flags & 0x40) q += 1 + b[q]; // URL
        if (flags & 0x20) q += 2; // OCR_ES_Id
        return findAudioSpecificConfig(b, q, body + len);
      }
      if (tag === 0x04) {
        // DecoderConfigDescriptor: objectType(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
        return findAudioSpecificConfig(b, body + 13, body + len);
      }
      if (tag === 0x05) return b.slice(body, body + len);
      p = body + len;
    }
    return null;
  }

  // stsd（サンプル記述）から、AudioDecoder の設定を作る。
  function decoderConfig(stsd) {
    const b = new Uint8Array(stsd);
    // stsd: ヘッダー 8 + version/flags 4 + entry_count 4 → 最初のエントリー
    const entry = 16;
    const type = typeAt(b, entry);
    const channels = (b[entry + 24] << 8) | b[entry + 25];
    const sampleRate = readU32(b, entry + 32) >>> 16;
    const entryEnd = entry + readU32(b, entry);

    if (type === 'mp4a') {
      for (let p = entry + 36; p + 8 <= entryEnd; p += readU32(b, p) || entryEnd) {
        if (typeAt(b, p) !== 'esds') continue;
        const asc = findAudioSpecificConfig(b, p + 12, p + readU32(b, p));
        if (!asc) break;
        let objectType = asc[0] >> 3;
        if (objectType === 31) objectType = 32 + (((asc[0] & 7) << 3) | (asc[1] >> 5));
        return { codec: `mp4a.40.${objectType}`, sampleRate, numberOfChannels: channels, description: asc };
      }
      return { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels };
    }
    if (type === 'Opus') return { codec: 'opus', sampleRate: 48000, numberOfChannels: channels };
    throw new Error(`この音声形式（${type}）には対応していません`);
  }

  function toInt16(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const v = Math.max(-1, Math.min(1, f32[i]));
      out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    return out;
  }

  // PCM（チャンネルごとの Float32Array）を受け取って MP3 にしていく小さなラッパー。
  function createMp3Writer(lamejs, sampleRate, channels) {
    const ch = Math.min(channels, 2);
    const encoder = new lamejs.Mp3Encoder(ch, sampleRate, MP3_KBPS);
    const chunks = [];
    return {
      write(planes) {
        const left = toInt16(planes[0]);
        const out = ch === 2 ? encoder.encodeBuffer(left, toInt16(planes[1])) : encoder.encodeBuffer(left);
        if (out.length) chunks.push(new Uint8Array(out));
      },
      finish() {
        const out = encoder.flush();
        if (out.length) chunks.push(new Uint8Array(out));
        return chunks;
      },
    };
  }

  // track: flatten.collectTracks() が返す音声トラック。戻り値: MP3 データの配列（Blob にそのまま渡せる）。
  async function toMp3(track, { lamejs, AudioDecoder, EncodedAudioChunk, onProgress = () => {} }) {
    const config = decoderConfig(track.stsd);
    const support = await AudioDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`このブラウザでは音声（${config.codec}）を解読できません`);

    let writer = null;
    let error = null;
    const decoder = new AudioDecoder({
      output(data) {
        try {
          if (!writer) writer = createMp3Writer(lamejs, data.sampleRate, data.numberOfChannels);
          const planes = [];
          for (let c = 0; c < Math.min(data.numberOfChannels, 2); c++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            planes.push(plane);
          }
          writer.write(planes);
        } catch (e) {
          error = e;
        } finally {
          data.close();
        }
      },
      error(e) {
        error = e;
      },
    });
    decoder.configure(config);

    let time = 0;
    const samples = track.samples;
    for (let i = 0; i < samples.length; i++) {
      if (error) throw error;
      const s = samples[i];
      decoder.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round((time / track.timescale) * 1e6),
          duration: Math.round((s.duration / track.timescale) * 1e6),
          data: s.data,
        })
      );
      time += s.duration;
      // 解読待ちが溜まりすぎないように、ときどき待つ。
      if (decoder.decodeQueueSize > 100) await new Promise((r) => setTimeout(r, 0));
      if (i % 500 === 0) onProgress(i / samples.length);
    }
    await decoder.flush();
    decoder.close();
    if (error) throw error;
    if (!writer) throw new Error('音声を解読できませんでした');
    onProgress(1);
    return writer.finish();
  }

  const api = { toMp3, decoderConfig, createMp3Writer };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AudioExport = api;
})(typeof self !== 'undefined' ? self : this);
