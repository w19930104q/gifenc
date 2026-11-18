// Acceptance test for metadata extensions (loop count, comments,
// custom extensions). Zero-dependency; run with:
//   node test/metadata_node.js
//
// Verifies:
//  1. Byte-identical output vs. the pre-change encoder (from git HEAD)
//     when no metadata APIs are used.
//  2. Deterministic output across runs.
//  3. Metadata blocks land in the stream in call order and can be
//     parsed back (loop count, comments, application/custom extensions).
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { pathToFileURL } from "url";
import { GIFEncoder, parseExtensions } from "../src/index.js";

const __dirname = import.meta.dirname;
const repoRoot = path.resolve(__dirname, "..");

let passed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`ok - ${msg}`);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// --- Fixed test sequence ------------------------------------------------

const WIDTH = 4;
const HEIGHT = 4;
const PALETTE = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
];

// Deterministic indexed bitmaps for 3 frames
function frameIndex(seed) {
  const index = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < index.length; i++) {
    index[i] = (i * 7 + seed * 3) % PALETTE.length;
  }
  return index;
}
const FRAMES = [frameIndex(0), frameIndex(1), frameIndex(2)];

// Encodes the fixed sequence without any metadata (baseline path).
function encodePlain(encoder) {
  encoder.writeFrame(FRAMES[0], WIDTH, HEIGHT, {
    palette: PALETTE,
    delay: 100,
  });
  encoder.writeFrame(FRAMES[1], WIDTH, HEIGHT, { delay: 200 });
  encoder.writeFrame(FRAMES[2], WIDTH, HEIGHT, {
    delay: 300,
    transparent: true,
    transparentIndex: 2,
  });
  encoder.finish();
  return encoder.bytes();
}

// --- 1. Byte-identical output vs. pre-change encoder ---------------------

// Extract the original (pre-change) sources from git HEAD into a temp dir
const baselineDir = path.join(
  os.tmpdir(),
  `gifenc-baseline-${process.pid}`,
);
mkdirSync(path.join(baselineDir, "src"), { recursive: true });
const srcFiles = [
  "color.js",
  "constants.js",
  "index.js",
  "lzwEncode.js",
  "palettize.js",
  "pnnquant2.js",
  "rgb-packing.js",
  "stream.js",
];
for (const file of srcFiles) {
  const content = execFileSync("git", ["show", `HEAD:src/${file}`], {
    cwd: repoRoot,
  });
  writeFileSync(path.join(baselineDir, "src", file), content);
}
const baselineModule = await import(
  pathToFileURL(path.join(baselineDir, "src", "index.js")).href
);
const baselineBytes = encodePlain(baselineModule.GIFEncoder());
rmSync(baselineDir, { recursive: true, force: true });

const plainBytes = encodePlain(GIFEncoder());
assert(
  bytesEqual(baselineBytes, plainBytes),
  "no-metadata output is byte-identical to pre-change encoder",
);

const plainBytes2 = encodePlain(GIFEncoder());
assert(bytesEqual(plainBytes, plainBytes2), "encoding is deterministic");

// --- 2. Metadata round-trip ----------------------------------------------

const APP_DATA = new Uint8Array(300);
for (let i = 0; i < APP_DATA.length; i++) APP_DATA[i] = (i * 13) & 0xff;

const gif = GIFEncoder();
gif.writeFrame(FRAMES[0], WIDTH, HEIGHT, {
  palette: PALETTE,
  delay: 100,
  repeat: -1, // skip the automatic NETSCAPE block; we write it manually below
  comment: "frame one",
});
gif.writeComment("file comment © 2026");
gif.writeFrame(FRAMES[1], WIDTH, HEIGHT, { delay: 200 });
gif.writeApplicationExt("TESTAPP1", "001", APP_DATA);
gif.writeLoopExt(5);
gif.writeExtension(0xce, "custom-payload");
gif.writeFrame(FRAMES[2], WIDTH, HEIGHT, {
  delay: 300,
  transparent: true,
  transparentIndex: 2,
});
gif.finish();
const metaBytes = gif.bytes();

assert(!bytesEqual(metaBytes, plainBytes), "metadata changes the output");

const meta = parseExtensions(metaBytes);

assert(meta.header === "GIF89a", "header parsed");
assert(
  meta.width === WIDTH && meta.height === HEIGHT,
  "logical screen size parsed",
);
assert(meta.frames === 3, "all 3 frames walked");
assert(meta.repeat === 5, "loop count read back (repeat === 5)");
assert(
  meta.comments.length === 2 &&
    meta.comments[0] === "frame one" &&
    meta.comments[1] === "file comment © 2026",
  "comments read back in order (incl. UTF-8)",
);
assert(
  meta.applications.length === 2 &&
    meta.applications[0].identifier === "TESTAPP1" &&
    meta.applications[0].authCode === "001" &&
    bytesEqual(meta.applications[0].data, APP_DATA),
  "application extension read back (300 bytes across sub-blocks)",
);
assert(
  meta.applications[1].identifier === "NETSCAPE" &&
    meta.applications[1].authCode === "2.0",
  "NETSCAPE2.0 application extension parsed",
);
assert(
  meta.extensions.length === 1 &&
    meta.extensions[0].label === 0xce &&
    new TextDecoder().decode(meta.extensions[0].data) === "custom-payload",
  "custom extension read back",
);

// Block order must mirror the encoding flow exactly
const expectedOrder = [
  "comment", // per-frame comment on frame 1
  "graphic-control",
  "image",
  "comment", // standalone file comment
  "graphic-control",
  "image",
  "application", // TESTAPP1
  "application", // NETSCAPE2.0 loop
  "extension", // custom 0xCE
  "graphic-control",
  "image",
  "trailer",
];
const actualOrder = meta.blocks.map((b) => b.type);
assert(
  JSON.stringify(actualOrder) === JSON.stringify(expectedOrder),
  `block order matches encoding flow (${actualOrder.join(",")})`,
);

const gceDelays = meta.blocks
  .filter((b) => b.type === "graphic-control")
  .map((b) => b.delay);
assert(
  JSON.stringify(gceDelays) === JSON.stringify([10, 20, 30]),
  "graphic control delays intact",
);

// --- 3. Manual mode + metadata -------------------------------------------

const manual = GIFEncoder({ auto: false });
manual.writeHeader();
manual.writeFrame(FRAMES[0], WIDTH, HEIGHT, {
  first: true,
  palette: PALETTE,
  repeat: 3,
  delay: 50,
});
manual.writeComment("between frames");
manual.writeFrame(FRAMES[1], WIDTH, HEIGHT, { delay: 50 });
manual.finish();
const manualMeta = parseExtensions(manual.bytes());
assert(
  manualMeta.repeat === 3 &&
    manualMeta.comments.length === 1 &&
    manualMeta.comments[0] === "between frames" &&
    manualMeta.frames === 2,
  "manual mode: metadata interleaves with frames",
);

// --- 4. Metadata-free output unchanged by parser additions ---------------

const stillPlain = encodePlain(GIFEncoder());
assert(
  bytesEqual(stillPlain, baselineBytes),
  "output still byte-identical after all tests",
);

console.log(`\nAll ${passed} assertions passed.`);
