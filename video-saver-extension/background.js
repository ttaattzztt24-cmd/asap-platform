// タブごとに、そのページで通信された動画（HLS プレイリスト / MP4 などの動画ファイル）を記録する。
// MV3 の Service Worker は停止することがあるため、状態は chrome.storage.session に保存する。

const HLS_CONTENT_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);
const VIDEO_CONTENT_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

function getHeader(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function classify(details) {
  let path;
  try {
    path = new URL(details.url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const ct = getHeader(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();

  if (path.endsWith('.m3u8') || HLS_CONTENT_TYPES.has(ct)) return 'hls';

  // HLS / DASH のセグメント（.ts, .m4s）は単体では意味がないので除外する。
  if (path.endsWith('.ts') || path.endsWith('.m4s') || ct === 'video/mp2t') return null;

  // MSE プレーヤーが XHR で取得する断片も除外し、<video> が直接読み込むファイルだけを対象にする。
  if (details.type === 'xmlhttprequest') return null;
  if (/\.(mp4|webm|mov|m4v)$/.test(path) || VIDEO_CONTENT_TYPES.has(ct)) return 'video';
  return null;
}

function contentSize(headers) {
  const range = getHeader(headers, 'content-range'); // 例: bytes 0-1023/123456
  const m = range.match(/\/(\d+)$/);
  if (m) return Number(m[1]);
  const len = Number(getHeader(headers, 'content-length'));
  return Number.isFinite(len) && len > 0 ? len : null;
}

const key = (tabId) => `tab:${tabId}`;

// 同じタブへの書き込みが並行して起きても取りこぼさないよう、直列化する。
let queue = Promise.resolve();
function serialize(fn) {
  queue = queue.then(fn).catch((e) => console.error(e));
  return queue;
}

async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#d93025' });
  } catch {
    // タブが既に閉じられている場合など
  }
}

// URL から「フォルダ部分」（クエリなし）を取り出す。HLS のセグメントはプレイリストと同じフォルダ配下にある。
function dirOf(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  } catch {
    return null;
  }
}

function isSegment(details) {
  let path;
  try {
    path = new URL(details.url).pathname.toLowerCase();
  } catch {
    return false;
  }
  const ct = getHeader(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  return /\.(ts|m4s|aac)$/.test(path) || ct === 'video/mp2t';
}

// 再生中の動画を見分けるため、セグメントの通信があった HLS に最終再生時刻を記録する。
// ストレージへの書き込みは同じタブ・同じフォルダにつき 3 秒に 1 回まで。
const lastMarked = new Map();
function markActivity(details) {
  const dir = dirOf(details.url);
  if (!dir) return;
  const memo = `${details.tabId}|${dir}`;
  const now = Date.now();
  if (now - (lastMarked.get(memo) || 0) < 3000) return;
  lastMarked.set(memo, now);

  serialize(async () => {
    const k = key(details.tabId);
    const state = (await chrome.storage.session.get(k))[k];
    if (!state) return;
    let changed = false;
    for (const it of state.items) {
      if (it.kind !== 'hls') continue;
      const itDir = dirOf(it.url);
      if (itDir && dir.startsWith(itDir)) {
        it.lastActiveAt = now;
        changed = true;
      }
    }
    if (changed) await chrome.storage.session.set({ [k]: state });
  });
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.statusCode >= 400) return;
    if (isSegment(details)) {
      markActivity(details);
      return;
    }
    const kind = classify(details);
    if (!kind) return;

    serialize(async () => {
      const k = key(details.tabId);
      const state = (await chrome.storage.session.get(k))[k] || { items: [] };
      if (state.items.some((it) => it.url === details.url)) return;

      let tab = null;
      try {
        tab = await chrome.tabs.get(details.tabId);
      } catch {
        return;
      }
      state.pageUrl = tab.url;
      state.pageTitle = tab.title;
      state.items.push({
        url: details.url,
        kind,
        size: contentSize(details.responseHeaders),
        frameUrl: details.initiator || tab.url,
        detectedAt: Date.now(),
      });
      await chrome.storage.session.set({ [k]: state });
      await updateBadge(details.tabId, state.items.length);
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

// ページを移動したら、そのタブの検出結果をリセットする。
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  serialize(async () => {
    await chrome.storage.session.remove(key(details.tabId));
    await updateBadge(details.tabId, 0);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => chrome.storage.session.remove(key(tabId)));
});
