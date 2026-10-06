// Minimal streaming WebM demuxer for the recordings this app makes
// (MediaRecorder: one Opus audio track, SimpleBlocks, clusters of unknown size).
// Feed it the file in pieces with push(); it returns the frames found so far.
// Works in the renderer (window.WebmDemuxer) and in Node (module.exports) for tests.
(function (root) {
  const ID = {
    EBML: 0x1a45dfa3,
    SEGMENT: 0x18538067,
    INFO: 0x1549a966,
    TIMECODE_SCALE: 0x2ad7b1,
    TRACKS: 0x1654ae6b,
    TRACK_ENTRY: 0xae,
    TRACK_NUMBER: 0xd7,
    CODEC_ID: 0x86,
    CODEC_PRIVATE: 0x63a2,
    AUDIO: 0xe1,
    SAMPLING_FREQUENCY: 0xb5,
    CHANNELS: 0x9f,
    CLUSTER: 0x1f43b675,
    TIMECODE: 0xe7,
    SIMPLE_BLOCK: 0xa3,
    BLOCK_GROUP: 0xa0,
    BLOCK: 0xa1,
  };
  // Containers we step into; everything else is read whole or skipped.
  const MASTERS = new Set([ID.SEGMENT, ID.INFO, ID.TRACKS, ID.TRACK_ENTRY, ID.AUDIO, ID.CLUSTER, ID.BLOCK_GROUP]);
  // Leaves whose contents we need.
  const WANTED = new Set([
    ID.TIMECODE_SCALE, ID.TRACK_NUMBER, ID.CODEC_ID, ID.CODEC_PRIVATE,
    ID.SAMPLING_FREQUENCY, ID.CHANNELS, ID.TIMECODE, ID.SIMPLE_BLOCK, ID.BLOCK,
  ]);

  function vintLength(first, max) {
    for (let len = 1; len <= max; len++) if (first & (0x80 >> (len - 1))) return len;
    return 0;
  }

  function readUint(bytes) {
    let v = 0;
    for (const b of bytes) v = v * 256 + b;
    return v;
  }

  class WebmDemuxer {
    constructor() {
      this.buf = new Uint8Array(0);
      this.skip = 0; // bytes of an unwanted element still to discard
      this.timecodeScale = 1000000; // ns per tick
      this.clusterTime = 0;
      this.track = { number: null, codec: null, codecPrivate: null, sampleRate: 48000, channels: 1 };
      this.trackReported = false;
    }

    // Returns { track (once, when known), frames: [{ timestampUs, data }] }.
    push(chunk) {
      const frames = [];
      let track = null;
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length);
        this.skip -= n;
        chunk = chunk.subarray(n);
      }
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      const b = merged;
      let p = 0;

      while (p < b.length) {
        const idLen = vintLength(b[p], 4);
        if (!idLen) throw new Error('WebMの形式が正しくありません（ID）');
        if (p + idLen >= b.length) break;
        const sizeLen = vintLength(b[p + idLen], 8);
        if (!sizeLen) throw new Error('WebMの形式が正しくありません（サイズ）');
        if (p + idLen + sizeLen > b.length) break;

        const id = readUint(b.subarray(p, p + idLen));
        const sizeBytes = b.subarray(p + idLen, p + idLen + sizeLen);
        const firstMasked = sizeBytes[0] & (0xff >> sizeLen);
        let unknown = firstMasked === 0xff >> sizeLen;
        for (let i = 1; i < sizeLen; i++) if (sizeBytes[i] !== 0xff) unknown = false;
        const size = unknown ? null : readUint([firstMasked, ...sizeBytes.subarray(1)]);
        const dataStart = p + idLen + sizeLen;

        if (MASTERS.has(id)) {
          if (id === ID.CLUSTER) this.clusterTime = 0;
          p = dataStart; // descend: children follow inline
          continue;
        }
        if (size === null) throw new Error('WebMの形式が正しくありません（不明なサイズ）');

        if (!WANTED.has(id)) {
          if (dataStart + size <= b.length) {
            p = dataStart + size;
          } else {
            this.skip = dataStart + size - b.length;
            p = b.length;
          }
          continue;
        }
        if (dataStart + size > b.length) break; // wait for the rest

        const data = b.subarray(dataStart, dataStart + size);
        switch (id) {
          case ID.TIMECODE_SCALE: this.timecodeScale = readUint(data); break;
          case ID.TRACK_NUMBER: this.track.number = readUint(data); break;
          case ID.CODEC_ID: this.track.codec = new TextDecoder().decode(data); break;
          case ID.CODEC_PRIVATE: this.track.codecPrivate = data.slice(); break;
          case ID.CHANNELS: this.track.channels = readUint(data); break;
          case ID.SAMPLING_FREQUENCY: {
            const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
            this.track.sampleRate = size === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
            break;
          }
          case ID.TIMECODE: this.clusterTime = readUint(data); break;
          case ID.SIMPLE_BLOCK:
          case ID.BLOCK: {
            if (!this.trackReported) {
              this.trackReported = true;
              track = { ...this.track };
            }
            const tnLen = vintLength(data[0], 8);
            const rel = new DataView(data.buffer, data.byteOffset + tnLen, 2).getInt16(0);
            const flags = data[tnLen + 2];
            if (flags & 0x06) break; // laced blocks are never produced by MediaRecorder
            const ticks = this.clusterTime + rel;
            frames.push({
              timestampUs: Math.round((ticks * this.timecodeScale) / 1000),
              data: data.slice(tnLen + 3),
            });
            break;
          }
        }
        p = dataStart + size;
      }

      this.buf = b.slice(p);
      return { track, frames };
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { WebmDemuxer };
  else root.WebmDemuxer = WebmDemuxer;
})(typeof window !== 'undefined' ? window : globalThis);
