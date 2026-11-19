// Utilities for dirty-region (incremental) frame encoding.
//
// GIF image descriptors carry their own (left, top) position and size,
// so a frame that only changed in a small region can be encoded as a
// sub-rectangle that decoders composite on top of the previous frame.

// Finds the smallest rectangle that contains all pixels that differ
// between `previous` and `current` (both flat indexed Uint8Arrays of
// length width*height). Because it is a pixel-exact diff, any dirty
// shape (scattered pixels, lines, circles, ...) is supported; the
// bounding box of the changed pixels is returned.
//
// Returns { x, y, width, height }, a zero-size rect if nothing changed,
// or null if the buffers cannot be diffed (mismatched sizes).
function findDirtyRect(previous, current, width, height) {
  if (
    !previous ||
    !current ||
    previous.length !== current.length ||
    current.length !== width * height
  ) {
    return null;
  }

  // Find the first and last rows containing a difference
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (previous[row + x] !== current[row + x]) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }

  // No differences at all
  if (top < 0) return { x: 0, y: 0, width: 0, height: 0 };

  // Find the left/right extents within the dirty row band
  let left = width - 1;
  let right = 0;
  for (let y = top; y <= bottom; y++) {
    const row = y * width;
    for (let x = 0; x <= left; x++) {
      if (previous[row + x] !== current[row + x]) {
        left = x;
        break;
      }
    }
    for (let x = width - 1; x >= right; x--) {
      if (previous[row + x] !== current[row + x]) {
        right = x;
        break;
      }
    }
  }

  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

// Clips a user-supplied dirty rect to the frame bounds.
// Returns { x, y, width, height }, possibly zero-size.
function clipDirtyRect(rect, width, height) {
  const x = Math.max(0, Math.min(width, Math.floor(rect.x || 0)));
  const y = Math.max(0, Math.min(height, Math.floor(rect.y || 0)));
  const w = Math.max(0, Math.min(width - x, Math.floor(rect.width || 0)));
  const h = Math.max(0, Math.min(height - y, Math.floor(rect.height || 0)));
  return { x, y, width: w, height: h };
}

// Copies a sub-rectangle out of a flat indexed bitmap into a new
// tightly-packed Uint8Array of rect.width * rect.height pixels.
function copyDirtyRegion(index, width, rect) {
  const { x, y, width: w, height: h } = rect;
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    const srcStart = (y + row) * width + x;
    out.set(index.subarray(srcStart, srcStart + w), row * w);
  }
  return out;
}

export { findDirtyRect, clipDirtyRect, copyDirtyRegion };
