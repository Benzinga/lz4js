// lz4.js - An implementation of Lz4 in plain JavaScript.
//
// TODO:
// - Unify header parsing/writing.
// - Support options (block size, checksums)
// - Support streams
// - Better error handling (handle bad offset, etc.)
// - HC support (better search algorithm)
// - Tests/benchmarking

var xxhash = require('./xxh32.js');
var util = require('./util.js');

// Constants
// --

// Compression format parameters/constants.
var minMatch = 4;
var minLength = 13;
var searchLimit = 5;
var skipTrigger = 6;
var hashSize = 1 << 16;

// Token constants.
var mlBits = 4;
var mlMask = (1 << mlBits) - 1;
var runBits = 4;
var runMask = (1 << runBits) - 1;

// Shared buffers
var blockBuf = makeBuffer(5 << 20);
var hashTable = makeHashTable();

// Frame constants.
var magicNum = 0x184D2204;

// Frame descriptor flags.
var fdContentChksum = 0x4;
var fdContentSize = 0x8;
var fdBlockChksum = 0x10;
// var fdBlockIndep = 0x20;
var fdVersion = 0x40;
var fdVersionMask = 0xC0;

// Block sizes.
var bsUncompressed = 0x80000000;
var bsDefault = 7;
var bsShift = 4;
var bsMask = 7;
var bsMap = {
  4: 0x10000,
  5: 0x40000,
  6: 0x100000,
  7: 0x400000
};

// Utility functions/primitives
// --

// Makes our hashtable. On older browsers, may return a plain array.
function makeHashTable () {
  try {
    return new Uint32Array(hashSize);
  } catch (error) {
    var hashTable = new Array(hashSize);

    for (var i = 0; i < hashSize; i++) {
      hashTable[i] = 0;
    }

    return hashTable;
  }
}

// Clear hashtable.
function clearHashTable (table) {
  for (var i = 0; i < hashSize; i++) {
    hashTable[i] = 0;
  }
}

// Makes a byte buffer. On older browsers, may return a plain array.
function makeBuffer (size) {
  try {
    return new Uint8Array(size);
  } catch (error) {
    var buf = new Array(size);

    for (var i = 0; i < size; i++) {
      buf[i] = 0;
    }

    return buf;
  }
}

function sliceArray (array, start, end) {
  if (typeof array.buffer !== undefined) {
    if (Uint8Array.prototype.slice) {
      return array.slice(start, end);
    } else {
      // Uint8Array#slice polyfill.
      var len = array.length;

      // Calculate start.
      start = start | 0;
      start = (start < 0) ? Math.max(len + start, 0) : Math.min(start, len);

      // Calculate end.
      end = (end === undefined) ? len : end | 0;
      end = (end < 0) ? Math.max(len + end, 0) : Math.min(end, len);

      // Copy into new array.
      var arraySlice = new Uint8Array(end - start);
      for (var i = start, n = 0; i < end;) {
        arraySlice[n++] = array[i++];
      }

      return arraySlice;
    }
  } else {
    // Assume normal array.
    return array.slice(start, end);
  }
}

// Implementation
// --

// Calculates an upper bound for lz4 compression.
exports.compressBound = function compressBound (n) {
  return (n + (n / 255) + 16) | 0;
};

// Calculates an upper bound for lz4 decompression, by reading the data.
exports.decompressBound = function decompressBound (src) {
  var sIndex = 0;

  // Read magic number
  if (util.readU32(src, sIndex) !== magicNum) {
    throw new Error('invalid magic number');
  }

  sIndex += 4;

  // Read descriptor
  var descriptor = src[sIndex++];

  // Check version
  if ((descriptor & fdVersionMask) !== fdVersion) {
    throw new Error('incompatible descriptor version ' + (descriptor & fdVersionMask));
  }

  // Read flags
  var useBlockSum = (descriptor & fdBlockChksum) !== 0;
  var useContentSize = (descriptor & fdContentSize) !== 0;

  // Read block size
  var bsIdx = (src[sIndex++] >> bsShift) & bsMask;

  if (bsMap[bsIdx] === undefined) {
    throw new Error('invalid block size ' + bsIdx);
  }

  var maxBlockSize = bsMap[bsIdx];

  // Get content size
  if (useContentSize) {
    return util.readU64(src, sIndex);
  }

  // Checksum
  sIndex++;

  // Read blocks.
  var maxSize = 0;
  while (true) {
    var blockSize = util.readU32(src, sIndex);
    sIndex += 4;

    if (blockSize & bsUncompressed) {
      blockSize &= ~bsUncompressed;
      maxSize += blockSize;
    } else {
      maxSize += maxBlockSize;
    }

    if (blockSize === 0) {
      return maxSize;
    }

    if (useBlockSum) {
      sIndex += 4;
    }

    sIndex += blockSize;
  }
};

// Creates a buffer of a given byte-size, falling back to plain arrays.
exports.makeBuffer = makeBuffer;

