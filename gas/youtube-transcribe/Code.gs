/**
 * YouTubeチャンネルの全動画をスプレッドシートに書き出し、Gladiaで文字起こしする。
 *
 * 列の使い方（1行目は見出し）
 *   A: タイトル / B: URL / F: 文字起こし
 *   G: GladiaジョブID / H: ステータス / I: 送信日時  ← 二重送信防止の管理用
 *
 * 高額請求を防ぐしくみ
 *   - Gladiaに送る「前」にH列へ「送信中」と書く。どの行も送信は生涯1回だけ。
 *   - ジョブIDをG列に保存し、結果は次回以降の実行で回収する（待ち時間切れで結果を失わない）。
 *   - 送信エラー・Gladiaエラーは自動で再送しない（H列を空にした行だけ再送される）。
 *   - LockServiceで同時実行を禁止（トリガーの重なりによる二重送信を防ぐ）。
 *   - 1回の実行・同時処理数・1日あたりの送信数に上限を設ける。
 *   - 文字起こしはセルの文字数上限に収まるよう切り詰めて必ず書き込む。
 *   - 処理する行がなくなったらトリガーを自動で削除する。
 */

const SPREADSHEET_ID = '16hUVA7q-fyUHZG0JyEEjGkbOo2be1sc2KqEKxt7Pipk';
const SHEET_GID = 0;
const CHANNEL_HANDLE = '@tonyobyo_amakana';

const COL = { TITLE: 1, URL: 2, TRANSCRIPT: 6, JOB_ID: 7, STATUS: 8, SUBMITTED_AT: 9 };
const LAST_COL = COL.SUBMITTED_AT;

const MAX_SUBMIT_PER_RUN = 1;   // 1回の実行で新しく送る本数
const MAX_IN_FLIGHT = 2;        // Gladiaで同時に処理中にしておく本数
const DAILY_SUBMIT_LIMIT = 10;  // 1日に送る本数の上限（費用の上限になる）
const STALE_HOURS = 24;         // これ以上終わらないジョブは「要確認」にする
const CELL_CHAR_LIMIT = 49000;  // スプレッドシートのセル上限（50,000文字）より少し下
const TRIGGER_MINUTES = 5;

const HANDLER = 'processTranscriptions';
const LEGACY_HANDLERS = ['transcribeAll']; // 以前のコードのトリガーも一緒に止める

const STATUS = {
  SENDING: '送信中',
  PENDING: '処理中',
  DONE: '完了',
};

/** 1. チャンネルの全動画をA列・B列に追加する（既にあるURLは追加しない）。何度実行しても重複しない。 */
function importVideos() {
  const sheet = getSheet_();
  ensureHeader_(sheet);

  const ch = YouTube.Channels.list('contentDetails', { forHandle: CHANNEL_HANDLE });
  if (!ch.items || !ch.items.length) throw new Error('チャンネルが見つかりません: ' + CHANNEL_HANDLE);
  const uploads = ch.items[0].contentDetails.relatedPlaylists.uploads;

  const existing = new Set(readRows_(sheet).map(r => videoId_(r[COL.URL - 1])).filter(Boolean));

  const videos = [];
  let pageToken;
  do {
    const res = YouTube.PlaylistItems.list('snippet,status', { playlistId: uploads, maxResults: 50, pageToken });
    (res.items || []).forEach(it => {
      const privacy = it.status && it.status.privacyStatus;
      if (privacy !== 'public' && privacy !== 'unlisted') return; // 非公開・削除済みは除外
      const id = it.snippet.resourceId.videoId;
      if (existing.has(id)) return;
      existing.add(id);
      videos.push({ id, title: it.snippet.title });
    });
    pageToken = res.nextPageToken;
  } while (pageToken);

  if (!videos.length) {
    Logger.log('新しい動画はありません。');
    return;
  }

  const rows = videos.map(v => {
    const row = new Array(LAST_COL).fill('');
    row[COL.TITLE - 1] = /^[=+\-@]/.test(v.title) ? "'" + v.title : v.title; // 数式扱いを防ぐ
    row[COL.URL - 1] = 'https://www.youtube.com/watch?v=' + v.id;
    return row;
  });
  // C〜E列は触らないよう、A〜B列とF〜I列に分けて書き込む
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, 2).setValues(rows.map(r => r.slice(0, 2)));

  const minutes = Math.round(totalSeconds_(videos.map(v => v.id)) / 60);
  Logger.log(`${videos.length}本を追加しました。合計 約${minutes}分（Gladiaの費用の目安）。`);
}

