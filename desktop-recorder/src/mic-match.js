// Finds the microphone the meeting app (Zoom, or the browser running Google Meet)
// is using right now, so the recorder can capture the same one.
// The data comes from native/mic-in-use (macOS only); elsewhere we return null
// and the recorder falls back to the OS default input.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const OWN_APP = /\/Kiku\.app\/|Kiku Helper|ASAP Meeting Recorder|Electron\.app|\/electron\//i;
const APP_PROCESS = {
  zoom: /zoom\.us/i,
  meet: /Google Chrome|Safari|WebKit|Microsoft Edge|Brave Browser|Arc\.app|Firefox/i,
};

function helperPath() {
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'bin', 'mic-in-use'),
    path.join(__dirname, '..', 'native', 'bin', 'mic-in-use'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function readAudioState() {
  const bin = process.platform === 'darwin' ? helperPath() : null;
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(bin, [], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

// state: output of mic-in-use. trigger: 'zoom' | 'meet' | 'manual'.
// currentName: the device this app is recording from now (or null).
// Returns { name, how } or null when nothing better than the default is known.
function pickMeetingMic(state, { trigger, currentName = null } = {}) {
  if (!state) return null;
  const inputs = (state.devices || []).filter((d) => !d.virtual && d.name);
  const byId = new Map(inputs.map((d) => [d.id, d]));

  // macOS 14+: exact per-process information.
  const others = (state.processes || []).filter((p) => !OWN_APP.test(p.path || ''));
  if (others.length) {
    const pattern = APP_PROCESS[trigger];
    const preferred = pattern ? others.filter((p) => pattern.test(p.path || '')) : [];
    for (const group of [preferred, others]) {
      for (const p of group) {
        const device = (p.devices || []).map((id) => byId.get(id)).find(Boolean);
        if (device) return { name: device.name, how: `process ${path.basename(p.path || String(p.pid))}` };
      }
    }
  }

  // Older macOS: which input devices are open by anyone. Our own capture keeps
  // currentName running, so prefer a different running device when there is one.
  const running = inputs.filter((d) => d.running);
  const elsewhere = running.filter((d) => d.name !== currentName);
  if (elsewhere.length === 1) return { name: elsewhere[0].name, how: 'running device' };
  if (elsewhere.length > 1) {
    const nonDefault = elsewhere.find((d) => !d.isDefault) || elsewhere[0];
    return { name: nonDefault.name, how: 'running device (ambiguous)' };
  }
  return null;
}

// Chromium mic labels are the CoreAudio name, sometimes with a suffix such as
// " (Built-in)" or " (046d:0825)".
function labelMatches(label, name) {
  if (!label || !name) return false;
  return label === name || label.startsWith(`${name} (`) || name.startsWith(`${label} (`);
}

module.exports = { readAudioState, pickMeetingMic, labelMatches };
