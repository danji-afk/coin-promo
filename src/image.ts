import { deflateSync } from 'node:zlib';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function generateLogo(): Buffer {
  const size = 512;
  const pixels = Buffer.alloc(size * (1 + size * 4));
  const palette = [
    [24, 12, 43], [67, 31, 105], [126, 65, 188],
    [183, 124, 239], [237, 212, 255],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(x / 16);
      const gy = Math.floor(y / 16);
      let color = (gx + gy) % 8 === 0 ? 1 : 0;
      // A chunky robot head with antenna, eyes, and a terminal-style mouth.
      if (gx >= 5 && gx <= 26 && gy >= 8 && gy <= 25) color = 1;
      if (gx >= 7 && gx <= 24 && gy >= 9 && gy <= 23) color = 2;
      if (gx >= 8 && gx <= 23 && gy === 9) color = 3;
      if (gx >= 15 && gx <= 16 && gy >= 5 && gy <= 8) color = 3;
      if (gx >= 14 && gx <= 17 && gy >= 3 && gy <= 4) color = 4;
      if ((gx >= 3 && gx <= 4 || gx >= 27 && gx <= 28) && gy >= 13 && gy <= 19) color = 3;
      if ((gx >= 10 && gx <= 13 || gx >= 18 && gx <= 21) && gy >= 13 && gy <= 16) color = 0;
      if ((gx === 11 || gx === 19) && gy >= 13 && gy <= 15) color = 4;
      if (gx >= 11 && gx <= 20 && gy >= 20 && gy <= 21) color = 0;
      if ([12, 15, 18].includes(gx) && gy === 20) color = 4;
      const offset = y * (1 + size * 4) + 1 + x * 4;
      pixels.set([...palette[color], 255], offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
