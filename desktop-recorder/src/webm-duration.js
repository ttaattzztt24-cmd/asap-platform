// MediaRecorder writes WebM files without a Duration, so players show no total
// time and seeking misbehaves. This inserts Segment > Info > Duration after the
// recording ends. Only the header is rewritten in memory; the (possibly
// multi-hour) rest of the file is streamed across unchanged.
const fs = require('fs');
const { pipeline } = require('stream/promises');

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const UNKNOWN_SIZE_8 = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const HEADER_BYTES = 64 * 1024;

function readId(buf, pos) {
  const first = buf[pos];
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4) throw new Error('bad EBML id');
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + buf[pos + i];
  return { id, len };
}

function readSize(buf, pos) {
  const first = buf[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('bad EBML size');
  let value = first & (0xff >> len);
  let allOnes = value === 0xff >> len;
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? null : value, len };
}

function size8(n) {
  const b = Buffer.alloc(8);
  b[0] = 0x01;
  b.writeUIntBE(n, 2, 6);
  return b;
}

// Returns a new header buffer with Duration inserted, or null if the file
// already has one (or does not look like a MediaRecorder WebM).
function patchHeader(head, durationMs) {
  let pos = 0;
  const ebml = readId(head, pos);
  if (ebml.id !== ID_EBML) return null;
  pos += ebml.len;
  const ebmlSize = readSize(head, pos);
  pos += ebmlSize.len + ebmlSize.size;

  const seg = readId(head, pos);
  if (seg.id !== ID_SEGMENT) return null;
  const segSizePos = pos + seg.len;
  const segSize = readSize(head, segSizePos);
  let p = segSizePos + segSize.len;

  // Walk Segment children until Info.
  while (p < head.length) {
    const child = readId(head, p);
    const childSize = readSize(head, p + child.len);
    const dataStart = p + child.len + childSize.len;
    if (child.id !== ID_INFO) {
      if (childSize.size === null) return null;
      p = dataStart + childSize.size;
      continue;
    }
    const dataEnd = dataStart + childSize.size;
    if (dataEnd > head.length) return null;

    let timecodeScale = 1000000;
    for (let q = dataStart; q < dataEnd; ) {
      const e = readId(head, q);
      const s = readSize(head, q + e.len);
      const v = q + e.len + s.len;
      if (e.id === ID_DURATION) return null; // already fixed
      if (e.id === ID_TIMECODE_SCALE) timecodeScale = head.readUIntBE(v, s.size);
      q = v + s.size;
    }

    const duration = Buffer.alloc(11);
    duration.writeUInt16BE(ID_DURATION, 0);
    duration[2] = 0x88; // size 8
    duration.writeDoubleBE((durationMs * 1e6) / timecodeScale, 3);

    return Buffer.concat([
      head.subarray(0, segSizePos),
      // Segment size: always "unknown" so we never have to recompute it.
      UNKNOWN_SIZE_8,
      head.subarray(segSizePos + segSize.len, p),
      head.subarray(p, p + child.len),
      size8(childSize.size + duration.length),
      head.subarray(dataStart, dataEnd),
      duration,
      head.subarray(dataEnd),
    ]);
  }
  return null;
}

async function fixWebmDuration(filePath, durationMs) {
  if (!(durationMs > 0)) return false;
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(HEADER_BYTES);
  const read = fs.readSync(fd, head, 0, HEADER_BYTES, 0);
  fs.closeSync(fd);

  let patched;
  try {
    patched = patchHeader(head.subarray(0, read), durationMs);
  } catch {
    return false;
  }
  if (!patched) return false;

  const tmp = `${filePath}.fixing`;
  const out = fs.createWriteStream(tmp);
  out.write(patched);
  await pipeline(fs.createReadStream(filePath, { start: read }), out);
  fs.renameSync(tmp, filePath);
  return true;
}

module.exports = { fixWebmDuration, patchHeader };
