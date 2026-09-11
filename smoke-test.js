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
  const classes = new Set()
  const el = {
    id,
    width: 600,
    height: 900,
    style: {},
    dataset: {},
    textContent: '',
    title: '',
    classList: {
      add(c) { classes.add(c) },
      remove(c) { classes.delete(c) },
      toggle(c, on) {
        if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c) }
        else if (on) classes.add(c)
        else classes.delete(c)
      },
      contains(c) { return classes.has(c) }
    },
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
const fsCalls = []
const vibes = []

/* 全屏 API 桩：documentElement + exitFullscreen */
const docElStub = {
  requestFullscreen() { fsCalls.push('enter'); return Promise.resolve() },
  webkitRequestFullscreen() { fsCalls.push('enter'); return Promise.resolve() }
}

const documentStub = {
  readyState: 'complete',
  hidden: false,
  fullscreenElement: null,
  documentElement: docElStub,
  exitFullscreen() { fsCalls.push('exit'); return Promise.resolve() },
  body: { dataset: {} },
  getElementById(id) { return els[id] || (els[id] = makeEl(id)) },
  addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn) }
}

const windowStub = {
  console,
  requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length },
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn) },
  /* 伪装成触摸设备：覆盖率走触屏分支（拖动增益 1.35、标题页触屏文案） */
  matchMedia(q) { return { matches: /coarse/.test(q), media: q } },
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null },
    setItem(k, v) { this._d[k] = String(v) }
  }
  /* 故意不提供 AudioContext：走音效降级分支 */
}

