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
const { pathToFileURL } = require('url');
const { MeetingDetector } = require('./meeting-detector');
const { fixWebmDuration } = require('./webm-duration');
const { readAudioState, pickMeetingMic, labelMatches } = require('./mic-match');
const { parseMeetingLink, findRegisteredMeeting } = require('./meeting-links');

// macOS: allow system-audio loopback capture through ScreenCaptureKit (macOS 13+).
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch(
    'enable-features',
    'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride'
  );
}

const DEFAULT_SETTINGS = {
  autoRecord: true,
  // 'all' = every Zoom / Meet meeting, 'listed' = only meetings in `meetings`.
  recordMode: 'all',
  meetings: [], // [{ kind: 'zoom' | 'meet', id, name, link }]
  includeMic: true,
  // 'auto' = the mic the meeting app is using, 'default' = OS default input,
  // 'device' = micDeviceId. The label is kept because macOS can reissue
  // device IDs, and we fall back to matching by name.
  micMode: 'auto',
  micDeviceId: '',
  micLabel: '',
  openAtLogin: false,
  saveDir: path.join(app.getPath('documents'), 'Kiku Recordings'),
};

let settings = { ...DEFAULT_SETTINGS };
let mainWindow = null;
let tray = null;
let isQuitting = false;
let current = null; // { stream, filePath, meta }
const detector = new MeetingDetector();
let unregisteredPrompt = null; // kept referenced so its click handler survives GC
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

