function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function fileNameFromUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return decodeURIComponent(last || url);
  } catch {
    return url;
  }
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  for (const c of children) node.append(c);
  return node;
}

function openDownloader(item, state) {
  const params = new URLSearchParams({
    url: item.url,
    referer: state.pageUrl || item.frameUrl || '',
    title: state.pageTitle || '',
  });
  chrome.tabs.create({ url: chrome.runtime.getURL(`download.html?${params}`) });
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

async function loadPlaylist(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Hls.parsePlaylist(await res.text(), url);
}

// HLS プレイリストを読んで、長さ・画質と、画質ごとの URL（一覧から隠す対象）を調べる。
async function describeHls(url) {
  try {
    const pl = await loadPlaylist(url);
    if (pl.type === 'media') return { duration: pl.duration, variantUris: [] };
    const best = pl.variants[0];
    let duration = null;
    if (best) {
      try {
        duration = (await loadPlaylist(best.uri)).duration;
      } catch {}
    }
    return {
      duration,
      variantUris: pl.variants.map((v) => v.uri),
      resolution: best ? best.resolution : '',
      qualities: pl.variants.length,
    };
  } catch {
    return null;
  }
}

// ---- ページ内の動画の位置を調べる（タブの各フレームに注入して実行する） ----
// executeScript で文字列化して送るので、この関数は外側の変数を使わないこと。
function scanPage() {
  const norm = (u) => {
    try {
      const x = new URL(u.replace(/\\\//g, '/'), document.baseURI);
      return x.origin + x.pathname;
    } catch {
      return null;
    }
  };
  const urlRe = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>()\\]*)?|[^\s"'<>()\\,]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>()\\]*)?/gi;

  // 直前にある見出し、なければ短い文章を、動画の説明として使う。
  const labelFor = (el) => {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = el;
    let fallback = '';
    for (let n, steps = 0; (n = walker.previousNode()) && steps < 3000; steps++) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) continue;
      if (/^H[1-6]$/.test(n.tagName)) {
        const t = (n.innerText || '').trim().replace(/\s+/g, ' ');
        if (t) return t.slice(0, 40);
      }
      if (!fallback) {
        const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim().replace(/\s+/g, ' ');
        if (own.length >= 4 && n.getClientRects().length) fallback = own.slice(0, 40);
      }
    }
    return fallback;
  };

  const all = [...document.querySelectorAll('*')];
  const hits = [];
  const seen = new Set();
  const add = (url, el, index) => {
    const key = norm(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    hits.push({ key, index, label: labelFor(el) });
  };

  all.forEach((el, index) => {
    if (el.tagName === 'VIDEO') {
      const src = el.currentSrc || el.src;
      if (src && !src.startsWith('blob:')) add(src, el, index);
    }
    for (const a of el.attributes) {
      if (!/\.(m3u8|mp4)/i.test(a.value)) continue;
      for (const m of a.value.replace(/\\\//g, '/').match(urlRe) || []) add(m, el, index);
    }
    if (el.tagName === 'SCRIPT' && /\.(m3u8|mp4)/i.test(el.textContent)) {
      for (const m of el.textContent.replace(/\\\//g, '/').match(urlRe) || []) add(m, el, index);
    }
  });

  const iframes = all.map((el, index) => (el.tagName === 'IFRAME' ? { index, src: el.src } : null)).filter(Boolean);
  return { url: location.href, hits, iframes };
}

// LP 上の該当する動画までスクロールして、赤い枠で数秒間示す。
function highlightOnPage(key, index) {
  const all = [...document.querySelectorAll('*')];
  const urlRe = /(?:https?:)?\/\/[^\s"'<>()\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>()\\]*)?|[^\s"'<>()\\,]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>()\\]*)?/gi;
  const norm = (u) => {
    try {
      const x = new URL(u, document.baseURI);
      return x.origin + x.pathname;
    } catch {
      return null;
    }
  };
  const refersTo = (text) => (text.replace(/\\\//g, '/').match(urlRe) || []).some((m) => norm(m) === key);
  const matches = (e) =>
    Boolean(e) &&
    ((e.tagName === 'VIDEO' && norm(e.currentSrc || e.src || '') === key) ||
      [...e.attributes].some((a) => refersTo(a.value)) ||
      (e.tagName === 'SCRIPT' && refersTo(e.textContent)));
  let el = all[index];
  if (!matches(el)) el = all.find(matches);
  if (!el) return false;
  // 表示されていない要素（<source> や <script> など）は、近くの表示されている要素を使う。
  let target = el;
  if (el.tagName === 'SCRIPT') target = el.previousElementSibling || el.parentElement;
  while (target && !target.getClientRects().length) target = target.parentElement;
  if (!target) return false;
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => {
    const r = target.getBoundingClientRect();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px`,
      border: '6px solid #d93025', borderRadius: '8px', zIndex: 2147483647, pointerEvents: 'none', boxSizing: 'border-box',
    });
    document.documentElement.append(box);
    setTimeout(() => box.remove(), 2500);
  }, 500);
  return true;
}

const keyOf = (url) => {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
};

// 各フレームを調べ、動画 URL ごとに「ページ上の位置」を返す。Map<key, { order: [..], label, frameId, index }>
async function locateOnPage(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: scanPage });
  } catch {
    return new Map();
  }
  const top = results.find((r) => r.frameId === 0)?.result;
  const located = new Map();
  for (const { frameId, result } of results) {
    if (!result) continue;
    let prefix = [];
    if (frameId !== 0) {
      // 子フレームは、親ページ上の iframe の位置で並べる（URL が一致するもの）。
      const frame = top?.iframes.find((f) => f.src && keyOf(f.src) === keyOf(result.url));
      prefix = [frame ? frame.index : Number.MAX_SAFE_INTEGER];
    }
    for (const h of result.hits) {
      const order = frameId === 0 ? [h.index, 0] : [...prefix, h.index];
      const prev = located.get(h.key);
      if (!prev || compareOrder(order, prev.order) < 0) located.set(h.key, { order, label: h.label, frameId, index: h.index });
    }
  }
  return located;
}

function compareOrder(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = `tab:${tab.id}`;
  const state = (await chrome.storage.session.get(k))[k] || { items: [] };

  document.getElementById('version').textContent = `v${chrome.runtime.getManifest().version}`;
  document.getElementById('page').textContent = tab.title || tab.url || '';
  const list = document.getElementById('list');

  if (!state.items.length) {
    document.getElementById('empty').hidden = false;
    return;
  }

  document.getElementById('loading').hidden = false;
  const [infos, located] = await Promise.all([
    Promise.all(state.items.map((it) => (it.kind === 'hls' ? describeHls(it.url) : null))),
    locateOnPage(tab.id),
  ]);
  document.getElementById('loading').hidden = true;

  // 同じ動画の「画質違い」のプレイリストは、まとめ役（マスター）があれば一覧から外す。
  const variantUrls = new Set(infos.flatMap((info) => (info ? info.variantUris : [])));
  const items = state.items
    .map((item, i) => ({ item, info: infos[i], place: located.get(keyOf(item.url)) || null, detected: i }))
    .filter(({ item }) => !(item.kind === 'hls' && variantUrls.has(item.url)));

  // LP 上の位置がわかるものは上から順に、わからないものはその後ろに検出順で並べる。
  items.sort((a, b) => {
    if (a.place && b.place) return compareOrder(a.place.order, b.place.order);
    if (a.place) return -1;
    if (b.place) return 1;
    return a.detected - b.detected;
  });

  const lastPlayed = items.reduce((best, x) => ((x.item.lastActiveAt || 0) > (best?.item.lastActiveAt || 0) ? x : best), null);
  const placedCount = items.filter((x) => x.place).length;

  const hint = document.getElementById('hint');
  hint.textContent =
    (placedCount ? 'LP の上から順に並んでいます。' : 'LP 上の位置は取得できなかったため、読み込まれた順に並んでいます。') +
    '動画を再生すると「▶ 最後に再生」の印が付きます。保存したい動画の「この動画をダウンロード」を押してください。';
  hint.hidden = false;

  items.forEach(({ item, info, place }, index) => {
    const isHls = item.kind === 'hls';
    const download = el('button', { className: 'primary', textContent: 'この動画をダウンロード' });
    download.addEventListener('click', () => {
      if (isHls) {
        openDownloader(item, state);
      } else {
        chrome.downloads.download({ url: item.url, saveAs: true });
      }
    });

    const buttons = [download];
    if (place) {
      const show = el('button', { textContent: 'ページで表示' });
      show.addEventListener('click', async () => {
        const [res] = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [place.frameId] },
          func: highlightOnPage,
          args: [keyOf(item.url), place.index],
        });
        if (!res?.result) show.textContent = '見つかりませんでした';
      });
      buttons.push(show);
    }
    const copy = el('button', { textContent: 'URLをコピー' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.url);
      copy.textContent = 'コピーしました';
    });
    buttons.push(copy);

    const details = [
      info && info.duration ? `長さ ${formatDuration(info.duration)}` : '',
      info && info.resolution ? `最高 ${info.resolution}` : '',
      info && info.qualities > 1 ? `${info.qualities} 画質` : '',
      isHls ? '' : formatSize(item.size), // HLS のサイズはプレイリスト自体の大きさなので表示しない
    ].filter(Boolean);

    const isLast = lastPlayed && lastPlayed.item === item && item.lastActiveAt;
    const title = place ? `LP の上から ${index + 1} 番目` : '位置不明';
    list.append(
      el('li', { className: isLast ? 'last-played' : '' }, [
        el('div', { className: 'row' }, [
          el('span', { className: 'num', textContent: `動画 ${index + 1}` }),
          el('span', { className: `tag ${isHls ? 'hls' : 'video'}`, textContent: isHls ? 'HLS' : 'MP4等' }),
          isLast ? el('span', { className: 'tag playing', textContent: '▶ 最後に再生' }) : '',
          el('span', { className: 'name', textContent: title, title: item.url }),
        ]),
        place && place.label ? el('div', { className: 'label', textContent: `「${place.label}」の近く` }) : '',
        el('div', { className: 'meta', textContent: details.join(' ・ ') }),
        el('div', { className: 'actions' }, buttons),
      ])
    );
  });
}

main();
