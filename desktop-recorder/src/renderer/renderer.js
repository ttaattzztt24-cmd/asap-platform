const api = window.recorderApi;
const $ = (id) => document.getElementById(id);

const CHUNK_MS = 5000;
// Opus at 128 kbps keeps speech and system audio clear (about 58 MB per hour).
const AUDIO_BITS_PER_SECOND = 128000;
// Follow the meeting app's mic this often while recording (auto mode).
const MIC_FOLLOW_MS = 5000;
// Echo cancellation only removes sound this app itself plays, so here it just
// degrades the voice. Keep light noise suppression and gain control.
const MIC_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
  sampleRate: 48000,
};
const APP_LABELS = { zoom: 'Zoom', meet: 'Google Meet' };

// { recorder, streams, audioCtx, dest, analyser, mic, micTimer, startedAt, writeChain, meterRaf, timerId }
let session = null;
let starting = false;

// ---------- Microphone ----------

async function listMics() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(
    (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
  );
}

// Decides which mic to record from. Returns { deviceId (null = OS default), note }.
async function chooseMic(settings, trigger, currentLabel = null) {
  const mics = await listMics();
  if (settings.micMode === 'device') {
    const m =
      mics.find((d) => d.deviceId === settings.micDeviceId) ||
      mics.find((d) => settings.micLabel && d.label === settings.micLabel);
    if (m) return { deviceId: m.deviceId, note: '設定で選んだマイク' };
    showError(`設定したマイク「${settings.micLabel}」が見つからないため、Macの設定のマイクで録音します。`);
  } else if (settings.micMode === 'auto') {
    const pick = await api.findMeetingMic({ trigger, currentLabel, labels: mics.map((d) => d.label) });
    const m = pick && mics.find((d) => d.label === pick.label);
    if (m) return { deviceId: m.deviceId, note: `${APP_LABELS[trigger] || '会議アプリ'}と同じマイク`, how: pick.how };
  }
  return { deviceId: null, note: 'Macの設定のマイク' };
}

// Opens a mic and mixes it into the recording, replacing the previous one.
async function attachMic(s, choice) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(choice.deviceId ? { deviceId: { exact: choice.deviceId } } : {}), ...MIC_CONSTRAINTS },
  });
  const track = stream.getAudioTracks()[0];
  const src = s.audioCtx.createMediaStreamSource(stream);
  src.connect(s.dest);
  src.connect(s.analyser);
  const old = s.mic;
  s.mic = { stream, src, label: track?.label || '不明', deviceId: track?.getSettings().deviceId || null };
  if (old) {
    old.src.disconnect();
    old.stream.getTracks().forEach((t) => t.stop());
  }
  $('micInUse').textContent = `録音中のマイク: ${s.mic.label}（${choice.note}）`;
  api.log(`mic: ${s.mic.label} (${choice.note}${choice.how ? `, ${choice.how}` : ''})`);
}