// Decompresses a block of Lz4.
exports.decompressBlock = function decompressBlock (src, dst, sIndex, sLength, dIndex) {
  var mLength, mOffset, sEnd, n, i;

  // Setup initial state.
  sEnd = sIndex + sLength;

  // Consume entire input block.
  while (sIndex < sEnd) {
    var token = src[sIndex++];

    // Copy literals.
    var literalCount = (token >> 4);
    if (literalCount > 0) {
      // Parse length.
      if (literalCount === 0xf) {
        while (true) {
          literalCount += src[sIndex];
          if (src[sIndex++] !== 0xff) {
            break;
          }
        }
      }

      // Copy literals
      for (n = sIndex + literalCount; sIndex < n;) {
        dst[dIndex++] = src[sIndex++];
      }
    }

    if (sIndex >= sEnd) {
      break;
    }

    // Copy match.
    mLength = (token & 0xf);

    // Parse offset.
    mOffset = src[sIndex++] | (src[sIndex++] << 8);

    // Parse length.
    if (mLength === 0xf) {
      while (true) {
        mLength += src[sIndex];
        if (src[sIndex++] !== 0xff) {
          break;
        }
      }
    }

    mLength += minMatch;

    // Copy match.
    for (i = dIndex - mOffset, n = i + mLength; i < n;) {
      dst[dIndex++] = dst[i++] | 0;
    }
  }

  return dIndex;
};

// Compresses a block with Lz4.
exports.compressBlock = function compressBlock (src, dst, sIndex, sLength, hashTable) {
  var mIndex, mAnchor, mLength, mOffset, mStep;
  var literalCount, dIndex, sEnd, n;

  // Setup initial state.
  dIndex = 0;
  sEnd = sLength + sIndex;
  mAnchor = sIndex;

  // Process only if block is large enough.
  if (sLength >= minLength) {
    var searchMatchCount = (1 << skipTrigger) + 3;

    // Consume until last n literals (Lz4 spec limitation.)
    while (sIndex + minMatch < sEnd - searchLimit) {
      var seq = util.readU32(src, sIndex);
      var hash = util.hashU32(seq) >>> 0;

      // Crush hash to 16 bits.
      hash = ((hash >> 16) ^ hash) >>> 0 & 0xffff;

      // Look for a match in the hashtable. NOTE: remove one; see below.
      mIndex = hashTable[hash] - 1;

      // Put pos in hash table. NOTE: add one so that zero = invalid.
      hashTable[hash] = sIndex + 1;

      // Determine if there is a match (within range.)
      if (mIndex < 0 || ((sIndex - mIndex) >>> 16) > 0 || util.readU32(src, mIndex) !== seq) {
        mStep = searchMatchCount++ >> skipTrigger;
        sIndex += mStep;
        continue;
      }

      searchMatchCount = (1 << skipTrigger) + 3;

      // Calculate literal count and offset.
      literalCount = sIndex - mAnchor;
      mOffset = sIndex - mIndex;

      // We've already matched one word, so get that out of the way.
      sIndex += minMatch;
      mIndex += minMatch;

      // Determine match length.
      // N.B.: mLength does not include minMatch, Lz4 adds it back
      // in decoding.
      mLength = sIndex;
      while (sIndex < sEnd - searchLimit && src[sIndex] === src[mIndex]) {
        sIndex++;
        mIndex++;
      }
      mLength = sIndex - mLength;

      // Write token + literal count.
      var token = mLength < mlMask ? mLength : mlMask;
      if (literalCount >= runMask) {
        dst[dIndex++] = (runMask << mlBits) + token;
        for (n = literalCount - runMask; n >= 0xff; n -= 0xff) {
          dst[dIndex++] = 0xff;
        }
        dst[dIndex++] = n;
      } else {
        dst[dIndex++] = (literalCount << mlBits) + token;
      }

      // Write literals.
      for (var i = 0; i < literalCount; i++) {
        dst[dIndex++] = src[mAnchor + i];
      }

      // Write offset.
      dst[dIndex++] = mOffset;
      dst[dIndex++] = (mOffset >> 8);

      // Write match length.
      if (mLength >= mlMask) {
        for (n = mLength - mlMask; n >= 0xff; n -= 0xff) {
          dst[dIndex++] = 0xff;
        }
        dst[dIndex++] = n;
      }

      // Move the anchor.
      mAnchor = sIndex;
    }
  }

  // Nothing was encoded.
  if (mAnchor === 0) {
    return 0;
  }

  // Write remaining literals.
  // Write literal token+count.
  literalCount = sEnd - mAnchor;
  if (literalCount >= runMask) {
    dst[dIndex++] = (runMask << mlBits);
    for (n = literalCount - runMask; n >= 0xff; n -= 0xff) {
      dst[dIndex++] = 0xff;
    }
    dst[dIndex++] = n;
  } else {
    dst[dIndex++] = (literalCount << mlBits);
  }

  // Write literals.
  sIndex = mAnchor;
  while (sIndex < sEnd) {
    dst[dIndex++] = src[sIndex++];
  }

  return dIndex;
};

