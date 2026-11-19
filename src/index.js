import constants from "./constants.js";
import lzwEncode from "./lzwEncode.js";
import createStream from "./stream.js";
import quantize from "./pnnquant2.js";

import {
  prequantize,
  applyPalette,
  nearestColorIndex,
  nearestColor,
  nearestColorIndexWithDistance,
  snapColorsToPalette,
} from "./palettize.js";

function GIFEncoder(opt = {}) {
  const { initialCapacity = 4096, auto = true } = opt;

  // Stream all encoded data into this buffer
  const stream = createStream(initialCapacity);

  // Shared array data across all frames
  const HSIZE = 5003; // 80% occupancy
  const accum = new Uint8Array(256);
  const htab = new Int32Array(HSIZE);
  const codetab = new Int32Array(HSIZE);

  let hasInit = false;

  return {
    reset() {
      stream.reset();
      hasInit = false;
    },
    finish() {
      stream.writeByte(constants.trailer);
    },
    bytes() {
      return stream.bytes();
    },
    bytesView() {
      return stream.bytesView();
    },
    get buffer() {
      return stream.buffer;
    },
    get stream() {
      return stream;
    },
    writeHeader,
    writeFrame(index, width, height, opts = {}) {
      const {
        transparent = false,
        transparentIndex = 0x00,
        delay = 0, // frame delay in milliseconds
        palette = null,
        repeat = 0, // total plays: -1 or 1 = once, 0 = forever, N > 1 = repeat N times
        colorDepth = 8,
        dispose = -1,
      } = opts;

      let first = false;
      if (auto) {
        // In 'auto' mode, the first time we write a frame
        // we will write LSD/GCT/EXT
        if (!hasInit) {
          // have not yet init, we can consider this our first frame
          first = true;
          // in 'auto' mode, we also encode a header on first frame
          // this is different than manual mode where you must encode
          // header yoursef (or perhaps not write header altogether)
          writeHeader();
          hasInit = true;
        }
      } else {
        // in manual mode, the first frame is determined by the options only
        first = Boolean(opts.first);
      }

      width = Math.max(0, Math.floor(width));
      height = Math.max(0, Math.floor(height));

      // Write pre-frame details such as repeat count and global palette
      if (first) {
        if (!palette) {
          throw new Error("First frame must include a { palette } option");
        }
        encodeLogicalScreenDescriptor(
          stream,
          width,
          height,
          palette,
          colorDepth,
        );
        encodeColorTable(stream, palette);
        // The NETSCAPE2.0 loop field counts *extra* iterations beyond the
        // first play (0 = loop forever), while the public `repeat` option is
        // expressed in total plays (-1/1 = once, 0 = forever, N > 1 = N
        // plays). Only emit the extension when there is something to encode;
        // a play-once animation simply omits the block.
        const loopCount = toNetscapeLoopCount(repeat);
        if (loopCount >= 0) {
          encodeNetscapeExt(stream, loopCount);
        }
      }

      // GIF frame delays are unsigned 16-bit values in hundredths of a second,
      // so convert the millisecond input and clamp it to the legal range.
      // Clamping (instead of letting writeUInt16 truncate) keeps playback
      // timing identical across players for any delay sequence.
      const delayTime = toGifDelay(delay);
      encodeGraphicControlExt(
        stream,
        dispose,
        delayTime,
        transparent,
        transparentIndex,
      );

      const useLocalColorTable = Boolean(palette) && !first;
      encodeImageDescriptor(
        stream,
        width,
        height,
        useLocalColorTable ? palette : null,
      );
      if (useLocalColorTable) encodeColorTable(stream, palette);
      encodePixels(
        stream,
        index,
        width,
        height,
        colorDepth,
        accum,
        htab,
        codetab,
      );
    },
  };

  function writeHeader() {
    writeUTFBytes(stream, "GIF89a");
  }
}

function encodeGraphicControlExt(
  stream,
  dispose,
  delay,
  transparent,
  transparentIndex,
) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(0xf9); // GCE label
  stream.writeByte(4); // data block size

  if (transparentIndex < 0) {
    transparentIndex = 0x00;
    transparent = false;
  }

  var transp, disp;
  if (!transparent) {
    transp = 0;
    disp = 0; // dispose = no action
  } else {
    transp = 1;
    disp = 2; // force clear if using transparent color
  }

  if (dispose >= 0) {
    disp = dispose & 7; // user override
  }

  disp <<= 2;

  const userInput = 0;

  // packed fields
  stream.writeByte(
    0 | // 1:3 reserved
      disp | // 4:6 disposal
      userInput | // 7 user input - 0 = none
      transp, // 8 transparency flag
  );

  writeUInt16(stream, delay); // delay x 1/100 sec
  stream.writeByte(transparentIndex || 0x00); // transparent color index
  stream.writeByte(0); // block terminator
}

