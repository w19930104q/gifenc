// Empirical memory comparison: whole-image path vs chunked+sink path.
// Measures the encoder's internal ArrayBuffer high-water mark while encoding
// a long, large animation.
import { GIFEncoder } from "../src/index.js";

function makeFrame(w, h, seed) {
  const out = new Uint8Array(w * h);
  let s = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = s & 0xff;
  }
  return out;
}

const W = 600;
const H = 400; // 240k pixels/frame
const FRAME_COUNTS = [1, 4, 16, 64];
const palette = Array.from({ length: 256 }, (_, i) => [i, (i * 3) & 255, (i * 7) & 255]);

console.log("frames | whole-path internal buffer (KB) | chunked+sink buffer (KB) | chunked sink output total (KB)");
for (const frames of FRAME_COUNTS) {
  // Whole-image path
  const whole = GIFEncoder();
  for (let f = 0; f < frames; f++) {
    whole.writeFrame(makeFrame(W, H, f + 1), W, H, {
      palette: f === 0 ? palette : undefined,
    });
  }
  whole.finish();
  const wholeResidentKB = Math.round(whole.buffer.byteLength / 1024);
  const outputKB = Math.round(whole.bytes().length / 1024);

  // Chunked path: blockSize 4096 pixels, sink drains every segment
  const blockSize = 4096;
  let highWater = 0;
  let sinkTotal = 0;
  const chunked = GIFEncoder({
    output: (c) => {
      sinkTotal += c.length;
      highWater = Math.max(highWater, chunked.buffer.byteLength);
    },
  });
  for (let f = 0; f < frames; f++) {
    const frame = makeFrame(W, H, f + 1);
    chunked.writeFrameTiles(
      (off, limit) => frame.slice(off, off + Math.min(limit, frame.length - off)),
      W,
      H,
      { palette: f === 0 ? palette : undefined, blockSize },
    );
    highWater = Math.max(highWater, chunked.buffer.byteLength);
  }
  chunked.finish();
  highWater = Math.max(highWater, chunked.buffer.byteLength);

  console.log(
    `${String(frames).padStart(6)} | ${String(wholeResidentKB).padStart(31)} | ${String(Math.round(highWater / 1024)).padStart(24)} | ${String(Math.round(sinkTotal / 1024)).padStart(28)}`,
  );

  // The differentiating invariant:
  // whole path grows with frame count; chunked resident memory stays flat
  // and output totals are equal.
  if (sinkTotal !== whole.bytes().length) {
    throw new Error("sink output size differs from whole-image output size");
  }
  if (highWater > blockSize * 2 + 16384) {
    throw new Error(`chunked resident memory ${highWater} exceeded block-derived cap`);
  }
}

// Also: blockSize=1 must stay bounded on a single large frame
let hw1 = 0;
const g1 = GIFEncoder({ output: () => { hw1 = Math.max(hw1, g1.buffer.byteLength); } });
const big = makeFrame(W, H, 7);
g1.writeFrameTiles(
  (off, limit) => big.slice(off, off + Math.min(limit, big.length - off)),
  W,
  H,
  { palette, blockSize: 1 },
);
g1.finish();
console.log(`\nblockSize=1 resident high-water mark: ${hw1} bytes (frame is ${W * H} pixels)`);
if (hw1 > 20000) throw new Error("blockSize=1 memory unexpectedly high");
console.log("All memory invariants hold.");
