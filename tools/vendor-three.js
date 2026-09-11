/*
 * 把 Three.js 的核心与所需 addons 复制进 vendor/，让 3D 版不依赖任何 CDN。
 *
 * 为什么要打包进仓库：
 *   1. 国内访问 unpkg / jsdelivr 不稳定，走 CDN 会变成「有时能玩有时白屏」
 *   2. 离线、无网络也能跑
 *
 * 纯 Node 实现：自己解析 npm tarball（gzip + tar），不使用 child_process
 * （沙箱环境下子进程管道会 EPERM）。
 *
 *   node tools/vendor-three.js [版本]
 */
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const VERSION = process.argv[2] || '0.160.0'
const OUT = path.join(__dirname, '..', 'vendor')

/* ---------- 最小 tar 解析 ---------- */

function untar(buf) {
  const files = new Map()
  let off = 0
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512)
    let name = h.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
    if (!name) { off += 512; continue }
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '')
    if (prefix) name = prefix + '/' + name
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim(), 8) || 0
    const type = String.fromCharCode(h[156])
    const start = off + 512
    if (type === '0' || type === '\0' || type === '') {
      files.set(name, buf.subarray(start, start + size))
    }
    off = start + Math.ceil(size / 512) * 512
  }
  return files
}

/* ---------- 依赖闭包 ---------- */

const IMPORT_RE = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g

function importsOf(src) {
  const out = []
  let m
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(src)) !== null) out.push(m[1])
  return out
}

function normalize(p) {
  const parts = []
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

/* ---------- 主流程 ---------- */

async function main() {
  const tgzUrl = 'https://registry.npmjs.org/three/-/three-' + VERSION + '.tgz'
  process.stdout.write('下载 ' + tgzUrl + ' … ')
  const res = await fetch(tgzUrl)
  if (!res.ok) throw new Error('下载失败 HTTP ' + res.status)
  const gz = Buffer.from(await res.arrayBuffer())
  console.log((gz.length / 1024 / 1024).toFixed(1) + ' MB')

  const files = untar(zlib.gunzipSync(gz))
  console.log('解包 ' + files.size + ' 个文件')

  /* 运行时核心：优先压缩版 */
  const coreCandidates = [
    'package/build/three.module.min.js',
    'package/build/three.module.js',
    'package/build/three.core.min.js'
  ]
  const core = coreCandidates.find(c => files.has(c))
  if (!core) throw new Error('找不到构建产物，包内 build/ 内容：' + [...files.keys()].filter(k => k.startsWith('package/build/')).join(', '))

  const entries = [
    'package/examples/jsm/postprocessing/EffectComposer.js',
    'package/examples/jsm/postprocessing/RenderPass.js',
    'package/examples/jsm/postprocessing/UnrealBloomPass.js',
    'package/examples/jsm/postprocessing/OutputPass.js'
  ].filter(e => files.has(e))

  /* 广度优先求闭包 */
  const wanted = new Map()      /* 目标相对路径 -> 包内路径 */
  const queue = [...entries]
  const seen = new Set()

  wanted.set('three.module.min.js', core)

  while (queue.length) {
    const pkgPath = queue.shift()
    if (seen.has(pkgPath)) continue
    seen.add(pkgPath)

    const data = files.get(pkgPath)
    if (!data) continue
    const src = data.toString('utf8')

    /* 记录：examples/jsm/xxx -> addons/xxx */
    const rel = pkgPath.replace(/^package\/examples\/jsm\//, '')
    wanted.set('addons/' + rel, pkgPath)

    for (const spec of importsOf(src)) {
      if (spec === 'three') continue                       /* 由 importmap 指向核心 */
      if (spec.startsWith('three/addons/')) {
        queue.push('package/examples/jsm/' + spec.slice('three/addons/'.length))
        continue
      }
      if (spec.startsWith('three/')) continue
      if (spec.startsWith('.')) {
        queue.push(normalize(path.posix.dirname(rel).replace(/^\.$/, '') + '/' + spec).replace(/^/, 'package/examples/jsm/'))
        continue
      }
      console.log('  ! 未处理的外部依赖: ' + spec + '  (来自 ' + rel + ')')
    }
  }

  /* 写盘 */
  fs.rmSync(OUT, { recursive: true, force: true })
  let total = 0
  const rows = []
  for (const [relOut, pkgPath] of wanted) {
    const data = files.get(pkgPath)
    if (!data) { console.log('  ! 缺失 ' + pkgPath); continue }
    const dest = path.join(OUT, relOut)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
    total += data.length
    rows.push([relOut, data.length])
  }

  console.log('\n写入 vendor/ （Three.js r' + VERSION + '）:')
  rows.sort((a, b) => b[1] - a[1])
  for (const [f, n] of rows) console.log('  ' + f.padEnd(46) + (n / 1024).toFixed(1) + ' KB')
  console.log('  ' + '合计'.padEnd(44) + (total / 1024).toFixed(1) + ' KB')

  /* 自检：确认 addons 里没有残留的裸模块说明符（除 three 与 three/addons） */
  let bad = 0
  for (const [relOut, pkgPath] of wanted) {
    if (!relOut.startsWith('addons/')) continue
    for (const spec of importsOf(files.get(pkgPath).toString('utf8'))) {
      if (spec === 'three' || spec.startsWith('three/')) continue
      if (spec.startsWith('.')) {
        const resolved = normalize(path.posix.dirname(relOut) + '/' + spec)
        if (!wanted.has(resolved)) { console.log('  ! 相对依赖未打包: ' + relOut + ' -> ' + spec); bad++ }
      }
    }
  }
  console.log(bad ? '\n有 ' + bad + ' 个未解析依赖' : '\n依赖闭包完整 ✅')
  process.exit(bad ? 1 : 0)
}

main().catch(e => { console.error('\n失败: ' + (e && e.message ? e.message : e)); process.exit(1) })
