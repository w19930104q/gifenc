// Dependency-free verification of the frame-delay time base and loop-count
// semantics emitted by GIFEncoder. Run with: node --test test/semantics_test.js
//
// The tests parse the encoded GIF bytes directly (GCE delay fields and the
// NETSCAPE2.0 application extension) so they validate what a standards-
// compliant player would actually consume.
import test from "node:test";
import assert from "node:assert/strict";
import { GIFEncoder } from "../src/index.js";

// Minimal 2x2 indexed frame with a 4-entry RGB global palette.
const WIDTH = 2;
const HEIGHT = 2;
const PALETTE = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];
const INDEX = new Uint8Array([0, 1, 2, 3]);

function encodeGif(frames) {
  const gif = GIFEncoder();
  for (const opts of frames) {
    gif.writeFrame(INDEX, WIDTH, HEIGHT, { palette: PALETTE, ...opts });
  }
  gif.finish();
  return gif.bytes();
}

// Parse GCE delays (centiseconds) and the NETSCAPE2.0 loop field.
// Returns { delays: number[], loopCount: number|null }
// (null means the NETSCAPE extension is absent, i.e. play exactly once).
function parseTiming(bytes) {
  const delays = [];
  let loopCount = null;
  let i = 0;
  assert.equal(String.fromCharCode(...bytes.subarray(0, 6)), "GIF89a");
  i = 6;
  // Skip Logical Screen Descriptor (7 bytes); the packed byte tells us the
  // size of the Global Color Table that follows it.
  const lsdPacked = bytes[i + 4];
  i += 7;
  if (lsdPacked & 0x80) {
    const gctSize = 2 ** ((lsdPacked & 0x07) + 1);
    i += gctSize * 3;
  }
  while (i < bytes.length) {
    const b = bytes[i++];
    if (b === 0x3b) break; // trailer
    if (b === 0x2c) {
      // image descriptor: 9 fixed bytes, optional local color table, then
      // LZW data sub-blocks which we skip via the block terminator.
      i += 9;
      const packed = bytes[i - 1];
      if (packed & 0x80) {
        const tableSize = 2 ** ((packed & 0x07) + 1);
        i += tableSize * 3;
      }
      i += 1; // LZW minimum code size
      while (bytes[i] !== 0) {
        i += bytes[i] + 1;
      }
      i += 1; // block terminator
    } else if (b === 0x21) {
      const label = bytes[i++];
      if (label === 0xf9) {
        // Graphic Control Extension: block size (4) + 4 body bytes
        // (packed, delay lo, delay hi, transparent index) + terminator
        assert.equal(bytes[i], 4); // block size
        i += 2; // skip block size + packed fields
        const delay = bytes[i] | (bytes[i + 1] << 8);
        delays.push(delay);
        i += 4; // delay (2) + transparent index (1) + block terminator (1)
      } else if (label === 0xff) {
        // Application Extension: inspect for NETSCAPE2.0 loop sub-block
        const blockSize = bytes[i];
        const appId = String.fromCharCode(
          ...bytes.subarray(i + 1, i + 1 + blockSize),
        );
        i += blockSize + 1;
        if (appId === "NETSCAPE2.0") {
          assert.equal(bytes[i], 3); // sub-block size
          assert.equal(bytes[i + 1], 1); // loop sub-block id
          loopCount = bytes[i + 2] | (bytes[i + 3] << 8);
          i += 4;
        }
        while (bytes[i] !== 0) i += bytes[i] + 1;
        i += 1; // block terminator
      } else {
        while (bytes[i] !== 0) i += bytes[i] + 1;
        i += 1;
      }
    }
  }
  return { delays, loopCount };
}

test("default semantics are unchanged: repeat=0 writes loop field 0, delay=0", () => {
  const { delays, loopCount } = parseTiming(encodeGif([{}]));
  assert.equal(loopCount, 0); // 0 = loop forever
  assert.deepEqual(delays, [0]);
});

