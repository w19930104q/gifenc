// Verification for dirty-region (incremental) frame encoding.
//
// Encodes a synthetic animation twice — once with full frames only, and
// once with incremental (dirty-region) frames — then decodes both with a
// minimal GIF decoder (LZW + compositing) and asserts:
//
//   1. The composited frames of the incremental GIF are pixel-identical
//      to the composited frames of the full-frame GIF (and both match
//      the source indexed frames).
//   2. Arbitrary dirty shapes (rects, circles, scattered pixels) and
//      empty (no-change) frames round-trip correctly.
//   3. The full-frame path is unchanged: frames whose dirty region covers
//      the whole frame (or when no dirty options are passed) produce
//      byte-identical output to before.
//   4. The incremental encoding is significantly smaller.
//
// Run with: node test/incremental_node.js

import { GIFEncoder, findDirtyRect } from "../src/index.js";

const width = 96;
const height = 80;

const palette = [];
for (let i = 0; i < 256; i++) {
  palette.push([i, (i * 5) % 256, (i * 11) % 256]);
}

// Build a sequence of indexed frames exercising several dirty shapes
function makeFrames() {
  const frames = [];

  // frame 0: full gradient
  const f0 = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      f0[y * width + x] = (x + y) % 256;
    }
  }
  frames.push(f0);

  // frame 1: small rectangular change
  const f1 = f0.slice();
  for (let y = 8; y < 20; y++) {
    for (let x = 10; x < 22; x++) {
      f1[y * width + x] = (x * y) % 256;
    }
  }
  frames.push(f1);

  // frame 2: arbitrary shape — a filled circle plus a scattered diagonal
  const f2 = f1.slice();
  const cx = 60;
  const cy = 50;
  const r = 9;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r) {
        f2[y * width + x] = (x + 2 * y) % 256;
      }
    }
  }
  for (let i = 0; i < 30; i++) {
    f2[(5 + i) * width + (3 + i)] = (200 - i) % 256;
  }
  frames.push(f2);

  // frame 3: no change at all
  frames.push(f2.slice());

  // frame 4: every single pixel changes
  const f4 = new Uint8Array(width * height);
  for (let i = 0; i < f4.length; i++) {
    f4[i] = (f2[i] + 128) % 256;
  }
  frames.push(f4);

  return frames;
}

function encodeFull(frames) {
  const gif = GIFEncoder();
  frames.forEach((index, i) => {
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: 100,
      repeat: 0,
    });
  });
  gif.finish();
  return gif.bytes();
}

function encodeIncremental(frames) {
  const gif = GIFEncoder();
  frames.forEach((index, i) => {
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: 100,
      repeat: 0,
      previous: i === 0 ? undefined : frames[i - 1],
    });
  });
  gif.finish();
  return gif.bytes();
}

// --- Minimal GIF decoder (LZW + compositing) for verification ---

function lzwDecode(minCodeSize, data, expectedLength) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize;
  let table;
  const resetTable = () => {
    table = [];
    for (let i = 0; i < clearCode; i++) table.push([i]);
    table.push(null); // clear code
    table.push(null); // eoi code
    codeSize = minCodeSize + 1;
  };
  resetTable();

  const out = [];
  let bitPos = 0;
  const readCode = () => {
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byteIndex = bitPos >> 3;
      if (byteIndex >= data.length) return -1;
      code |= ((data[byteIndex] >> (bitPos & 7)) & 1) << i;
      bitPos++;
    }
    return code;
  };

  let prev = null;
  while (out.length < expectedLength) {
    const code = readCode();
    if (code < 0 || code === eoiCode) break;
    if (code === clearCode) {
      resetTable();
      prev = null;
      continue;
    }
    let entry;
    if (code < table.length && table[code]) {
      entry = table[code];
    } else if (prev && code === table.length) {
      entry = prev.concat(prev[0]);
    } else {
      throw new Error(`Invalid LZW code ${code} (table size ${table.length})`);
    }
    for (let i = 0; i < entry.length; i++) out.push(entry[i]);
    if (prev) {
      table.push(prev.concat(entry[0]));
      if (table.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return Uint8Array.from(out);
}

function decodeGIF(bytes) {
  let pos = 0;
  const readByte = () => bytes[pos++];
  const readShort = () => bytes[pos++] | (bytes[pos++] << 8);

  // header
  for (let i = 0; i < 6; i++) readByte();
  const screenWidth = readShort();
  const screenHeight = readShort();
  const packed = readByte();
  readByte(); // background color index
  readByte(); // pixel aspect ratio
  if (packed & 0x80) {
    pos += 3 * (2 << (packed & 7)); // global color table
  }

  const canvas = new Uint8Array(screenWidth * screenHeight);
  const frames = [];
  let gce = { dispose: 0, transparent: false, transparentIndex: 0 };

  while (pos < bytes.length) {
    const introducer = readByte();
    if (introducer === 0x3b) break; // trailer
    if (introducer === 0x21) {
      const label = readByte();
      if (label === 0xf9) {
        readByte(); // block size (4)
        const gcePacked = readByte();
        readShort(); // delay
        const transparentIndex = readByte();
        readByte(); // block terminator
        gce = {
          dispose: (gcePacked >> 2) & 7,
          transparent: (gcePacked & 1) !== 0,
          transparentIndex,
        };
      } else {
        // skip extension sub-blocks
        let size = readByte();
        while (size !== 0) {
          pos += size;
          size = readByte();
        }
      }
    } else if (introducer === 0x2c) {
      const left = readShort();
      const top = readShort();
      const w = readShort();
      const h = readShort();
      const imgPacked = readByte();
      if (imgPacked & 0x80) {
        pos += 3 * (2 << (imgPacked & 7)); // local color table
      }
      const minCodeSize = readByte();
      const chunks = [];
      let total = 0;
      let size = readByte();
      while (size !== 0) {
        chunks.push(bytes.subarray(pos, pos + size));
        total += size;
        pos += size;
        size = readByte();
      }
      const data = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      const pixels = lzwDecode(minCodeSize, data, w * h);
      if (pixels.length !== w * h) {
        throw new Error(
          `Decoded ${pixels.length} pixels, expected ${w * h} (${w}x${h})`,
        );
      }
      // composite onto canvas
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = pixels[y * w + x];
          if (gce.transparent && p === gce.transparentIndex) continue;
          canvas[(top + y) * screenWidth + (left + x)] = p;
        }
      }
      frames.push(canvas.slice());
      // apply disposal for the next frame
      if (gce.dispose === 2) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            canvas[(top + y) * screenWidth + (left + x)] = 0;
          }
        }
      }
      gce = { dispose: 0, transparent: false, transparentIndex: 0 };
    } else {
      throw new Error(`Unknown block introducer 0x${introducer.toString(16)}`);
    }
  }
  return { width: screenWidth, height: screenHeight, frames };
}

