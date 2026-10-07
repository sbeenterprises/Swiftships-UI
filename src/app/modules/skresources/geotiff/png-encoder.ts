/**
 * Minimal PNG encoder (8 bit RGB / RGBA, no interlace) used to store chart tiles.
 * Compression uses the browser CompressionStream ('deflate' = zlib format, as
 * required by PNG). Without it the data is stored uncompressed.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let crcTable: Uint32Array;

/** CRC-32 (ISO 3309) of the bytes */
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Adler-32 checksum of the bytes (zlib trailer) */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream of the bytes, using uncompressed (stored) deflate blocks */
function zlibStored(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535;
    const len = Math.min(65535, data.length - start);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const adler = adler32(data);
  out[o++] = adler >>> 24;
  out[o++] = (adler >>> 16) & 0xff;
  out[o++] = (adler >>> 8) & 0xff;
  out[o++] = adler & 0xff;
  return out;
}

/** zlib compressed stream of the bytes */
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    return zlibStored(data);
  }
  // written straight to the stream: going through a Blob keeps the data in
  // memory long after the compression has finished
  const stream = new CompressionStream('deflate');
  const writer = stream.writable.getWriter();
  writer.write(data as BufferSource).catch(() => undefined);
  writer.close().catch(() => undefined);
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/** Write a big endian 32 bit unsigned integer */
function writeUint32(out: Uint8Array, offset: number, value: number) {
  out[offset] = value >>> 24;
  out[offset + 1] = (value >>> 16) & 0xff;
  out[offset + 2] = (value >>> 8) & 0xff;
  out[offset + 3] = value & 0xff;
}

/** PNG chunk (length, type, data, crc) */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeUint32(out, 0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  writeUint32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * @description Encode RGBA pixels as a PNG image.
 * @param rgba Pixels (4 bytes per pixel, rows from the top)
 * @param width Image width
 * @param height Image height
 * @param alpha Keep the alpha channel (RGBA PNG) or drop it (RGB PNG)
 * @returns PNG file bytes
 */
export async function encodePng(
  rgba: Uint8Array,
  width: number,
  height: number,
  alpha: boolean
): Promise<Uint8Array> {
  const channels = alpha ? 4 : 3;
  const rowBytes = width * channels + 1;
  const raw = new Uint8Array(rowBytes * height);
  // filter type 1 (Sub): each byte minus the byte of the pixel on its left
  for (let y = 0; y < height; y++) {
    let o = y * rowBytes;
    raw[o++] = 1;
    let p = y * width * 4;
    let pr = 0;
    let pg = 0;
    let pb = 0;
    let pa = 0;
    for (let x = 0; x < width; x++, p += 4) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      raw[o++] = (r - pr) & 0xff;
      raw[o++] = (g - pg) & 0xff;
      raw[o++] = (b - pb) & 0xff;
      pr = r;
      pg = g;
      pb = b;
      if (alpha) {
        const a = rgba[p + 3];
        raw[o++] = (a - pa) & 0xff;
        pa = a;
      }
    }
  }
  const header = new Uint8Array(13);
  writeUint32(header, 0, width);
  writeUint32(header, 4, height);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // colour type RGBA / RGB
  header[10] = 0; // compression
  header[11] = 0; // filter method
  header[12] = 0; // no interlace
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0))
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    png.set(p, offset);
    offset += p.length;
  }
  return png;
}