/** 2. 文字起こし本体。トリガーから定期実行される。手動で1回ずつ実行して試すこともできる。 */
function processTranscriptions() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('別の実行が動いているので今回はスキップします。');
    return;
  }
  try {
    const apiKey = getApiKey_();
    const sheet = getSheet_();
    const rows = readRows_(sheet);
    let inFlight = 0;

    // 送信済みジョブの結果を回収する（結果の取得は無料）
    rows.forEach((r, i) => {
      const rowNum = i + 2;
      const jobId = r[COL.JOB_ID - 1];
      if (!jobId || r[COL.STATUS - 1] !== STATUS.PENDING) return;

      let data;
      try {
        data = fetchJob_(jobId, apiKey);
      } catch (e) {
        Logger.log(`行${rowNum}: 結果の取得に失敗（次回また確認します）: ${e.message}`);
        inFlight++;
        return;
      }

      if (data.status === 'done') {
        const t = data.result && data.result.transcription;
        writeTranscript_(sheet, rowNum, (t && t.full_transcript) || '（音声なし）');
        r[COL.STATUS - 1] = STATUS.DONE;
      } else if (data.status === 'error') {
        setStatus_(sheet, rowNum, 'エラー(Gladia): ' + (data.error_code || ''));
        r[COL.STATUS - 1] = 'エラー';
      } else if (hoursSince_(r[COL.SUBMITTED_AT - 1]) > STALE_HOURS) {
        setStatus_(sheet, rowNum, '要確認: ' + STALE_HOURS + '時間以上未完了');
        r[COL.STATUS - 1] = '要確認';
      } else {
        inFlight++;
      }
    });

    // 未処理の行を新しく送信する
    const props = PropertiesService.getScriptProperties();
    const todayKey = 'submitted_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
    let submittedToday = Number(props.getProperty(todayKey) || 0);
    let submittedNow = 0;

    for (let i = 0; i < rows.length; i++) {
      if (submittedNow >= MAX_SUBMIT_PER_RUN || inFlight >= MAX_IN_FLIGHT) break;
      if (submittedToday >= DAILY_SUBMIT_LIMIT) {
        Logger.log(`今日の上限（${DAILY_SUBMIT_LIMIT}本）に達しました。明日続きを送ります。`);
        break;
      }
      const r = rows[i];
      const rowNum = i + 2;
      if (!isTodo_(r)) continue;

      // 送る前に印をつける。ここで止まっても、この行が再送されることはない。
      setStatus_(sheet, rowNum, STATUS.SENDING);
      r[COL.STATUS - 1] = STATUS.SENDING;
      SpreadsheetApp.flush();
      props.setProperty(todayKey, String(++submittedToday));

      try {
        const jobId = submitJob_(r[COL.URL - 1], apiKey);
        sheet.getRange(rowNum, COL.JOB_ID, 1, 3).setValues([[jobId, STATUS.PENDING, new Date()]]);
        r[COL.STATUS - 1] = STATUS.PENDING;
        inFlight++;
        submittedNow++;
        Logger.log(`行${rowNum}: 送信しました（ジョブID ${jobId}）`);
      } catch (e) {
        setStatus_(sheet, rowNum, 'エラー(送信): ' + e.message.slice(0, 200));
        Logger.log(`行${rowNum}: 送信エラー（自動再送はしません）: ${e.message}`);
      }
      SpreadsheetApp.flush();
    }

    const remaining = rows.filter(isTodo_).length;
    Logger.log(`処理中 ${inFlight}本 / 未送信 ${remaining}本 / 今日の送信 ${submittedToday}本`);
    if (remaining === 0 && inFlight === 0) {
      stopTrigger();
      Logger.log('すべて処理しました。トリガーを削除しました。');
    }
  } finally {
    lock.releaseLock();
  }
}