test("delay milliseconds are converted to GIF centiseconds (1/100 s)", () => {
  const { delays } = parseTiming(
    encodeGif([
      { delay: 100 },
      { delay: 250 },
      { delay: 33 }, // 3.3 cs -> rounded
      { delay: 37 }, // 3.7 cs -> rounded
      { delay: 1 }, // sub-centisecond rounds to 0, same as a 0-delay frame
    ]),
  );
  assert.deepEqual(delays, [10, 25, 3, 4, 0]);
});

test("arbitrary delay sequence: oversized delays clamp to u16 max instead of wrapping", () => {
  // Without clamping, 700000 ms -> 4464 cs (u16 wrap); must become 65535.
  const { delays } = parseTiming(
    encodeGif([{ delay: 700000 }, { delay: 655350 }, { delay: 655360 }]),
  );
  assert.deepEqual(delays, [65535, 65535, 65535]);
});

test("arbitrary delay sequence: negative and non-finite delays are well-defined", () => {
  // Without clamping, -50 ms would wrap to 65535 cs (~11 minutes).
  // +Infinity clamps to the longest representable delay; -Infinity/NaN -> 0.
  const { delays } = parseTiming(
    encodeGif([
      { delay: -50 },
      { delay: -1 },
      { delay: NaN },
      { delay: -Infinity },
      { delay: Infinity },
    ]),
  );
  assert.deepEqual(delays, [0, 0, 0, 0, 65535]);
});

test("every frame in a mixed delay sequence keeps its own timing", () => {
  const sequence = [0, 10, 500, 999, 1000, 4242, 655350, 700000, -100];
  const { delays } = parseTiming(encodeGif(sequence.map((delay) => ({ delay }))));
  assert.equal(delays.length, sequence.length);
  assert.deepEqual(
    delays,
    sequence.map((d) => {
      const cs = Math.round(d / 10);
      if (cs === Infinity) return 0xffff;
      if (!Number.isFinite(cs) || cs < 0) return 0;
      return Math.min(cs, 0xffff);
    }),
  );
});

test("repeat: -1 and 1 mean play once, so no NETSCAPE block is emitted", () => {
  for (const repeat of [-1, 1]) {
    const { loopCount, delays } = parseTiming(
      encodeGif([{ repeat, delay: 100 }, { delay: 100 }]),
    );
    assert.equal(loopCount, null, `repeat=${repeat} should omit the extension`);
    assert.deepEqual(delays, [10, 10]);
  }
});

test("repeat: N>1 maps total plays to N-1 extra iterations", () => {
  const cases = [
    [2, 1],
    [3, 2],
    [5, 4],
    [10, 9],
    [65536, 65535], // clamps to u16 max
    [1000000, 65535],
  ];
  for (const [repeat, expectedField] of cases) {
    const { loopCount } = parseTiming(encodeGif([{ repeat }]));
    assert.equal(loopCount, expectedField, `repeat=${repeat}`);
  }
});

test("repeat: fractional values floor to a whole play count", () => {
  assert.equal(parseTiming(encodeGif([{ repeat: 2.9 }])).loopCount, 1);
  assert.equal(parseTiming(encodeGif([{ repeat: 1.9 }])).loopCount, null);
});

test("repeat: non-finite and below -1 behave as play once", () => {
  for (const repeat of [-2, -100]) {
    assert.equal(parseTiming(encodeGif([{ repeat }])).loopCount, null);
  }
});

test("repeat option on later frames is ignored; only the first frame controls looping", () => {
  const gif = GIFEncoder();
  gif.writeFrame(INDEX, WIDTH, HEIGHT, { palette: PALETTE, repeat: 3 });
  gif.writeFrame(INDEX, WIDTH, HEIGHT, { repeat: 0, delay: 200 });
  gif.finish();
  const { loopCount, delays } = parseTiming(gif.bytes());
  assert.equal(loopCount, 2); // 3 total plays -> 2 extra iterations
  assert.deepEqual(delays, [0, 20]);
});
