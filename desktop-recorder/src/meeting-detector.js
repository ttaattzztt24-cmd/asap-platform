// Detects whether an online meeting is in progress by polling the system.
// - Zoom (Windows): the helper process "CptHost.exe" runs only during a meeting.
// - Zoom (macOS): CptHost is not reliable, so we also count Zoom's open UDP sockets.
//   An idle Zoom app holds about 1; a meeting opens several for audio/video.
// - Google Meet: a browser tab is on a meeting URL (meet.google.com/abc-defg-hij).
//   The "you left the meeting" page keeps the same URL, so on macOS we also run a
//   small script inside the Meet tab to check that the call UI is actually showing.
//   That needs the browser's "Allow JavaScript from Apple Events" setting; without
//   it we fall back to the URL alone (recording then stops when the tab closes).
//   Windows can only see the active tab's title, so there the Meet tab must be
//   the front tab.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const ZOOM_MEETING_PROCESS = /cpthost/i;
const MAC_ZOOM_MEETING_UDP_SOCKETS = 3;
const MEET_URL = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
const MEET_TITLE = /^Meet\s*[-–]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/im;

// AppleScript-capable browsers on macOS, matched against `ps` executable paths.
// We only script a browser that is already running, so osascript never launches one.
const MAC_BROWSERS = [
  { app: 'Google Chrome', kind: 'chromium', exe: /Google Chrome\.app\/Contents\/MacOS\/Google Chrome\s*$|^Google Chrome\s*$/m },
  { app: 'Safari', kind: 'safari', exe: /Safari\.app\/Contents\/MacOS\/Safari\s*$|^Safari\s*$/m },
  { app: 'Microsoft Edge', kind: 'chromium', exe: /Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge\s*$|^Microsoft Edge\s*$/m },
  { app: 'Brave Browser', kind: 'chromium', exe: /Brave Browser\.app\/Contents\/MacOS\/Brave Browser\s*$|^Brave Browser\s*$/m },
  { app: 'Arc', kind: 'url-only', exe: /Arc\.app\/Contents\/MacOS\/Arc\s*$|^Arc\s*$/m },
];

// Runs inside the Meet tab. Language-independent signals that the call UI is up:
// the hang-up button's "call_end" material icon, or participant tiles. Neither
// exists on the pre-join screen or on the "you left the meeting" page.
const MEET_IN_CALL_JS =
  "([...document.querySelectorAll('i,span')].some(e => e.textContent.trim() === 'call_end') || " +
  "!!document.querySelector('[data-participant-id]')) ? 'incall' : 'notincall'";

// For every Meet tab, print "<url> <incall|notincall|jserror ...>" on its own line.
function meetTabsScript(app, kind) {
  const evalJs =
    kind === 'safari'
      ? `do JavaScript "${MEET_IN_CALL_JS}" in t`
      : kind === 'chromium'
        ? `execute t javascript "${MEET_IN_CALL_JS}"`
        : null;
  const probe = evalJs
    ? `try
          set r to (${evalJs})
        on error errMsg
          set r to "jserror " & errMsg
        end try`
    : 'set r to "unknown"';
  return `tell application "${app}"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set u to URL of t
      if u contains "meet.google.com/" then
        set r to "unknown"
        ${probe}
        set out to out & u & " " & r & linefeed
      end if
    end repeat
  end repeat
  return out
end tell`;
}

