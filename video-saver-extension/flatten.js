// 断片化 MP4（初期化セグメント + moof/mdat の断片）を、普通の MP4（moov + mdat 1 つ）に組み直す。
// ブラウザでは window.Flatten として、Node（テスト）では module.exports として使う。
//
// 断片化 MP4 は、QuickTime Player などで「長さ 24 時間」「最初の断片だけ再生される」
// 「映像が出ない」といった問題が起きる。サンプル表を持つ普通の MP4 にすれば、どのプレーヤーでも再生できる。

(function (root) {
  const MOVIE_TIMESCALE = 1000;

  // ---- 読み取り ----

  function readU32(b, p) {
    return b[p] * 0x1000000 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]);
  }
  function readI32(b, p) {
    return (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
  }
  function readU64(b, p) {
    return readU32(b, p) * 0x100000000 + readU32(b, p + 4);
  }
  function typeAt(b, p) {
    return String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
  }

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
      yield { type: typeAt(b, pos), start: pos, body: pos + header, end: pos + size };
      pos += size;
    }
  }
  function child(b, box, name) {
    for (const c of boxes(b, box.body, box.end)) if (c.type === name) return c;
    return null;
  }
  const raw = (b, box) => b.subarray(box.start, box.end);

  // 初期化セグメントからトラック情報を読む。
  function parseInit(init) {
    const b = new Uint8Array(init);
    const tracks = new Map();
    const trex = new Map();
    for (const moov of boxes(b, 0, b.length)) {
      if (moov.type !== 'moov') continue;
      for (const box of boxes(b, moov.body, moov.end)) {
        if (box.type === 'mvex') {
          for (const t of boxes(b, box.body, box.end)) {
            if (t.type !== 'trex') continue;
            trex.set(readU32(b, t.body + 4), {
              duration: readU32(b, t.body + 12),
              size: readU32(b, t.body + 16),
              flags: readU32(b, t.body + 20),
            });
          }
        }
        if (box.type !== 'trak') continue;
        const tkhd = child(b, box, 'tkhd');
        const mdia = child(b, box, 'mdia');
        const mdhd = mdia && child(b, mdia, 'mdhd');
        const hdlr = mdia && child(b, mdia, 'hdlr');
        const minf = mdia && child(b, mdia, 'minf');
        const stbl = minf && child(b, minf, 'stbl');
        const stsd = stbl && child(b, stbl, 'stsd');
        if (!tkhd || !mdhd || !hdlr || !minf || !stsd) continue;
        const tkV1 = b[tkhd.body] === 1;
        const mdV1 = b[mdhd.body] === 1;
        const id = readU32(b, tkhd.body + (tkV1 ? 20 : 12));
        const mediaHeader = [...boxes(b, minf.body, minf.end)].find((c) => /^(vmhd|smhd|sthd|nmhd)$/.test(c.type));
        const dinf = child(b, minf, 'dinf');
        tracks.set(id, {
          id,
          handler: typeAt(b, hdlr.body + 4),
          timescale: readU32(b, mdhd.body + (mdV1 ? 20 : 12)),
          language: b.subarray(mdhd.body + (mdV1 ? 32 : 20), mdhd.body + (mdV1 ? 34 : 22)),
          widthHeight: b.subarray(tkhd.end - 8, tkhd.end),
          hdlr: raw(b, hdlr),
          mediaHeader: mediaHeader ? raw(b, mediaHeader) : null,
          dinf: dinf ? raw(b, dinf) : null,
          stsd: raw(b, stsd),
          samples: [],
          chunks: [], // { first: サンプル番号, count }
          firstTime: null,
        });
      }
    }
    return { tracks, trex };
  }

  // 断片（moof + mdat）からサンプルを取り出して、トラックごとに追加する。
  function readFragments(buffer, tracks, trex) {
    const b = new Uint8Array(buffer);
    for (const moof of boxes(b, 0, b.length)) {
      if (moof.type !== 'moof') continue;
      let prevTrafEnd = moof.start;
      for (const traf of boxes(b, moof.body, moof.end)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(b, traf, 'tfhd');
        if (!tfhd) continue;
        const tf = readU32(b, tfhd.body) & 0xffffff;
        const trackId = readU32(b, tfhd.body + 4);
        const track = tracks.get(trackId);
        if (!track) continue;
        const defaults = trex.get(trackId) || { duration: 0, size: 0, flags: 0 };
        let p = tfhd.body + 8;
        let base;
        if (tf & 0x1) {
          base = readU64(b, p);
          p += 8;
        } else if (tf & 0x20000) {
          base = moof.start;
        } else {
          base = prevTrafEnd;
        }
        if (tf & 0x2) p += 4; // sample_description_index
        let defDuration = defaults.duration;
        let defSize = defaults.size;
        let defFlags = defaults.flags;
        if (tf & 0x8) (defDuration = readU32(b, p)), (p += 4);
        if (tf & 0x10) (defSize = readU32(b, p)), (p += 4);
        if (tf & 0x20) (defFlags = readU32(b, p)), (p += 4);

        const tfdt = child(b, traf, 'tfdt');
        if (tfdt && track.firstTime === null) {
          track.firstTime = b[tfdt.body] === 1 ? readU64(b, tfdt.body + 4) : readU32(b, tfdt.body + 4);
        }

        let dataPos = base;
        for (const trun of boxes(b, traf.body, traf.end)) {
          if (trun.type !== 'trun') continue;
          const version = b[trun.body];
          const rf = readU32(b, trun.body) & 0xffffff;
          const count = readU32(b, trun.body + 4);
          let q = trun.body + 8;
          if (rf & 0x1) (dataPos = base + readI32(b, q)), (q += 4);
          let firstFlags = null;
          if (rf & 0x4) (firstFlags = readU32(b, q)), (q += 4);
          const firstSample = track.samples.length;
          for (let i = 0; i < count; i++) {
            const duration = rf & 0x100 ? readU32(b, (q += 4) - 4) : defDuration;
            const size = rf & 0x200 ? readU32(b, (q += 4) - 4) : defSize;
            let flags = rf & 0x400 ? readU32(b, (q += 4) - 4) : defFlags;
            if (i === 0 && firstFlags !== null) flags = firstFlags;
            let cto = 0;
            if (rf & 0x800) cto = version === 0 ? readU32(b, (q += 4) - 4) : readI32(b, (q += 4) - 4);
            if (dataPos + size > b.length) throw new Error('断片のデータが不足しています');
            track.samples.push({
              data: b.subarray(dataPos, dataPos + size),
              duration,
              sync: track.handler === 'soun' || !(flags & 0x10000), // 音声はすべて同期サンプル
              cto,
            });
            dataPos += size;
          }
          if (count) track.chunks.push({ first: firstSample, count });
        }
        prevTrafEnd = dataPos;
      }
    }
  }

  // ---- 書き出し ----

  function concat(parts) {
    const len = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return out;
  }
  function u32(v) {
    return new Uint8Array([(v / 0x1000000) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }
  function u64(v) {
    return concat([u32(Math.floor(v / 0x100000000)), u32(v % 0x100000000)]);
  }
  const u16 = (v) => new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
  const ascii = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

  function box(type, ...parts) {
    const body = concat(parts);
    return concat([u32(body.length + 8), ascii(type), body]);
  }
  const fullbox = (type, version, flags, ...parts) => box(type, u32(version * 0x1000000 + flags), ...parts);

  const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

  function buildStbl(track, chunkOffsets, useCo64) {
    const s = track.samples;

    const stts = [];
    for (const x of s) {
      const last = stts[stts.length - 1];
      if (last && last[1] === x.duration) last[0]++;
      else stts.push([1, x.duration]);
    }

    const stsc = [];
    track.chunks.forEach((c, i) => {
      const last = stsc[stsc.length - 1];
      if (!last || last[1] !== c.count) stsc.push([i + 1, c.count]);
    });

    const parts = [
      track.stsd,
      fullbox('stts', 0, 0, u32(stts.length), ...stts.flatMap(([n, d]) => [u32(n), u32(d)])),
      fullbox('stsc', 0, 0, u32(stsc.length), ...stsc.flatMap(([first, n]) => [u32(first), u32(n), u32(1)])),
      fullbox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.data.length))),
      useCo64
        ? fullbox('co64', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u64))
        : fullbox('stco', 0, 0, u32(chunkOffsets.length), ...chunkOffsets.map(u32)),
    ];

    if (s.some((x) => !x.sync)) {
      const sync = [];
      s.forEach((x, i) => x.sync && sync.push(i + 1));
      parts.push(fullbox('stss', 0, 0, u32(sync.length), ...sync.map(u32)));
    }

    if (s.some((x) => x.cto !== 0)) {
      const ctts = [];
      for (const x of s) {
        const last = ctts[ctts.length - 1];
        if (last && last[1] === x.cto) last[0]++;
        else ctts.push([1, x.cto]);
      }
      const negative = ctts.some(([, c]) => c < 0);
      parts.push(fullbox('ctts', negative ? 1 : 0, 0, u32(ctts.length), ...ctts.flatMap(([n, c]) => [u32(n), u32(c >>> 0)])));
    }

    return box('stbl', ...parts);
  }

  function buildTrak(track, chunkOffsets, useCo64, startOffset) {
    const mediaDuration = track.samples.reduce((n, x) => n + x.duration, 0);
    const movieDuration = Math.round((mediaDuration / track.timescale) * MOVIE_TIMESCALE);
    const isAudio = track.handler === 'soun';

    const tkhd = fullbox(
      'tkhd', 0, 3,
      u32(0), u32(0), u32(track.id), u32(0), u32(movieDuration),
      u32(0), u32(0), u16(0), u16(0), u16(isAudio ? 0x0100 : 0), u16(0),
      MATRIX, track.widthHeight
    );

    // 音声と映像の開始のずれ（数十ミリ秒）を、空白の edit で再現する。
    const parts = [tkhd];
    const delay = Math.round((startOffset / track.timescale) * MOVIE_TIMESCALE);
    if (delay > 0) {
      parts.push(
        box('edts', fullbox('elst', 0, 0, u32(2),
          u32(delay), u32(0xffffffff), u16(1), u16(0),
          u32(movieDuration), u32(0), u16(1), u16(0)))
      );
    }

    const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(mediaDuration), track.language, u16(0));
    const minf = box('minf', ...[track.mediaHeader, track.dinf].filter(Boolean), buildStbl(track, chunkOffsets, useCo64));
    parts.push(box('mdia', mdhd, track.hdlr, minf));

    return { trak: box('trak', ...parts), movieDuration: movieDuration + Math.max(delay, 0) };
  }

  // init: 初期化セグメント、fragments: moof/mdat を含む ArrayBuffer（または Uint8Array）の配列。
  // 戻り値: Blob にそのまま渡せる部品の配列（ftyp, moov, mdat ヘッダー, サンプルデータ…）。
  function flatten(init, fragments) {
    const { tracks, trex } = parseInit(init);
    for (const f of fragments) readFragments(f, tracks, trex);
    const list = [...tracks.values()].filter((t) => t.samples.length);
    if (!list.length) throw new Error('サンプルが見つかりませんでした');

    // mdat 内の並び: 断片の順に、トラックごとのかたまり（チャンク）を交互に置く。
    const order = [];
    const maxChunks = Math.max(...list.map((t) => t.chunks.length));
    for (let i = 0; i < maxChunks; i++) for (const t of list) if (t.chunks[i]) order.push({ track: t, chunk: t.chunks[i] });

    const chunkSize = ({ track, chunk }) => {
      let n = 0;
      for (let i = chunk.first; i < chunk.first + chunk.count; i++) n += track.samples[i].data.length;
      return n;
    };
    const dataSize = order.reduce((n, c) => n + chunkSize(c), 0);
    const largeMdat = dataSize + 8 > 0xffffffff;
    const mdatHeader = largeMdat ? concat([u32(1), ascii('mdat'), u64(dataSize + 16)]) : concat([u32(dataSize + 8), ascii('mdat')]);

    const minTime = Math.min(...list.map((t) => (t.firstTime === null ? Infinity : t.firstTime / t.timescale)));
    const ftyp = box('ftyp', ascii('isom'), u32(512), ascii('isom'), ascii('iso2'), ascii('avc1'), ascii('mp41'));

    const buildMoov = (useCo64, mdatStart) => {
      const offsets = new Map(list.map((t) => [t, []]));
      let pos = mdatStart + mdatHeader.length;
      for (const c of order) {
        offsets.get(c.track).push(pos);
        pos += chunkSize(c);
      }
      let duration = 0;
      const traks = list.map((t) => {
        const start = t.firstTime === null || !isFinite(minTime) ? 0 : t.firstTime - minTime * t.timescale;
        const { trak, movieDuration } = buildTrak(t, offsets.get(t), useCo64, start);
        duration = Math.max(duration, movieDuration);
        return trak;
      });
      const nextId = Math.max(...list.map((t) => t.id)) + 1;
      const mvhd = fullbox(
        'mvhd', 0, 0,
        u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(duration),
        u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
        MATRIX, new Uint8Array(24), u32(nextId)
      );
      return box('moov', mvhd, ...traks);
    };

    // moov の大きさでデータの位置が変わるので、2 回組み立てる。
    const useCo64 = ftyp.length + dataSize + 1024 * 1024 * 64 > 0xffffffff;
    let moov = buildMoov(useCo64, 0);
    moov = buildMoov(useCo64, ftyp.length + moov.length);

    const parts = [ftyp, moov, mdatHeader];
    for (const { track, chunk } of order) {
      for (let i = chunk.first; i < chunk.first + chunk.count; i++) parts.push(track.samples[i].data);
    }
    return parts;
  }

  const api = { flatten };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Flatten = api;
})(typeof self !== 'undefined' ? self : this);
