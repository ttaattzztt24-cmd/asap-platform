// HLS（m3u8）プレイリストの最小限のパーサー。
// ブラウザでは window.Hls として、Node（テスト）では module.exports として使う。

(function (root) {
  // 例: BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"
  function parseAttributes(str) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let value = m[2];
      if (value.startsWith('"')) value = value.slice(1, -1);
      attrs[m[1]] = value;
    }
    return attrs;
  }

  // 例: 1000@2000 → { length: 1000, offset: 2000 }。offset 省略時は直前の続きから。
  function parseByteRange(str, nextOffset) {
    const [len, off] = str.split('@');
    const length = Number(len);
    const offset = off !== undefined ? Number(off) : nextOffset;
    return { length, offset };
  }

  function parsePlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines[0] !== '#EXTM3U') throw new Error('HLS プレイリストではありません');

    const resolve = (uri) => new URL(uri, baseUrl).href;

    if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
      const variants = [];
      const audio = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const attrs = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
          let j = i + 1;
          while (j < lines.length && lines[j].startsWith('#')) j++;
          if (j < lines.length) {
            variants.push({
              uri: resolve(lines[j]),
              bandwidth: Number(attrs.BANDWIDTH) || 0,
              resolution: attrs.RESOLUTION || '',
              audioGroup: attrs.AUDIO || null,
              codecs: attrs.CODECS || '',
            });
            i = j;
          }
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
          const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
          if (attrs.TYPE === 'AUDIO' && attrs.URI) {
            audio.push({ groupId: attrs['GROUP-ID'], name: attrs.NAME || '', uri: resolve(attrs.URI) });
          }
        }
      }
      variants.sort((a, b) => b.bandwidth - a.bandwidth);
      return { type: 'master', variants, audio };
    }

    const segments = [];
    let map = null;
    let encryption = null;
    let duration = 0;
    let pendingRange = null;
    let nextOffset = 0;
    let segDuration = 0;
    let discontinuity = false;

    for (const line of lines) {
      if (line.startsWith('#EXT-X-KEY:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
        if (attrs.METHOD && attrs.METHOD !== 'NONE') encryption = attrs.METHOD;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
        map = {
          uri: resolve(attrs.URI),
          byteRange: attrs.BYTERANGE ? parseByteRange(attrs.BYTERANGE, 0) : null,
        };
      } else if (line.startsWith('#EXTINF:')) {
        segDuration = parseFloat(line.slice('#EXTINF:'.length)) || 0;
        duration += segDuration;
      } else if (line.startsWith('#EXT-X-DISCONTINUITY') && !line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE')) {
        discontinuity = true;
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        pendingRange = parseByteRange(line.slice('#EXT-X-BYTERANGE:'.length), nextOffset);
      } else if (!line.startsWith('#')) {
        segments.push({ uri: resolve(line), byteRange: pendingRange, duration: segDuration, discontinuity });
        if (pendingRange) nextOffset = pendingRange.offset + pendingRange.length;
        pendingRange = null;
        segDuration = 0;
        discontinuity = false;
      }
    }

    return { type: 'media', segments, map, encryption, duration };
  }

  const api = { parsePlaylist, parseAttributes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Hls = api;
})(typeof self !== 'undefined' ? self : this);