// The app used to be called "ASAP Meeting Recorder"; carry its settings and log
// over once so the recordings folder and choices survive the rename.
function migrateFromOldName() {
  const oldDir = path.join(app.getPath('appData'), 'ASAP Meeting Recorder');
  for (const file of ['settings.json', 'recorder.log']) {
    const from = path.join(oldDir, file);
    const to = path.join(app.getPath('userData'), file);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function loadSettings() {
  migrateFromOldName();
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    // Before micMode existed, a non-empty micDeviceId meant a manually chosen mic.
    if (!('micMode' in saved)) saved.micMode = saved.micDeviceId ? 'device' : 'auto';
    settings = { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }
  fs.mkdirSync(settings.saveDir, { recursive: true });
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, openAsHidden: true });
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
  tray.setToolTip(recording ? 'Kiku — 録音中' : 'Kiku — 待機中');
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
    title: 'Kiku',
    icon: path.join(__dirname, 'assets', 'icon-256.png'),
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
  // macOS: "...Template.png" is drawn in the menu bar's own color (light/dark).
  const icon =
    process.platform === 'darwin'
      ? nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'))
      : nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon-256.png')).resize({ width: 16, height: 16 });
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
        fileUrl: pathToFileURL(filePath).href, // correct on Windows (file:///C:/...) too
        size: stat.size,
        startedAt: meta.startedAt || stat.birthtime.toISOString(),
        endedAt: meta.endedAt || null,
        durationSec: meta.durationSec ?? null,
        trigger: meta.trigger || 'unknown',
        title: meta.title || null,
        recording: current?.filePath === filePath,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// Only files directly inside the recordings folder may be read for export.
function assertRecording(filePath) {
  if (!filePath.endsWith('.webm') || path.dirname(path.resolve(filePath)) !== path.resolve(settings.saveDir)) {
    throw new Error('録音フォルダの外のファイルは扱えません');
  }
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}${ext}`);
  for (let i = 2; fs.existsSync(p) || fs.existsSync(`${p}.part`); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

// MP3 exports in progress: id -> { stream, tmpPath, outPath }.
const mp3Exports = new Map();
let mp3ExportSeq = 0;

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
  // Maps the meeting app's current mic onto one of the renderer's device labels.
  ipcMain.handle('mic:meeting', async (_e, { trigger, currentLabel, labels }) => {
    const state = await readAudioState();
    if (!state) return null;
    const current = currentLabel && state.devices.find((d) => labelMatches(currentLabel, d.name));
    const pick = pickMeetingMic(state, { trigger, currentName: current?.name || null });
    const label = pick && labels.find((l) => labelMatches(l, pick.name));
    return label ? { label, how: pick.how } : null;
  });
  // Registered meetings ("record only these").
  const saveMeetings = (meetings) => {
    settings = { ...settings, meetings };
    saveSettings();
    return settings;
  };
  ipcMain.handle('meetings:add', (_e, { name, link }) => {
    const parsed = parseMeetingLink(link);
    if (!parsed) return { error: 'Zoom または Google Meet のリンク（または会議ID）を貼り付けてください' };
    if (settings.meetings.some((m) => m.kind === parsed.kind && m.id === parsed.id)) {
      return { error: 'この会議はすでに登録されています' };
    }
    const fallback = parsed.kind === 'zoom' ? `Zoom ${parsed.id}` : `Meet ${parsed.id}`;
    const entry = { ...parsed, name: String(name || '').trim() || fallback, link: String(link).trim() };
    log('meeting registered', entry.kind, entry.id);
    return { settings: saveMeetings([...settings.meetings, entry]) };
  });
  ipcMain.handle('meetings:add-current', (_e, { name }) => {
    const app_ = detector.app;
    const id = app_ === 'meet' ? detector.info.meetCodes[0] : app_ === 'zoom' ? detector.info.zoomIds[0] : null;
    if (!id) {
      return {
        error:
          app_ === 'zoom'
            ? '今のZoom会議のIDがわかりませんでした。Zoomのリンクを貼り付けて登録してください'
            : '会議中ではありません',
      };
    }
    if (settings.meetings.some((m) => m.kind === app_ && m.id === id)) return { error: 'この会議はすでに登録されています' };
    const entry = { kind: app_, id, name: String(name || '').trim() || (app_ === 'zoom' ? `Zoom ${id}` : `Meet ${id}`), link: '' };
    log('meeting registered (current)', entry.kind, entry.id);
    return { settings: saveMeetings([...settings.meetings, entry]) };
  });
  ipcMain.handle('meetings:remove', (_e, { kind, id }) =>
    saveMeetings(settings.meetings.filter((m) => !(m.kind === kind && m.id === id)))
  );
  ipcMain.handle('log:write', (_e, message) => log('[renderer]', message));
  ipcMain.handle('log:open', () => shell.openPath(logPath()));

  // Recording is streamed to disk chunk by chunk, so there is no length limit
  // and a crash loses at most the last few seconds.
  ipcMain.handle('rec:begin', (_e, { trigger, title }) => {
    if (current) return { filePath: current.filePath };
    const startedAt = new Date();
    const safeTitle = title ? `_${String(title).replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60)}` : '';
    const filePath = path.join(settings.saveDir, `${timestampName(startedAt)}${safeTitle}.webm`);
    current = {
      filePath,
      stream: fs.createWriteStream(filePath),
      meta: { startedAt: startedAt.toISOString(), trigger, ...(title ? { title } : {}) },
    };
    fs.writeFileSync(filePath.replace(/\.webm$/, '.json'), JSON.stringify(current.meta, null, 2));
    updateTray();
    log('recording started', trigger, filePath);
    notify(
      '録音を開始しました',
      title ? `「${title}」を録音しています` : APP_LABELS[trigger] ? `${APP_LABELS[trigger]}の会議を検知しました` : '手動で開始しました'
    );
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
    const durationMs = endedAt - new Date(rec.meta.startedAt);
    rec.meta.durationSec = Math.round(durationMs / 1000);
    return new Promise((resolve) => {
      rec.stream.end(async () => {
        // Write the total length into the file so players can show it and seek.
        try {
          await fixWebmDuration(rec.filePath, durationMs);
          rec.meta.durationFixed = true;
        } catch (err) {
          log('duration fix failed', rec.filePath, err.message);
        }
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

  // MP3 export: the renderer converts; main reads the recording in pieces and
  // writes the MP3 to Downloads (as .part until finished).
  ipcMain.handle('export:begin', (_e, filePath) => {
    assertRecording(filePath);
    const outPath = uniquePath(app.getPath('downloads'), path.basename(filePath, '.webm'), '.mp3');
    const tmpPath = `${outPath}.part`;
    const id = ++mp3ExportSeq;
    mp3Exports.set(id, { stream: fs.createWriteStream(tmpPath), tmpPath, outPath });
    log('mp3 export started', filePath, '->', outPath);
    return { id, outPath, size: fs.statSync(filePath).size };
  });
  ipcMain.handle('export:read', async (_e, filePath, offset, length) => {
    assertRecording(filePath);
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  });
  ipcMain.handle('export:write', (_e, id, data) => {
    const job = mp3Exports.get(id);
    if (!job) return false;
    return new Promise((resolve) => job.stream.write(Buffer.from(data), () => resolve(true)));
  });
  ipcMain.handle('export:end', (_e, id, ok) => {
    const job = mp3Exports.get(id);
    if (!job) return null;
    mp3Exports.delete(id);
    return new Promise((resolve) => {
      job.stream.end(() => {
        if (!ok) {
          fs.rmSync(job.tmpPath, { force: true });
          log('mp3 export failed', job.outPath);
          return resolve(null);
        }
        fs.renameSync(job.tmpPath, job.outPath);
        log('mp3 export saved', job.outPath);
        notify('MP3を保存しました', `ダウンロードフォルダ: ${path.basename(job.outPath)}`);
        shell.showItemInFolder(job.outPath);
        resolve(job.outPath);
      });
    });
  });
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

// Recordings made before the duration fix existed have no total length; patch them once.
async function fixOldRecordings() {
  for (const r of listRecordings()) {
    const metaPath = r.filePath.replace(/\.webm$/, '.json');
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
      continue;
    }
    if (meta.durationFixed || !meta.durationSec || r.recording) continue;
    try {
      await fixWebmDuration(r.filePath, meta.durationSec * 1000);
      meta.durationFixed = true;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      log('duration fixed for old recording', r.filePath);
    } catch (err) {
      log('duration fix failed', r.filePath, err.message);
    }
  }
}

// Windows shows notifications only for an app with an AppUserModelID matching
// the installer's shortcut (electron-builder uses the appId).
if (process.platform === 'win32') app.setAppUserModelId('ai.asap.meetingrecorder');

// One Kiku at a time: a second launch just brings the window forward
// (two copies would record every meeting twice).
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();
else app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  if (!isPrimaryInstance) return;
  loadSettings();
  await fixOldRecordings();
  registerIpc();
  setupDisplayMediaHandler();
  createWindow();
  createTray();

  log('app started', process.platform, process.getSystemVersion(), 'saveDir=' + settings.saveDir);
  detector.on('meeting-start', (meetingApp, reason, info) => {
    log('meeting detected', meetingApp, reason, JSON.stringify(info));
    send('meeting:status', { app: meetingApp });
    if (!settings.autoRecord) return;
    if (settings.recordMode !== 'listed') {
      send('control:start', { trigger: meetingApp });
      return;
    }
    const match = findRegisteredMeeting(settings.meetings, meetingApp, info);
    if (match) {
      log('registered meeting', match.kind, match.id);
      send('control:start', { trigger: meetingApp, title: match.name });
      return;
    }
    // Not on the list: stay quiet, but make it one click to record anyway.
    log('not a registered meeting; not recording');
    if (Notification.isSupported()) {
      const n = new Notification({
        title: '登録されていない会議です',
        body: `${APP_LABELS[meetingApp]}の会議を検知しましたが、録音していません。録音するにはここをクリック`,
      });
      n.on('click', () => {
        if (detector.app === meetingApp) send('control:start', { trigger: meetingApp });
      });
      unregisteredPrompt = n;
      n.show();
    }
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