/** 3. 定期実行を開始する。何度実行してもトリガーは1つだけになる。 */
function setupTrigger() {
  stopTrigger();
  ScriptApp.newTrigger(HANDLER).timeBased().everyMinutes(TRIGGER_MINUTES).create();
  Logger.log(`${TRIGGER_MINUTES}分ごとの実行を開始しました。`);
}

/** 定期実行を止める（以前のコードの transcribeAll トリガーも削除する）。 */
function stopTrigger() {
  const names = [HANDLER].concat(LEGACY_HANDLERS);
  ScriptApp.getProjectTriggers()
    .filter(t => names.indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ---- 内部関数 ----

function isTodo_(r) {
  return r[COL.URL - 1] && !r[COL.TRANSCRIPT - 1] && !r[COL.JOB_ID - 1] && !r[COL.STATUS - 1];
}

function submitJob_(url, apiKey) {
  const res = UrlFetchApp.fetch('https://api.gladia.io/v2/pre-recorded', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-gladia-key': apiKey },
    payload: JSON.stringify({ audio_url: url }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const body = res.getContentText();
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code} ${body.slice(0, 200)}`);
  const data = JSON.parse(body);
  if (!data.id) throw new Error('ジョブIDが返ってきません: ' + body.slice(0, 200));
  return data.id;
}

function fetchJob_(jobId, apiKey) {
  const res = UrlFetchApp.fetch('https://api.gladia.io/v2/pre-recorded/' + jobId, {
    headers: { 'x-gladia-key': apiKey },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error(`HTTP ${code} ${res.getContentText().slice(0, 200)}`);
  return JSON.parse(res.getContentText());
}

function writeTranscript_(sheet, rowNum, text) {
  if (text.length > CELL_CHAR_LIMIT) text = text.slice(0, CELL_CHAR_LIMIT) + '…（文字数上限のため以下省略）';
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  sheet.getRange(rowNum, COL.TRANSCRIPT).setValue(text);
  setStatus_(sheet, rowNum, STATUS.DONE);
  SpreadsheetApp.flush();
}

function setStatus_(sheet, rowNum, status) {
  sheet.getRange(rowNum, COL.STATUS).setValue(status);
}

function getSheet_() {
  const sheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheets().find(s => s.getSheetId() === SHEET_GID);
  if (!sheet) throw new Error('シートが見つかりません（gid=' + SHEET_GID + '）');
  return sheet;
}

function readRows_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, LAST_COL).getValues();
}

function ensureHeader_(sheet) {
  const headers = {
    [COL.TITLE]: 'タイトル', [COL.URL]: 'URL', [COL.TRANSCRIPT]: '文字起こし',
    [COL.JOB_ID]: 'GladiaジョブID', [COL.STATUS]: 'ステータス', [COL.SUBMITTED_AT]: '送信日時',
  };
  Object.keys(headers).forEach(col => {
    const cell = sheet.getRange(1, Number(col));
    if (!cell.getValue()) cell.setValue(headers[col]);
  });
}

function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('GLADIA_API_KEY');
  if (!key) throw new Error('スクリプトプロパティに GLADIA_API_KEY を設定してください。');
  return key;
}

function videoId_(url) {
  const m = /(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/.exec(String(url || ''));
  return m ? m[1] : null;
}

function hoursSince_(date) {
  if (!(date instanceof Date)) return 0;
  return (Date.now() - date.getTime()) / 3600000;
}

function totalSeconds_(ids) {
  let total = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const res = YouTube.Videos.list('contentDetails', { id: ids.slice(i, i + 50).join(',') });
    (res.items || []).forEach(v => {
      const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails.duration || '');
      if (m) total += (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
    });
  }
  return total;
}
