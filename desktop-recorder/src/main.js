const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  dialog,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { MeetingDetector } = require('./meeting-detector');

// macOS: allow system-audio loopback capture through ScreenCaptureKit (macOS 13+).
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  );
}

const DEFAULT_SETTINGS = {
  autoRecord: true,
  includeMic: true,
  openAtLogin: false,
  saveDir: path.join(app.getPath('documents'), 'ASAP Recordings'),
};

let settings = { ...DEFAULT_SETTINGS };
let mainWindow = null;
let tray = null;
let isQuitting = false;
let current = null; // { stream, filePath, meta }
const detector = new MeetingDetector();
const APP_LABELS = { zoom: 'Zoom', meet: 'Google Meet' };

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const logPath = () => path.join(app.getPath('userData'), 'recorder.log');

// Plain-text log so failures (permissions, detection) can be diagnosed later.
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    fs.appendFileSync(logPath(), line);
  } catch {}
}

function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  fs.mkdirSync(settings.saveDir, { recursive: true });
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: true });
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function timestampName(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}_${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

function updateTray() {
  if (!tray) return;
  const recording = Boolean(current);
  tray.setToolTip(recording ? 'ASAP Recorder — 録音中' : 'ASAP Recorder — 待機中');
  if (process.platform === 'darwin') tray.setTitle(recording ? '● REC' : '');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: recording ? '● 録音中' : '待機中', enabled: false },
      { type: 'separator' },
      recording
        ? { label: '録音を停止', click: () => send('control:stop') }
        : { label: '録音を開始', click: () => send('control:start', { trigger: 'manual' }) },
      { label: 'ウィンドウを表示', click: showWindow },
      { label: '保存フォルダを開く', click: () => shell.openPath(settings.saveDir) },
      { type: 'separator' },
      { label: '終了', click: () => { isQuitting = true; app.quit(); } },
    ])
  );
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 640,
    minHeight: 480,
    title: 'ASAP Meeting Recorder',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Recording must keep running while the window is hidden in the tray.
      backgroundThrottling: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Closing the window keeps the app alive in the tray so auto-recording still works.
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // 16x16 red dot so the tray icon works without bundling image assets.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAWklEQVR4nGO4o6bGQAmmSDMhA3zuqKlVQbEPKQaAFN+8o6b2Hw3fxGYQNs3oGtGxDz4DsNmMzSVYDSDGdgxXIBtQRYIBVTQxgGIvUByIVIlGihMSVZIyfXMjADZZhxhxnB1QAAAAAElFTkSuQmCC'
  );
  tray = new Tray(icon);
  tray.on('click', showWindow);
  updateTray();
}

// Answer getDisplayMedia() from the renderer with the primary screen plus
// system-audio loopback, without showing a picker. Only the audio is recorded.
function setupDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

