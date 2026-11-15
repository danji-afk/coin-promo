// Pixel-art PNG generator (pure node:zlib, no deps). 48x48 design upscaled to 512.
import { deflateSync } from 'node:zlib';

const W = 48, H = 48;
const P = { bg: [16, 12, 24], hand: [167, 139, 250], dark: [91, 33, 182], white: [245, 242, 255], accent: [217, 70, 239], paper: [250, 245, 255] };

type RGB = [number, number, number];
const px: (RGB | null)[][] = Array.from({ length: H }, () => Array(W).fill(null));

function rect(x0: number, y0: number, x1: number, y1: number, c: RGB) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (x >= 0 && x < W && y >= 0 && y < H) px[y][x] = c;
}
function outline(x0: number, y0: number, x1: number, y1: number, c: RGB) {
  rect(x0, y0, x1, y0, c); rect(x0, y1, x1, y1, c); rect(x0, y0, x0, y1, c); rect(x1, y0, x1, y1, c);
}

// document (paper) tilted-ish
rect(14, 14, 34, 40, P.paper);
outline(14, 14, 34, 40, P.dark);
rect(17, 20, 31, 21, P.dark); // lines
rect(17, 25, 29, 26, P.dark);
rect(17, 30, 27, 31, P.dark);
// big stamp circle on paper
rect(20, 33, 30, 37, P.accent);
outline(20, 33, 30, 37, P.white);
rect(22, 35, 28, 35, P.white);

// robot arm from top-left
rect(2, 2, 12, 10, P.hand);
outline(2, 2, 12, 10, P.dark);
rect(12, 6, 16, 9, P.dark); // wrist
// gripper fingers
rect(15, 3, 18, 6, P.hand);
rect(15, 9, 18, 12, P.hand);
outline(15, 3, 18, 6, P.dark);
outline(15, 9, 18, 12, P.dark);
// eye lights on arm
rect(4, 4, 5, 5, P.accent);
rect(8, 4, 9, 5, P.accent);

// impact sparks
rect(36, 8, 37, 9, P.accent); rect(40, 12, 41, 13, P.accent); rect(35, 3, 36, 4, P.accent);

function nearest(c: RGB | null): number {
  if (!c) return 0;
  return (c[0] << 16) | (c[1] << 8) | c[2];
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

export function renderLogoPng(scale = 10): Buffer {
  const w = W * scale, h = H * scale;
  const raw: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0;
    for (let x = 0; x < w; x++) {
      const c = nearest(px[Math.floor(y / scale)][Math.floor(x / scale)]);
      row[1 + x * 3] = (c >> 16) & 255;
      row[2 + x * 3] = (c >> 8) & 255;
      row[3 + x * 3] = c & 255;
    }
    raw.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