const navigatorStub = {
  vibrate(p) { vibes.push(p); return true }
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
  window: windowStub, document: documentStub, navigator: navigatorStub,
  console, Math, JSON, Object, Array,
  String, Number, Boolean, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
  Set, Map, Proxy, WeakMap, Symbol, Date, Promise
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
function pump(frames, onFrame) {
  for (let i = 0; i < frames; i++) {
    t += 1000 / 60
    const q = rafQueue.splice(0, rafQueue.length)
    for (const fn of q) fn(t)
    if (onFrame) onFrame()
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

/* 2. 开局：点一下就应该「既能开局、又能马上拖」 */
const down = stage.__handlers.pointerdown[0]
const move = stage.__handlers.pointermove[0]
const up = stage.__handlers.pointerup[0]

down({ clientX: 300, clientY: 800, pointerId: 1 })
pump(5)
check('点击后进入 playing', S.mode === 'playing', 'mode=' + S.mode)

const px0 = S.p.x
move({ clientX: 340, clientY: 800, pointerId: 1 })   /* 手指右移 40 */
pump(30)
const px1 = S.p.x
up()
check('开局那次触摸就能直接拖飞机', px1 > px0 + 20,
  'x ' + Math.round(px0) + ' -> ' + Math.round(px1))
check('触屏拖动有 1.35 倍增益', (px1 - px0) > 46 && (px1 - px0) < 62,
  'dx=' + Math.round(px1 - px0) + '（手指位移 40，期望 ≈54）')

/* 2b. 全屏与震动接线 */
const btnFull = els.btnFull
check('存在全屏按钮并已接线',
  !!(btnFull && btnFull.__handlers.click && btnFull.__handlers.click.length))
if (btnFull && btnFull.__handlers.click && btnFull.__handlers.click.length) {
  btnFull.__handlers.click[0]()
  check('点击全屏会调用 requestFullscreen', fsCalls.includes('enter'), 'fsCalls=' + fsCalls.join(','))
}

/* 3. 无敌试飞 90 秒：用「会瞄准的试飞员」验证波次推进 / 分数 / 强化成长。
      早先用左右横扫的无脑飞行员，会出现「一直打不死缩在边缘的敌人 → 波次永久卡住」，
      那是试飞员太笨；不过它顺带暴露了「悬停敌人永不离场」的隐患（见 3b）。 */
let xmin = 9999, xmax = -9999
let lastWave = S.wave
let lastWaveAt = 0
let worstStall = 0

function aimPilot() {
  let target = null
  if (S.boss && !S.boss.entering) {
    target = S.boss
  } else {
    let bd = Infinity
    for (const e of S.enemies) {
      if (e.dead || e.kind === 'boss') continue
      const d = Math.abs(e.x - S.p.x) + (e.retreat ? 900 : 0)
      if (d < bd) { bd = d; target = e }
    }
  }
  keyup('ArrowLeft')
  keyup('ArrowRight')
  if (!target) return
  const dx = target.x - S.p.x
  if (dx < -5) keydown('ArrowLeft')
  else if (dx > 5) keydown('ArrowRight')
}

for (let f = 0; f < 150 * 60; f++) {
  keepAlive()
  aimPilot()
  pump(1)
  if (S.p.x < xmin) xmin = S.p.x
  if (S.p.x > xmax) xmax = S.p.x
  if (S.wave !== lastWave) { lastWave = S.wave; lastWaveAt = f }
  else if (f - lastWaveAt > worstStall) worstStall = f - lastWaveAt
}
keyup('ArrowLeft')
keyup('ArrowRight')
check('波次持续推进（无卡死）', S.wave >= 8 && worstStall < 60 * 60,
  'wave=' + S.wave + ' kills=' + S.kills +
  ' 最长无进展=' + (worstStall / 60).toFixed(1) + 's' +
  ' 横扫[' + Math.round(xmin) + ',' + Math.round(xmax) + ']' +
  ' 残留=' + S.enemies.filter(e => !e.dead).map(e => e.kind + ' hp' + Math.round(e.hp)).join(' '))
check('分数在涨', S.score > 20000, 'score=' + S.score)
check('强化 Mk 随击杀成长', S.mk >= 3, 'mk=' + S.mk + ' ×' + (1 + S.mk * 0.11).toFixed(2))
check('击杀计数', S.kills > 40, 'kills=' + S.kills)
check('试飞期间未意外结束', S.mode === 'playing', 'mode=' + S.mode)
check('键盘移动生效', Math.abs(S.p.x - 300) > 20, 'x=' + Math.round(S.p.x))

/* 3b. 悬停敌人滞空到期会撤退 —— 保证波次不会因为「打不死的残留敌人」永久卡住 */
clearField()
S.mode = 'playing'
S.wave = 3
keepAlive()
S.p.x = 30; S.p.tx = 30
S.p.y = VHY; S.p.ty = VHY
const stubborn = mkDummy('drone', 570, 100, 1e9)   /* 血量拉到打不死，保证只能靠撤退离场 */
stubborn.linger = 22
stubborn.amp = 0
stubborn.freq = 0
S.enemies.push(stubborn)
let sawRetreat = false
for (let f = 0; f < 60 * 32; f++) {
  keepAlive()
  pump(1)
  if (S.enemies[0] && S.enemies[0].retreat) sawRetreat = true
  if (!S.enemies.length) break
}
check('打不死的悬停敌人会撤退离场', sawRetreat && S.enemies.length === 0,
  '进入撤退=' + sawRetreat + ' 剩余=' + S.enemies.length)

/* 4. 四种武器：正前方放受控靶机，验证能否稳定命中并造成实质伤害。
      注意霰弹是 ±29° 扇形，远距离只有部分弹丸命中，这是设计而不是 bug，
      所以判据是「造成 ≥25% 伤害」而不是「必须击杀」。 */
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
  /* 靶机不摆动，避免命中与否取决于相位这种偶然因素 */
  const dummy = mkDummy('drone', 300, VHY - 320, 600)
  dummy.amp = 0
  dummy.freq = 0
  S.enemies.push(dummy)
  const hp0 = dummy.hp
  pump(600)
  keepAlive()
  const dealt = hp0 - Math.max(0, dummy.hp)
  check('武器 ' + w + ' 能命中靶机', dealt >= hp0 * 0.25,
    '造成 ' + Math.round(dealt) + '/' + hp0 + ' 伤害' + (dummy.hp <= 0 ? '（已击破）' : '（剩余 ' + Math.round(dummy.hp) + '）'))
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
  S.p.bombs >= 3 && S.p.shieldT > 0 && S.p.power >= 2 && S.p.weapon === 'scatter',
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
  /* 血量拉到打不死：这个窗口只验证「五套招式会轮换」，
     否则强力武器会把 BOSS 秒掉，根本来不及换招（之前就踩过这个坑）。 */
  S.boss.maxHp = 1e9
  S.boss.hp = 1e9
  const seen = new Set()
  for (let i = 0; i < 70; i++) {
    if (!S.boss) break
    keepAlive()
    seen.add(S.boss.pat)
    pump(40)
  }
  check('BOSS 五套招式都跑到', seen.size >= 5, 'patterns=' + [...seen].sort().join(','))

  /* 狂暴分支：压到 30% 以下，确认射速加快的代码路径能跑通且不报错 */
  if (S.boss) {
    S.boss.hp = S.boss.maxHp * 0.28
    keepAlive()
    pump(180)
    check('BOSS 低血量狂暴分支可运行', S.mode === 'playing' && !!S.boss,
      'mode=' + S.mode + ' hp=' + Math.round(S.boss ? S.boss.hp : -1) + ' 弹幕=' + S.ebullets.length)
  }
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

/* 8b. 触屏浮动炸弹键 */
const bombBtn = els.btnBomb
check('存在浮动炸弹键并已接线',
  !!(bombBtn && bombBtn.__handlers.pointerdown && bombBtn.__handlers.pointerdown.length))
if (bombBtn && bombBtn.__handlers.pointerdown && bombBtn.__handlers.pointerdown.length) {
  S.mode = 'playing'
  keepAlive()
  S.p.bombs = 2
  S.ebullets.push({ x: 300, y: 400, vx: 0, vy: 0, c: '255,90,170', r: 6, life: 5 })
  bombBtn.__handlers.pointerdown[0]({ preventDefault() {} })
  pump(20)
  check('浮动炸弹键能释放炸弹', S.p.bombs === 1 && S.ebullets.length < 5,
    'bombs=' + S.p.bombs + ' ebullets=' + S.ebullets.length)
  check('炸弹数量已同步到按钮', els.bombNum && els.bombNum.textContent === '1',
    'label=' + (els.bombNum ? els.bombNum.textContent : '无'))
  /* 数量为 0 时应置灰 */
  S.p.bombs = 0
  pump(3)
  check('炸弹耗尽后按钮置灰', els.btnBomb.classList.contains('is-empty'), 'is-empty=' + els.btnBomb.classList.contains('is-empty'))
  check('放炸弹触发震动反馈', vibes.length > 0, 'vibrate 调用 ' + vibes.length + ' 次: ' + JSON.stringify(vibes.slice(0, 4)))
}

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

/* 11. 伤害结算回归：撞机 / BOSS 分数 / 炸弹（这几条都曾真实出错） */
{
  S.mode = 'playing'
  S.p.dead = false
  S.p.hp = S.p.maxHp
  S.p.lives = 3
  S.p.weapon = 'plasma'
  S.p.doubleT = 0
  const R = 1 + S.mk * 0.11

  /* 把机体钉在目标身上：只留撞机伤害，不掺入武器输出 */
  function glue(target, frames, keepInv) {
    let lost = 0
    let taken = 0
    for (let i = 0; i < frames; i++) {
      S.p.dead = false
      S.p.cd = 1e9
      S.p.x = target.x; S.p.y = target.y
      S.p.tx = target.x; S.p.ty = target.y
      S.p.invT = keepInv ? 5 : 0
      const a = target.hp
      const b = S.p.hp
      S.bullets.length = 0
      pump(1)
      lost += Math.max(0, a - target.hp)
      taken += Math.max(0, b - S.p.hp)
      S.p.hp = S.p.maxHp
    }
    return { lost, taken }
  }

  /* 撞机是一次 0.5 秒的双向交换，而不是每帧刷伤害 */
  clearField()
  const ramT = mkDummy('drone', S.p.x, S.p.y, 1e6)
  S.enemies.push(ramT)
  const r1 = glue(ramT, 60, false)
  const cap = 40 * R * 4
  check('撞机伤害有冷却（1 秒最多 4 次接触结算）', r1.lost > 0 && r1.lost <= cap,
    '1 秒掉血 ' + Math.round(r1.lost) + '（上限 ' + Math.round(cap) + '，修复前 2400）')
  check('撞机对玩家同样结算', r1.taken > 0, '玩家掉血 ' + Math.round(r1.taken))

  clearField()
  const invT = mkDummy('drone', S.p.x, S.p.y, 1e6)
  S.enemies.push(invT)
  const r2 = glue(invT, 60, true)
  check('无敌帧内撞机不输出伤害（复活后不能白撞）', Math.round(r2.lost) === 0,
    '无敌 1 秒掉血 ' + Math.round(r2.lost) + '（修复前 2400）')

  /* 炸弹只对 BOSS 结算一次专属伤害 */
  clearField()
  const bombBoss = mkDummy('boss', S.p.x, 300, 1e6)
  S.enemies.push(bombBoss)
  S.boss = bombBoss
  S.p.bombs = 3
  S.p.dead = false
  S.p.hp = S.p.maxHp
  const wantBomb = 320 * R
  const bombHp0 = bombBoss.hp
  els.btnBomb.__handlers.pointerdown[0]({ preventDefault: function () {} })
  check('炸弹对 BOSS 只打一次（320 × 强化倍率）', Math.abs((bombHp0 - bombBoss.hp) - wantBomb) < 0.001,
    '掉血 ' + Math.round(bombHp0 - bombBoss.hp) + ' 应为 ' + Math.round(wantBomb) +
    '（修复前 ' + Math.round(wantBomb + (155 + S.p.power * 45) * R) + '）')

  /* BOSS 分数只在通用击杀路径结算一次 */
  clearField()
  S.score = 0
  S.combo = 0
  S.comboT = 0
  const killBoss = mkDummy('boss', S.p.x, 300, 30)
  killBoss.score = 6000
  killBoss.entering = false
  S.enemies.push(killBoss)
  S.boss = killBoss
  S.p.cd = 0
  for (let i = 0; i < 300 && S.boss === killBoss; i++) {
    S.p.dead = false
    S.p.hp = S.p.maxHp
    S.p.x = killBoss.x; S.p.tx = killBoss.x
    S.p.y = 700; S.p.ty = 700
    pump(1)
  }
  check('BOSS 分数按连击结算一次', S.score === 6120,
    '入账 ' + S.score + ' 应为 6120（修复前 12120）')

  /* BOSS 入场动画期间不参与机身碰撞 */
  clearField()
  const entering = mkDummy('boss', S.p.x, 300, 1e6)
  entering.entering = true
  entering.baseY = 4000        /* 让它整个测量期间都停在「入场中」 */
  entering.y = 300
  S.enemies.push(entering)
  S.boss = entering
  const r3 = glue(entering, 60, false)
  check('入场动画期间不参与机身碰撞', r3.lost === 0 && r3.taken === 0,
    'BOSS 掉血 ' + Math.round(r3.lost) + ' 玩家掉血 ' + Math.round(r3.taken))

  clearField()
  S.p.dead = false
  S.p.hp = S.p.maxHp
  S.p.cd = 0
}

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
