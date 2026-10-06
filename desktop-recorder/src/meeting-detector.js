// Detects whether an online meeting is in progress by polling the system.
// - Zoom (Windows): the helper process "CptHost.exe" runs only during a meeting.
// - Zoom (macOS): CptHost is not reliable, so we also count Zoom's open UDP sockets.
//   An idle Zoom app holds about 1; a meeting opens several for audio/video.
// - Google Meet: a browser tab is on a meeting URL (meet.google.com/abc-defg-hij).
//   macOS reads every tab's URL via AppleScript; Windows can only see the
//   active tab's title, so there the Meet tab must be the front tab.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const ZOOM_MEETING_PROCESS = /cpthost/i;
const MAC_ZOOM_MEETING_UDP_SOCKETS = 3;
const MEET_URL = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;
const MEET_TITLE = /^Meet\s*[-–]\s*[a-z]{3}-[a-z]{4}-[a-z]{3}/im;

// AppleScript-capable browsers on macOS, matched against `ps` executable paths.
// We only script a browser that is already running, so osascript never launches one.
const MAC_BROWSERS = [
  { app: 'Google Chrome', exe: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/m },
  { app: 'Safari', exe: /\/Safari\.app\/Contents\/MacOS\/Safari$/m },
  { app: 'Microsoft Edge', exe: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge$/m },
  { app: 'Brave Browser', exe: /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser$/m },
  { app: 'Arc', exe: /\/Arc\.app\/Contents\/MacOS\/Arc$/m },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 10000 }, (_err, stdout) => {
      // lsof exits 1 when nothing matches; stdout is still usable.
      resolve(stdout || '');
    });
  });
}

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

async function detectMeet(processes) {
  if (process.platform === 'darwin') {
    for (const { app, exe } of MAC_BROWSERS) {
      if (!exe.test(processes)) continue;
      const urls = await run('osascript', [
        '-e',
        `tell application "${app}" to get URL of every tab of every window`,
      ]);
      if (MEET_URL.test(urls)) return app;
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

module.exports = { MeetingDetector, detectMeeting, MEET_URL, MEET_TITLE };
