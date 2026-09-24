// 外部依存なしで拡張機能アイコン(PNG)を描く: 紺の角丸四角に、橙の盾とチェック
import { writeFile, mkdir } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const outDir = fileURLToPath(new URL("../static/icons/", import.meta.url));
const SIZES = [16, 32, 48, 128];
const SS = 4; // 1ピクセルあたりのサンプル数(一辺)

const NAVY = [31, 34, 80];
const ORANGE = [251, 146, 60];
const CREAM = [255, 247, 237];

// 0..1 の座標系で形を定義する
function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// 盾: 上辺は水平、側面は下で尖る
const SHIELD = [
  [0.5, 0.16],
  [0.79, 0.26],
  [0.79, 0.5],
  [0.74, 0.64],
  [0.64, 0.76],
  [0.5, 0.86],
  [0.36, 0.76],
  [0.26, 0.64],
  [0.21, 0.5],
  [0.21, 0.26],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const CHECK = [
  [0.36, 0.5],
  [0.46, 0.6],
  [0.65, 0.4],
];

function sample(x, y, size) {
  if (!inRoundedRect(x, y, 0.22)) return null;
  // 小さいアイコンではチェックを太くして潰れないようにする
  const stroke = size <= 16 ? 0.085 : size <= 32 ? 0.07 : 0.055;
  if (inPolygon(x, y, SHIELD)) {
    const onCheck = distToSegment(x, y, CHECK[0], CHECK[1]) < stroke || distToSegment(x, y, CHECK[1], CHECK[2]) < stroke;
    return onCheck ? CREAM : ORANGE;
  }
  return NAVY;
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let pxX = 0; pxX < size; pxX++) {
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((pxX + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size, size);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      const i = (py * size + pxX) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  await writeFile(`${outDir}icon-${size}.png`, encodePng(size, render(size)));
  console.log(`icons/icon-${size}.png`);
}
