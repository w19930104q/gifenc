// Per-frame adaptive palette support — verification test.
//
// Verifies:
//   A. (required) Local path pixel consistency: a GIF encoded with a
//      per-frame (local) color table decodes back to exactly the pixels
//      described by each frame's palette + indexed bitmap (within ±1).
//   B. Local palette decode is consistent with the global palette path:
//      the same indexed frames + same color table, encoded once via a
//      global color table and once via per-frame local color tables,
//      decode to the same pixels (within ±1).
//   C. (differentiator) For a frame sequence with distinct per-frame color
//      distributions, adaptive per-frame palettes clearly reduce color
//      error vs. a single shared 256-color palette.
//   D. The global palette path output is unchanged (byte-identical to the
//      recorded reference hash, and deterministic across runs).
//
// Run with: node test/adaptive_palette_node.js

import * as path from "path";
import { promisify } from "util";
import { createHash } from "crypto";
import { writeFile } from "fs/promises";
import getPixelsCb from "get-pixels";
import { GIFEncoder, quantize, applyPalette } from "../src/index.js";

const getPixels = promisify(getPixelsCb);
const __dirname = import.meta.dirname;

const W = 128;
const H = 96;
const FRAMES = 3;
const FORMAT = "rgb565";
const TOLERANCE = 1; // per-channel decode tolerance

// Byte hash of the global-palette path output, recorded from the
// unmodified encoder (commit 27db5b9). Guards "global path output unchanged".
const GLOBAL_PATH_SHA256 =
  "88e4070d503255a1f7c09eb9b7fb070e4aca4872d1f1883b7ae7526978612d52";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

// Each frame lives in a different 2D color plane, so a single shared
// 256-color palette cannot represent all frames well, while a per-frame
// 256-color palette can.
function makeFrame(f) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const u = Math.round((x / (W - 1)) * 255);
      const v = Math.round((y / (H - 1)) * 255);
      let r, g, b;
      if (f === 0) {
        r = u; g = v; b = 32;
      } else if (f === 1) {
        r = 32; g = u; b = v;
      } else {
        r = v; g = 32; b = u;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function mse(decoded, frameIdx, source) {
  let sum = 0;
  const off = frameIdx * W * H * 4;
  for (let i = 0; i < W * H * 4; i++) {
    const d = decoded[off + i] - source[i];
    sum += d * d;
  }
  return sum / (W * H * 4);
}

async function decode(file) {
  const { data, shape } = await getPixels(file);
  if (shape[0] !== FRAMES || shape[1] !== W || shape[2] !== H) {
    throw new Error("unexpected decoded shape " + shape.join("x"));
  }
  return data;
}

const frames = [];
for (let f = 0; f < FRAMES; f++) frames.push(makeFrame(f));

// ---- Global path: one shared 256-color palette for the whole animation ----
const combined = new Uint8Array(W * H * 4 * FRAMES);
frames.forEach((d, i) => combined.set(d, i * W * H * 4));
const globalPalette = quantize(combined, 256, { format: FORMAT });

function encodeGlobal() {
  const gif = GIFEncoder();
  frames.forEach((data, i) => {
    const index = applyPalette(data, globalPalette, FORMAT);
    // palette only on the first frame -> global color table, no local tables
    gif.writeFrame(index, W, H, { palette: i === 0 ? globalPalette : undefined, delay: 100 });
  });
  gif.finish();
  return gif.bytes();
}

const globalBytes = encodeGlobal();
const globalFile = path.resolve(__dirname, "output/adaptive_global.gif");
await writeFile(globalFile, Buffer.from(globalBytes));

// ---- Local path: adaptive per-frame palette on every frame ----
const localPalettes = [];
const localIndexes = [];
function encodeLocal() {
  const gif = GIFEncoder();
  frames.forEach((data, i) => {
    const palette = quantize(data, 256, { format: FORMAT });
    const index = applyPalette(data, palette, FORMAT);
    localPalettes.push(palette);
    localIndexes.push(index);
    gif.writeFrame(index, W, H, { palette, delay: 100 });
  });
  gif.finish();
  return gif.bytes();
}

const localBytes = encodeLocal();
const localFile = path.resolve(__dirname, "output/adaptive_local.gif");
await writeFile(localFile, Buffer.from(localBytes));

const globalDecoded = await decode(globalFile);
const localDecoded = await decode(localFile);

// ---- Check A: local path pixel consistency (required) ----
let mismatches = 0;
for (let f = 0; f < FRAMES; f++) {
  const palette = localPalettes[f];
  const index = localIndexes[f];
  const off = f * W * H * 4;
  for (let p = 0; p < W * H; p++) {
    const expected = palette[index[p]];
    for (let c = 0; c < 3; c++) {
      if (Math.abs(localDecoded[off + p * 4 + c] - expected[c]) > TOLERANCE) {
        mismatches++;
      }
    }
  }
}
check("A. local path decodes to palette[index] for every pixel", mismatches === 0, `${mismatches} mismatches`);

// ---- Check B: local color table decode is consistent with global path ----
// Same palette + same indexed bitmaps, encoded via GCT vs per-frame LCT.
{
  const shared = quantize(combined, 256, { format: FORMAT });
  const indexes = frames.map((d) => applyPalette(d, shared, FORMAT));

  const gifGCT = GIFEncoder();
  indexes.forEach((index, i) => {
    gifGCT.writeFrame(index, W, H, { palette: i === 0 ? shared : undefined, delay: 100 });
  });
  gifGCT.finish();
  const gctFile = path.resolve(__dirname, "output/consistency_gct.gif");
  await writeFile(gctFile, Buffer.from(gifGCT.bytes()));

  const gifLCT = GIFEncoder();
  indexes.forEach((index) => {
    gifLCT.writeFrame(index, W, H, { palette: shared, delay: 100 });
  });
  gifLCT.finish();
  const lctFile = path.resolve(__dirname, "output/consistency_lct.gif");
  await writeFile(lctFile, Buffer.from(gifLCT.bytes()));

  const a = await decode(gctFile);
  const b = await decode(lctFile);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > TOLERANCE) diff++;
  }
  check("B. local palette decode == global palette decode", diff === 0, `${diff} differing channel values`);
}

// ---- Check C: adaptive per-frame palettes clearly reduce color error ----
let gErr = 0;
let lErr = 0;
for (let f = 0; f < FRAMES; f++) {
  gErr += mse(globalDecoded, f, frames[f]);
  lErr += mse(localDecoded, f, frames[f]);
}
const reduction = (gErr - lErr) / gErr;
console.log(`     global path MSE=${gErr.toFixed(2)}  local path MSE=${lErr.toFixed(2)}  reduction=${(reduction * 100).toFixed(1)}%`);
check("C. adaptive per-frame palettes reduce color error", reduction >= 0.3, `${(reduction * 100).toFixed(1)}% reduction`);

// ---- Check D: global path output unchanged ----
const hash = createHash("sha256").update(globalBytes).digest("hex");
const deterministic = createHash("sha256").update(encodeGlobal()).digest("hex") === hash;
check("D1. global path output is deterministic", deterministic);
if (GLOBAL_PATH_SHA256 === "__GOLDEN__") {
  console.log(`     global path sha256: ${hash}`);
  console.log("     (record this hash in GLOBAL_PATH_SHA256 to lock the global path output)");
} else {
  check("D2. global path output unchanged vs reference", hash === GLOBAL_PATH_SHA256, hash);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed.");
