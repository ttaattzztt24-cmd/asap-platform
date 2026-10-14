// fMP4 形式の HLS セグメントの時刻（tfdt）を 0 から始まるように書き換える。
// ブラウザでは window.Fmp4 として、Node（テスト）では module.exports として使う。
//
// fMP4 のセグメントは、配信元の時刻（例: 24 時間 10 分）をそのまま持っていることがある。
// そのままつなぐと、プレーヤーは冒頭に長い空白があると判断し、長さがおかしくなり映像も出ない。
// また途中で時刻が飛ぶ（不連続点）場合も、プレイリスト上の再生位置に合わせてつなぎ直す。

(function (root) {
  const JUMP_TOLERANCE_SEC = 2;

  function type(b, pos) {
    return String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
  }

  function readU32(b, pos) {
    return b[pos] * 0x1000000 + ((b[pos + 1] << 16) | (b[pos + 2] << 8) | b[pos + 3]);
  }

  function writeU32(b, pos, v) {
    b[pos] = (v / 0x1000000) & 0xff;
    b[pos + 1] = (v >>> 16) & 0xff;
    b[pos + 2] = (v >>> 8) & 0xff;
    b[pos + 3] = v & 0xff;
  }

  function readU64(b, pos) {
    return readU32(b, pos) * 0x100000000 + readU32(b, pos + 4);
  }

  function writeU64(b, pos, v) {
    writeU32(b, pos, Math.floor(v / 0x100000000));
    writeU32(b, pos + 4, v % 0x100000000);
  }

  // [start, end) の範囲にある子ボックスを列挙する。
  function* boxes(b, start, end) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = readU32(b, pos);
      let header = 8;
      if (size === 1) {
        size = readU64(b, pos + 8);
        header = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < header || pos + size > end) return;
      yield { type: type(b, pos), start: pos, body: pos + header, end: pos + size };
      pos += size;
    }
  }

  function child(b, box, name) {
    for (const c of boxes(b, box.body, box.end)) if (c.type === name) return c;
    return null;
  }

  // 初期化セグメントから、トラック ID ごとのタイムスケールを読む。
  function readTimescales(init) {
    const b = new Uint8Array(init);
    const scales = new Map();
    for (const moov of boxes(b, 0, b.length)) {
      if (moov.type !== 'moov') continue;
      for (const trak of boxes(b, moov.body, moov.end)) {
        if (trak.type !== 'trak') continue;
        const tkhd = child(b, trak, 'tkhd');
        const mdia = child(b, trak, 'mdia');
        const mdhd = mdia && child(b, mdia, 'mdhd');
        if (!tkhd || !mdhd) continue;
        const trackId = readU32(b, tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
        const timescale = readU32(b, mdhd.body + (b[mdhd.body] === 1 ? 20 : 12));
        scales.set(trackId, timescale);
      }
    }
    return scales;
  }

  // 初期化セグメントの edit list にある「空白の区間」（media_time = -1）の長さを 0 にする。
  // 配信元の時刻を冒頭の空白として持っている場合があり、そのままだと長い空白が入る。
  function removeEmptyEdits(init) {
    const b = new Uint8Array(init);
    let removed = 0;
    for (const moov of boxes(b, 0, b.length)) {
      if (moov.type !== 'moov') continue;
      for (const trak of boxes(b, moov.body, moov.end)) {
        if (trak.type !== 'trak') continue;
        const edts = child(b, trak, 'edts');
        const elst = edts && child(b, edts, 'elst');
        if (!elst) continue;
        const v1 = b[elst.body] === 1;
        const entrySize = v1 ? 20 : 12;
        const count = readU32(b, elst.body + 4);
        for (let i = 0; i < count; i++) {
          const e = elst.body + 8 + i * entrySize;
          if (e + entrySize > elst.end) break;
          const mediaTimeEmpty = v1
            ? readU32(b, e + 8) === 0xffffffff && readU32(b, e + 12) === 0xffffffff
            : readU32(b, e + 4) === 0xffffffff;
          if (!mediaTimeEmpty) continue;
          if (v1) writeU64(b, e, 0);
          else writeU32(b, e, 0);
          removed++;
        }
      }
    }
    return removed;
  }

  // セグメント内の全 traf の tfdt（位置・バージョン・値）を集める。
  function findTfdts(b) {
    const found = [];
    for (const top of boxes(b, 0, b.length)) {
      if (top.type === 'sidx') {
        // 個々のセグメントの索引はつないだ後では誤りになるので、無害な free ボックスに変える。
        b[top.start + 4] = 0x66; // f
        b[top.start + 5] = 0x72; // r
        b[top.start + 6] = 0x65; // e
        b[top.start + 7] = 0x65; // e
        continue;
      }
      if (top.type !== 'moof') continue;
      for (const traf of boxes(b, top.body, top.end)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(b, traf, 'tfhd');
        const tfdt = child(b, traf, 'tfdt');
        if (!tfhd || !tfdt) continue;
        const version = b[tfdt.body];
        const pos = tfdt.body + 4;
        found.push({
          trackId: readU32(b, tfhd.body + 4),
          version,
          pos,
          value: version === 1 ? readU64(b, pos) : readU32(b, pos),
        });
      }
    }
    return found;
  }

  // buffers の中身をその場で書き換える。segments: [{ duration, discontinuity }]
  function normalizeTimestamps(init, buffers, segments) {
    const scales = readTimescales(init);
    removeEmptyEdits(init);
    let offsetSec = null; // 元の時刻からこの秒数を引く
    let position = 0; // プレイリスト上の再生位置（秒）
    let runs = 0;

    for (let i = 0; i < buffers.length; i++) {
      const b = new Uint8Array(buffers[i]);
      const seg = segments[i] || {};
      const tfdts = findTfdts(b).filter((t) => scales.get(t.trackId));

      if (tfdts.length) {
        const startSec = Math.min(...tfdts.map((t) => t.value / scales.get(t.trackId)));
        const drift = offsetSec === null ? Infinity : Math.abs(startSec - offsetSec - position);
        if (offsetSec === null || seg.discontinuity || drift > JUMP_TOLERANCE_SEC) {
          offsetSec = startSec - position;
          runs++;
        }
        for (const t of tfdts) {
          const v = Math.max(0, t.value - Math.round(offsetSec * scales.get(t.trackId)));
          if (t.version === 1) writeU64(b, t.pos, v);
          else writeU32(b, t.pos, Math.min(v, 0xffffffff));
        }
      }
      position += seg.duration || 0;
    }
    return { runs };
  }

  const api = { normalizeTimestamps, readTimescales };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Fmp4 = api;
})(typeof self !== 'undefined' ? self : this);
