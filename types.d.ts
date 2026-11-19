type Format = "rgb565" | "rgb444" | "rgba4444";

type QuantizeOptions = {
  format?: Format;
  oneBitAlpha?: boolean | number;
  clearAlpha?: boolean;
  clearAlphaThreshold?: number;
  clearAlphaColor?: number;
};

type GIFEncoderOpts = {
  auto?: boolean;
  initialCapacity?: number;
  /**
   * Optional sink for bounded-memory (chunked) encoding. Whenever a segment
   * of the GIF has been produced it is handed to this callback and released
   * from the encoder's internal buffer, so resident memory no longer grows
   * with the number/size of frames. Concatenate the received chunks to
   * reconstruct the exact same bytes the encoder would otherwise expose via
   * bytes()/bytesView().
   */
  output?: (chunk: Uint8Array) => void;
};

type WriteFrameOpts = {
  palette?: number[][];
  first?: boolean;
  transparent?: boolean;
  transparentIndex?: number;
  delay?: number;
  repeat?: number;
  dispose?: number;
  colorDepth?: number;
};

type WriteFrameTilesOpts = WriteFrameOpts & {
  /** Maximum number of indexed pixels fed to the encoder per chunk. */
  blockSize?: number;
};

type ChunkCallback = (offset: number, blockSize: number) => Uint8Array | null;

type Encoder = {
  writeFrame: (
    index: Uint8Array,
    width: number,
    height: number,
    ops?: WriteFrameOpts,
  ) => void;
  /** Write frame metadata (GCE, image descriptor, optional local palette). */
  writeFrameStart: (
    width: number,
    height: number,
    ops?: WriteFrameOpts,
  ) => void;
  /** Feed a contiguous span (chunk) of indexed pixels to an open frame. */
  writeFrameChunk: (
    index: Uint8Array,
    offset?: number,
    length?: number,
  ) => void;
  /** Finalize the LZW data of the frame opened with writeFrameStart(). */
  writeFrameEnd: () => void;
  /**
   * Encode one frame in bounded-memory chunks, with output byte-identical to
   * writeFrame(). Pass either the full indexed array (pull style) or a
   * callback that returns successive chunks (push style).
   */
  writeFrameTiles: (
    indexOrFn: Uint8Array | ChunkCallback,
    width: number,
    height: number,
    ops?: WriteFrameTilesOpts,
  ) => void;
  finish: () => void;
  bytes: () => Uint8Array;
  bytesView: () => Uint8Array;
  /** Hand off and release the bytes encoded so far, rewinding the buffer. */
  drain: () => Uint8Array;
  writeHeader: () => void;
  reset: () => void;
  buffer: ArrayBuffer;
  stream: any;
};

export declare function quantize(
  rgba: Uint8Array | Uint8ClampedArray,
  maxColors: number,
  options?: QuantizeOptions,
): number[][];

export declare function applyPalette(
  rgba: Uint8Array | Uint8ClampedArray,
  palette: number[][],
  format?: Format,
): Uint8Array;

export declare function GIFEncoder(opts?: GIFEncoderOpts): Encoder;

export declare function nearestColorIndex(
  palette: number[][],
  pixel: [number, number, number] | [number, number, number],
): number;

export declare function nearestColorIndexWithDistance(
  palette: number[][],
  pixel: [number, number, number] | [number, number, number],
): [number, number];
