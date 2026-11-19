// Acceptance test: transparency + disposal semantics.
//
// Encodes transparent animations with GIFEncoder, then decodes the bytes
// with a small reference GIF89a decoder (transparent canvas, disposal
// 0/1 = keep, 2 = restore to background, 3 = restore to previous) and
// verifies:
//
//   1. transparent frames never show residue of previous frames
//   2. every explicit disposal mode is written and composited per spec
//   3. accumulation (dispose 1) still works when explicitly requested
//   4. opaque frames are unaffected (no transparency flag, disposal 0)
//
// Run with: node test/transparent_disposal_node.js

import { GIFEncoder, quantize, applyPalette } from "../src/index.js";

const W = 32;
const H = 32;

// ---------------------------------------------------------------------------
// minimal reference GIF decoder
// ---------------------------------------------------------------------------

function parseGIF(bytes) {
  let pos = 0;
  const readByte = () => bytes[pos++];
  const readShort = () => bytes[pos++] | (bytes[pos++] << 8);
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== "GIF89a" && header !== "GIF87a") throw new Error("bad header");
  pos = 6;
  const width = readShort();
  const height = readShort();
  const packed = readByte();
  readByte(); // background color index
  readByte(); // aspect
  let gct = null;
  if (packed & 0x80) {
    const size = 3 * (1 << ((packed & 7) + 1));
    gct = bytes.subarray(pos, pos + size);
    pos += size;
  }
  const frames = [];
  let gce = { disposal: 0, transparent: false, transparentIndex: 0, delay: 0 };
  while (pos < bytes.length) {
    const b = readByte();
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = readByte();
      if (label === 0xf9) {
        readByte(); // block size
        const p = readByte();
        const delay = readShort();
        const tindex = readByte();
        readByte(); // terminator
        gce = {
          disposal: (p >> 2) & 7,
          transparent: Boolean(p & 1),
          transparentIndex: tindex,
          delay,
        };
      } else {
        let n;
        while ((n = readByte()) !== 0) pos += n;
      }
      continue;
    }
    if (b === 0x2c) {
      const x = readShort();
      const y = readShort();
      const w = readShort();
      const h = readShort();
      const ipacked = readByte();
      let palette = gct;
      if (ipacked & 0x80) {
        const size = 3 * (1 << ((ipacked & 7) + 1));
        palette = bytes.subarray(pos, pos + size);
        pos += size;
      }
      const minCode = readByte();
      const chunks = [];
      let n;
      while ((n = readByte()) !== 0) {
        chunks.push(bytes.subarray(pos, pos + n));
        pos += n;
      }
      const data = concatBytes(chunks);
      const pixels = lzwDecode(minCode, data, w * h);
      frames.push({ x, y, w, h, palette, pixels, gce });
      gce = { disposal: 0, transparent: false, transparentIndex: 0, delay: 0 };
      continue;
    }
    throw new Error("unknown block 0x" + b.toString(16));
  }
  return { width, height, frames };
}

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function lzwDecode(minCode, data, expected) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let codeSize = minCode + 1;
  let table;
  const reset = () => {
    table = [];
    for (let i = 0; i < clear; i++) table.push([i]);
    table.push(null, null);
  };
  reset();
  const out = [];
  let bitpos = 0;
  let prev = null;
  const readCode = () => {
    let val = 0;
    for (let i = 0; i < codeSize; i++) {
      val |= ((data[bitpos >> 3] >> (bitpos & 7)) & 1) << i;
      bitpos++;
    }
    return val;
  };
  while (out.length < expected) {
    const code = readCode();
    if (code === clear) {
      reset();
      codeSize = minCode + 1;
      prev = null;
      continue;
    }
    if (code === eoi) break;
    let entry;
    if (prev === null) {
      entry = table[code];
    } else {
      entry = code < table.length && table[code] ? table[code] : [...prev, prev[0]];
      table.push([...prev, entry[0]]);
      if (table.length === 1 << codeSize && codeSize < 12) codeSize++;
    }
    out.push(...entry);
    prev = entry;
  }
  return Uint8Array.from(out.subarray ? out.subarray(0, expected) : out.slice(0, expected));
}