// Decompresses a frame of Lz4 data.
exports.decompressFrame = function decompressFrame (src, dst) {
  var useBlockSum, useContentSum, useContentSize, descriptor;
  var sIndex = 0;
  var dIndex = 0;

  // Read magic number
  if (util.readU32(src, sIndex) !== magicNum) {
    throw new Error('invalid magic number');
  }

  sIndex += 4;

  // Read descriptor
  descriptor = src[sIndex++];

  // Check version
  if ((descriptor & fdVersionMask) !== fdVersion) {
    throw new Error('incompatible descriptor version');
  }

  // Read flags
  useBlockSum = (descriptor & fdBlockChksum) !== 0;
  useContentSum = (descriptor & fdContentChksum) !== 0;
  useContentSize = (descriptor & fdContentSize) !== 0;

  // Read block size
  var bsIdx = (src[sIndex++] >> bsShift) & bsMask;

  if (bsMap[bsIdx] === undefined) {
    throw new Error('invalid block size');
  }

  if (useContentSize) {
    // TODO: read content size
    sIndex += 8;
  }

  sIndex++;

  // Read blocks.
  while (true) {
    var compSize;

    compSize = util.readU32(src, sIndex);
    sIndex += 4;

    if (compSize === 0) {
      break;
    }

    if (useBlockSum) {
      // TODO: read block checksum
      sIndex += 4;
    }

    // Check if block is compressed
    if ((compSize & bsUncompressed) !== 0) {
      // Mask off the 'uncompressed' bit
      compSize &= ~bsUncompressed;

      // Copy uncompressed data into destination buffer.
      for (var j = 0; j < compSize; j++) {
        dst[dIndex++] = src[sIndex++];
      }
    } else {
      // Decompress into blockBuf
      dIndex = exports.decompressBlock(src, dst, sIndex, compSize, dIndex);
      sIndex += compSize;
    }
  }

  if (useContentSum) {
    // TODO: read content checksum
    sIndex += 4;
  }

  return dIndex;
};

// Compresses data to an Lz4 frame.
exports.compressFrame = function compressFrame (src, dst) {
  var dIndex = 0;

  // Write magic number.
  util.writeU32(dst, dIndex, magicNum);
  dIndex += 4;

  // Descriptor flags.
  dst[dIndex++] = fdVersion;
  dst[dIndex++] = bsDefault << bsShift;

  // Descriptor checksum.
  dst[dIndex] = xxhash.hash(0, dst, 4, dIndex - 4) >> 8;
  dIndex++;

  // Write blocks.
  var maxBlockSize = bsMap[bsDefault];
  var remaining = src.length;
  var sIndex = 0;

  // Clear the hashtable.
  clearHashTable(hashTable);

  // Split input into blocks and write.
  while (remaining > 0) {
    var compSize = 0;
    var blockSize = remaining > maxBlockSize ? maxBlockSize : remaining;

    compSize = exports.compressBlock(src, blockBuf, sIndex, blockSize, hashTable);

    if (compSize > blockSize || compSize === 0) {
      // Output uncompressed.
      util.writeU32(dst, dIndex, 0x80000000 | blockSize);
      dIndex += 4;

      for (var z = sIndex + blockSize; sIndex < z;) {
        dst[dIndex++] = src[sIndex++];
      }

      remaining -= blockSize;
    } else {
      // Output compressed.
      util.writeU32(dst, dIndex, compSize);
      dIndex += 4;

      for (var j = 0; j < compSize;) {
        dst[dIndex++] = blockBuf[j++];
      }

      sIndex += blockSize;
      remaining -= blockSize;
    }
  }

  // Write blank end block.
  util.writeU32(dst, dIndex, 0);
  dIndex += 4;

  return dIndex;
};

// Decompresses a buffer containing an Lz4 frame. maxSize is optional; if not
// provided, a maximum size will be determined by examining the data. The
// buffer returned will always be perfectly-sized.
exports.decompress = function decompress (src, maxSize) {
  var dst, size;

  if (maxSize === undefined) {
    maxSize = exports.decompressBound(src);
  }

  dst = exports.makeBuffer(maxSize);
  size = exports.decompressFrame(src, dst);

  if (size !== maxSize) {
    dst = sliceArray(dst, 0, size);
  }

  return dst;
};

// Compresses a buffer to an Lz4 frame. maxSize is optional; if not provided,
// a buffer will be created based on the theoretical worst output size for a
// given input size. The buffer returned will always be perfectly-sized.
exports.compress = function compress (src, maxSize) {
  var dst, size;

  if (maxSize === undefined) {
    maxSize = exports.compressBound(src.length);
  }

  dst = exports.makeBuffer(maxSize);
  size = exports.compressFrame(src, dst);

  if (size !== maxSize) {
    dst = sliceArray(dst, 0, size);
  }

  return dst;
};
