// 生成 KinetAios 应用图标:build/icon.ico + build/icon.png。
// 设计:金色径向渐变底 + 白色 4 角火花(✨),呼应 UI 的 spark 标识。
// 零外部依赖 —— zlib 手撸 PNG,再按 ICO 容器封装(Vista+ 直接吃 PNG inside ICO)。
// 跑法:node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 24, 32, 48, 64, 128, 256];

// 4 角火花(astroid):|dx|^(2/3) + |dy|^(2/3) <= r^(2/3)。两个叠加模拟 ✨。
function isInSpark(x, y, cx, cy, r) {
  const dx = Math.abs(x - cx);
  const dy = Math.abs(y - cy);
  if (dx > r || dy > r) return false;
  // 0^? 兜底;小 r 退化为点。
  const lhs = Math.pow(dx, 2 / 3) + Math.pow(dy, 2 / 3);
  return lhs <= Math.pow(r, 2 / 3);
}

// 金色径向渐变:中心亮 #f6c95a,边缘深 #b87710。
function goldAt(t) {
  // t ∈ [0,1],0=中心 1=边缘
  const c0 = [0xf6, 0xc9, 0x5a];
  const c1 = [0xb8, 0x77, 0x10];
  return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t];
}

function render(size) {
  const buf = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2;
  const cy = size / 2;
  // 圆角方形底(半径 = size/2 退化为圆;留 4% 边距防裁切)
  const outerR = size * 0.48;
  // 大火花(中心)
  const sparkR1 = size * 0.34;
  // 小火花(右上)
  const sparkR2 = size * 0.18;
  const sparkCx2 = cx + size * 0.22;
  const sparkCy2 = cy - size * 0.22;
  for (let y = 0; y < size; y++) {
    buf[y * (size * 4 + 1)] = 0; // PNG filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const dx = x - cx + 0.5;
      const dy = y - cy + 0.5;
      const d = Math.sqrt(dx * dx + dy * dy);
      const insideCircle = d <= outerR;
      if (!insideCircle) {
        buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0;
        continue;
      }
      // 金色渐变
      const t = d / outerR;
      const [r, g, b] = goldAt(t);
      // 火花(白色,稍微往外柔化一下边缘抗锯齿)
      let isSpark = isInSpark(x + 0.5, y + 0.5, cx, cy, sparkR1) || isInSpark(x + 0.5, y + 0.5, sparkCx2, sparkCy2, sparkR2);
      if (isSpark) {
        buf[o] = 255; buf[o + 1] = 255; buf[o + 2] = 255; buf[o + 3] = 255;
      } else {
        buf[o] = Math.round(r); buf[o + 1] = Math.round(g); buf[o + 2] = Math.round(b); buf[o + 3] = 255;
      }
    }
  }
  return buf;
}

function num32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function pngChunk(type, data) {
  const len = num32(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = num32(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// PNG CRC32(标准 zlib polynomial)。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePNG(size) {
  const raw = render(size);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk('IHDR', Buffer.concat([num32(size), num32(size), Buffer.from([8, 6, 0, 0, 0])])); // 8-bit RGBA
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

// ICO 容器:6 字节 header + N×16 字节目录 + PNG 数据(Vista+ 支持 PNG inside ICO,electron-builder 也吃)。
function encodeICO(sizes) {
  const pngs = sizes.map((s) => ({ size: s, png: encodePNG(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(pngs.length, 4);
  const dirEntrySize = 16;
  const dirBuf = Buffer.alloc(pngs.length * dirEntrySize);
  const dataOffset = header.length + dirBuf.length;
  let cursor = 0;
  let dataCursor = dataOffset;
  const datas = [];
  for (let i = 0; i < pngs.length; i++) {
    const { size, png } = pngs[i];
    dirBuf.writeUInt8(size >= 256 ? 0 : size, cursor);      // width(0 = 256)
    dirBuf.writeUInt8(size >= 256 ? 0 : size, cursor + 1);   // height
    dirBuf.writeUInt8(0, cursor + 2);                         // colors
    dirBuf.writeUInt8(0, cursor + 3);                         // reserved
    dirBuf.writeUInt16LE(1, cursor + 4);                      // planes
    dirBuf.writeUInt16LE(32, cursor + 6);                     // bpp
    dirBuf.writeUInt32LE(png.length, cursor + 8);             // size
    dirBuf.writeUInt32LE(dataCursor, cursor + 12);            // offset
    cursor += dirEntrySize;
    dataCursor += png.length;
    datas.push(png);
  }
  return Buffer.concat([header, dirBuf, ...datas]);
}

const outDir = path.resolve(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const ico = encodeICO(SIZES);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
const png256 = encodePNG(256);
fs.writeFileSync(path.join(outDir, 'icon.png'), png256);
console.log(`wrote build/icon.ico (${ico.length} bytes, sizes ${SIZES.join('/')})`);
console.log(`wrote build/icon.png (${png256.length} bytes, 256×256)`);
