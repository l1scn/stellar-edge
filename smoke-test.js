/* 无头冒烟测试：用假的 DOM/Canvas 跑真实 game.js，覆盖各武器、各杂兵、BOSS 五套招式、全部道具分支。 */
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC_PATH = path.join(__dirname, 'game.js')
let src = fs.readFileSync(SRC_PATH, 'utf8')

/* 注入一个测试专用的状态句柄（只作用于内存中的副本，不改磁盘文件） */
const marker = 'S.p = newPlayer()\n    initStars()'
if (!src.includes(marker)) {
  console.error('FAIL: 注入点未找到，game.js 结构已变')
  process.exit(1)
}
src = src.replace(marker, marker + '\n    window.__S = S')

/* ---------- 假 Canvas 2D 上下文 ---------- */
const ctxMethodCalls = new Set()
function makeCtx(canvasEl) {
  const store = { canvas: canvasEl }
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s) => ({ width: String(s).length * 7 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return () => ({ addColorStop() {} })
      }
      if (k === 'createPattern') return () => null
      return () => { ctxMethodCalls.add(String(k)); return undefined }
    },
    set(t, k, v) { t[k] = v; return true }
  })
}

/* ---------- 假元素 ---------- */
function makeEl(id) {
  const handlers = {}
  const el = {
    id,
    width: 600,
    height: 900,
    style: {},
    dataset: {},
    textContent: '',
    title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 900 }),
    addEventListener(type, fn) { (handlers[type] = handlers[type] || []).push(fn) },
    removeEventListener() {},
    blur() {},
    focus() {},
    insertAdjacentHTML() {},
    setPointerCapture() {},
    __handlers: handlers
  }
  el.getContext = () => (el.__ctx = el.__ctx || makeCtx(el))
  return el
}

/* ---------- 假 document / window ---------- */
const els = {}
const docHandlers = {}
const winHandlers = {}
const rafQueue = []

const documentStub = {
  readyState: 'complete',
  hidden: false,
  body: { dataset: {} },
  getElementById(id) { return els[id] || (els[id] = makeEl(id)) },
  addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn) }
}

const windowStub = {
  console,
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length },
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn) },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v) { this._d[k] = String(v) }
  }
  /* 故意不提供 AudioContext：走音效降级分支 */
}

/* ---------- 捕获引擎内部报错 ---------- */
const errors = []
const origError = console.error
console.error = function (...args) {
  const s = args.map(String).join(' ')
  if (s.includes('STELLAR EDGE')) errors.push(s)
  else origError.apply(console, args)
}

/* ---------- 执行 ---------- */
const sandbox = {
  window: windowStub, document: documentStub, console, Math, JSON, Object, Array,
  String, Number, Boolean, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
  Set, Map, Proxy, WeakMap, Symbol, Date
}
sandbox.globalThis = sandbox
sandbox.self = sandbox
vm.createContext(sandbox)
try {
  vm.runInContext(src, sandbox, { filename: 'game.js' })
} catch (e) {
  origError('FAIL: 脚本加载即抛错 ->', e && e.stack ? e.stack : e)
  process.exit(1)
}

const S = windowStub.__S
if (!S) { origError('FAIL: 未能取得引擎状态'); process.exit(1) }

const stage = els.stage
if (!stage || !stage.__handlers.pointerdown) { origError('FAIL: 未接上 pointerdown'); process.exit(1) }

/* ---------- 驱动帧 ---------- */
let t = 0
function pump(frames) {
  for (let i = 0; i < frames; i++) {
    t += 1000 / 60
    const q = rafQueue.splice(0, rafQueue.length)
    for (const fn of q) fn(t)
  }
}
function tap(x, y) {
  stage.__handlers.pointerdown[0]({ clientX: x, clientY: y, pointerId: 1 })
  stage.__handlers.pointerup[0]()
}
function keydown(k) { for (const fn of winHandlers.keydown || []) fn({ key: k, preventDefault() {}, repeat: false }) }
function keyup(k) { for (const fn of winHandlers.keyup || []) fn({ key: k }) }
/* 无敌试飞员：只用于验证波次推进与成长曲线，不检验难度 */
function keepAlive() {
  if (!S.p) return
  S.p.dead = false
  S.p.hp = S.p.maxHp
  S.p.invT = 5
  S.p.lives = 3
}

