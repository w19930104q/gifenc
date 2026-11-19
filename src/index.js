import constants from "./constants.js";
import lzwEncode from "./lzwEncode.js";
import createStream from "./stream.js";
import quantize from "./pnnquant2.js";
import { findDirtyRect, clipDirtyRect, copyDirtyRegion } from "./dirty.js";

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
        delay = 0,
        palette = null,
        repeat = 0, // -1=once, 0=forever, >0=count
        colorDepth = 8,
        dispose = -1,
        previous = null,
        rect = null,
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
        if (repeat >= 0) {
          encodeNetscapeExt(stream, repeat);
        }
      }

      const delayTime = Math.round(delay / 10);

      // Dirty-region (incremental) encoding: if a dirty rect is given
      // explicitly, or can be derived by diffing against the indexed
      // pixels of the previous frame, we only encode the changed region
      // as a positioned sub-image. Decoders composite it onto the
      // previous frame, producing the same result as a full frame.
      // The first frame is always encoded in full, since it defines the
      // logical screen and there is nothing to composite onto yet.
      let dirty = null;
      if (!first) {
        if (rect) {
          dirty = clipDirtyRect(rect, width, height);
        } else if (previous) {
          dirty = findDirtyRect(previous, index, width, height);
        }
      }

      let frameX = 0;
      let frameY = 0;
      let frameWidth = width;
      let frameHeight = height;
      let pixels = index;
      let frameDispose = dispose;
      if (dirty) {
        if (dirty.width <= 0 || dirty.height <= 0) {
          // Nothing changed: emit a 1x1 no-op frame. The single pixel
          // holds the current (unchanged) value, so compositing is a
          // no-op and the decoded result still matches a full frame.
          dirty = { x: 0, y: 0, width: 1, height: 1 };
        }
        const isFullFrame =
          dirty.x === 0 &&
          dirty.y === 0 &&
          dirty.width === width &&
          dirty.height === height;
        if (!isFullFrame) {
          frameX = dirty.x;
          frameY = dirty.y;
          frameWidth = dirty.width;
          frameHeight = dirty.height;
          pixels = copyDirtyRegion(index, width, dirty);
          if (frameDispose < 0) {
            // Default to "do not dispose" so that subsequent frames
            // composite onto this one.
            frameDispose = 1;
          }
        }
      }

      encodeGraphicControlExt(
        stream,
        frameDispose,
        delayTime,
        transparent,
        transparentIndex,
      );

      const useLocalColorTable = Boolean(palette) && !first;
      encodeImageDescriptor(
        stream,
        frameX,
        frameY,
        frameWidth,
        frameHeight,
        useLocalColorTable ? palette : null,
      );
      if (useLocalColorTable) encodeColorTable(stream, palette);
      encodePixels(
        stream,
        pixels,
        frameWidth,
        frameHeight,
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

function encodeNetscapeExt(stream, repeat) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(0xff); // app extension label
  stream.writeByte(11); // block size
  writeUTFBytes(stream, "NETSCAPE2.0"); // app id + auth code
  stream.writeByte(3); // sub-block size
  stream.writeByte(1); // loop sub-block id
  writeUInt16(stream, repeat); // loop count (extra iterations, 0=repeat forever)
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

function encodeImageDescriptor(stream, left, top, width, height, localPalette) {
  stream.writeByte(0x2c); // image separator

  writeUInt16(stream, left); // x position
  writeUInt16(stream, top); // y position
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
  findDirtyRect,
};

export default GIFEncoder;