// In auto mode, switch mics when the meeting app switches.
function followMeetingMic(s, settings, trigger) {
  let busy = false;
  s.micTimer = setInterval(async () => {
    if (busy || session !== s) return;
    busy = true;
    try {
      const choice = await chooseMic(settings, trigger, s.mic?.label);
      if (choice.deviceId && choice.deviceId !== s.mic?.deviceId && session === s) await attachMic(s, choice);
    } catch (err) {
      api.log(`mic follow failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }, MIC_FOLLOW_MS);
}

// ---------- Recording ----------

async function captureSystemAudio() {
  // System audio (the other participants) via loopback; the video track is unused.
  // If it fails (e.g. macOS permission not granted), keep going with the mic only.
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    if (display.getAudioTracks().length === 0) {
      showError('PCの音声（相手の声）を取得できませんでした。「画面収録とシステムオーディオ録音」の許可を確認してください。');
    }
    return display;
  } catch (err) {
    showError(`PCの音声（相手の声）を取得できませんでした。「画面収録とシステムオーディオ録音」の許可を確認してください: ${err.message}`);
    return null;
  }
}

async function startRecording(trigger) {
  if (session || starting) return;
  starting = true;
  hideError();
  api.log(`start requested (${trigger})`);
  let s = null;
  try {
    const settings = await api.getSettings();

    // Mix system audio and mic into a single track.
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    s = { audioCtx, dest, analyser, streams: [], mic: null, writeChain: Promise.resolve() };

    const display = await captureSystemAudio();
    if (display) {
      s.streams.push(display);
      if (display.getAudioTracks().length) {
        const src = audioCtx.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
        src.connect(dest);
        src.connect(analyser);
      }
    }
    if (settings.includeMic) {
      try {
        await attachMic(s, await chooseMic(settings, trigger));
      } catch (err) {
        showError(`マイクを取得できませんでした。「マイク」の許可を確認してください: ${err.message}`);
      }
    }
    if (!display?.getAudioTracks().length && !s.mic) throw new Error('録音できる音声が見つかりませんでした');

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    s.recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });

    await api.beginRecording(trigger);
    s.startedAt = Date.now();
    // Chunks are written in order; each write waits for the previous one.
    s.recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      s.writeChain = s.writeChain
        .then(() => e.data.arrayBuffer())
        .then((buf) => api.writeChunk(buf))
        .catch((err) => showError(`書き込みエラー: ${err.message}`));
    };
    s.recorder.start(CHUNK_MS);
    session = s;
    if (settings.includeMic && settings.micMode === 'auto') followMeetingMic(s, settings, trigger);
    startUiLoop();
  } catch (err) {
    showError(`録音を開始できませんでした: ${err.message}`);
    if (s && session !== s) releaseCapture(s);
  } finally {
    starting = false;
    renderState();
  }
}

function releaseCapture(s) {
  clearInterval(s.micTimer);
  s.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
  s.mic?.stream.getTracks().forEach((t) => t.stop());
  s.audioCtx.close().catch(() => {});
}

async function stopRecording() {
  if (!session) return;
  const s = session;
  clearInterval(s.micTimer);
  await new Promise((resolve) => {
    s.recorder.onstop = resolve;
    s.recorder.stop();
  });
  await s.writeChain;
  releaseCapture(s);
  cancelAnimationFrame(s.meterRaf);
  clearInterval(s.timerId);
  session = null;
  await api.endRecording();
  renderState();
  refreshRecordings();
}

// ---------- UI ----------

function fmtDuration(sec) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

function fmtSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function startUiLoop() {
  const s = session;
  const data = new Uint8Array(s.analyser.fftSize);
  const meter = () => {
    s.analyser.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    $('meterBar').style.width = `${Math.min(100, (peak / 128) * 160)}%`;
    s.meterRaf = requestAnimationFrame(meter);
  };
  meter();
  s.timerId = setInterval(() => {
    $('timer').textContent = fmtDuration(Math.floor((Date.now() - s.startedAt) / 1000));
  }, 500);
}

function renderState() {
  const on = Boolean(session);
  $('recState').textContent = on ? '● 録音中' : '待機中';
  $('recState').classList.toggle('on', on);
  $('recBtn').textContent = on ? '録音を停止' : '録音を開始';
  $('recBtn').classList.toggle('stop', on);
  if (!on) {
    $('micInUse').textContent = '';
    $('timer').textContent = '00:00:00';
    $('meterBar').style.width = '0';
  }
}

function renderMeeting(app) {
  $('meetingBadge').textContent = app ? `会議中: ${APP_LABELS[app]}` : '会議: 未検出';
  $('meetingBadge').classList.toggle('live', Boolean(app));
}

function showError(msg) {
  // Several warnings can occur during one start; show them all.
  $('error').textContent = $('error').hidden ? msg : `${$('error').textContent}\n${msg}`;
  $('error').hidden = false;
  api.log(`error: ${msg}`);
}

function hideError() {
  $('error').hidden = true;
}

async function refreshRecordings() {
  const list = await api.listRecordings();
  const ul = $('recordings');
  ul.replaceChildren();
  if (list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'まだ録音はありません';
    ul.append(li);
    return;
  }
  for (const r of list) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'rec-meta';
    const title = document.createElement('strong');
    title.textContent = new Date(r.startedAt).toLocaleString('ja-JP');
    const sub = document.createElement('span');
    sub.className = 'sub';
    const dur = r.recording ? '録音中' : r.durationSec != null ? fmtDuration(r.durationSec) : '—';
    const via = APP_LABELS[r.trigger] ? `${APP_LABELS[r.trigger]}自動` : r.trigger === 'manual' ? '手動' : '';
    sub.textContent = [dur, fmtSize(r.size), via].filter(Boolean).join(' · ');
    meta.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'rec-actions';
    if (!r.recording) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = r.fileUrl;
      actions.append(audio);
    }
    if (!r.recording) {
      const mp3 = document.createElement('button');
      mp3.textContent = 'MP3でダウンロード';
      mp3.onclick = () => downloadMp3(r, mp3);
      actions.append(mp3);
    }
    const reveal = document.createElement('button');
    reveal.textContent = '場所を表示';
    reveal.onclick = () => api.reveal(r.filePath);
    actions.append(reveal);
    if (!r.recording) {
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '削除';
      del.onclick = async () => {
        if (confirm('この録音を削除しますか？')) {
          await api.deleteRecording(r.filePath);
          refreshRecordings();
        }
      };
      actions.append(del);
    }

    li.append(meta, actions);
    ul.append(li);
  }
}

// Converts one recording to MP3 in the Downloads folder, showing progress on the button.
async function downloadMp3(r, button) {
  if (button.disabled) return;
  button.disabled = true;
  const label = button.textContent;
  let job = null;
  try {
    job = await api.exportBegin(r.filePath);
    button.textContent = 'MP3に変換中… 0%';
    await window.exportToMp3(
      {
        size: job.size,
        read: async (offset, length) => new Uint8Array(await api.exportRead(r.filePath, offset, length)),
        write: (bytes) => api.exportWrite(job.id, bytes),
      },
      { onProgress: (v) => (button.textContent = `MP3に変換中… ${Math.floor(v * 100)}%`) }
    );
    await api.exportEnd(job.id, true);
    button.textContent = '保存しました ✓';
    setTimeout(() => {
      button.textContent = label;
      button.disabled = false;
    }, 4000);
  } catch (err) {
    if (job) await api.exportEnd(job.id, false);
    showError(`MP3に変換できませんでした: ${err.message}`);
    button.textContent = label;
    button.disabled = false;
  }
}

// Fills the mic picker. Device names are only visible after mic permission was
// granted once, so ask briefly if they come back blank.
async function refreshMicList() {
  let mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  if (mics.length && mics.every((d) => !d.label)) {
    try {
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach((t) => t.stop());
      mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {}
  }
  const { micMode, micDeviceId, micLabel } = await api.getSettings();
  const select = $('micSelect');
  select.replaceChildren(
    new Option('Zoom / Meet と同じマイクを自動で使う（おすすめ）', 'auto'),
    new Option('Macの設定と同じマイク', 'default')
  );
  for (const m of mics) {
    if (m.deviceId === 'default' || m.deviceId === 'communications') continue;
    select.append(new Option(m.label || 'マイク', `device:${m.deviceId}`));
  }
  if (micMode !== 'device') {
    select.value = micMode === 'default' ? 'default' : 'auto';
    return;
  }
  const chosen = mics.find((d) => d.deviceId === micDeviceId) || mics.find((d) => micLabel && d.label === micLabel);
  if (chosen) {
    select.value = `device:${chosen.deviceId}`;
  } else {
    // Saved mic is unplugged right now: keep showing it so the choice is not lost.
    select.append(new Option(`${micLabel || 'マイク'}（未接続）`, `device:${micDeviceId}`));
    select.value = `device:${micDeviceId}`;
  }
}

async function renderSettings(settings) {
  $('autoRecord').checked = settings.autoRecord;
  $('includeMic').checked = settings.includeMic;
  $('micSelect').disabled = !settings.includeMic;
  $('openAtLogin').checked = settings.openAtLogin;
  $('saveDir').textContent = settings.saveDir;
}

// ---------- Wiring ----------

$('recBtn').onclick = () => (session ? stopRecording() : startRecording('manual'));
$('openFolder').onclick = () => api.openFolder();
$('micSelect').onchange = async (e) => {
  const value = e.target.value;
  const patch = value.startsWith('device:')
    ? {
        micMode: 'device',
        micDeviceId: value.slice('device:'.length),
        micLabel: e.target.selectedOptions[0].textContent.replace(/（未接続）$/, ''),
      }
    : { micMode: value };
  renderSettings(await api.setSettings(patch));
};
navigator.mediaDevices.addEventListener('devicechange', refreshMicList);
$('openLog').onclick = () => api.openLog();
$('chooseFolder').onclick = async () => {
  renderSettings(await api.chooseFolder());
  refreshRecordings();
};
for (const key of ['autoRecord', 'includeMic', 'openAtLogin']) {
  $(key).onchange = async (e) => renderSettings(await api.setSettings({ [key]: e.target.checked }));
}

api.onControlStart(({ trigger }) => startRecording(trigger));
api.onControlStop(() => stopRecording());
api.onMeetingStatus(({ app }) => renderMeeting(app));
api.onBrowserProblem(({ browser, kind }) => {
  const box = $('browserProblem');
  if (kind === 'not-authorized') {
    box.textContent =
      `Google Meetを検知するには「${browser}」の許可が必要です。` +
      `システム設定 →「プライバシーとセキュリティ」→「オートメーション」で、` +
      `ASAP Meeting Recorder の下の「${browser}」をオンにしてから、アプリを開き直してください。`;
  } else if (kind === 'js-disabled') {
    const where =
      browser === 'Safari'
        ? 'Safariのメニュー「開発」→「Apple EventsからのJavaScriptを許可」'
        : `${browser}のメニュー「表示」→「開発 / 管理」→「Apple Events からの JavaScript を許可」`;
    box.textContent =
      `Google Meetの会議を退出したらすぐに録音を止めるには、${where}をオンにしてください。` +
      `（オフのままだと、Meetのタブを閉じるまで録音が続きます）`;
  } else if (kind) {
    box.textContent = `「${browser}」のタブを確認できませんでした。「ログを開く」の内容を確認してください。`;
  }
  box.hidden = !kind;
});

(async () => {
  renderSettings(await api.getSettings());
  refreshMicList();
  renderMeeting((await api.getMeetingStatus()).app);
  renderState();
  refreshRecordings();
})();