/* 受控靶机：让武器 / 兵种测试不依赖随机刷怪位置与随机命中 */
function mkDummy(kind, x, y, hp) {
  return {
    kind, x, y, vx: 0, vy: 0, r: kind === 'drone' ? 15 : 24,
    hp, maxHp: hp, t: 0, fireT: 999, flash: 0, score: 100,
    amp: 40, freq: 1.5, baseY: y, dead: false, ang: 0, pat: 0, patT: 0,
    step: 0, entering: false, drift: 0, tier: 1, chargeT: 0, charge: 0, firing: 0, beamX: x
  }
}
function clearField() {
  S.enemies.length = 0
  S.ebullets.length = 0
  S.bullets.length = 0
  S.picks.length = 0
  S.boss = null
  S.queue.length = 0
  S.waveDelay = 9999
}

const results = []
function check(name, cond, extra) { results.push({ name, ok: !!cond, extra }) }

const VHY = 750   /* 机体常规站位：画布高 900，底部留 150 */

/* 1. 标题页 */
pump(120)
check('标题页可渲染', S.mode === 'title', 'mode=' + S.mode)
check('曝光度: canvas 调用种类', ctxMethodCalls.size > 15, ctxMethodCalls.size + ' 种')

/* 2. 开局 */
tap(300, 800)
pump(10)
check('点击后进入 playing', S.mode === 'playing', 'mode=' + S.mode)

/* 3. 无敌试飞 90 秒：验证波次推进 / 分数 / 强化成长 */
let held = null
for (let i = 0; i < 90; i++) {
  keepAlive()
  const k = i % 2 ? 'ArrowLeft' : 'ArrowRight'
  if (held && held !== k) keyup(held)
  keydown(k)
  held = k
  pump(60)
}
keyup(held)
check('波次推进到 8+', S.wave >= 8, 'wave=' + S.wave)
check('分数在涨', S.score > 20000, 'score=' + S.score)
check('强化 Mk 随击杀成长', S.mk >= 3, 'mk=' + S.mk + ' ×' + (1 + S.mk * 0.11).toFixed(2))
check('击杀计数', S.kills > 40, 'kills=' + S.kills)
check('试飞期间未意外结束', S.mode === 'playing', 'mode=' + S.mode)
check('键盘移动生效', Math.abs(S.p.x - 300) > 20, 'x=' + Math.round(S.p.x))

/* 4. 四种武器：正前方放受控靶机，逐一验证能否击破（含激光持续伤害与四种绘制分支） */
for (const w of ['plasma', 'laser', 'homing', 'scatter']) {
  clearField()
  S.mode = 'playing'
  keepAlive()
  S.p.weapon = w
  S.p.x = 300
  S.p.y = VHY
  S.p.tx = 300
  S.p.ty = VHY
  S.kills = 0
  S.enemies.push(mkDummy('drone', 300, VHY - 320, 600))
  pump(600)
  keepAlive()
  check('武器 ' + w + ' 能击破正前方靶机', S.kills > 0, 'kills=' + S.kills + ' 剩余hp=' +
    (S.enemies[0] ? Math.round(S.enemies[0].hp) : '已摧毁'))
}

/* 5. 全部 11 种道具分支（先清场，避免护盾在测试途中被子弹打碎） */
clearField()
keepAlive()
for (const k of ['P', 'L', 'M', 'R', 'B', 'S', 'H', 'F', 'D', 'G', 'W']) {
  keepAlive()
  S.picks.push({ x: S.p.x, y: S.p.y, vy: 0, t: 0, kind: k })
  pump(3)
}
check('11 种道具全部生效',
  S.p.rageT > 0 && S.p.doubleT > 0 && S.p.magnetT > 0 && S.p.wingT > 0 &&
  S.p.bombs >= 3 && S.p.shieldT > 0 && S.p.power >= 3 && S.p.weapon === 'scatter',
  '火力' + S.p.power + ' 武器' + S.p.weapon + ' 炸弹' + S.p.bombs +
  ' 护盾' + S.p.shieldT.toFixed(1) +
  ' 狂怒' + S.p.rageT.toFixed(1) + ' 双倍' + S.p.doubleT.toFixed(1) +
  ' 磁力' + S.p.magnetT.toFixed(1) + ' 僚机' + S.p.wingT.toFixed(1))

/* 6. BOSS 五套招式 */
S.mode = 'playing'
S.wave = 4
S.waveDelay = 0
S.queue.length = 0
S.enemies.length = 0
S.boss = null
keepAlive()
pump(200)
check('第 5 波触发 BOSS', !!S.boss, S.boss ? 'hp=' + Math.round(S.boss.hp) : 'no boss')