// --- assertions ---

let failures = 0;
function assert(cond, message) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`ok: ${message}`);
  }
}

function framesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const frames = makeFrames();

// findDirtyRect sanity checks
const dirty1 = findDirtyRect(frames[0], frames[1], width, height);
assert(
  dirty1 &&
    dirty1.x === 10 &&
    dirty1.y === 8 &&
    dirty1.width === 12 &&
    dirty1.height === 12,
  `findDirtyRect finds exact bounding box of rect change (${JSON.stringify(dirty1)})`,
);
const dirty3 = findDirtyRect(frames[2], frames[3], width, height);
assert(
  dirty3 && dirty3.width === 0 && dirty3.height === 0,
  "findDirtyRect returns empty rect for identical frames",
);
const dirty4 = findDirtyRect(frames[3], frames[4], width, height);
assert(
  dirty4 &&
    dirty4.x === 0 &&
    dirty4.y === 0 &&
    dirty4.width === width &&
    dirty4.height === height,
  "findDirtyRect returns full frame when everything changed",
);

// encode both ways
const fullBytes = encodeFull(frames);
const incBytes = encodeIncremental(frames);

// decode and compare composited output against ground truth
const decodedFull = decodeGIF(fullBytes);
const decodedInc = decodeGIF(incBytes);

assert(
  decodedFull.frames.length === frames.length &&
    decodedInc.frames.length === frames.length,
  "both GIFs decode to the expected number of frames",
);

for (let i = 0; i < frames.length; i++) {
  assert(
    framesEqual(decodedFull.frames[i], frames[i]),
    `full-frame GIF: composited frame ${i} matches source pixels`,
  );
  assert(
    framesEqual(decodedInc.frames[i], frames[i]),
    `incremental GIF: composited frame ${i} matches source pixels`,
  );
  assert(
    framesEqual(decodedInc.frames[i], decodedFull.frames[i]),
    `frame ${i}: incremental composite identical to full-frame composite`,
  );
}

// full-frame path output is unchanged:
// (a) a frame whose dirty region spans the whole frame encodes byte-identically
{
  const pair = [frames[0], frames[4]];
  const a = encodeFull(pair);
  const b = encodeIncremental(pair);
  assert(
    framesEqual(a, b),
    "full-change frame via { previous } is byte-identical to full-frame path",
  );
}
// (b) an explicit full-frame rect encodes byte-identically
{
  const gif = GIFEncoder();
  gif.writeFrame(frames[0], width, height, { palette, delay: 100, repeat: 0 });
  gif.writeFrame(frames[1], width, height, {
    delay: 100,
    rect: { x: 0, y: 0, width, height },
  });
  gif.finish();
  const withRect = gif.bytes();
  const withoutRect = encodeFull([frames[0], frames[1]]);
  assert(
    framesEqual(withRect, withoutRect),
    "explicit full-frame { rect } is byte-identical to full-frame path",
  );
}
// (c) explicit dirty rect also decodes correctly
{
  const gif = GIFEncoder();
  gif.writeFrame(frames[0], width, height, { palette, delay: 100, repeat: 0 });
  gif.writeFrame(frames[1], width, height, {
    delay: 100,
    rect: { x: 10, y: 8, width: 12, height: 12 },
  });
  gif.finish();
  const decoded = decodeGIF(gif.bytes());
  assert(
    framesEqual(decoded.frames[1], frames[1]),
    "explicit dirty { rect } composites to the correct frame",
  );
}

// size comparison
const ratio = incBytes.length / fullBytes.length;
console.log(
  `full-frame GIF: ${fullBytes.length} bytes, incremental GIF: ${incBytes.length} bytes (${(ratio * 100).toFixed(1)}%)`,
);
assert(
  incBytes.length < fullBytes.length * 0.7,
  "incremental encoding is significantly smaller for localized changes",
);

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
} else {
  console.log("\nAll incremental-frame checks passed.");
}
