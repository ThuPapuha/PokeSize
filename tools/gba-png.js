/* ============================================================================
   gba-png.js — utilidades para los gráficos de pokeemerald, sin dependencias.

   · pngDecode  : PNG indexado (1/2/4/8 bpp) y RGB/RGBA de 8 bpp
   · pngEncode  : PNG RGBA de 8 bpp
   · readPal    : paletas JASC-PAL (.pal)
   · Canvas     : lienzo RGBA plano + blit / upscale / crop / contentBox
   · toCanvas   : PNG indexado -> lienzo, con un índice como transparente

   Los gráficos del juego son PNG de 4 bpp indexado: 16 valores por píxel. En
   los tilemaps de fondo, el banco de paleta de cada entrada apunta a un slot
   de VRAM, no a un offset del .pal — ver composeTilemap.
   ========================================================================== */

'use strict';
const zlib = require('zlib');
const fs = require('fs');

/* ---------------------------------------------------------------- CRC32 --- */
const CRCT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ----------------------------------------------------------- PNG decode --- */
function pngDecode(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('no es PNG');
  let o = 8, idat = [], plte = null, ihdr = null;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') ihdr = {
      width: data.readUInt32BE(0), height: data.readUInt32BE(4),
      bitDepth: data[8], colorType: data[9], interlace: data[12]
    };
    else if (type === 'PLTE') plte = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr) throw new Error('PNG sin IHDR');
  if (ihdr.interlace) throw new Error('PNG entrelazado no soportado');

  const { width, height, bitDepth, colorType } = ihdr;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = channels * bitDepth;
  const bpl = Math.ceil((width * bpp) / 8);
  const fstep = Math.max(1, bpp >> 3);

  /* deshace los filtros por scanline */
  const lines = Buffer.alloc(height * bpl);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const cur = lines.subarray(y * bpl, (y + 1) * bpl);
    raw.copy(cur, 0, p, p + bpl); p += bpl;
    const prev = y > 0 ? lines.subarray((y - 1) * bpl, y * bpl) : null;
    for (let x = 0; x < bpl; x++) {
      const a = x >= fstep ? cur[x - fstep] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= fstep ? prev[x - fstep] : 0;
      let v = cur[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }

  let indices = null;
  if (colorType === 3) {
    indices = new Uint8Array(width * height);
    const per = 8 / bitDepth, mask = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const byte = lines[y * bpl + ((x / per) | 0)];
        indices[y * width + x] = (byte >> (8 - bitDepth * ((x % per) + 1))) & mask;
      }
  }
  const palette = [];
  if (plte) for (let i = 0; i + 2 < plte.length; i += 3) palette.push([plte[i], plte[i + 1], plte[i + 2]]);
  return { width, height, bitDepth, colorType, indices, palette, lines, bpl };
}

/* ----------------------------------------------------------- PNG encode --- */
function pngEncode(width, height, rgba) {
  const bpl = width * 4;
  const raw = Buffer.alloc(height * (bpl + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (bpl + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * bpl, bpl).copy(raw, y * (bpl + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------- paletas --- */
function parsePal(text) {
  const lines = text.split(/\r?\n/);
  const n = parseInt(lines[2], 10), out = [];
  for (let i = 0; i < n; i++) {
    const m = lines[3 + i].trim().split(/\s+/).map(Number);
    out.push([m[0], m[1], m[2]]);
  }
  return out;
}
const readPal = file => parsePal(fs.readFileSync(file, 'latin1'));
const readPalBuf = buf => parsePal(buf.toString('latin1'));

/* -------------------------------------------------------------- lienzos --- */
const Canvas = (w, h) => ({ w, h, d: new Uint8Array(w * h * 4) });

function setPx(c, x, y, col, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const o = (y * c.w + x) * 4;
  c.d[o] = col[0]; c.d[o + 1] = col[1]; c.d[o + 2] = col[2];
  c.d[o + 3] = a === undefined ? 255 : a;
}
function getPx(c, x, y) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return [0, 0, 0, 0];
  const o = (y * c.w + x) * 4;
  return [c.d[o], c.d[o + 1], c.d[o + 2], c.d[o + 3]];
}
function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      const p = getPx(src, x, y);
      if (p[3]) setPx(dst, dx + x, dy + y, p, p[3]);
    }
}
function upscale(c, n) {
  const o = Canvas(c.w * n, c.h * n);
  for (let y = 0; y < o.h; y++)
    for (let x = 0; x < o.w; x++) {
      const p = getPx(c, (x / n) | 0, (y / n) | 0);
      setPx(o, x, y, p, p[3]);
    }
  return o;
}
function crop(c, x0, y0, w, h) {
  const o = Canvas(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = getPx(c, x0 + x, y0 + y);
      setPx(o, x, y, p, p[3]);
    }
  return o;
}
function contentBox(c) {
  let x0 = c.w, y0 = c.h, x1 = -1, y1 = -1;
  for (let y = 0; y < c.h; y++)
    for (let x = 0; x < c.w; x++)
      if (getPx(c, x, y)[3]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* PNG indexado -> lienzo. transparentIndex = índice tratado como transparente
   (0 por convención GBA), o un ARRAY de índices para vaciar varios a la vez —
   útil para pelar anillos exteriores de los marcos de ventana. Pásale null
   para dejarlo todo opaco. */
function toCanvas(png, transparentIndex, palette) {
  const pal = palette || png.palette;
  const clear = Array.isArray(transparentIndex) ? transparentIndex : [transparentIndex];
  const c = Canvas(png.width, png.height);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const v = png.indices[y * png.width + x];
      setPx(c, x, y, pal[v] || [255, 0, 255], clear.indexOf(v) !== -1 ? 0 : 255);
    }
  return c;
}

const hex = c => '#' + c.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('');

module.exports = {
  crc32, pngDecode, pngEncode, readPal, readPalBuf, parsePal,
  Canvas, setPx, getPx, blit, upscale, crop, contentBox, toCanvas, hex
};