if (S.boss) {
  const seen = new Set()
  for (let i = 0; i < 70; i++) {
    if (!S.boss) break
    keepAlive()
    /* 周期性压到 30% 以下，触发狂暴分支 */
    S.boss.hp = (i % 5 === 0) ? Math.max(1, S.boss.maxHp * 0.3) : S.boss.maxHp
    seen.add(S.boss.pat)
    pump(40)
  }
  check('BOSS 五套招式都跑到', seen.size >= 5, 'patterns=' + [...seen].sort().join(','))
}

/* 7. 三种新兵种：血量拉到极高，保证 6 秒窗口内只验证「行为」不被击杀打断 */
for (const [kind, wave] of [['sniper', 6], ['spinner', 9], ['beamer', 11]]) {
  clearField()
  S.mode = 'playing'
  S.wave = wave
  keepAlive()
  S.picks.push({ x: S.p.x, y: S.p.y, vy: 0, t: 0, kind: 'S' })
  S.enemies.push(mkDummy(kind, 300, 150, 1e9))
  pump(360)
  const e = S.enemies[0]
  check('兵种 ' + kind + ' 可运行', S.mode === 'playing' && e && !e.dead,
    'mode=' + S.mode + ' ebullets=' + S.ebullets.length +
    (kind === 'beamer' ? ' firing=' + S.enemies[0].firing.toFixed(2) : ''))
}

/* 8. 炸弹 / 暂停 */
S.mode = 'playing'
keepAlive()
S.p.bombs = 3
S.ebullets.push({ x: 300, y: 400, vx: 0, vy: 0, c: '255,90,170', r: 6, life: 5 })
keydown(' ')
pump(30)
check('炸弹清屏', S.p.bombs === 2 && S.ebullets.length < 5, 'bombs=' + S.p.bombs + ' ebullets=' + S.ebullets.length)

keydown('p')
pump(5)
check('暂停生效', S.mode === 'paused', 'mode=' + S.mode)
const snapA = S.enemies.map(e => Math.round(e.x) + ',' + Math.round(e.y)).join('|') + '#' + S.ebullets.length + '#' + S.wave
pump(120)
const snapB = S.enemies.map(e => Math.round(e.x) + ',' + Math.round(e.y)).join('|') + '#' + S.ebullets.length + '#' + S.wave
check('暂停时战场完全冻结', snapA === snapB, snapA === snapB ? '2 秒无变化' : 'A=' + snapA + ' B=' + snapB)
keydown('p')
pump(5)
check('恢复后继续跑', S.mode === 'playing', 'mode=' + S.mode)

/* 9. 死亡与结算 */
S.mode = 'playing'
S.p.dead = false
S.p.lives = 1
S.p.hp = 1
S.p.invT = 0
S.p.shieldT = 0
S.ebullets.push({ x: S.p.x, y: S.p.y, vx: 0, vy: 0, c: '255,90,170', r: 6, life: 5 })
pump(300)
check('能进入 GAME OVER', S.mode === 'over', 'mode=' + S.mode)
check('最高分已落盘', windowStub.localStorage.getItem('stellar-edge.best') !== null,
  'best=' + windowStub.localStorage.getItem('stellar-edge.best'))

/* 10. 重开 */
keydown(' ')
pump(2)
check('可重新开局', S.mode === 'playing', 'mode=' + S.mode)
check('重开后进度归零', S.mk === 0 && S.score === 0 && S.wave <= 1,
  'mk=' + S.mk + ' score=' + S.score + ' wave=' + S.wave)
pump(150)
check('重开后可继续跑', S.mode === 'playing', 'mode=' + S.mode + ' wave=' + S.wave)

/* ---------- 汇总 ---------- */
const bad = results.filter(r => !r.ok)
const say = (s) => process.stdout.write(s + '\n')
say('')
say('================ 冒烟测试结果 ================')
for (const r of results) {
  say((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : ''))
}
say('  canvas 调用种类: ' + ctxMethodCalls.size)
say('  引擎内部报错: ' + errors.length)
for (const e of errors.slice(0, 5)) say('    ! ' + e)
say('  失败项: ' + bad.length + ' / ' + results.length)
say('=============================================')
process.exit(bad.length || errors.length ? 1 : 0)
