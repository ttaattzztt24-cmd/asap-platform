// Turns meeting links into stable IDs and decides whether a detected meeting is
// one the user registered ("record only these meetings").
//   Google Meet: the meeting code, e.g. "abc-defg-hij".
//   Zoom: the numeric meeting ID ("81234567890") or a personal link ("my/yamada").

const MEET_CODE = /(?:^|meet\.google\.com\/)([a-z]{3}-[a-z]{4}-[a-z]{3})(?=$|[/?#\s])/i;
const ZOOM_NUMERIC = [
  /zoom\.us\/(?:j|s|w|wc|wc\/join)\/(\d{9,12})/i,
  /[?&]confno=(\d{9,12})/i,
];
const ZOOM_PERSONAL = /zoom\.us\/my\/([\w.-]+)/i;

// Returns { kind: 'zoom' | 'meet', id } or null.
function parseMeetingLink(text) {
  const s = String(text || '').trim();
  const meet = s.match(MEET_CODE);
  if (meet) return { kind: 'meet', id: meet[1].toLowerCase() };
  for (const re of ZOOM_NUMERIC) {
    const m = s.match(re);
    if (m) return { kind: 'zoom', id: m[1] };
  }
  const personal = s.match(ZOOM_PERSONAL);
  if (personal) return { kind: 'zoom', id: `my/${personal[1].toLowerCase()}` };
  // A bare Zoom meeting ID ("812 3456 7890"), or the "ミーティングID: …" line
  // of a pasted Zoom invitation.
  const idText = s.match(/^(\d[\d\s-]{7,15}\d)$/) || s.match(/(?:ミーティング\s*ID|Meeting\s*ID)\s*[:：]?\s*(\d[\d\s-]{7,15}\d)/i);
  if (idText) {
    const digits = idText[1].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 12) return { kind: 'zoom', id: digits };
  }
  return null;
}

// IDs of every Zoom join page found among browser tab URLs.
function zoomIdsFromUrls(urls) {
  const ids = new Set();
  for (const url of urls) {
    const parsed = /zoom\.us\//i.test(url) ? parseMeetingLink(url) : null;
    if (parsed?.kind === 'zoom') ids.add(parsed.id);
  }
  return [...ids];
}

// meetings: [{ kind, id, name }]. info: { meetCodes, zoomIds } from the detector.
function findRegisteredMeeting(meetings, app, info = {}) {
  const seen = app === 'meet' ? info.meetCodes || [] : app === 'zoom' ? info.zoomIds || [] : [];
  return meetings.find((m) => m.kind === app && seen.includes(m.id)) || null;
}

module.exports = { parseMeetingLink, zoomIdsFromUrls, findRegisteredMeeting };
