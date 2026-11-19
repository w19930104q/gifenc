// End-to-end check on a real image: whole vs chunked output must be byte
// identical, and an independent GIF decoder (omggif) must recover the exact
// indexed pixels that were encoded.
import path from "node:path";
import fs from "node:fs";
import { promisify } from "node:util";
import getPixelsCb from "get-pixels";
import { GifReader } from "omggif";
import { GIFEncoder, quantize, applyPalette } from "../src/index.js";

const getPixels = promisify(getPixelsCb);
const root = path.resolve(import.meta.dirname, "..");

const pixelsImg = await getPixels(
  path.join(root, "test/fixtures/baboon.png"),
);
const data = pixelsImg.data;
const width = pixelsImg.shape[0];
const height = pixelsImg.shape[1];
const format = "rgb444";
const palette = quantize(data, 256, { format });
const index = applyPalette(data, palette, format);

function whole() {
  const gif = GIFEncoder();
  gif.writeFrame(index, width, height, { palette });
  gif.finish();
  return gif.bytes();
}

function chunked(blockSize) {
  const gif = GIFEncoder();
  gif.writeFrameTiles(index, width, height, { palette, blockSize });
  gif.finish();
  return gif.bytes();
}

const expected = whole();
for (const bs of [1, 7, 255, 256, 4096, index.length]) {
  const got = chunked(bs);
  if (got.length !== expected.length || !got.every((v, i) => v === expected[i])) {
    throw new Error(`mismatch at blockSize=${bs}`);
  }
  console.log(`ok - real image, blockSize=${bs}, ${got.length} bytes, identical`);
}

// Independent decode check of a chunk-produced GIF (blockSize=999, odd split)
const bytes = chunked(999);
const reader = new GifReader(Buffer.from(bytes));
if (reader.width !== width || reader.height !== height) {
  throw new Error("decoded dimensions differ");
}
const info = reader.frameInfo(0);
const rgba = new Uint8Array(width * height * 4);
reader.decodeAndBlitFrameRGBA(0, rgba);
// Compare decoded RGB against the palette colors that were indexed.
let mismatches = 0;
for (let i = 0; i < width * height; i++) {
  const [pr, pg, pb] = palette[index[i]];
  if (rgba[i * 4] !== pr || rgba[i * 4 + 1] !== pg || rgba[i * 4 + 2] !== pb) {
    mismatches++;
  }
}
console.log(`ok - omggif decoded frame ${info.width}x${info.height}, pixel mismatches: ${mismatches}`);
if (mismatches !== 0) throw new Error("decoded pixels differ from encoded index");

// Multi-frame animated GIF through the sink path, decoded frame count check
const parts = [];
const anim = GIFEncoder({ output: (c) => parts.push(c) });
const frames = 5;
for (let f = 0; f < frames; f++) {
  anim.writeFrameTiles(
    (off, limit) => index.slice(off, off + Math.min(limit, index.length - off)),
    width,
    height,
    { palette: f === 0 ? palette : undefined, delay: 20, blockSize: 8191 },
  );
}
anim.finish();
const animBytes = parts.reduce((n, p) => n + p.length, 0);
const animReader = new GifReader(Buffer.from(concat(parts)));
console.log(`ok - animated chunked+sink GIF: ${animBytes} bytes, ${animReader.numFrames()} frames`);
if (animReader.numFrames() !== frames) throw new Error("frame count mismatch");
const frgba = new Uint8Array(width * height * 4);
animReader.decodeAndBlitFrameRGBA(2, frgba);
let fm = 0;
for (let i = 0; i < width * height; i++) {
  const [pr, pg, pb] = palette[index[i]];
  if (frgba[i * 4] !== pr || frgba[i * 4 + 1] !== pg || frgba[i * 4 + 2] !== pb) fm++;
}
if (fm !== 0) throw new Error("animated frame pixels mismatch");
console.log("ok - animated frame 2 pixels match source");

fs.mkdirSync(path.join(root, "test/output"), { recursive: true });
fs.writeFileSync(path.join(root, "test/output/chunked.gif"), Buffer.from(bytes));
console.log("\nAll end-to-end checks passed.");

function concat(list) {
  const total = list.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of list) { out.set(p, off); off += p.length; }
  return out;
}
