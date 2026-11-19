// Zero-dependency tests for chunked/tile encoding.
// Run: node test/chunked_test.js
import assert from "node:assert/strict";
import { GIFEncoder, createLZWStream } from "../src/index.js";
import lzwEncode from "../src/lzwEncode.js";
import createStream from "../src/stream.js";

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// Deterministic pseudo-random indexed frame data
function makeIndex(width, height, maxIndex, seed = 1) {
  const out = new Uint8Array(width * height);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s % maxIndex;
  }
  return out;
}

function makePalette(n) {
  const pal = [];
  for (let i = 0; i < n; i++) pal.push([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255]);
  return pal;
}

function encodeWhole(frames, opts = {}) {
  const gif = GIFEncoder(opts);
  for (const f of frames) {
    gif.writeFrame(f.index, f.width, f.height, f.opts);
  }
  gif.finish();
  return gif.bytes();
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- 1. LZW streaming state machine is byte-identical to lzwEncode ----------
test("lzw stream: every chunk split matches whole-image LZW output", () => {
  const width = 47;
  const height = 31;
  const pixels = makeIndex(width, height, 200, 42);
  const depth = 8;

  const expected = lzwEncode(width, height, pixels, depth, createStream(512));

  for (const chunkSize of [1, 2, 3, 7, 16, 100, pixels.length, pixels.length + 50]) {
    const s = createStream(512);
    const lzw = createLZWStream(depth, s);
    for (let off = 0; off < pixels.length; off += chunkSize) {
      lzw.write(pixels, off, Math.min(chunkSize, pixels.length - off));
    }
    lzw.end();
    const got = s.bytesView();
    assert.equal(got.length, expected.length, `length mismatch at chunkSize=${chunkSize}`);
    assert.deepEqual(got.slice(), expected.slice(), `bytes mismatch at chunkSize=${chunkSize}`);
  }

  // Single write() + end() must also match
  const s2 = createStream(512);
  const lzw2 = createLZWStream(depth, s2);
  lzw2.write(pixels);
  lzw2.end();
  assert.deepEqual(s2.bytesView().slice(), expected.slice());

  // Empty writes between chunks must not alter the output
  const s3 = createStream(512);
  const lzw3 = createLZWStream(depth, s3);
  lzw3.write(pixels, 0, 10);
  lzw3.write(pixels, 0, 0);
  lzw3.write(pixels, 10, pixels.length - 10);
  lzw3.end();
  assert.deepEqual(s3.bytesView().slice(), expected.slice());
});

test("lzw stream: zero-pixel frame matches whole-image behavior", () => {
  const expected = lzwEncode(0, 0, new Uint8Array(0), 8, createStream(16));
  const s = createStream(16);
  const lzw = createLZWStream(8, s);
  lzw.end();
  assert.deepEqual(s.bytesView().slice(), expected.slice());
});

// ---------- 2. Full GIF: chunked frame path byte-identical to whole path ----------
function buildFrames() {
  const palA = makePalette(16);
  const palB = makePalette(64);
  return [
    { width: 53, height: 29, index: makeIndex(53, 29, 16, 1), opts: { palette: palA, delay: 100, repeat: 0 } },
    { width: 53, height: 29, index: makeIndex(53, 29, 64, 2), opts: { palette: palB, delay: 50 } },
    { width: 53, height: 29, index: makeIndex(53, 29, 64, 3), opts: { delay: 20, transparent: true, transparentIndex: 3, dispose: 2 } },
  ];
}

test("writeFrameStart/Chunk/End: identical bytes for every block size", () => {
  const frames = buildFrames();
  const expected = encodeWhole(frames);

  for (const blockSize of [1, 2, 5, 37, 255, 256, 1000, 53 * 29]) {
    const gif = GIFEncoder();
    for (const f of frames) {
      gif.writeFrameStart(f.width, f.height, f.opts);
      for (let off = 0; off < f.index.length; off += blockSize) {
        gif.writeFrameChunk(f.index, off, Math.min(blockSize, f.index.length - off));
      }
      gif.writeFrameEnd();
    }
    gif.finish();
    const got = gif.bytes();
    assert.equal(got.length, expected.length, `length mismatch blockSize=${blockSize}`);
    assert.deepEqual(got.slice(), expected.slice(), `bytes mismatch blockSize=${blockSize}`);
  }
});

test("writeFrameTiles (pull): identical bytes for every block size", () => {
  const frames = buildFrames();
  const expected = encodeWhole(frames);

  for (const blockSize of [1, 3, 64, 777, 53 * 29 + 1]) {
    const gif = GIFEncoder();
    for (const f of frames) {
      gif.writeFrameTiles(f.index, f.width, f.height, { ...f.opts, blockSize });
    }
    gif.finish();
    assert.deepEqual(gif.bytes().slice(), expected.slice(), `mismatch blockSize=${blockSize}`);
  }
});

test("writeFrameTiles (push callback): identical bytes, chunks never exceed blockSize", () => {
  const frames = buildFrames();
  const expected = encodeWhole(frames);
  const blockSize = 123;

  const gif = GIFEncoder();
  for (const f of frames) {
    gif.writeFrameTiles(
      (offset, limit) => {
        assert.ok(limit <= blockSize);
        const len = Math.min(limit, f.index.length - offset);
        // Return a *freshly allocated* small array: the whole frame never resides here
        return f.index.slice(offset, offset + len);
      },
      f.width,
      f.height,
      { ...f.opts, blockSize },
    );
  }
  gif.finish();
  assert.deepEqual(gif.bytes().slice(), expected.slice());
});

test("auto:false manual mode chunked output matches manual whole output", () => {
  const frames = buildFrames();
  const whole = GIFEncoder({ auto: false });
  whole.writeHeader();
  frames.forEach((f, i) => whole.writeFrame(f.index, f.width, f.height, { ...f.opts, first: i === 0 }));
  whole.finish();
  const expected = whole.bytes();

  const chunked = GIFEncoder({ auto: false });
  chunked.writeHeader();
  frames.forEach((f, i) => {
    chunked.writeFrameStart(f.width, f.height, { ...f.opts, first: i === 0 });
    chunked.writeFrameChunk(f.index);
    chunked.writeFrameEnd();
  });
  chunked.finish();
  assert.deepEqual(chunked.bytes().slice(), expected.slice());
});

test("single-frame still image matches across paths", () => {
  const pal = makePalette(256);
  const index = makeIndex(64, 48, 256, 9);
  const a = encodeWhole([{ width: 64, height: 48, index, opts: { palette: pal } }]);
  const gif = GIFEncoder();
  gif.writeFrameTiles(index, 64, 48, { palette: pal, blockSize: 333 });
  gif.finish();
  assert.deepEqual(gif.bytes().slice(), a.slice());
});

// ---------- 3. Sink / drain: output identical + resident memory bounded ----------
test("output sink: concatenated chunks are identical to buffered output", () => {
  const frames = buildFrames();
  const expected = encodeWhole(frames);

  const parts = [];
  const gif = GIFEncoder({ output: (c) => parts.push(c) });
  for (const f of frames) {
    gif.writeFrameTiles(f.index, f.width, f.height, { ...f.opts, blockSize: 97 });
  }
  gif.finish();
  // After a finish() everything must have been drained
  assert.equal(gif.bytesView().length, 0);
  assert.deepEqual(concat(parts).slice(), expected.slice());
});

test("drain() between frames yields identical output", () => {
  const frames = buildFrames();
  const expected = encodeWhole(frames);

  const gif = GIFEncoder();
  const parts = [];
  for (const f of frames) {
    gif.writeFrameTiles(f.index, f.width, f.height, { ...f.opts, blockSize: 200 });
    parts.push(gif.drain());
  }
  gif.finish();
  parts.push(gif.drain());
  assert.deepEqual(concat(parts).slice(), expected.slice());
  assert.equal(gif.bytesView().length, 0);
});

test("peak resident memory is bounded by the block cap, not by frame count/size", () => {
  // Large, many frames; whole-image path grows, chunked+sink stays flat.
  const width = 400;
  const height = 300; // 120k pixels/frame
  const frameCount = 12;
  const blockSize = 4096;
  const pal = makePalette(256);

  let maxResident = 0;
  const parts = [];
  const gif = GIFEncoder({
    output: (c) => {
      parts.push(c.length);
      maxResident = Math.max(maxResident, gif.buffer.byteLength);
    },
  });

  for (let fr = 0; fr < frameCount; fr++) {
    const full = makeIndex(width, height, 256, fr + 1);
    gif.writeFrameTiles(
      (offset, limit) => full.slice(offset, offset + Math.min(limit, full.length - offset)),
      width,
      height,
      { palette: fr === 0 ? pal : undefined, delay: 10, blockSize },
    );
    maxResident = Math.max(maxResident, gif.buffer.byteLength);
  }
  gif.finish();

  // Conservative analytic bound: the encoder buffer holds at most one segment
  // (frame header + one block's worth of compressed bytes), drained each time.
  // GIF image data expands by <= ~1.08x; give generous slack for headers.
  const bound = blockSize * 2 + 8192;
  assert.ok(
    maxResident <= bound,
    `resident buffer ${maxResident} exceeded block-derived bound ${bound}`,
  );

  // And crucially, it is far smaller than what whole-image encoding requires:
  // the final whole-image output alone is many times the bound.
  const whole = encodeWhole(
    Array.from({ length: frameCount }, (_, fr) => ({
      width,
      height,
      index: makeIndex(width, height, 256, fr + 1),
      opts: { palette: fr === 0 ? pal : undefined, delay: 10 },
    })),
  );
  assert.ok(whole.length > maxResident * 4, "whole-image output should dwarf resident chunk memory");
});

// ---------- 4. Produced GIFs are structurally valid and decodable ----------
test("chunked output is a valid GIF with a trailer and full image descriptor", () => {
  const frames = buildFrames();
  const gif = GIFEncoder();
  for (const f of frames) gif.writeFrameTiles(f.index, f.width, f.height, { ...f.opts, blockSize: 17 });
  gif.finish();
  const b = gif.bytes();

  assert.equal(String.fromCharCode(...b.subarray(0, 6)), "GIF89a");
  assert.equal(b[b.length - 1], 0x3b); // trailer
  // Logical screen descriptor carries full frame dimensions
  assert.equal(b[6] | (b[7] << 8), 53);
  assert.equal(b[8] | (b[9] << 8), 29);

  // Structural parse: count image descriptors (0x2c introducers) and walk
  // every sub-block, proving the stream decodes cleanly end-to-end and that
  // tiling does not split the frame into multiple GIF images.
  let p = 13; // header(6) + LSD(7)
  const gctSize = 1 << ((b[10] & 0x07) + 1);
  p += gctSize * 3;
  let images = 0;
  const imageRects = [];
  while (p < b.length) {
    const intro = b[p++];
    if (intro === 0x3b) break; // trailer
    if (intro === 0x21) {
      // extension: label + sub-blocks
      p++; // label
      while (b[p] !== 0) p += b[p] + 1;
      p++; // terminator
    } else if (intro === 0x2c) {
      images++;
      const x = b[p] | (b[p + 1] << 8);
      const y = b[p + 2] | (b[p + 3] << 8);
      const w = b[p + 4] | (b[p + 5] << 8);
      const h = b[p + 6] | (b[p + 7] << 8);
      imageRects.push([x, y, w, h]);
      const packed = b[p + 8];
      p += 9;
      if (packed & 0x80) p += (1 << ((packed & 0x07) + 1)) * 3; // local color table
      p++; // LZW minimum code size
      while (b[p] !== 0) p += b[p] + 1; // image data sub-blocks
      p++; // block terminator
    } else {
      assert.fail(`unexpected GIF introducer 0x${intro.toString(16)} at ${p - 1}`);
    }
  }
  assert.equal(p, b.length, "parser consumed the whole file up to the trailer");
  assert.equal(images, frames.length);
  for (const [x, y, w, h] of imageRects) {
    assert.deepEqual([x, y, w, h], [0, 0, 53, 29], "each image descriptor covers the full frame");
  }
});

// ---------- 5. Error paths and lifecycle guards ----------
test("lifecycle guards and error paths", () => {
  const pal = makePalette(8);
  const index = makeIndex(4, 4, 8);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameChunk(index);
  }, /writeFrameStart/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameEnd();
  }, /without writeFrameStart/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.writeFrameStart(4, 4, { palette: pal });
  }, /already in progress/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.writeFrame(index, 4, 4, { palette: pal });
  }, /chunked frame/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.writeFrameChunk(index, 0, 15);
    g.writeFrameEnd();
  }, /incomplete/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.writeFrameChunk(index);
    g.writeFrameChunk(index, 0, 1); // over total
  }, /more pixels/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.finish();
  }, /in progress/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameStart(4, 4, { palette: pal });
    g.drain();
  }, /in progress/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameTiles(index, 4, 4, { palette: pal, blockSize: 0 });
  }, /blockSize/);

  assert.throws(() => {
    const g = GIFEncoder();
    g.writeFrameTiles(() => null, 4, 4, { palette: pal, blockSize: 4 });
  }, /no data/);

  // After a failed tiles() call the encoder is usable again (state cleaned)
  const g2 = GIFEncoder();
  assert.throws(() => g2.writeFrameTiles(() => null, 4, 4, { palette: pal, blockSize: 4 }));
  g2.writeFrame(index, 4, 4, { palette: pal });
  g2.finish();
  assert.ok(g2.bytes().length > 0);

  // LZW stream guards
  const lzw = createLZWStream(8, createStream(8));
  lzw.write(index);
  lzw.end();
  assert.throws(() => lzw.write(index), /after end/);
});

