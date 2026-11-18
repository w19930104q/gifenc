import constants from "./constants.js";
import lzwEncode from "./lzwEncode.js";
import createStream from "./stream.js";
import quantize from "./pnnquant2.js";
import parseExtensions from "./parse.js";

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
  let frameCount = 0;

  // In 'auto' mode, ensure the GIF header has been written. This runs
  // lazily before the first frame or before any out-of-band metadata
  // block (comment/extension), so blocks land in the stream exactly
  // in the order the API calls are made.
  function ensureHeader() {
    if (auto && !hasInit) {
      writeHeader();
      hasInit = true;
    }
  }

  return {
    reset() {
      stream.reset();
      hasInit = false;
      frameCount = 0;
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
    // Writes a NETSCAPE2.0 looping extension at the current stream
    // position. repeat: -1=once (no extension needed), 0=forever, >0=count
    writeLoopExt(repeat = 0) {
      ensureHeader();
      encodeNetscapeExt(stream, repeat);
    },
    // Writes a comment extension (0x21 0xFE) at the current stream
    // position. Accepts a string (UTF-8 encoded) or a Uint8Array.
    writeComment(comment) {
      ensureHeader();
      encodeCommentExt(stream, comment);
    },
    // Writes an application extension (0x21 0xFF) with an 8-byte
    // application identifier, 3-byte auth code and arbitrary data.
    writeApplicationExt(appIdentifier, authCode, data) {
      ensureHeader();
      encodeApplicationExt(stream, appIdentifier, authCode, data);
    },
    // Writes a generic extension block (0x21, label, data sub-blocks)
    // for extension labels that carry data sub-blocks.
    writeExtension(label, data) {
      ensureHeader();
      encodeExtension(stream, label, data);
    },
    writeFrame(index, width, height, opts = {}) {
      const {
        transparent = false,
        transparentIndex = 0x00,
        delay = 0,
        palette = null,
        repeat = 0, // -1=once, 0=forever, >0=count
        colorDepth = 8,
        dispose = -1,
        comment = null,
      } = opts;

      let first = false;
      if (auto) {
        // In 'auto' mode, the first time we write a frame
        // we will write LSD/GCT/EXT
        first = frameCount === 0;
        // in 'auto' mode, we also encode a header on first frame
        // this is different than manual mode where you must encode
        // header yoursef (or perhaps not write header altogether)
        ensureHeader();
      } else {
        // in manual mode, the first frame is determined by the options only
        first = Boolean(opts.first);
      }
      frameCount++;

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

      // Optional per-frame comment extension(s), written just before
      // this frame's graphic control extension
      if (comment != null) {
        const comments = Array.isArray(comment) ? comment : [comment];
        for (const c of comments) {
          encodeCommentExt(stream, c);
        }
      }

      const delayTime = Math.round(delay / 10);
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

function encodeCommentExt(stream, comment) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(0xfe); // comment label
  writeSubBlocks(stream, toByteArray(comment));
}

function encodeApplicationExt(stream, appIdentifier, authCode, data) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(0xff); // app extension label
  stream.writeByte(11); // block size
  stream.writeBytesView(fixedLengthBytes(appIdentifier, 8)); // app id
  stream.writeBytesView(fixedLengthBytes(authCode, 3)); // app auth code
  writeSubBlocks(stream, toByteArray(data));
}

function encodeExtension(stream, label, data) {
  stream.writeByte(0x21); // extension introducer
  stream.writeByte(label & 0xff); // extension label
  writeSubBlocks(stream, toByteArray(data));
}

// Writes data as a series of GIF data sub-blocks (each up to 255 bytes,
// prefixed by its size), followed by a zero-size block terminator.
function writeSubBlocks(stream, data) {
  for (let i = 0; i < data.length; i += 255) {
    const chunkSize = Math.min(255, data.length - i);
    stream.writeByte(chunkSize);
    stream.writeBytesView(data, i, chunkSize);
  }
  stream.writeByte(0); // block terminator
}

function toByteArray(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return Uint8Array.from(data);
}

// Coerces data to exactly `length` bytes, truncating or padding
// with spaces (0x20) as needed (per GIF app identifier convention).
function fixedLengthBytes(data, length) {
  const bytes = toByteArray(data);
  const out = new Uint8Array(length);
  out.fill(0x20);
  out.set(bytes.subarray(0, Math.min(bytes.length, length)));
  return out;
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
  parseExtensions,
};

export default GIFEncoder;
