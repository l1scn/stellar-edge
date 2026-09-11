/*
 * 生成 PWA 图标（192 / 512 / apple-touch 180）。
 *
 * 不引入任何依赖：手写 PNG 编码器（IHDR + IDAT(zlib) + IEND），
 * 用点到多边形判定把星刃机体的矢量路径栅格化，再做两遍箱式模糊做外发光。
 *
 *   node tools/make-icons.js
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td), 0)
  return Buffer.concat([len, td, crc])
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // color type: RGBA
  ihdr[10] = 0   // compression
  ihdr[11] = 0   // filter
  ihdr[12] = 0   // interlace

  // 每行前加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ---------- 机体矢量路径（与 game.js 中的机身多边形一致） ---------- */

const SHIP = [
  [0, -31], [6, -10], [21, 8], [9, 6], [6, 17],
  [0, 13], [-6, 17], [-9, 6], [-21, 8], [-6, -10]
]

function inPoly(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function boxBlur(src, w, h, radius, passes) {
  let a = Float32Array.from(src)
  let b = new Float32Array(w * h)
  for (let p = 0; p < passes; p++) {
    // 水平
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let x = -radius; x <= radius; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))]
      for (let x = 0; x < w; x++) {
        b[y * w + x] = sum / (radius * 2 + 1)
        const out = a[y * w + Math.min(w - 1, Math.max(0, x - radius))]
        const inn = a[y * w + Math.min(w - 1, Math.max(0, x + radius + 1))]
        sum += inn - out
      }
    }
    // 垂直
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let y = -radius; y <= radius; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x]
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (radius * 2 + 1)
        const out = b[Math.min(h - 1, Math.max(0, y - radius)) * w + x]
        const inn = b[Math.min(h - 1, Math.max(0, y + radius + 1)) * w + x]
        sum += inn - out
      }
    }
  }
  return a
}

function renderIcon(size, shipScale) {
  const rgba = Buffer.alloc(size * size * 4)
  const cx = size / 2
  const cy = size / 2

  // 机体：按包围盒适配
  const s = size * shipScale / 48
  const poly = SHIP.map(([x, y]) => [cx + x * s, cy + (y + 7) * s])

  const mask = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inPoly(x + 0.5, y + 0.5, poly)) mask[y * size + x] = 1
    }
  }
  const glow = boxBlur(mask, size, size, Math.max(2, Math.round(size / 22)), 2)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const o = i * 4

      // 背景：中心偏亮的深空径向渐变
      const dx = (x - cx) / size
      const dy = (y - cy) / size
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.7)
      let r = 22 * (1 - d) + 3 * d
      let g = 44 * (1 - d) + 4 * d
      let b = 96 * (1 - d) + 14 * d

      // 外发光（青色）
      const gl = Math.min(1, glow[i] * 1.15)
      r += 70 * gl
      g += 190 * gl
      b += 235 * gl

      // 机体本体：上白下蓝的纵向渐变
      const m = mask[i]
      if (m) {
        const t = Math.min(1, Math.max(0, (y - (cy - 31 * s)) / (48 * s)))
        r = r * (1 - m) + (234 * (1 - t) + 47 * t) * m
        g = g * (1 - m) + (252 * (1 - t) + 157 * t) * m
        b = b * (1 - m) + (255 * (1 - t) + 255 * t) * m
      }

      rgba[o] = Math.max(0, Math.min(255, Math.round(r)))
      rgba[o + 1] = Math.max(0, Math.min(255, Math.round(g)))
      rgba[o + 2] = Math.max(0, Math.min(255, Math.round(b)))
      rgba[o + 3] = 255
    }
  }
  return encodePNG(size, size, rgba)
}

/* ---------- 输出 ---------- */

const outDir = path.join(__dirname, '..')
const targets = [
  ['icon-192.png', 192, 0.56],
  ['icon-512.png', 512, 0.56],
  ['apple-touch-icon.png', 180, 0.56],
  ['favicon-32.png', 32, 0.62]
]

for (const [name, size, scale] of targets) {
  const buf = renderIcon(size, scale)
  const p = path.join(outDir, name)
  fs.writeFileSync(p, buf)
  console.log(name.padEnd(22) + size + 'x' + size + '  ' + buf.length + ' bytes')
}
console.log('\n完成。')