test("reset() clears chunked frame state and allows reuse", () => {
  const pal = makePalette(8);
  const g = GIFEncoder();
  g.writeFrameStart(4, 4, { palette: pal });
  g.reset();
  g.writeFrame(makeIndex(4, 4, 8), 4, 4, { palette: pal });
  g.finish();
  assert.ok(g.bytes().length > 0);
});

test("randomized chunk splits across many frames always match", () => {
  const pal = makePalette(256);
  const sizes = [
    [1, 1], [1, 7], [7, 1], [13, 1], [1, 13], [33, 17], [64, 64], [100, 3],
  ];
  for (const [w, h] of sizes) {
    // Each size gets its own GIF: the logical screen descriptor is fixed by
    // the first frame's dimensions.
    const frames = [
      { width: w, height: h, index: makeIndex(w, h, 256, w * 31 + h), opts: { palette: pal, delay: 10 } },
      { width: w, height: h, index: makeIndex(w, h, 128, w * 17 + h + 99), opts: { palette: makePalette(128), delay: 20, transparent: true, transparentIndex: 5 } },
    ];
    const expected = encodeWhole(frames);
    for (let trial = 0; trial < 8; trial++) {
      const g = GIFEncoder();
      for (const f of frames) {
        g.writeFrameStart(w, h, f.opts);
        let off = 0;
        while (off < f.index.length) {
          // Arbitrary positive step, including 1 and overshooting the end
          const step = 1 + Math.floor(Math.random() * (f.index.length * 2 + 1));
          const len = Math.min(step, f.index.length - off);
          g.writeFrameChunk(f.index, off, len);
          off += len;
        }
        g.writeFrameEnd();
      }
      g.finish();
      assert.deepEqual(g.bytes().slice(), expected.slice(), `mismatch ${w}x${h} trial ${trial}`);
    }
  }
});

