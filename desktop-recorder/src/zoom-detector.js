// Detects whether a Zoom meeting is in progress by polling the process list.
// Zoom launches a helper process "CptHost" (Windows: CptHost.exe, macOS: cpthost.app)
// only while the user is inside a meeting, which makes it a reliable signal.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const MEETING_PROCESS = /cpthost/i;

function listProcesses() {
  return new Promise((resolve) => {
    const [cmd, args] =
      process.platform === 'win32'
        ? ['tasklist', ['/FO', 'CSV', '/NH']]
        : ['ps', ['-A', '-o', 'comm=']];
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

class ZoomDetector extends EventEmitter {
  constructor({ intervalMs = 3000, endGraceChecks = 2 } = {}) {
    super();
    this.intervalMs = intervalMs;
    // Require several consecutive misses before declaring the meeting over,
    // so a brief process restart does not split a recording in two.
    this.endGraceChecks = endGraceChecks;
    this.inMeeting = false;
    this.misses = 0;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      const found = MEETING_PROCESS.test(await listProcesses());
      if (found) {
        this.misses = 0;
        if (!this.inMeeting) {
          this.inMeeting = true;
          this.emit('meeting-start');
        }
      } else if (this.inMeeting && ++this.misses >= this.endGraceChecks) {
        this.inMeeting = false;
        this.misses = 0;
        this.emit('meeting-end');
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

module.exports = { ZoomDetector };