// Interprets the script output. Returns { inCall, jsBlocked }.
function parseMeetTabs(output) {
  let inCall = false;
  let jsBlocked = false;
  for (const line of output.split('\n')) {
    if (!MEET_URL.test(line)) continue;
    if (/\sincall\s*$/.test(line)) inCall = true;
    else if (/\snotincall\s*$/.test(line)) continue;
    else {
      // Page state unknown (JavaScript from Apple Events is off): trust the URL.
      inCall = true;
      if (/\sjserror/.test(line)) jsBlocked = true;
    }
  }
  return { inCall, jsBlocked };
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

// lsof exits 1 when nothing matches; stdout is still usable.
const run = async (cmd, args) => (await exec(cmd, args)).stdout;

// Browser scripting problems (e.g. the macOS Automation permission was denied)
// are reported here so the app can explain them instead of failing silently.
let reportProblem = () => {};

const listProcesses = () =>
  process.platform === 'win32'
    ? run('tasklist', ['/FO', 'CSV', '/NH'])
    : run('ps', ['-A', '-o', 'comm=']);

async function detectZoom(processes) {
  if (ZOOM_MEETING_PROCESS.test(processes)) return 'CptHost';
  if (process.platform === 'darwin') {
    const out = await run('/usr/sbin/lsof', ['-nP', '-i', '4UDP']);
    const udp = out.split('\n').filter((line) => /^zoom/i.test(line)).length;
    if (udp >= MAC_ZOOM_MEETING_UDP_SOCKETS) return `udp=${udp}`;
  }
  return null;
}

let lastBrowsers = null;
let reportBrowsers = () => {};

async function detectMeet(processes) {
  if (process.platform === 'darwin') {
    const running = MAC_BROWSERS.filter(({ exe }) => exe.test(processes)).map(({ app }) => app).join(', ');
    if (running !== lastBrowsers) {
      lastBrowsers = running;
      reportBrowsers(running || 'none');
    }
    for (const { app, kind, exe } of MAC_BROWSERS) {
      if (!exe.test(processes)) continue;
      const { stdout, stderr } = await exec('osascript', ['-e', meetTabsScript(app, kind)]);
      const { inCall, jsBlocked } = parseMeetTabs(stdout);
      if (stderr.trim()) {
        // -1743: the user has not allowed this app to control the browser.
        reportProblem(app, /-1743|not authori[sz]ed/i.test(stderr) ? 'not-authorized' : 'error', stderr.trim());
      } else if (jsBlocked) {
        reportProblem(app, 'js-disabled', stdout.trim());
      } else {
        reportProblem(app, null);
      }
      if (inCall) return app;
    }
    return null;
  }
  if (process.platform === 'win32') {
    const titles = await run('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Process chrome,msedge,brave -ErrorAction SilentlyContinue | ForEach-Object { $_.MainWindowTitle }',
    ]);
    return MEET_TITLE.test(titles) ? 'browser' : null;
  }
  return null;
}

async function detectMeeting() {
  const processes = await listProcesses();
  const [zoom, meet] = await Promise.all([detectZoom(processes), detectMeet(processes)]);
  if (zoom) return { app: 'zoom', reason: zoom };
  if (meet) return { app: 'meet', reason: meet };
  return { app: null, reason: 'none' };
}

class MeetingDetector extends EventEmitter {
  constructor({ intervalMs = 3000, endGraceChecks = 2 } = {}) {
    super();
    this.intervalMs = intervalMs;
    // Require several consecutive misses before declaring the meeting over,
    // so a brief network hiccup does not split a recording in two.
    this.endGraceChecks = endGraceChecks;
    this.app = null; // 'zoom' | 'meet' | null
    this.misses = 0;
    this.timer = null;
    this.busy = false;
    this.problems = new Map(); // browser -> problem kind
    reportProblem = (browser, kind, detail) => {
      if ((this.problems.get(browser) || null) === kind) return;
      if (kind) this.problems.set(browser, kind);
      else this.problems.delete(browser);
      this.emit('browser-problem', browser, kind, detail);
    };
    reportBrowsers = (list) => this.emit('browsers', list);
  }

  get inMeeting() {
    return this.app !== null;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      if (this.busy) return;
      this.busy = true;
      try {
        const { app, reason } = await detectMeeting();
        if (app) {
          this.misses = 0;
          if (!this.app) {
            this.app = app;
            this.emit('meeting-start', app, reason);
          }
        } else if (this.app && ++this.misses >= this.endGraceChecks) {
          const ended = this.app;
          this.app = null;
          this.misses = 0;
          this.emit('meeting-end', ended, reason);
        }
      } finally {
        this.busy = false;
      }
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { MeetingDetector, detectMeeting, MEET_URL, MEET_TITLE, MEET_IN_CALL_JS, meetTabsScript, parseMeetTabs };