// Composite frames onto a transparent canvas following GIF89a disposal rules.
function compositeFrames(gif) {
  const { width, height } = gif;
  const canvas = new Uint8Array(width * height * 4);
  const result = [];
  let snapshot = null;
  for (const frame of gif.frames) {
    const { gce } = frame;
    if (gce.disposal === 3) snapshot = canvas.slice();
    for (let py = 0; py < frame.h; py++) {
      for (let px = 0; px < frame.w; px++) {
        const idx = frame.pixels[py * frame.w + px];
        if (gce.transparent && idx === gce.transparentIndex) continue;
        const o = ((frame.y + py) * width + (frame.x + px)) * 4;
        canvas[o] = frame.palette[idx * 3];
        canvas[o + 1] = frame.palette[idx * 3 + 1];
        canvas[o + 2] = frame.palette[idx * 3 + 2];
        canvas[o + 3] = 0xff;
      }
    }
    result.push(canvas.slice());
    if (gce.disposal === 2) {
      for (let py = 0; py < frame.h; py++) {
        for (let px = 0; px < frame.w; px++) {
          const o = ((frame.y + py) * width + (frame.x + px)) * 4;
          canvas.fill(0, o, o + 4);
        }
      }
    } else if (gce.disposal === 3 && snapshot) {
      canvas.set(snapshot);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// test helpers
// ---------------------------------------------------------------------------

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

function framesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// frame i: opaque red square moving across a transparent background
function transparentFrame(i) {
  const data = new Uint8Array(W * H * 4);
  const x0 = 2 + i * 6;
  for (let y = 4; y < 12; y++) {
    for (let x = x0; x < x0 + 8; x++) {
      const o = (y * W + x) * 4;
      data[o] = 0xff;
      data[o + 3] = 0xff;
    }
  }
  return data;
}

function opaqueFrame(r, g, b) {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 0xff;
  }
  return data;
}

function encode(frames) {
  const gif = GIFEncoder();
  for (const { data, opts = {} } of frames) {
    const palette = quantize(data, 256, { format: "rgba4444", oneBitAlpha: true });
    const transparentIndex = palette.findIndex((p) => p[3] === 0);
    const index = applyPalette(data, palette, "rgba4444");
    gif.writeFrame(index, W, H, {
      palette,
      delay: 100,
      transparent: transparentIndex >= 0,
      transparentIndex: Math.max(0, transparentIndex),
      ...opts,
    });
  }
  gif.finish();
  return gif.bytes();
}

// ---------------------------------------------------------------------------
// 1. transparent animation: no residue of previous frames
// ---------------------------------------------------------------------------
{
  const sources = [0, 1, 2, 3].map(transparentFrame);
  const bytes = encode(sources.map((data) => ({ data })));
  const gif = parseGIF(bytes);
  const composited = compositeFrames(gif);
  check("transparent animation: frame count", gif.frames.length === 4);
  check(
    "transparent animation: every frame has transparency + restore-to-background",
    gif.frames.every((f) => f.gce.transparent && f.gce.disposal === 2),
  );
  for (let i = 0; i < sources.length; i++) {
    // quantize/applyPalette is lossless for these flat frames
    check(
      `transparent animation: frame ${i} composites without previous-frame residue`,
      framesEqual(composited[i], sources[i]),
    );
  }
}

// ---------------------------------------------------------------------------
// 2. mixed opaque -> transparent: the transparent frames must be clean
// ---------------------------------------------------------------------------
{
  const base = opaqueFrame(0, 0, 0xff);
  const sources = [transparentFrame(0), transparentFrame(1)];
  const bytes = encode([
    { data: base },
    ...sources.map((data) => ({ data })),
  ]);
  const gif = parseGIF(bytes);
  const composited = compositeFrames(gif);
  check(
    "mixed: opaque frame before transparent frame is cleared from canvas",
    gif.frames[0].gce.disposal === 2,
  );
  for (let i = 0; i < sources.length; i++) {
    check(
      `mixed: transparent frame ${i} shows no opaque-frame residue`,
      framesEqual(composited[i + 1], sources[i]),
    );
  }
}

// ---------------------------------------------------------------------------
// 3. explicit disposal modes are written and composited per spec
// ---------------------------------------------------------------------------
{
  for (const dispose of [0, 1, 2, 3]) {
    const bytes = encode([0, 1, 2].map((i) => ({ data: transparentFrame(i), opts: { dispose } })));
    const gif = parseGIF(bytes);
    check(
      `dispose ${dispose}: written verbatim to every frame`,
      gif.frames.every((f) => f.gce.disposal === dispose),
    );
    // reference compositing of the same source frames under this disposal mode
    const canvas = new Uint8Array(W * H * 4);
    let snapshot = null;
    const composited = compositeFrames(gif);
    let ok = true;
    for (let i = 0; i < 3; i++) {
      if (dispose === 3) snapshot = canvas.slice();
      const src = transparentFrame(i);
      for (let p = 0; p < W * H; p++) {
        if (src[p * 4 + 3] !== 0) canvas.set(src.subarray(p * 4, p * 4 + 4), p * 4);
      }
      if (!framesEqual(composited[i], canvas)) ok = false;
      if (dispose === 2) canvas.fill(0);
      else if (dispose === 3 && snapshot) canvas.set(snapshot);
    }
    check(`dispose ${dispose}: composited frames match reference`, ok);
  }
}

// ---------------------------------------------------------------------------
// 4. explicit accumulation (dispose 1) is preserved, not "fixed"
// ---------------------------------------------------------------------------
{
  const bytes = encode([
    { data: opaqueFrame(0, 0, 0xff) },
    { data: transparentFrame(0), opts: { dispose: 1 } },
    { data: transparentFrame(1), opts: { dispose: 1 } },
  ]);
  const gif = parseGIF(bytes);
  check(
    "accumulation: explicit dispose 1 on transparent frames does not rewrite previous frame",
    gif.frames[0].gce.disposal === 0,
  );
  const composited = compositeFrames(gif);
  // last frame: blue background with both squares accumulated
  const expected = opaqueFrame(0, 0, 0xff);
  for (const i of [0, 1]) {
    const sq = transparentFrame(i);
    for (let p = 0; p < W * H; p++) {
      if (sq[p * 4 + 3] !== 0) expected.set(sq.subarray(p * 4, p * 4 + 4), p * 4);
    }
  }
  check("accumulation: frames accumulate as requested", framesEqual(composited[2], expected));
}

// ---------------------------------------------------------------------------
// 5. opaque animation is unaffected
// ---------------------------------------------------------------------------
{
  const bytes = encode([
    { data: opaqueFrame(0, 0, 0xff) },
    { data: opaqueFrame(0, 0xff, 0) },
  ]);
  const gif = parseGIF(bytes);
  check(
    "opaque: no transparency flag and default disposal on every frame",
    gif.frames.every((f) => !f.gce.transparent && f.gce.disposal === 0),
  );
  const composited = compositeFrames(gif);
  check("opaque: frame 0 composites", framesEqual(composited[0], opaqueFrame(0, 0, 0xff)));
  check("opaque: frame 1 composites", framesEqual(composited[1], opaqueFrame(0, 0xff, 0)));
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall transparency/disposal checks passed");