function encodeLogicalScreenDescriptor(
  stream,
  width,
  height,
  palette,
  colorDepth = 8,
) {
  const globalColorTableFlag = 1;
  const sortFlag = 0;
  const globalColorTableSize = colorTableSize(palette.length) - 1;
  const fields =
    (globalColorTableFlag << 7) |
    ((colorDepth - 1) << 4) |
    (sortFlag << 3) |
    globalColorTableSize;
  const backgroundColorIndex = 0;
  const pixelAspectRatio = 0;
  writeUInt16(stream, width);
  writeUInt16(stream, height);
  stream.writeBytes([fields, backgroundColorIndex, pixelAspectRatio]);
}

function encodeNetscapeExt(stream, loopCount) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(0xff); // app extension label
  stream.writeByte(11); // block size
  writeUTFBytes(stream, "NETSCAPE2.0"); // app id + auth code
  stream.writeByte(3); // sub-block size
  stream.writeByte(1); // loop sub-block id
  writeUInt16(stream, loopCount); // extra iterations beyond the first play, 0=repeat forever
  stream.writeByte(0); // block terminator
}

function encodeColorTable(stream, palette) {
  const colorTableLength = 1 << colorTableSize(palette.length);
  for (let i = 0; i < colorTableLength; i++) {
    let color = [0, 0, 0];
    if (i < palette.length) {
      color = palette[i];
    }
    stream.writeByte(color[0]);
    stream.writeByte(color[1]);
    stream.writeByte(color[2]);
  }
}

function encodeImageDescriptor(stream, width, height, localPalette) {
  stream.writeByte(0x2c); // image separator

  writeUInt16(stream, 0); // x position
  writeUInt16(stream, 0); // y position
  writeUInt16(stream, width); // image size
  writeUInt16(stream, height);

  if (localPalette) {
    const interlace = 0;
    const sorted = 0;
    const palSize = colorTableSize(localPalette.length) - 1;
    // local palette
    stream.writeByte(
      0x80 | // 1 local color table 1=yes
        interlace | // 2 interlace - 0=no
        sorted | // 3 sorted - 0=no
        0 | // 4-5 reserved
        palSize, // 6-8 size of color table
    );
  } else {
    // global palette
    stream.writeByte(0);
  }
}

function encodePixels(
  stream,
  index,
  width,
  height,
  colorDepth = 8,
  accum,
  htab,
  codetab,
) {
  lzwEncode(width, height, index, colorDepth, stream, accum, htab, codetab);
}

// Utilities

// The GIF Graphic Control Extension stores frame delays as an unsigned
// 16-bit integer measured in hundredths of a second. The public API takes
// milliseconds, so convert units and clamp to [0, 65535]. Without the
// clamp, oversized or negative delays overflow/wrap when written as a
// u16 and different players interpret them differently.
function toGifDelay(delay) {
  const centiseconds = Math.round(Number(delay) / 10);
  if (centiseconds === Infinity) return 0xffff; // infinite wait -> longest representable delay
  if (!Number.isFinite(centiseconds) || centiseconds < 0) return 0; // NaN / negative -> no delay
  if (centiseconds > 0xffff) return 0xffff; // oversized -> clamp instead of u16 wrapping
  return centiseconds;
}

// Maps the public `repeat` option (total number of plays) onto the
// NETSCAPE2.0 loop field, which counts *extra* iterations after the first
// play where 0 means "loop forever". Returns -1 when no extension should
// be written at all (i.e. the animation plays exactly once).
function toNetscapeLoopCount(repeat) {
  if (repeat === 0) return 0; // keep default: loop forever
  if (!Number.isFinite(repeat) || repeat < 2) return -1; // play once / no block
  // Total plays N means N - 1 extra iterations; clamp to the u16 maximum.
  return Math.min(Math.floor(repeat) - 1, 0xffff);
}

function writeUInt16(stream, short) {
  stream.writeByte(short & 0xff);
  stream.writeByte((short >> 8) & 0xff);
}

function writeUTFBytes(stream, text) {
  for (var i = 0; i < text.length; i++) {
    stream.writeByte(text.charCodeAt(i));
  }
}

function colorTableSize(length) {
  return Math.max(Math.ceil(Math.log2(length)), 1);
}

export {
  GIFEncoder,
  quantize,
  prequantize,
  applyPalette,
  nearestColorIndex,
  nearestColor,
  nearestColorIndexWithDistance,
  snapColorsToPalette,
};

export default GIFEncoder;
