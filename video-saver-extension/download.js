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
const blobUrls = [];

// 診断情報（不具合の調査用）。映像の中身や URL のトークンは含めない。
const diag = [];
function note(line) {
  diag.push(line);
}

function fileExt(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
    return m ? m[1] : '(なし)';
  } catch {
    return '?';
  }
}

function sampleIndexes(n) {
  return [...new Set([0, 1, 2, Math.floor(n / 2), n - 2, n - 1].filter((i) => i >= 0 && i < n))];
}

const sec = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(3));

function describeFmp4Output(label, init, fragments) {
  const tracks = Fmp4.probeInit(init);
  note(`${label} トラック: ${tracks.map((t) => `#${t.id} ${t.handler}/${t.codec} ts=${t.timescale}${t.editList ? ' elst' : ''}`).join(', ') || '(なし)'}`);
  const scale = new Map(tracks.map((t) => [t.id, t.timescale]));
  for (const i of sampleIndexes(fragments.length)) {
    const tf = Fmp4.probeSegment(fragments[i]);
    note(`${label} [${i}] ${tf.map((t) => `#${t.trackId}=${sec(t.tfdt / (scale.get(t.trackId) || 1))}s`).join(' ') || '(tfdt なし)'}`);
  }
}

function showDiagnostics() {
  const text = [
    `LP Video Saver v${chrome.runtime.getManifest().version}`,
    `Chrome: ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || '?'}`,
    ...diag,
  ].join('\n');
  $('diag-text').value = text;
  $('diag').hidden = false;
}

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

// 断片化 MP4 を普通の MP4 に組み直す。QuickTime などで正しく再生できるようにするため。
// 失敗した場合は断片化 MP4 のまま保存する（Chrome や VLC では再生できる）。
function toPlainMp4(init, fragments) {
  try {
    const parts = Flatten.flatten(init, fragments);
    note('出力形式: 通常の MP4');
    return parts;
  } catch (e) {
    console.error(e);
    note(`出力形式: 断片化 MP4（組み直しに失敗: ${e.message}）`);
    return [init, ...fragments];
  }
}

async function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  blobUrls.push(url);
  await chrome.downloads.download({ url, filename: fileName, saveAs: true });
}

async function run(mediaUrl, convert, concurrency, outputs) {
  $('options').hidden = true;
  $('progress').hidden = false;
  showMessage('');

  const playlist = await loadMediaPlaylist(mediaUrl);
  note(
    `メディア: セグメント ${playlist.segments.length} 個, 長さ ${formatDuration(playlist.duration)}, ` +
      `不連続タグ ${playlist.segments.filter((x) => x.discontinuity).length} 個, ` +
      `形式 ${playlist.map ? 'fMP4' : 'MPEG-TS'}, 拡張子 .${fileExt(playlist.segments[0]?.uri || '')}, ` +
      `暗号化 ${playlist.encryption || 'なし'}, 範囲指定 ${playlist.segments.some((x) => x.byteRange) ? 'あり' : 'なし'}`
  );
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

  // まず断片化 MP4（初期化セグメント + 断片）の形にそろえる。動画と MP3 の両方の元になる。
  let mp4 = null;
  if (playlist.map) {
    // fMP4 形式: 初期化セグメント + 各セグメントをつなげると MP4 になる。
    // ただし配信元の時刻が残っているので、0 秒から始まるように書き換える。
    const init = await fetchWithRetry(playlist.map.uri, { byteRange: playlist.map.byteRange });
    describeFmp4Output('入力', init, buffers);
    const { runs } = Fmp4.normalizeTimestamps(init, buffers, playlist.segments);
    note(`時刻の区切り: ${runs}`);
    describeFmp4Output('出力', init, buffers);
    mp4 = { init, fragments: buffers };
  } else if (convert || outputs.mp3) {
    $('progress-text').textContent = 'MP4 に変換しています…';
    for (const i of sampleIndexes(buffers.length)) {
      const streams = Remux.probeTs(buffers[i]);
      note(`入力 [${i}] ${streams.map((x) => `PID${x.pid} ${x.type} pts=${sec(x.pts)}s`).join(', ') || '(ストリームなし)'}`);
    }
    try {
      const result = Remux.transmuxToMp4(muxjs, buffers, playlist.segments);
      note(`時刻の区切り: ${result.runs}`);
      describeFmp4Output('出力', result.parts[0], result.parts.slice(1));
      mp4 = { init: result.parts[0], fragments: result.parts.slice(1) };
    } catch (e) {
      note(`変換エラー: ${e.message}`);
      console.error(e);
      if (outputs.video && convert) showMessage('MP4 への変換に失敗したため、.ts 形式で保存します。');
    }
  }

  const saved = [];
  if (outputs.video) {
    if (mp4 && (playlist.map || convert)) {
      await saveBlob(new Blob(toPlainMp4(mp4.init, mp4.fragments), { type: 'video/mp4' }), `${baseName}.mp4`);
      saved.push('動画（MP4）');
    } else {
      await saveBlob(new Blob(buffers, { type: 'video/mp2t' }), `${baseName}.ts`);
      saved.push('動画（.ts）');
    }
  }

  if (outputs.mp3) {
    if (!mp4) throw new Error('音声を取り出せませんでした。');
    const audio = Flatten.collectTracks(mp4.init, mp4.fragments).find((t) => t.handler === 'soun' && t.samples.length);
    if (!audio) throw new Error('この動画には音声が入っていません。');
    $('progress-text').textContent = 'MP3 に変換しています… 0%';
    const startedMp3 = Date.now();
    const mp3 = await AudioExport.toMp3(audio, {
      lamejs,
      AudioDecoder,
      EncodedAudioChunk,
      onProgress: (p) => {
        $('progress-text').textContent = `MP3 に変換しています… ${Math.round(p * 100)}%`;
      },
    });
    const mp3Bytes = mp3.reduce((n, c) => n + c.length, 0);
    note(`MP3: ${(mp3Bytes / 1024 / 1024).toFixed(1)} MB, 変換 ${((Date.now() - startedMp3) / 1000).toFixed(0)} 秒`);
    await saveBlob(new Blob(mp3, { type: 'audio/mpeg' }), `${baseName}.mp3`);
    saved.push('音声（MP3）');
  }
  note(`保存: ${saved.join('、')}`);

  $('progress-text').textContent =
    `完了（${formatDuration(playlist.duration)}・形式: ${playlist.map ? 'fMP4' : 'MPEG-TS'}・v${chrome.runtime.getManifest().version}）`;
  showMessage('保存を開始しました。保存が終わるまで、このタブは閉じないでください。', 'success');
  showDiagnostics();
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
    note(`マスター: ${playlist.variants.map((v) => `${v.resolution || '?'} ${Math.round(v.bandwidth / 1000)}kbps [${v.codecs || '?'}]${v.audioGroup ? ' audio=' + v.audioGroup : ''}`).join(' / ')}`);
    note(`別音声トラック: ${playlist.audio.length} 個`);
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

  try {
    $('save-mp3').checked = localStorage.getItem('save-mp3') === '1';
  } catch {}

  $('convert-row').hidden = !needsConvertOption;
  $('options').hidden = false;
  $('start').addEventListener('click', () => {
    try {
      localStorage.setItem('concurrency', speedSelect.value);
    } catch {}
    const outputs = { video: $('save-video').checked, mp3: $('save-mp3').checked };
    if (!outputs.video && !outputs.mp3) {
      showMessage('「動画」か「音声（MP3）」の少なくとも一方を選んでください。', 'error');
      return;
    }
    try {
      localStorage.setItem('save-mp3', outputs.mp3 ? '1' : '');
    } catch {}
    run(getMediaUrl(), $('convert').checked, Number(speedSelect.value), outputs).catch(fail);
  });
}

function fail(e) {
  console.error(e);
  note(`エラー: ${e.message || e}`);
  showDiagnostics();
  $('progress').hidden = true;
  showMessage(e.message || String(e), 'error');
  removeRefererRule();
}

$('diag-copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('diag-text').value);
  $('diag-copy').textContent = 'コピーしました';
});

window.addEventListener('beforeunload', () => {
  removeRefererRule();
  for (const url of blobUrls) URL.revokeObjectURL(url);
});

init().catch(fail);
