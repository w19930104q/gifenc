/*
  Streaming / chunked variant of lzwEncode.js.

  This is a stateful version of the exact same GIF/LZW state machine used by
  lzwEncode(), split into write()/end() calls so that a frame can be fed in
  chunks (tiles/bands) without ever materializing the whole indexed bitmap.

  The encoding state and output sequence are line-for-line equivalent to
  lzwEncode(): feeding the entire pixel array through one write() followed by
  end() produces bytes identical to a single lzwEncode() call.

  Authors/history: see lzwEncode.js
*/

import createStream from "./stream.js";

const BITS = 12;
const DEFAULT_HSIZE = 5003; // 80% occupancy
const MASKS = [
  0x0000, 0x0001, 0x0003, 0x0007, 0x000f, 0x001f, 0x003f, 0x007f, 0x00ff,
  0x01ff, 0x03ff, 0x07ff, 0x0fff, 0x1fff, 0x3fff, 0x7fff, 0xffff,
];

function createLZWStream(
  colorDepth,
  outStream = createStream(512),
  accum = new Uint8Array(256),
  htab = new Int32Array(DEFAULT_HSIZE),
  codetab = new Int32Array(DEFAULT_HSIZE),
) {
  const hsize = htab.length;
  const initCodeSize = Math.max(2, colorDepth);

  accum.fill(0);
  codetab.fill(0);
  htab.fill(-1);

  let cur_accum = 0;
  let cur_bits = 0;

  // block compression parameters -- after all codes are used up,
  // and compression rate changes, start over.
  let clear_flg = false;
  const init_bits = initCodeSize + 1;
  const g_init_bits = init_bits;
  let n_bits = g_init_bits;
  let maxcode = (1 << n_bits) - 1;

  const ClearCode = 1 << (init_bits - 1);
  const EOFCode = ClearCode + 1;
  let free_ent = ClearCode + 2;
  let a_count = 0; // clear packet

  // Streaming state:
  // started=false means no pixel has been seen yet.
  // ent holds the prefix code carried across write() boundaries.
  let started = false;
  let ent = 0;
  let ended = false;

  let hshift = 0;
  for (let fcode = hsize; fcode < 65536; fcode *= 2) {
    ++hshift;
  }
  hshift = 8 - hshift; // set hash code range bound

  // write "initial code size" byte
  outStream.writeByte(initCodeSize);

  return {
    get outStream() {
      return outStream;
    },
    write(pixels, byteOffset = 0, pixelCount = pixels.length - byteOffset) {
      if (ended) throw new Error("Cannot write() after end()");
      if (pixelCount <= 0) return;
      if (byteOffset < 0 || byteOffset + pixelCount > pixels.length) {
        throw new RangeError("LZW write range is out of bounds");
      }

      let start = byteOffset;
      const end = byteOffset + pixelCount;
      if (!started) {
        // First pixel of the stream: lzwEncode() seeds `ent` with pixels[0]
        // and emits ClearCode before processing the remaining pixels.
        started = true;
        ent = pixels[start++];
        output(ClearCode);
      }

      for (let idx = start; idx < end; idx++) {
        next_block: {
          const c = pixels[idx];
          const fcode = (c << BITS) + ent;
          let i = (c << hshift) ^ ent; // xor hashing
          if (htab[i] === fcode) {
            ent = codetab[i];
            break next_block;
          }

          const disp = i === 0 ? 1 : hsize - i; // secondary hash (after G. Knott)
          while (htab[i] >= 0) {
            // non-empty slot
            i -= disp;
            if (i < 0) i += hsize;
            if (htab[i] === fcode) {
              ent = codetab[i];
              break next_block;
            }
          }
          output(ent);
          ent = c;
          if (free_ent < 1 << BITS) {
            codetab[i] = free_ent++; // code -> hashtable
            htab[i] = fcode;
          } else {
            // Clear out the hash table
            // table clear for block compress
            htab.fill(-1);
            free_ent = ClearCode + 2;
            clear_flg = true;
            output(ClearCode);
          }
        }
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (started) {
        // Put out the final code.
        output(ent);
      } else {
        // Mirror lzwEncode() exactly for a zero-pixel frame: it seeds
        // ent = pixels[0] (undefined) and still emits ClearCode before the
        // loop (which never runs), then outputs ent and EOFCode.
        ent = undefined;
        output(ClearCode);
        output(ent);
      }
      output(EOFCode);
      outStream.writeByte(0); // write block terminator
      return outStream.bytesView();
    },
  };

  function output(code) {
    cur_accum &= MASKS[cur_bits];

    if (cur_bits > 0) cur_accum |= code << cur_bits;
    else cur_accum = code;

    cur_bits += n_bits;

    while (cur_bits >= 8) {
      // Add a character to the end of the current packet, and if it is 254
      // characters, flush the packet to disk.
      accum[a_count++] = cur_accum & 0xff;
      if (a_count >= 254) {
        outStream.writeByte(a_count);
        outStream.writeBytesView(accum, 0, a_count);
        a_count = 0;
      }
      cur_accum >>= 8;
      cur_bits -= 8;
    }

    // If the next entry is going to be too big for the code size,
    // then increase it, if possible.
    if (free_ent > maxcode || clear_flg) {
      if (clear_flg) {
        n_bits = g_init_bits;
        maxcode = (1 << n_bits) - 1;
        clear_flg = false;
      } else {
        ++n_bits;
        maxcode = n_bits === BITS ? 1 << n_bits : (1 << n_bits) - 1;
      }
    }

    if (code == EOFCode) {
      // At EOF, write the rest of the buffer.
      while (cur_bits > 0) {
        // Add a character to the end of the current packet, and if it is 254
        // characters, flush the packet to disk.
        accum[a_count++] = cur_accum & 0xff;
        if (a_count >= 254) {
          outStream.writeByte(a_count);
          outStream.writeBytesView(accum, 0, a_count);
          a_count = 0;
        }
        cur_accum >>= 8;
        cur_bits -= 8;
      }
      // Flush the packet to disk, and reset the accumulator
      if (a_count > 0) {
        outStream.writeByte(a_count);
        outStream.writeBytesView(accum, 0, a_count);
        a_count = 0;
      }
    }
  }
}

export default createLZWStream;