test("non-default colorDepth and chunked output still match", () => {
  const pal = makePalette(4);
  const index = makeIndex(20, 12, 4, 55);
  const whole = GIFEncoder();
  whole.writeFrame(index, 20, 12, { palette: pal, colorDepth: 2 });
  whole.finish();

  for (const bs of [1, 3, 50, index.length]) {
    const g = GIFEncoder();
    g.writeFrameTiles(index, 20, 12, { palette: pal, colorDepth: 2, blockSize: bs });
    g.finish();
    assert.deepEqual(g.bytes().slice(), whole.bytes().slice(), `colorDepth=2 bs=${bs}`);
  }
});

test("LZW table-clear boundary is handled across chunk boundaries", () => {
  // A frame large and diverse enough to force one or more 12-bit table clears;
  // split at every possible small boundary around the clear point.
  const w = 300;
  const h = 200;
  const pixels = makeIndex(w, h, 256, 1234);
  const expected = lzwEncode(w, h, pixels, 8, createStream(512));

  for (const bs of [1, 2, 4, 8, 256, 1024, 4095, 4096, 4097, 10000]) {
    const s = createStream(512);
    const lzw = createLZWStream(8, s);
    for (let off = 0; off < pixels.length; off += bs) {
      lzw.write(pixels, off, Math.min(bs, pixels.length - off));
    }
    lzw.end();
    assert.deepEqual(s.bytesView().slice(), expected.slice(), `clear-boundary bs=${bs}`);
  }
});

test("blockSize larger than the frame is equivalent to one chunk", () => {
  const pal = makePalette(8);
  const index = makeIndex(5, 5, 8);
  const expected = encodeWhole([{ width: 5, height: 5, index, opts: { palette: pal } }]);
  const g = GIFEncoder();
  g.writeFrameTiles(index, 5, 5, { palette: pal, blockSize: 10 ** 9 });
  g.finish();
  assert.deepEqual(g.bytes().slice(), expected.slice());
});

test("sink mode also works with the low-level chunk lifecycle", () => {
  const pal = makePalette(16);
  const frames = buildFrames().map((f) => ({ ...f, opts: { ...f.opts, palette: f.opts.palette || pal } }));
  const expected = encodeWhole(frames);

  const parts = [];
  const g = GIFEncoder({ output: (c) => parts.push(c) });
  for (const f of frames) {
    g.writeFrameStart(f.width, f.height, f.opts);
    g.writeFrameChunk(f.index, 0, 400);
    g.writeFrameChunk(f.index, 400);
    g.writeFrameEnd();
  }
  g.finish();
  assert.deepEqual(concat(parts).slice(), expected.slice());
});

console.log(`\nAll ${passed} tests passed.`);
