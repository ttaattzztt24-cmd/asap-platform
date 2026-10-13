// HLS 動画のダウンロードページ。
// プレイリストを読み、セグメントを順に取得して 1 つのファイルにまとめて保存する。

const DEFAULT_CONCURRENCY = 12;
const RETRIES = 3;

const params = new URLSearchParams(location.search);
const playlistUrl = params.get('url');
const referer = params.get('referer') || '';
const pageTitle = params.get('title') || '';

const $ = (id) => document.getElementById(id);
let ruleId = null;
let blobUrl = null;

function showMessage(text, kind = '') {
  const m = $('message');
  m.textContent = text;
  m.className = kind;
}

function sanitizeFileName(name) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 100);
  return cleaned || 'video';
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

// 配信サーバーが Referer を確認している場合に備え、このタブからの通信に元ページの Referer を付ける。
async function installRefererRule() {
  if (!referer) return;
  let origin;
  try {
    origin = new URL(referer).origin;
  } catch {
    return;
  }
  const tab = await chrome.tabs.getCurrent();
  ruleId = tab ? tab.id + 1 : 1;
  const condition = { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] };
  if (tab) condition.tabIds = [tab.id];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        condition,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: referer },
            { header: 'origin', operation: 'set', value: origin },
          ],
        },
      },
    ],
  });
}

async function removeRefererRule() {
  if (ruleId === null) return;
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  ruleId = null;
}

async function fetchWithRetry(url, { byteRange = null, as = 'arrayBuffer' } = {}) {
  const headers = {};
  if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers, credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === 'text' ? await res.text() : await res.arrayBuffer();
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`取得に失敗しました: ${url}\n(${lastError.message})`);
}

async function loadMediaPlaylist(url) {
  const playlist = Hls.parsePlaylist(await fetchWithRetry(url, { as: 'text' }), url);
  if (playlist.type !== 'media') throw new Error('プレイリストの形式に対応していません');
  return playlist;
}

async function downloadSegments(segments, concurrency, onProgress) {
  const results = new Array(segments.length);
  let next = 0;
  let done = 0;
  let bytes = 0;

  async function worker() {
    while (next < segments.length) {
      const i = next++;
      const buf = await fetchWithRetry(segments[i].uri, { byteRange: segments[i].byteRange });
      results[i] = buf;
      done++;
      bytes += buf.byteLength;
      onProgress(done, segments.length, bytes);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
  return results;
}

// MPEG-TS のセグメント群を MP4 に変換する（mux.js を使用）。
function transmuxToMp4(tsBuffers) {
  // mux-mp4.min.js では muxjs.Transmuxer、フル版では muxjs.mp4.Transmuxer として公開されている。
  const Transmuxer = muxjs.Transmuxer || muxjs.mp4.Transmuxer;
  const transmuxer = new Transmuxer();
  const parts = [];
  let init = null;
  transmuxer.on('data', (segment) => {
    if (!init) init = segment.initSegment;
    parts.push(segment.data);
  });
  for (const buf of tsBuffers) {
    transmuxer.push(new Uint8Array(buf));
    transmuxer.flush();
  }
  if (!init) throw new Error('MP4 への変換に失敗しました');
  return [init, ...parts];
}

async function saveBlob(blob, fileName) {
  blobUrl = URL.createObjectURL(blob);
  await chrome.downloads.download({ url: blobUrl, filename: fileName, saveAs: true });
}

async function run(mediaUrl, convert, concurrency) {
  $('options').hidden = true;
  $('progress').hidden = false;
  showMessage('');

  const playlist = await loadMediaPlaylist(mediaUrl);
  if (playlist.encryption) {
    throw new Error(`この動画は暗号化（${playlist.encryption}）されているため保存できません。`);
  }
  if (!playlist.segments.length) throw new Error('セグメントが見つかりませんでした');

  const startedAt = Date.now();
  const buffers = await downloadSegments(playlist.segments, concurrency, (done, total, bytes) => {
    $('bar').value = done / total;
    const mb = bytes / 1024 / 1024;
    const elapsed = (Date.now() - startedAt) / 1000;
    const remain = done ? (elapsed / done) * (total - done) : 0;
    const speed = elapsed ? (mb / elapsed).toFixed(1) : '0.0';
    $('progress-text').textContent =
      `${done} / ${total} セグメント ・ ${mb.toFixed(1)} MB ・ ${speed} MB/秒 ・ 残り約 ${formatDuration(remain)}`;
  });

  const baseName = sanitizeFileName(pageTitle);
  if (playlist.map) {
    // fMP4 形式: 初期化セグメント + 各セグメントをつなげるとそのまま MP4 になる。
    const init = await fetchWithRetry(playlist.map.uri, { byteRange: playlist.map.byteRange });
    await saveBlob(new Blob([init, ...buffers], { type: 'video/mp4' }), `${baseName}.mp4`);
  } else if (convert) {
    $('progress-text').textContent = 'MP4 に変換しています…';
    let parts;
    try {
      parts = transmuxToMp4(buffers);
    } catch (e) {
      console.error(e);
      showMessage('MP4 への変換に失敗したため、.ts 形式で保存します。');
    }
    if (parts) await saveBlob(new Blob(parts, { type: 'video/mp4' }), `${baseName}.mp4`);
    else await saveBlob(new Blob(buffers, { type: 'video/mp2t' }), `${baseName}.ts`);
  } else {
    await saveBlob(new Blob(buffers, { type: 'video/mp2t' }), `${baseName}.ts`);
  }

  $('progress-text').textContent = `完了（${formatDuration(playlist.duration)}）`;
  showMessage('保存を開始しました。保存が終わるまで、このタブは閉じないでください。', 'success');
  await removeRefererRule();
}

async function init() {
  if (!playlistUrl) {
    showMessage('動画の URL が指定されていません。', 'error');
    return;
  }
  if (pageTitle) $('title').textContent = pageTitle;
  $('source').textContent = playlistUrl;

  await installRefererRule();
  const text = await fetchWithRetry(playlistUrl, { as: 'text' });
  const playlist = Hls.parsePlaylist(text, playlistUrl);

  let getMediaUrl = () => playlistUrl;
  let needsConvertOption = !playlist.map;

  if (playlist.type === 'master') {
    if (!playlist.variants.length) throw new Error('画質の候補が見つかりませんでした');
    const select = $('quality');
    for (const v of playlist.variants) {
      const label = [v.resolution, v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : ''].filter(Boolean).join(' ・ ');
      select.append(new Option(label || v.uri, v.uri));
    }
    $('quality-row').hidden = false;
    getMediaUrl = () => select.value;
    needsConvertOption = true;

    if (playlist.audio.length) {
      showMessage('この動画は音声が別トラックで配信されています。映像のみ保存される場合があります。');
    }
  }

  const speedSelect = $('speed');
  try {
    speedSelect.value = localStorage.getItem('concurrency') || String(DEFAULT_CONCURRENCY);
  } catch {}
  if (!speedSelect.value) speedSelect.value = String(DEFAULT_CONCURRENCY);

  $('convert-row').hidden = !needsConvertOption;
  $('options').hidden = false;
  $('start').addEventListener('click', () => {
    try {
      localStorage.setItem('concurrency', speedSelect.value);
    } catch {}
    run(getMediaUrl(), $('convert').checked, Number(speedSelect.value)).catch(fail);
  });
}

function fail(e) {
  console.error(e);
  $('progress').hidden = true;
  showMessage(e.message || String(e), 'error');
  removeRefererRule();
}

window.addEventListener('beforeunload', () => {
  removeRefererRule();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});

init().catch(fail);
