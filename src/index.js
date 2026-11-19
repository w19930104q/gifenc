import constants from "./constants.js";
import lzwEncode from "./lzwEncode.js";
import createLZWStream from "./lzwStream.js";
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
  const { initialCapacity = 4096, auto = true, output = null } = opt;

  // Stream all encoded data into this buffer
  const stream = createStream(initialCapacity);

  // Shared array data across all frames
  const HSIZE = 5003; // 80% occupancy
  const accum = new Uint8Array(256);
  const htab = new Int32Array(HSIZE);
  const codetab = new Int32Array(HSIZE);

  let hasInit = false;

  // State for a frame that is being encoded incrementally via
  // writeFrameStart() / writeFrameChunk() / writeFrameEnd().
  // While non-null, no other frame may be started.
  let activeFrame = null;

  return {
    reset() {
      stream.reset();
      hasInit = false;
      activeFrame = null;
    },
    finish() {
      if (activeFrame) {
        throw new Error(
          "Cannot finish() while a chunked frame is in progress; call writeFrameEnd() first",
        );
      }
      stream.writeByte(constants.trailer);
      flushOutput();
    },
    bytes() {
      return stream.bytes();
    },
    bytesView() {
      return stream.bytesView();
    },
    // Drains the bytes encoded so far and rewinds the internal buffer.
    // Combined with the { output } sink option this allows arbitrarily long
    // animations to be encoded with bounded resident memory.
    drain() {
      if (activeFrame) {
        throw new Error(
          "Cannot drain() while a chunked frame is in progress; call writeFrameEnd() first",
        );
      }
      return stream.drain();
    },
    get buffer() {
      return stream.buffer;
    },
    get stream() {
      return stream;
    },
    writeHeader,
    writeFrame(index, width, height, opts = {}) {
      if (activeFrame) {
        throw new Error(
          "Cannot writeFrame() while a chunked frame is in progress",
        );
      }
      const {
        transparent = false,
        transparentIndex = 0x00,
        delay = 0,
        palette = null,
        repeat = 0, // -1=once, 0=forever, >0=count
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
        if (repeat >= 0) {
          encodeNetscapeExt(stream, repeat);
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
      flushOutput();
    },
    // Begins a frame and writes everything up to (but not including) the
    // LZW image data. Feed the indexed pixels afterwards with one or more
    // writeFrameChunk() calls, then close the frame with writeFrameEnd().
    //
    // Chunks are plain contiguous spans of the frame's indexed pixel data in
    // the same row-major order writeFrame() consumes, so the encoded output is
    // byte-identical to writeFrame() regardless of how the pixels are split.
    writeFrameStart(width, height, opts = {}) {
      if (activeFrame) {
        throw new Error(
          "A chunked frame is already in progress; call writeFrameEnd() first",
        );
      }
      const {
        transparent = false,
        transparentIndex = 0x00,
        delay = 0,
        palette = null,
        repeat = 0, // -1=once, 0=forever, >0=count
        colorDepth = 8,
        dispose = -1,
      } = opts;

      let first = false;
      if (auto) {
        if (!hasInit) {
          first = true;
          writeHeader();
          hasInit = true;
        }
      } else {
        first = Boolean(opts.first);
      }

      width = Math.max(0, Math.floor(width));
      height = Math.max(0, Math.floor(height));

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

      const lzw = createLZWStream(colorDepth, stream, accum, htab, codetab);
      activeFrame = {
        lzw,
        width,
        height,
        pixelsWritten: 0,
        totalPixels: width * height,
      };
      flushOutput();
      return activeFrame;
    },
    // Writes a contiguous chunk of indexed pixels belonging to the frame
    // opened with writeFrameStart(). `index` may be a small per-chunk array;
    // the optional offset/length select a span within it.
    writeFrameChunk(index, offset = 0, length = index.length - offset) {
      if (!activeFrame) {
        throw new Error(
          "writeFrameChunk() must be called between writeFrameStart() and writeFrameEnd()",
        );
      }
      if (length < 0 || offset < 0 || offset + length > index.length) {
        throw new RangeError("Chunk range is out of bounds");
      }
      if (activeFrame.pixelsWritten + length > activeFrame.totalPixels) {
        throw new RangeError(
          "Chunked frame received more pixels than declared by width * height",
        );
      }
      activeFrame.lzw.write(index, offset, length);
      activeFrame.pixelsWritten += length;
      flushOutput();
    },
    // Closes the frame opened with writeFrameStart() and finalizes LZW output.
    writeFrameEnd() {
      if (!activeFrame) {
        throw new Error("writeFrameEnd() called without writeFrameStart()");
      }
      if (activeFrame.pixelsWritten !== activeFrame.totalPixels) {
        throw new Error(
          `Chunked frame is incomplete: received ${activeFrame.pixelsWritten} of ${activeFrame.totalPixels} pixels`,
        );
      }
      activeFrame.lzw.end();
      activeFrame = null;
      flushOutput();
    },
    // Convenience wrapper around the chunked frame API.
    //
    // Two call styles are supported, both producing output byte-identical to
    // writeFrame():
    //   1. push style: pass an onChunk(offset) callback that returns the
    //      indexed pixels for the next chunk (a Uint8Array of at most
    //      blockSize pixels, or null at the end);
    //   2. pull style: pass the full indexed array and a blockSize; the frame
    //      is fed to the encoder in contiguous spans of at most blockSize
    //      pixels, so the encoder itself only ever holds one span at a time.
    //
    // Any positive blockSize is valid, including 1 and sizes that do not
    // evenly divide width * height.
    writeFrameTiles(indexOrFn, width, height, opts = {}) {
      const { blockSize = 64 * 1024, ...frameOpts } = opts;
      if (!Number.isFinite(blockSize) || blockSize <= 0) {
        throw new Error("blockSize must be a positive finite number");
      }
      const limit = Math.floor(blockSize);
      const totalPixels = Math.max(0, Math.floor(width)) *
        Math.max(0, Math.floor(height));

      this.writeFrameStart(width, height, frameOpts);
      try {
        if (typeof indexOrFn === "function") {
          let offset = 0;
          while (offset < totalPixels) {
            const chunk = indexOrFn(offset, limit);
            if (!chunk || chunk.length === 0) {
              throw new Error(
                "onChunk returned no data before the frame was fully encoded",
              );
            }
            const length = Math.min(chunk.length, totalPixels - offset);
            this.writeFrameChunk(chunk, 0, length);
            offset += length;
          }
        } else {
          for (let offset = 0; offset < totalPixels; offset += limit) {
            const length = Math.min(limit, totalPixels - offset);
            this.writeFrameChunk(indexOrFn, offset, length);
          }
        }
      } catch (err) {
        // Leave the encoder in a clean state on failure
        activeFrame = null;
        throw err;
      }
      this.writeFrameEnd();
    },
  };

  function writeHeader() {
    writeUTFBytes(stream, "GIF89a");
  }

  // When an output sink was provided, hand off and release every fully encoded
  // segment so the internal buffer cannot grow with the number of frames.
  function flushOutput() {
    if (typeof output === "function" && stream.bytesView().length > 0) {
      output(stream.drain());
    }
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
  createLZWStream,
};

export default GIFEncoder;
