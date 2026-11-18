// A lightweight GIF metadata parser (decode-side companion to GIFEncoder).
// Walks the GIF block structure and reads back the metadata extensions:
// loop count (NETSCAPE2.0), comments, application extensions and any
// other extension blocks, preserving their order in the stream.

function ascii(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return str;
}

export default function parseExtensions(bytes) {
  const data =
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer || bytes);
  let p = 0;

  const readByte = () => {
    if (p >= data.length) throw new Error("Unexpected end of GIF data");
    return data[p++];
  };
  const readUInt16 = () => readByte() | (readByte() << 8);
  const readBytes = (n) => {
    if (p + n > data.length) throw new Error("Unexpected end of GIF data");
    const slice = data.subarray(p, p + n);
    p += n;
    return slice;
  };
  const readSubBlocks = () => {
    const chunks = [];
    let size;
    while ((size = readByte()) !== 0) {
      chunks.push(readBytes(size));
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  };
  const skipSubBlocks = () => {
    readSubBlocks();
  };

  const result = {
    header: null,
    width: 0,
    height: 0,
    // loop count from NETSCAPE2.0 application extension
    // (null if not present, 0 = forever, >0 = count)
    repeat: null,
    // all comment extensions, in stream order, decoded as UTF-8
    comments: [],
    // all application extensions: { identifier, authCode, data }
    applications: [],
    // other extension blocks: { label, data }
    extensions: [],
    // number of image frames
    frames: 0,
    // ordered log of every block in the stream, e.g.
    // { type: "comment" } | { type: "application" } | { type: "image" } ...
    blocks: [],
  };

  // Header: 3-byte signature + 3-byte version
  result.header = ascii(readBytes(6));
  if (!result.header.startsWith("GIF")) {
    throw new Error(`Invalid GIF header: ${result.header}`);
  }

  // Logical screen descriptor
  result.width = readUInt16();
  result.height = readUInt16();
  const fields = readByte();
  readByte(); // background color index
  readByte(); // pixel aspect ratio
  if (fields & 0x80) {
    // global color table
    readBytes(3 * (1 << ((fields & 0x07) + 1)));
  }

  const textDecoder = new TextDecoder();

  while (p < data.length) {
    const introducer = readByte();
    if (introducer === 0x3b) {
      // trailer
      result.blocks.push({ type: "trailer" });
      break;
    } else if (introducer === 0x2c) {
      // image descriptor
      readUInt16(); // x
      readUInt16(); // y
      readUInt16(); // width
      readUInt16(); // height
      const packed = readByte();
      if (packed & 0x80) {
        // local color table
        readBytes(3 * (1 << ((packed & 0x07) + 1)));
      }
      readByte(); // LZW minimum code size
      skipSubBlocks(); // compressed image data
      result.frames++;
      result.blocks.push({ type: "image" });
    } else if (introducer === 0x21) {
      const label = readByte();
      if (label === 0xf9) {
        // graphic control extension (fixed layout)
        const size = readByte(); // always 4
        const gce = readBytes(size);
        readByte(); // block terminator
        result.blocks.push({
          type: "graphic-control",
          disposal: (gce[0] >> 2) & 0x07,
          delay: gce[1] | (gce[2] << 8),
          transparent: Boolean(gce[0] & 0x01),
          transparentIndex: gce[3],
        });
      } else if (label === 0xfe) {
        // comment extension
        const text = textDecoder.decode(readSubBlocks());
        result.comments.push(text);
        result.blocks.push({ type: "comment", text });
      } else if (label === 0xff) {
        // application extension
        const size = readByte(); // usually 11
        const id = readBytes(size);
        const appData = readSubBlocks();
        const app = {
          identifier: ascii(id.subarray(0, 8)),
          authCode: ascii(id.subarray(8, 11)),
          data: appData,
        };
        result.applications.push(app);
        result.blocks.push({ type: "application", ...app });
        // NETSCAPE2.0 looping extension: sub-block [1, lo, hi]
        if (
          app.identifier === "NETSCAPE" &&
          app.authCode === "2.0" &&
          appData.length >= 3 &&
          appData[0] === 1
        ) {
          result.repeat = appData[1] | (appData[2] << 8);
        }
      } else if (label === 0x01) {
        // plain text extension: fixed-size header block, then data
        const size = readByte();
        readBytes(size);
        const textData = readSubBlocks();
        result.extensions.push({ label, data: textData });
        result.blocks.push({ type: "extension", label, data: textData });
      } else {
        // any other extension label with data sub-blocks
        const extData = readSubBlocks();
        result.extensions.push({ label, data: extData });
        result.blocks.push({ type: "extension", label, data: extData });
      }
    } else {
      throw new Error(
        `Unknown block 0x${introducer.toString(16)} at offset ${p - 1}`,
      );
    }
  }

  return result;
}
