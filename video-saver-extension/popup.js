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

  for (const item of state.items) {
    const isHls = item.kind === 'hls';
    const download = el('button', { className: 'primary', textContent: 'ダウンロード' });
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

    list.append(
      el('li', {}, [
        el('div', { className: 'row' }, [
          el('span', { className: `tag ${isHls ? 'hls' : 'video'}`, textContent: isHls ? 'HLS' : '動画' }),
          el('span', { className: 'name', textContent: fileNameFromUrl(item.url), title: item.url }),
        ]),
        el('div', { className: 'meta', textContent: [formatSize(item.size), new URL(item.url).host].filter(Boolean).join(' ・ ') }),
        el('div', { className: 'actions' }, [download, copy]),
      ])
    );
  }
}

main();
