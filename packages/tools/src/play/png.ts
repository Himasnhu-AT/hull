// Just enough PNG to compare screenshots: decode 8-bit RGB/RGBA (what a canvas gives), encode RGBA. No dependency.
import { crc32, deflateSync, inflateSync } from 'node:zlib';

export interface Image { width: number; height: number; /** RGBA, 4 bytes a pixel. */ data: Uint8Array }

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function decodePng(buf: Uint8Array): Image {
  const b = Buffer.from(buf);
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) throw new Error('not a PNG file');
  let width = 0; let height = 0; let depth = 0; let type = 0; let interlace = 0;
  const idat: Buffer[] = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p);
    const name = b.toString('latin1', p + 4, p + 8);
    const body = b.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; type = body[9]!; interlace = body[12]!; }
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || (type !== 2 && type !== 6) || interlace !== 0) throw new Error(`unsupported PNG (bit depth ${depth}, color type ${type}, interlace ${interlace}); expected 8-bit RGB or RGBA`);
  const bpp = type === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? cur[i - bpp]! : 0;
      const up = prev[i]!;
      const ul = i >= bpp ? prev[i - bpp]! : 0;
      let v = src[i]!;
      if (f === 1) v += left;
      else if (f === 2) v += up;
      else if (f === 3) v += (left + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - ul); const pb = Math.abs(left - ul); const pc = Math.abs(left + up - 2 * ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      } else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * bpp]!; out[o + 1] = cur[x * bpp + 1]!; out[o + 2] = cur[x * bpp + 2]!;
      out[o + 3] = bpp === 4 ? cur[x * bpp + 3]! : 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

const chunk = (name: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(name, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
};

export function encodePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0); ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
