const api = window.recorderApi;
const $ = (id) => document.getElementById(id);

const CHUNK_MS = 5000;
let session = null; // { recorder, streams, audioCtx, startedAt, writeChain, meterRaf, timerId }
let starting = false;

// ---------- Recording ----------

async function captureStreams(includeMic) {
  const streams = [];
  // System audio (the other participants) via loopback; the video track is unused.
  // If it fails (e.g. macOS permission not granted), keep going with the mic only.
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    if (display.getAudioTracks().length === 0) {
      showError('PCの音声（相手の声）を取得できませんでした。「画面収録とシステムオーディオ録音」の許可を確認してください。');
    }
    streams.push(display);
  } catch (err) {
    showError(`PCの音声（相手の声）を取得できませんでした。「画面収録とシステムオーディオ録音」の許可を確認してください: ${err.message}`);
  }
  if (includeMic) {
    try {
      streams.push(
        await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        })
      );
    } catch (err) {
      showError(`マイクを取得できませんでした。「マイク」の許可を確認してください: ${err.message}`);
    }
  }
  return streams;
}

async function startRecording(trigger) {
  if (session || starting) return;
  starting = true;
  hideError();
  api.log(`start requested (${trigger})`);
  try {
    const { includeMic } = await api.getSettings();
    const streams = await captureStreams(includeMic);

    // Mix system audio and mic into a single track.
    const audioCtx = new AudioContext();
    const dest = audioCtx.createMediaStreamDestination();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    let hasAudio = false;
    for (const s of streams) {
      if (s.getAudioTracks().length === 0) continue;
      const src = audioCtx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
      src.connect(dest);
      src.connect(analyser);
      hasAudio = true;
    }
    if (!hasAudio) throw new Error('録音できる音声が見つかりませんでした');

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    const recorder = new MediaRecorder(dest.stream, { mimeType, audioBitsPerSecond: 64000 });

    await api.beginRecording(trigger);
    session = {
      recorder,
      streams,
      audioCtx,
      analyser,
      startedAt: Date.now(),
      // Chunks are written in order; each write waits for the previous one.
      writeChain: Promise.resolve(),
    };
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const s = session;
      s.writeChain = s.writeChain
        .then(() => e.data.arrayBuffer())
        .then((buf) => api.writeChunk(buf))
        .catch((err) => showError(`書き込みエラー: ${err.message}`));
    };
    recorder.start(CHUNK_MS);
    startUiLoop();
  } catch (err) {
    showError(`録音を開始できませんでした: ${err.message}`);
  } finally {
    starting = false;
    renderState();
  }
}

async function stopRecording() {
  if (!session) return;
  const s = session;
  await new Promise((resolve) => {
    s.recorder.onstop = resolve;
    s.recorder.stop();
  });
  await s.writeChain;
  s.streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
  await s.audioCtx.close();
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
    $('timer').textContent = '00:00:00';
    $('meterBar').style.width = '0';
  }
}

const APP_LABELS = { zoom: 'Zoom', meet: 'Google Meet' };

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
      audio.preload = 'none';
      audio.src = r.fileUrl;
      actions.append(audio);
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

async function renderSettings(settings) {
  $('autoRecord').checked = settings.autoRecord;
  $('includeMic').checked = settings.includeMic;
  $('openAtLogin').checked = settings.openAtLogin;
  $('saveDir').textContent = settings.saveDir;
}

// ---------- Wiring ----------

$('recBtn').onclick = () => (session ? stopRecording() : startRecording('manual'));
$('openFolder').onclick = () => api.openFolder();
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
  } else if (kind) {
    box.textContent = `「${browser}」のタブを確認できませんでした。「ログを開く」の内容を確認してください。`;
  }
  box.hidden = !kind;
});

(async () => {
  renderSettings(await api.getSettings());
  renderMeeting((await api.getMeetingStatus()).app);
  renderState();
  refreshRecordings();
})();
