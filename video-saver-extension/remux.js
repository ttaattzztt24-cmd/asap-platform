// MPEG-TS のセグメント群を 1 本の MP4 にまとめる（mux.js を使用）。
// ブラウザでは window.Remux として、Node（テスト）では module.exports として使う。
//
// HLS では、途中でタイムスタンプが飛ぶこと（不連続点）がある。
// そのまま変換すると、動画の長さが極端に長くなったり、映像が途中から再生されなくなったりする。
// そこで不連続点ごとに変換器を作り直し、プレイリスト上の再生位置から続けて並べる。

(function (root) {
  const CLOCK = 90000; // MPEG-TS のタイムスタンプは 90kHz
  const WRAP = 2 ** 33; // PTS は 33bit で一周する
  const JUMP_TOLERANCE = 2 * CLOCK; // これ以上ずれていたら不連続とみなす

  function readPts(p, i) {
    return (
      (p[i] & 0x0e) * 536870912 + // 2^29
      p[i + 1] * 4194304 + // 2^22
      (p[i + 2] & 0xfe) * 16384 + // 2^14
      p[i + 3] * 128 + // 2^7
      ((p[i + 4] & 0xfe) >>> 1)
    );
  }

  // セグメント内で最初に現れる PES の PTS を返す。映像を優先し、なければ音声など。
  function firstPts(buffer) {
    const b = new Uint8Array(buffer);
    let fallback = null;
    for (let off = 0; off + 188 <= b.length; off += 188) {
      if (b[off] !== 0x47) {
        // 同期バイトがずれている場合は次の 0x47 を探す
        const next = b.indexOf(0x47, off + 1);
        if (next < 0) break;
        off = next - 188;
        continue;
      }
      if (!(b[off + 1] & 0x40)) continue; // payload_unit_start_indicator
      const afc = (b[off + 3] >> 4) & 3;
      if (!(afc & 1)) continue; // ペイロードなし
      let p = off + 4;
      if (afc & 2) p += 1 + b[off + 4];
      if (p + 14 > off + 188) continue;
      if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1) continue;
      const streamId = b[p + 3];
      if (!(b[p + 7] & 0x80)) continue; // PTS なし
      const pts = readPts(b, p + 9);
      if (streamId >= 0xe0 && streamId <= 0xef) return pts;
      if (fallback === null) fallback = pts;
    }
    return fallback;
  }

  const STREAM_TYPES = { 0x1b: 'H.264', 0x24: 'H.265', 0x0f: 'AAC', 0x03: 'MP3', 0x04: 'MP3', 0x81: 'AC-3', 0x15: 'ID3', 0x06: 'private' };

  // 診断用: セグメント内のストリーム（PID・種類・最初の PTS 秒）を調べる。
  function probeTs(buffer) {
    const b = new Uint8Array(buffer);
    let pmtPid = null;
    const types = new Map();
    const pts = new Map();
    for (let off = 0; off + 188 <= b.length; off += 188) {
      if (b[off] !== 0x47) continue;
      const pusi = b[off + 1] & 0x40;
      const pid = ((b[off + 1] & 0x1f) << 8) | b[off + 2];
      const afc = (b[off + 3] >> 4) & 3;
      if (!(afc & 1)) continue;
      let p = off + 4;
      if (afc & 2) p += 1 + b[off + 4];
      if (!pusi || p >= off + 188) continue;
      if (pid === 0 || pid === pmtPid) {
        p += 1 + b[p]; // pointer_field
        const sectionLength = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
        const end = Math.min(p + 3 + sectionLength - 4, off + 188);
        if (pid === 0) {
          for (let q = p + 8; q + 4 <= end; q += 4) {
            const program = (b[q] << 8) | b[q + 1];
            if (program !== 0) pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3];
          }
        } else {
          const infoLen = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
          for (let q = p + 12 + infoLen; q + 5 <= end; ) {
            const esPid = ((b[q + 1] & 0x1f) << 8) | b[q + 2];
            types.set(esPid, STREAM_TYPES[b[q]] || `0x${b[q].toString(16)}`);
            q += 5 + (((b[q + 3] & 0x0f) << 8) | b[q + 4]);
          }
        }
        continue;
      }
      if (pts.has(pid) || p + 14 > off + 188) continue;
      if (b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1 || !(b[p + 7] & 0x80)) continue;
      pts.set(pid, readPts(b, p + 9) / CLOCK);
    }
    const pids = new Set([...types.keys(), ...pts.keys()]);
    return [...pids].map((pid) => ({ pid, type: types.get(pid) || '?', pts: pts.has(pid) ? pts.get(pid) : null }));
  }

  // segments: [{ duration, discontinuity }]、buffers: 各セグメントの ArrayBuffer
  function transmuxToMp4(muxjs, buffers, segments) {
    // mux-mp4.min.js では muxjs.Transmuxer、フル版では muxjs.mp4.Transmuxer として公開されている。
    const Transmuxer = muxjs.Transmuxer || muxjs.mp4.Transmuxer;
    const parts = [];
    let init = null;
    let transmuxer = null;
    let position = 0; // 出力上の再生位置（秒）
    let prevPts = null;
    let prevDuration = 0;
    let runs = 0;

    for (let i = 0; i < buffers.length; i++) {
      const seg = segments[i] || {};
      const duration = seg.duration || 0;
      const pts = firstPts(buffers[i]);

      let jump = Boolean(seg.discontinuity);
      if (!jump && prevPts !== null && pts !== null) {
        let diff = pts - prevPts;
        if (diff < -WRAP / 2) diff += WRAP;
        if (diff > WRAP / 2) diff -= WRAP;
        if (Math.abs(diff - prevDuration * CLOCK) > JUMP_TOLERANCE) jump = true;
      }

      if (!transmuxer || jump) {
        transmuxer = new Transmuxer({ baseMediaDecodeTime: Math.round(position * CLOCK) });
        transmuxer.on('data', (out) => {
          if (!init) init = out.initSegment;
          parts.push(out.data);
        });
        runs++;
      }

      transmuxer.push(new Uint8Array(buffers[i]));
      transmuxer.flush();

      prevPts = pts !== null ? pts : prevPts !== null ? prevPts + prevDuration * CLOCK : null;
      prevDuration = duration;
      position += duration;
    }

    if (!init) throw new Error('MP4 への変換に失敗しました');
    return { parts: [init, ...parts], runs };
  }

  const api = { transmuxToMp4, firstPts, probeTs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Remux = api;
})(typeof self !== 'undefined' ? self : this);
