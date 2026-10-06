// Detects whether a Zoom meeting is in progress by polling the system.
// - Windows: Zoom runs the helper process "CptHost.exe" only while in a meeting.
// - macOS: CptHost is not reliable, so we also count Zoom's open UDP sockets.
//   An idle Zoom app holds about 1; a meeting opens several for audio/video.
const { execFile } = require('child_process');
const { EventEmitter } = require('events');

const MEETING_PROCESS = /cpthost/i;
const MAC_MEETING_UDP_SOCKETS = 3;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      // lsof exits 1 when nothing matches; stdout is still usable.
      resolve(stdout || '');
    });
  });
}

async function hasMeetingProcess() {
  const out =
    process.platform === 'win32'
      ? await run('tasklist', ['/FO', 'CSV', '/NH'])
      : await run('ps', ['-A', '-o', 'comm=']);
  return MEETING_PROCESS.test(out);
}

async function zoomUdpSocketCount() {
  const out = await run('/usr/sbin/lsof', ['-nP', '-i', '4UDP']);
  return out.split('\n').filter((line) => /^zoom/i.test(line)).length;
}

async function detectMeeting() {
  if (await hasMeetingProcess()) return { inMeeting: true, reason: 'CptHost' };
  if (process.platform === 'darwin') {
    const udp = await zoomUdpSocketCount();
    return { inMeeting: udp >= MAC_MEETING_UDP_SOCKETS, reason: `udp=${udp}` };
  }
  return { inMeeting: false, reason: 'none' };
}

class ZoomDetector extends EventEmitter {
  constructor({ intervalMs = 3000, endGraceChecks = 2 } = {}) {
    super();
    this.intervalMs = intervalMs;
    // Require several consecutive misses before declaring the meeting over,
    // so a brief network hiccup does not split a recording in two.
    this.endGraceChecks = endGraceChecks;
    this.inMeeting = false;
    this.lastReason = '';
    this.misses = 0;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    const tick = async () => {
      const { inMeeting, reason } = await detectMeeting();
      this.lastReason = reason;
      if (inMeeting) {
        this.misses = 0;
        if (!this.inMeeting) {
          this.inMeeting = true;
          this.emit('meeting-start', reason);
        }
      } else if (this.inMeeting && ++this.misses >= this.endGraceChecks) {
        this.inMeeting = false;
        this.misses = 0;
        this.emit('meeting-end', reason);
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

module.exports = { ZoomDetector, detectMeeting };
