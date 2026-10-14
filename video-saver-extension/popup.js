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

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const k = `tab:${tab.id}`;
  const state = (await chrome.storage.session.get(k))[k] || { items: [] };

  document.getElementById('page').textContent = tab.title || tab.url || '';
  const list = document.getElementById('list');

  if (!state.items.length) {
    document.getElementById('empty').hidden = false;
    return;
  }

  document.getElementById('loading').hidden = false;
  const infos = await Promise.all(state.items.map((it) => (it.kind === 'hls' ? describeHls(it.url) : null)));
  document.getElementById('loading').hidden = true;

  // 同じ動画の「画質違い」のプレイリストは、まとめ役（マスター）があれば一覧から外す。
  const variantUrls = new Set(infos.flatMap((info) => (info ? info.variantUris : [])));
  const items = state.items
    .map((item, i) => ({ item, info: infos[i] }))
    .filter(({ item }) => !(item.kind === 'hls' && variantUrls.has(item.url)));

  document.getElementById('hint').hidden = false;

  items.forEach(({ item, info }, index) => {
    const isHls = item.kind === 'hls';
    const download = el('button', { className: 'primary', textContent: 'この動画をダウンロード' });
    download.addEventListener('click', () => {
      if (isHls) {
        openDownloader(item, state);
      } else {
        chrome.downloads.download({ url: item.url, saveAs: true });
      }
    });

    const copy = el('button', { textContent: 'URLをコピー' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(item.url);
      copy.textContent = 'コピーしました';
    });

    const details = [
      info && info.duration ? `長さ ${formatDuration(info.duration)}` : '',
      info && info.resolution ? `最高 ${info.resolution}` : '',
      info && info.qualities > 1 ? `${info.qualities} 画質` : '',
      isHls ? "" : formatSize(item.size), // HLS のサイズはプレイリスト自体の大きさなので表示しない
      new URL(item.url).host,
    ].filter(Boolean);

    list.append(
      el('li', {}, [
        el('div', { className: 'row' }, [
          el('span', { className: 'num', textContent: `動画 ${index + 1}` }),
          el('span', { className: `tag ${isHls ? 'hls' : 'video'}`, textContent: isHls ? 'HLS' : 'MP4等' }),
          el('span', { className: 'name', textContent: fileNameFromUrl(item.url), title: item.url }),
        ]),
        el('div', { className: 'meta', textContent: details.join(' ・ ') }),
        el('div', { className: 'actions' }, [download, copy]),
      ])
    );
  });
}

main();