function listRecordings() {
  if (!fs.existsSync(settings.saveDir)) return [];
  return fs
    .readdirSync(settings.saveDir)
    .filter((f) => f.endsWith('.webm'))
    .map((f) => {
      const filePath = path.join(settings.saveDir, f);
      const metaPath = filePath.replace(/\.webm$/, '.json');
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch {}
      const stat = fs.statSync(filePath);
      return {
        name: f,
        filePath,
        fileUrl: `file://${filePath.replace(/\\/g, '/')}`,
        size: stat.size,
        startedAt: meta.startedAt || stat.birthtime.toISOString(),
        endedAt: meta.endedAt || null,
        durationSec: meta.durationSec ?? null,
        trigger: meta.trigger || 'unknown',
        recording: current?.filePath === filePath,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);
  ipcMain.handle('settings:set', (_e, patch) => {
    settings = { ...settings, ...patch };
    fs.mkdirSync(settings.saveDir, { recursive: true });
    saveSettings();
    return settings;
  });
  ipcMain.handle('settings:choose-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.saveDir,
    });
    if (res.canceled || !res.filePaths[0]) return settings;
    settings.saveDir = res.filePaths[0];
    saveSettings();
    return settings;
  });

  ipcMain.handle('meeting:status', () => ({ app: detector.app }));
  ipcMain.handle('log:write', (_e, message) => log('[renderer]', message));
  ipcMain.handle('log:open', () => shell.openPath(logPath()));

  // Recording is streamed to disk chunk by chunk, so there is no length limit
  // and a crash loses at most the last few seconds.
  ipcMain.handle('rec:begin', (_e, { trigger }) => {
    if (current) return { filePath: current.filePath };
    const startedAt = new Date();
    const filePath = path.join(settings.saveDir, `${timestampName(startedAt)}.webm`);
    current = {
      filePath,
      stream: fs.createWriteStream(filePath),
      meta: { startedAt: startedAt.toISOString(), trigger },
    };
    fs.writeFileSync(filePath.replace(/\.webm$/, '.json'), JSON.stringify(current.meta, null, 2));
    updateTray();
    log('recording started', trigger, filePath);
    notify('録音を開始しました', APP_LABELS[trigger] ? `${APP_LABELS[trigger]}の会議を検知しました` : '手動で開始しました');
    return { filePath };
  });

  ipcMain.handle('rec:chunk', (_e, data) => {
    if (!current) return false;
    return new Promise((resolve) => current.stream.write(Buffer.from(data), () => resolve(true)));
  });

  ipcMain.handle('rec:end', () => {
    if (!current) return null;
    const rec = current;
    current = null;
    const endedAt = new Date();
    rec.meta.endedAt = endedAt.toISOString();
    rec.meta.durationSec = Math.round((endedAt - new Date(rec.meta.startedAt)) / 1000);
    return new Promise((resolve) => {
      rec.stream.end(() => {
        log('recording saved', rec.filePath, `${rec.meta.durationSec}s`);
        fs.writeFileSync(rec.filePath.replace(/\.webm$/, '.json'), JSON.stringify(rec.meta, null, 2));
        updateTray();
        const min = Math.floor(rec.meta.durationSec / 60);
        notify('録音を保存しました', `${path.basename(rec.filePath)}（${min}分）`);
        resolve(rec.filePath);
      });
    });
  });

  ipcMain.handle('recordings:list', () => listRecordings());
  ipcMain.handle('recordings:open-folder', () => shell.openPath(settings.saveDir));
  ipcMain.handle('recordings:reveal', (_e, filePath) => shell.showItemInFolder(filePath));
  ipcMain.handle('recordings:delete', (_e, filePath) => {
    if (current?.filePath === filePath) return false;
    if (path.dirname(filePath) !== path.resolve(settings.saveDir)) return false;
    fs.rmSync(filePath, { force: true });
    fs.rmSync(filePath.replace(/\.webm$/, '.json'), { force: true });
    return true;
  });
}

app.whenReady().then(() => {
  loadSettings();
  registerIpc();
  setupDisplayMediaHandler();
  createWindow();
  createTray();

  log('app started', process.platform, process.getSystemVersion(), 'saveDir=' + settings.saveDir);
  detector.on('meeting-start', (meetingApp, reason) => {
    log('meeting detected', meetingApp, reason);
    send('meeting:status', { app: meetingApp });
    if (settings.autoRecord) send('control:start', { trigger: meetingApp });
  });
  detector.on('browsers', (list) => log('running browsers', list));
  detector.on('browser-problem', (browser, kind, detail) => {
    log('browser check', browser, kind || 'ok', detail || '');
    send('meeting:browser-problem', { browser, kind });
  });
  detector.on('meeting-end', (meetingApp, reason) => {
    log('meeting ended', meetingApp, reason);
    send('meeting:status', { app: null });
    // Only auto-stop recordings that were auto-started; manual ones stay under user control.
    if (APP_LABELS[current?.meta.trigger]) send('control:stop');
  });
  // Wait for the renderer to be ready before reporting the first detection.
  mainWindow.webContents.once('did-finish-load', () => detector.start());

  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  isQuitting = true;
  detector.stop();
  if (current) {
    current.stream.end();
    current = null;
  }
});

app.on('window-all-closed', () => {
  // Stay resident in the tray.
});
