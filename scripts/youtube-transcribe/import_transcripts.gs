// 「テスト」シートの拡張機能 → Apps Script に貼り付けて importTranscripts を 1 回実行する。
// @tonyobyo_amakana 全47本: A=No, B=公開日, C=タイトル, D=URL, E=再生時間, F=文字起こし（Gladia）
// Gladia への送信は行わない（取得済みの文字起こしを GitHub から読み込むだけ）。
const CSV_URL = "https://raw.githubusercontent.com/ttaattzztt24-cmd/asap-platform/66e3a80293def6f7120105aa489cad8069c2c075/scripts/youtube-transcribe/transcripts_sheet.csv";

function importTranscripts() {
  const csv = UrlFetchApp.fetch(CSV_URL).getContentText("UTF-8");
  const rows = Utilities.parseCsv(csv);
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, rows[0].length).setFontWeight("bold");
  SpreadsheetApp.getUi().alert((rows.length - 1) + " 件を書き込みました");
}
