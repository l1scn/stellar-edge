/*
 * 星刃 3D — 模拟层
 *
 * 纯逻辑，不 import THREE、不碰 DOM，所以可以在 Node 里无头测试。
 * 坐标系沿用 2D 版的 600×900 游戏单位（x 横向、y 纵向），
 * 渲染层负责把它映射到 3D 世界空间（见 render3d.js 的 toWorld）。
 *
 * 判定只在 x-y 平面内做 —— 3D 只提供视角与视觉层次，不改变判定，
 * 这样俯视视角下躲弹依然可判读。实体带一个 h 字段表示视觉高度。
 */

export const VW = 600
export const VH = 900
export const DT = 1 / 60
const TAU = Math.PI * 2

export const WEAPON_NAME = { plasma: '等离子', laser: '激光', homing: '追踪', scatter: '霰弹' }
export const PICK_COL = {
  P: '255,220,120', L: '140,240,255', M: '255,180,90', R: '255,120,150',
  B: '130,225,255', S: '150,255,220', H: '255,150,190',
  F: '255,140,80', D: '255,225,120', G: '140,210,255', W: '160,255,200'
}
export const BUFF_ROWS = [
  { key: 'rageT', name: '狂怒', col: '255,150,90', total: 8 },
  { key: 'doubleT', name: '双倍', col: '255,225,120', total: 10 },
  { key: 'magnetT', name: '磁力', col: '150,220,255', total: 9 },
  { key: 'wingT', name: '僚机', col: '180,255,200', total: 14 }
]
const DROPS = [
  ['P', 24], ['L', 10], ['M', 10], ['R', 10], ['F', 7], ['D', 5], ['G', 5], ['W', 7],
  ['B', 10], ['S', 8], ['H', 4]
]
const DROP_RATE = { drone: 0.13, dart: 0.11, turret: 0.5, orb: 0.7, sniper: 0.45, spinner: 0.62, beamer: 0.8 }
const ENERGY = { drone: 2, dart: 2, turret: 4, orb: 5, sniper: 4, spinner: 6, beamer: 8, boss: 40 }
const MK_STEP = 0.11

/* 各类敌机的视觉高度（3D 世界单位）与体型 */
const KIND = {
  drone: { r: 15, h: 1.6, hp: 14, score: 125, linger: 22 },
  dart: { r: 12, h: 0.9, hp: 10, score: 95, linger: 0 },
  turret: { r: 22, h: 2.4, hp: 46, score: 420, linger: 26 },
  orb: { r: 24, h: 3.1, hp: 60, score: 640, linger: 28 },
  sniper: { r: 16, h: 2.0, hp: 30, score: 280, linger: 24 },
  spinner: { r: 26, h: 3.4, hp: 70, score: 720, linger: 26 },
  beamer: { r: 26, h: 0.5, hp: 108, score: 950, linger: 20 },
  boss: { r: 74, h: 2.8, hp: 980, score: 6000, linger: 0 }
}

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }
export function rand(a, b) { return a + Math.random() * (b - a) }
export function hpMul(w) { return 1 + Math.max(0, w - 1) * 0.17 + Math.max(0, w - 10) * 0.14 }
export function fireMul(w) { return 1 / (1 + Math.max(0, w - 10) * 0.035) }
export function mkNeed(mk) { return Math.round(4 + mk * 2.4) }
export function fmt(n) {
  const s = String(Math.max(0, Math.floor(n)))
  let out = '', c = 0
  for (let i = s.length - 1; i >= 0; i--) {
    out = s.charAt(i) + out
    if (++c % 3 === 0 && i > 0) out = ',' + out
  }
  return out
}

function rollDrop() {
  let total = 0
  for (const d of DROPS) total += d[1]
  let r = Math.random() * total
  for (const d of DROPS) { r -= d[1]; if (r <= 0) return d[0] }
  return 'P'
}

export function createSim(api) {
  api = api || {}
  const buzz = p => { if (api.buzz) { try { api.buzz(p) } catch (e) {} } }

  const S = {
    mode: 'title', t: 0, score: 0, wave: 0,
    combo: 0, comboT: 0, bestCombo: 0, kills: 0,
    mk: 0, energy: 0, mkFlash: 0, hitStop: 0, overT: 0,
    shake: 0, flash: 0, flashCol: '255,255,255',
    banner: '', bannerSub: '', bannerT: 0,
    bullets: [], ebullets: [], enemies: [], picks: [], parts: [], rings: [], queue: [], floats: [],
    waveDelay: 1.1, boss: null, p: null,
    keys: { left: false, right: false, up: false, down: false },
    err: '', errN: 0
  }

  const dmgMul = () => 1 + S.mk * MK_STEP

  /* ---------------- 反馈 ---------------- */

  function burst(x, y, h, n, col, power) {
    const pw = power || 1
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(30, 210) * pw, lf = rand(0.24, 0.72)
      S.parts.push({ x, y, h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: rand(-30, 60) * pw, r: rand(1.6, 4.2) * pw, life: lf, max: lf, c: col, kind: 'dot' })
    }
  }
  function spark(x, y, h, n, col) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU), sp = rand(120, 420), lf = rand(0.12, 0.3)
      S.parts.push({ x, y, h, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vh: rand(-40, 40), r: 1, life: lf, max: lf, c: col, kind: 'spark' })
    }
  }
  function ring(x, y, h, maxR, col, life, w) {
    S.rings.push({ x, y, h, r: 4, max: maxR, life, maxLife: life, c: col, w: w || 3 })
  }
  function floatText(x, y, h, text, col) {
    S.floats.push({ x, y, h, t: 0, life: 0.95, text, c: col || '200,240,255' })
  }
  function boom(x, y, h, size, col) {
    const c = col || '255,180,90'
    S.shake = Math.min(26, S.shake + size * 0.26)
    S.flash = Math.min(0.5, S.flash + size * 0.0035)
    S.flashCol = '255,220,170'
    ring(x, y, h, size * 3.1, c, 0.5, 3 + size * 0.06)
    burst(x, y, h, Math.min(34, 8 + Math.floor(size * 0.7)), c, size > 40 ? 1.5 : 1)
    spark(x, y, h, Math.min(20, 5 + Math.floor(size * 0.35)), '255,240,200')
    if (api.sound) api.sound(size > 40 ? 'bigBoom' : 'boom')
  }

  /* ---------------- 强化 ---------------- */

  function addEnergy(n) {
    S.energy += n
    let need = mkNeed(S.mk), guard = 0
    while (S.energy >= need && guard++ < 40) {
      S.energy -= need
      S.mk++
      need = mkNeed(S.mk)
      onMkUp()
    }
  }
  function onMkUp() {
    const p = S.p
    S.mkFlash = 1.3
    buzz(14)
    if (api.sound) api.sound('power')
    if (!p) return
    ring(p.x, p.y, 1, 175, '255,230,150', 0.6, 5)
    burst(p.x, p.y, 1, 16, '255,235,170', 1.1)
    floatText(p.x, p.y, 2, '强化 Mk.' + S.mk + '  ×' + dmgMul().toFixed(2), '255,232,150')
  }

  /* ---------------- 实体 ---------------- */

  function newPlayer() {
    return {
      x: VW / 2, y: VH - 150, tx: VW / 2, ty: VH - 150, h: 0,
      r: 11, hp: 100, maxHp: 100, lives: 3, power: 1, bombs: 2,
      invT: 1.8, cd: 0, shieldT: 0, dead: false, deadT: 0, trailT: 0, roll: 0,
      weapon: 'plasma', rageT: 0, doubleT: 0, magnetT: 0, wingT: 0,
      beamHits: [], wings: [
        { x: VW / 2 - 44, y: VH - 128, cd: 0.1 },
        { x: VW / 2 + 44, y: VH - 128, cd: 0.2 }
      ]
    }
  }

  function spawn(o) {
    const base = KIND[o.kind] || KIND.drone
    const e = {
      kind: 'drone', x: 0, y: -50, vx: 0, vy: 0, r: base.r, h: base.h,
      hp: base.hp, maxHp: base.hp, score: base.score,
      t: 0, fireT: 1.4, flash: 0, amp: 60, freq: 1.8, baseY: 130,
      dead: false, ang: 0, pat: 0, patT: 0, step: 0, entering: true,
      drift: 0, tier: 1, chargeT: 0, charge: 0, firing: 0,
      retreat: false, linger: base.linger
    }
    Object.assign(e, o)
    if (e.kind === 'boss') {
      e.maxHp = e.hp
      e.h = KIND.boss.h
    } else {
      e.hp = Math.max(1, Math.round(e.hp * hpMul(S.wave)))
      e.maxHp = e.hp
    }
    S.enemies.push(e)
    return e
  }
  const later = (t, fn) => S.queue.push({ t, fn })

  function addDrone(i, w, delay, x, baseY, freq) {
    later(delay, () => spawn({
      kind: 'drone', x, y: -50, amp: 52 + (i % 4) * 14, freq, baseY,
      fireT: 1.7 + Math.random() * 0.9
    }))
  }

  function form(w) {
    const shape = (w - 1) % 4
    if (shape === 0) {
      const n = 6 + Math.min(8, Math.floor(w / 3))
      for (let i = 0; i < n; i++) addDrone(i, w, i * 0.3, 90 + (i % 3) * 210, 110 + Math.floor(i / 3) * 72, 1.7)
    } else if (shape === 1) {
      const m = 7
      for (let i = 0; i < m; i++) {
        const s = i - (m - 1) / 2
        later(i * 0.09, () => spawn({
          kind: 'dart', x: VW / 2 + s * 46, y: -60 - Math.abs(s) * 26,
          vy: 185 + Math.abs(s) * 9, vx: -s * 11, fireT: 99
        }))
      }
      later(1.2, () => {
        if (w >= 6) spawn({ kind: 'spinner', x: VW / 2, y: -84, baseY: 230, ang: 0.7, fireT: 1.4 })
        else spawn({ kind: 'orb', x: VW / 2, y: -80, baseY: 210, ang: 0, fireT: 2.6 })
      })
    } else if (shape === 2) {
      later(0, () => spawn({ kind: 'turret', x: 148, y: -70, baseY: 168, drift: 70, fireT: 1.8 }))
      later(0.45, () => spawn({ kind: 'turret', x: VW - 148, y: -70, baseY: 168, drift: -70, fireT: 2.4 }))
      const q = 4 + Math.floor(w / 2)
      for (let i = 0; i < q; i++) addDrone(i, w, 1.3 + i * 0.42, 85 + i * (VW - 170) / Math.max(1, q - 1), 100 + (i % 2) * 62, 2.2)
    } else {
      const k = 2 + Math.floor(w / 7)
      for (let i = 0; i < k; i++) {
        later(i * 0.95, () => spawn({
          kind: 'orb', x: VW / 2 + (i % 2 ? 1 : -1) * (110 + i * 16),
          y: -80, baseY: 190 + i * 46, ang: i * 1.9, fireT: 2.6
        }))
      }
      for (let i = 0; i < 4; i++) {
        later(1.6 + i * 0.5, () => spawn({
          kind: 'dart', x: i % 2 ? VW - 80 : 80, y: -60,
          vy: 210, vx: i % 2 ? -40 : 40, fireT: 99
        }))
      }
    }
    if (w >= 4 && w % 2 === 0) {
      later(0.6, () => spawn({ kind: 'sniper', x: 112, y: -70, baseY: 152, fireT: 2.8 }))
      later(1.0, () => spawn({ kind: 'sniper', x: VW - 112, y: -70, baseY: 152, fireT: 3.4 }))
    }
    if (w >= 9 && w % 3 === 0) {
      later(1.5, () => spawn({ kind: 'spinner', x: 152, y: -84, baseY: 236, ang: 0.4, fireT: 1.7 }))
    }
    if (w >= 11 && w % 3 === 2) {
      later(1.3, () => {
        const bx = VW / 2 + (Math.random() < 0.5 ? -128 : 128)
        spawn({ kind: 'beamer', x: bx, y: -92, baseY: 134, fireT: 2.4 })
      })
    }
  }

  function spawnBoss(w) {
    const tier = Math.max(1, Math.floor(w / 5))
    const b = spawn({
      kind: 'boss', x: VW / 2, y: -170, r: 74,
      hp: 980 + tier * 820, score: 6000 * tier,
      baseY: 168, pat: 0, patT: 0, step: 0, entering: true, tier, fireT: 0
    })
    S.boss = b
    if (api.sound) api.sound('warn')
    buzz(45)
  }

  function nextWave() {
    S.wave++
    const w = S.wave
    S.waveDelay = 1.9
    S.bannerT = 2.1
    if (w % 5 === 0) {
      S.banner = '警  告'
      S.bannerSub = 'BOSS 接近'
      S.flash = 0.34
      S.flashCol = '255,60,90'
      spawnBoss(w)
    } else {
      S.banner = '第 ' + w + ' 波'
      S.bannerSub = ['编队突入', '疾影穿插', '重装巡弋', '蜂群散射'][(w - 1) % 4]
      form(w)
    }
  }

  /* ---------------- 武器 ---------------- */

  const pbullet = (x, y, h, vx, vy, dmg, kind) =>
    S.bullets.push({ x, y, h, vx, vy, dmg, kind: kind || 'bolt', r: 7, hit: [] })
  const ebullet = (x, y, h, vx, vy, col, r) => {
    S.ebullets.push({ x, y, h, vx, vy, r: r || 6, c: col || '255,90,170', life: 6.5 })
  }

  function fireRate(p) {
    const base = p.weapon === 'homing' ? 0.3
      : p.weapon === 'scatter' ? 0.22
        : (0.125 - Math.min(0.05, p.power * 0.009))
    return p.rageT > 0 ? base / 1.85 : base
  }

  function shoot(p) {
    const lvl = p.power
    if (p.weapon === 'homing') {
      for (let a = 0; a < lvl; a++) {
        const t = lvl === 1 ? 0.5 : a / (lvl - 1)
        const ang = -Math.PI / 2 + (t - 0.5) * 1.15
        S.bullets.push({
          x: p.x + (t - 0.5) * 34, y: p.y - 10, h: 0.6,
          vx: Math.cos(ang) * 520, vy: Math.sin(ang) * 520,
          r: 7, dmg: 20, kind: 'missile', ang, homing: true, life: 3.2, hit: []
        })
      }
      if (api.sound) api.sound('shoot')
      return
    }
    if (p.weapon === 'scatter') {
      const pairs = 5 + lvl
      const stepA = 0.24 / pairs
      pbullet(p.x, p.y - 12, 0.6, 0, -900, 8, 'pellet')
      for (let s = 1; s <= pairs; s++) {
        for (let sg = -1; sg <= 1; sg += 2) {
          const ab = -Math.PI / 2 + sg * s * stepA
          S.bullets.push({
            x: p.x, y: p.y - 12, h: 0.6,
            vx: Math.cos(ab) * 900, vy: Math.sin(ab) * 900,
            r: 5, dmg: 8, kind: 'pellet', life: 0.7, hit: []
          })
        }
      }
      if (api.sound) api.sound('shoot')
      return
    }
    const spd = -900
    pbullet(p.x, p.y - 26, 0.6, 0, spd, 12)
    if (lvl >= 2) { pbullet(p.x - 11, p.y - 16, 0.6, 0, spd, 9); pbullet(p.x + 11, p.y - 16, 0.6, 0, spd, 9) }
    if (lvl >= 3) { pbullet(p.x - 16, p.y - 6, 0.6, -150, spd * 0.98, 8); pbullet(p.x + 16, p.y - 6, 0.6, 150, spd * 0.98, 8) }
    if (lvl >= 4) { pbullet(p.x - 20, p.y + 2, 0.6, -320, spd * 0.92, 7); pbullet(p.x + 20, p.y + 2, 0.6, 320, spd * 0.92, 7) }
    if (lvl >= 5) { pbullet(p.x - 24, p.y + 8, 0.6, -520, spd * 0.8, 7); pbullet(p.x + 24, p.y + 8, 0.6, 520, spd * 0.8, 7) }
    if (api.sound) api.sound('shoot')
  }

  function nearestTarget(x, y) {
    let best = null, bd = Infinity
    for (const e of S.enemies) {
      if (e.dead || e.y < -20) continue
      const d = (e.x - x) ** 2 + (e.y - y) ** 2
      if (d < bd) { bd = d; best = e }
    }
    const b = S.boss
    if (b && !b.entering && b.hp > 0) {
      const d2 = (b.x - x) ** 2 + (b.y - y) ** 2
      if (d2 < bd) best = b
    }
    return best
  }

  function updateBeam(p, dt) {
    const hw = 7 + p.power * 2.4
    const dps = 58 + p.power * 26
    p.beamHits.length = 0
    for (const e of S.enemies) {
      if (e.dead || e.kind === 'boss' || e.y > p.y - 20) continue
      if (Math.abs(e.x - p.x) < e.r + hw) {
        hitEnemy(e, dps * dt, true)
        if (!e.dead) {
          p.beamHits.push({ x: e.x, y: e.y, h: e.h })
          if (Math.random() < 0.5) spark(e.x + rand(-e.r, e.r), e.y, e.h, 1, '200,250,255')
        }
      }
    }
    const b = S.boss
    if (b && !b.entering && b.hp > 0 && b.y < p.y - 20 && Math.abs(b.x - p.x) < b.r + hw) {
      hitEnemy(b, dps * dt, true)
      if (!b.dead) {
        p.beamHits.push({ x: b.x, y: b.y, h: b.h })
        if (Math.random() < 0.7) spark(b.x + rand(-b.r, b.r), b.y, b.h, 1, '255,230,245')
      }
    }
  }

  function updateWings(p, dt) {
    if (p.wingT <= 0) return
    const rate = p.rageT > 0 ? 0.16 : 0.24
    for (let i = 0; i < 2; i++) {
      const sgn = i === 0 ? -1 : 1
      const w = p.wings[i]
      const tx = p.x + sgn * 46
      const ty = p.y + 24 + Math.sin(S.t * 3 + i * 1.6) * 3
      w.x += (tx - w.x) * Math.min(1, dt * 5)
      w.y += (ty - w.y) * Math.min(1, dt * 5)
      w.cd -= dt
      if (w.cd <= 0) {
        w.cd = rate
        S.bullets.push({ x: w.x, y: w.y - 14, h: 0.6, vx: 0, vy: -900, r: 5, dmg: 7, kind: 'bolt', hit: [] })
      }
    }
  }

  function addScore(n) {
    const p = S.p
    S.score += Math.round(n * (p && p.doubleT > 0 ? 2 : 1))
  }

  function killEnemy(e) {
    e.dead = true
    S.kills++
    addEnergy(ENERGY[e.kind] || 1)
    S.combo++
    S.comboT = 2.3
    if (S.combo > S.bestCombo) S.bestCombo = S.combo
    const gain = Math.floor(e.score * (1 + Math.min(60, S.combo) * 0.02))
    addScore(gain)
    floatText(e.x, e.y, e.h + 1, '+' + gain, '190,245,255')
    if (e.kind === 'boss') { bigBossDeath(e); return }
    boom(e.x, e.y, e.h, e.r + 8, e.kind === 'dart' ? '255,190,90' : '255,140,110')
    const ch = DROP_RATE[e.kind]
    if (Math.random() < (ch === undefined ? 0.14 : ch)) dropPick(e.x, e.y, e.h)
  }

  /* 所有伤害的唯一入口：统一吃 Mk 倍率 */
  function hitEnemy(e, dmg, silent) {
    if (e.dead) return
    e.hp -= dmg * dmgMul()
    if (silent) {
      if (e.flash < 0.15) e.flash = 0.5
    } else {
      e.flash = 0.7
      spark(e.x + rand(-6, 6), e.y + rand(-6, 6), e.h, 2, '255,225,180')
    }
    if (e.hp <= 0) killEnemy(e)
  }

  function dropPick(x, y, h, force) {
    if (S.picks.length > 14) return
    S.picks.push({ x, y, h: 0.7, vy: 62, t: 0, kind: force || rollDrop() })
  }

  function bigBossDeath(b) {
    S.boss = null
    S.flash = 0.9
    S.flashCol = '255,240,220'
    S.shake = 30
    if (api.sound) api.sound('bigBoom')
    addScore(b.score)
    floatText(b.x, b.y, b.h + 1, '+' + fmt(b.score), '255,235,180')
    for (let i = 0; i < 9; i++) {
      later(i * 0.13, () => boom(b.x + rand(-70, 70), b.y + rand(-52, 52), b.h + rand(-1, 1), 34 + rand(0, 26), '255,170,90'))
    }
    later(0.7, () => ring(b.x, b.y, b.h, 460, '255,220,180', 0.9, 9))
    dropPick(b.x - 50, b.y, b.h, 'P')
    dropPick(b.x, b.y, b.h, ['L', 'M', 'R'][Math.floor(Math.random() * 3)])
    dropPick(b.x + 50, b.y, b.h, Math.random() < 0.5 ? 'B' : 'H')
    S.waveDelay = 2.6
  }

  function playerHit(dmg) {
    const p = S.p
    if (!p || S.mode !== 'playing' || p.dead || p.invT > 0) return
    if (p.shieldT > 0) {
      p.shieldT = 0
      p.invT = 1.3
      ring(p.x, p.y, 1, 90, '120,225,255', 0.45, 5)
      burst(p.x, p.y, 1, 14, '140,230,255', 1.1)
      floatText(p.x, p.y, 2, '护盾破碎', '150,235,255')
      if (api.sound) api.sound('hit')
      buzz(18)
      S.shake = Math.min(20, S.shake + 7)
      return
    }
    p.hp -= dmg
    S.shake = Math.min(20, S.shake + 6)
    p.invT = 0.42
    if (api.sound) api.sound('hit')
    buzz(16)
    burst(p.x, p.y, 1, 7, '255,200,140', 1)
    if (p.hp <= 0) killPlayer()
  }

  function playerBurn(dmg) {
    const p = S.p
    if (!p || S.mode !== 'playing' || p.dead || p.invT > 0) return
    if (p.shieldT > 0) { playerHit(1); return }
    p.hp -= dmg
    S.shake = Math.min(14, S.shake + dmg * 0.25)
    S.flash = Math.max(S.flash, 0.08)
    S.flashCol = '255,120,160'
    if (Math.random() < 0.4) spark(p.x + rand(-8, 8), p.y + rand(-8, 8), 1, 1, '255,160,180')
    if (p.hp <= 0) killPlayer()
  }

  function killPlayer() {
    const p = S.p
    p.dead = true
    p.deadT = 1.35
    p.hp = 0
    p.lives--
    p.rageT = p.doubleT = p.magnetT = p.wingT = 0
    S.ebullets.length = 0
    boom(p.x, p.y, 1, 62, '255,190,96')
    buzz([0, 45, 35, 65])
    S.flash = 0.72
    S.flashCol = '255,210,170'
    S.shake = 28
    S.combo = 0
  }

  function respawn() {
    const p = S.p
    p.dead = false
    p.hp = p.maxHp
    p.invT = 2.6
    p.power = Math.max(1, p.power - 1)
    p.x = VW / 2
    p.y = VH - 150
    p.tx = p.x
    p.ty = p.y
    S.ebullets.length = 0
    ring(p.x, p.y, 1, 130, '130,230,255', 0.5, 5)
  }

  function gameOver() {
    S.mode = 'over'
    S.overT = 0
    if (api.onOver) api.onOver(S.score, S.wave)
    if (api.onMode) api.onMode('over')
  }

  function useBomb() {
    const p = S.p
    if (!p || p.dead) return
    if (p.bombs <= 0) { floatText(p.x, p.y, 2, '炸弹不足', '255,150,150'); return }
    p.bombs--
    S.flash = 0.9
    S.flashCol = '190,240,255'
    S.shake = 26
    ring(p.x, p.y, 1, 900, '150,240,255', 1.1, 9)
    ring(p.x, p.y, 1, 620, '255,255,255', 0.8, 4)
    if (api.sound) api.sound('bomb')
    buzz(30)
    for (const b of S.ebullets) { burst(b.x, b.y, b.h, 2, '160,240,255', 0.7); addScore(12) }
    S.ebullets.length = 0
    for (let j = S.enemies.length - 1; j >= 0; j--) hitEnemy(S.enemies[j], 155 + p.power * 45)
    if (S.boss) hitEnemy(S.boss, 320)
    S.hitStop = 0.12
  }

  /* ---------------- 每帧 ---------------- */

  function stepFx(dt) {
    for (let i = S.parts.length - 1; i >= 0; i--) {
      const q = S.parts[i]
      q.life -= dt
      if (q.life <= 0) { S.parts.splice(i, 1); continue }
      q.x += q.vx * dt; q.y += q.vy * dt; q.h += q.vh * dt
      const dr = q.kind === 'spark' ? 0.9 : 0.86
      q.vx *= dr; q.vy *= dr; q.vh *= dr
      if (q.h < 0.1) { q.h = 0.1; q.vh = Math.abs(q.vh) * 0.4 }
    }
    for (let i = S.rings.length - 1; i >= 0; i--) {
      const r = S.rings[i]
      r.life -= dt
      if (r.life <= 0) { S.rings.splice(i, 1); continue }
      r.r += (r.max - r.r) * Math.min(1, dt * 7)
    }
    for (let i = S.floats.length - 1; i >= 0; i--) {
      const f = S.floats[i]
      f.t += dt
      f.h += 1.4 * dt
      if (f.t >= f.life) S.floats.splice(i, 1)
    }
    if (S.parts.length > 700) S.parts.splice(0, 120)
    if (S.shake > 0.2) S.shake *= Math.pow(0.0025, dt); else S.shake = 0
    if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 2.4)
    if (S.bannerT > 0) S.bannerT -= dt
    if (S.mkFlash > 0) S.mkFlash -= dt
  }

  function stepBullets(dt) {
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i]
      if (b.homing) {
        const tgt = nearestTarget(b.x, b.y)
        if (tgt) {
          const want = Math.atan2(tgt.y - b.y, tgt.x - b.x)
          let diff = want - b.ang
          while (diff > Math.PI) diff -= TAU
          while (diff < -Math.PI) diff += TAU
          b.ang += clamp(diff, -6.2 * dt, 6.2 * dt)
        }
        b.vx = Math.cos(b.ang) * 540
        b.vy = Math.sin(b.ang) * 540
        if (Math.random() < 0.4) {
          S.parts.push({ x: b.x, y: b.y, h: b.h, vx: rand(-20, 20), vy: rand(-20, 20), vh: rand(-10, 10), r: rand(1.4, 2.4), life: 0.26, max: 0.26, c: '255,170,90', kind: 'dot' })
        }
      }
      b.x += b.vx * dt
      b.y += b.vy * dt
      if (b.life !== undefined) {
        b.life -= dt
        if (b.life <= 0) { S.bullets.splice(i, 1); continue }
      }
      if (b.y < -30 || b.y > VH + 40 || b.x < -40 || b.x > VW + 40) S.bullets.splice(i, 1)
    }
    for (let i = S.ebullets.length - 1; i >= 0; i--) {
      const b = S.ebullets[i]
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.life -= dt
      if (b.y < -60 || b.y > VH + 60 || b.x < -60 || b.x > VW + 60 || b.life <= 0) S.ebullets.splice(i, 1)
    }
    for (let i = S.picks.length - 1; i >= 0; i--) {
      const pk = S.picks[i]
      pk.t += dt
      pk.y += pk.vy * dt
      pk.x += Math.sin(pk.t * 2.4) * 22 * dt
      const p = S.p
      if (p && !p.dead && p.magnetT > 0) {
        const dx = p.x - pk.x, dy = p.y - pk.y
        const d = Math.hypot(dx, dy) || 1
        if (d < 460) { pk.x += dx / d * 700 * dt; pk.y += dy / d * 700 * dt }
      }
      if (pk.y > VH + 30) { S.picks.splice(i, 1); continue }
      if (p && !p.dead && Math.hypot(pk.x - p.x, pk.y - p.y) < 32) {
        collect(pk)
        S.picks.splice(i, 1)
      }
    }
  }

  function collect(pk) {
    const p = S.p
    ring(pk.x, pk.y, pk.h, 70, PICK_COL[pk.kind] || '180,255,220', 0.35, 3)
    burst(pk.x, pk.y, pk.h, 10, PICK_COL[pk.kind] || '180,255,220', 0.8)
    const k = pk.kind
    if (k === 'P') {
      if (api.sound) api.sound('pick')
      if (p.power < 5) { p.power++; floatText(p.x, p.y, 2.4, '火力 ×' + p.power, '255,225,140') }
      else { addScore(600); floatText(p.x, p.y, 2.4, '火力满级 +600', '255,225,140') }
    } else if (k === 'L' || k === 'M' || k === 'R') {
      const wp = k === 'L' ? 'laser' : k === 'M' ? 'homing' : 'scatter'
      if (api.sound) api.sound('power')
      if (p.weapon === wp) {
        if (p.power < 5) { p.power++; floatText(p.x, p.y, 2.4, WEAPON_NAME[wp] + '同调 · 火力 ×' + p.power, PICK_COL[k]) }
        else { addScore(500); floatText(p.x, p.y, 2.4, '模组同调 +500', PICK_COL[k]) }
      } else {
        p.weapon = wp
        floatText(p.x, p.y, 2.4, '武器切换 · ' + WEAPON_NAME[wp], PICK_COL[k])
        ring(p.x, p.y, 1, 150, PICK_COL[k], 0.6, 4)
        S.flash = Math.max(S.flash, 0.22)
        S.flashCol = PICK_COL[k]
      }
    } else if (k === 'B') {
      if (api.sound) api.sound('pick')
      p.bombs = Math.min(4, p.bombs + 1)
      floatText(p.x, p.y, 2.4, '炸弹 +1', '160,230,255')
    } else if (k === 'S') {
      if (api.sound) api.sound('pick')
      p.shieldT = 9
      floatText(p.x, p.y, 2.4, '护盾展开', '140,235,255')
    } else if (k === 'H') {
      if (api.sound) api.sound('pick')
      p.hp = Math.min(p.maxHp, p.hp + 45)
      p.lives = Math.min(5, p.lives + 1)
      floatText(p.x, p.y, 2.4, '生命 +1', '255,170,200')
    } else if (k === 'F') { if (api.sound) api.sound('power'); p.rageT = 8; floatText(p.x, p.y, 2.4, '狂怒 · 射速 ×1.85', '255,150,90') }
    else if (k === 'D') { if (api.sound) api.sound('power'); p.doubleT = 10; floatText(p.x, p.y, 2.4, '双倍得分', '255,225,120') }
    else if (k === 'G') { if (api.sound) api.sound('power'); p.magnetT = 9; floatText(p.x, p.y, 2.4, '磁力场展开', '150,220,255') }
    else if (k === 'W') { if (api.sound) api.sound('power'); p.wingT = 14; floatText(p.x, p.y, 2.4, '僚机出击 ×2', '180,255,200') }
  }

  function stepPlay(dt) {
    const p = S.p
    stepBullets(dt)

    if (S.comboT > 0) {
      S.comboT -= dt
      if (S.comboT <= 0) S.combo = 0
    }
    for (let i = S.queue.length - 1; i >= 0; i--) {
      S.queue[i].t -= dt
      if (S.queue[i].t <= 0) {
        const fn = S.queue[i].fn
        S.queue.splice(i, 1)
        fn()
      }
    }
    if (!S.queue.length && !S.enemies.length && !S.boss) {
      S.waveDelay -= dt
      if (S.waveDelay <= 0) nextWave()
    }

    if (p.dead) {
      p.deadT -= dt
      if (p.deadT <= 0) { if (p.lives <= 0) gameOver(); else respawn() }
    } else {
      if (p.rageT > 0) p.rageT -= dt
      if (p.doubleT > 0) p.doubleT -= dt
      if (p.magnetT > 0) p.magnetT -= dt
      if (p.wingT > 0) p.wingT -= dt
      if (p.invT > 0) p.invT -= dt
      if (p.shieldT > 0) p.shieldT -= dt

      const kx = (S.keys.right ? 1 : 0) - (S.keys.left ? 1 : 0)
      const ky = (S.keys.down ? 1 : 0) - (S.keys.up ? 1 : 0)
      if (kx || ky) {
        const n = Math.hypot(kx, ky)
        p.x = clamp(p.x + kx / n * 620 * dt, 26, VW - 26)
        p.y = clamp(p.y + ky / n * 620 * dt, 108, VH - 84)
        p.tx = p.x; p.ty = p.y
        p.roll += (kx * 0.34 - p.roll) * Math.min(1, dt * 10)
      } else {
        const dx = p.tx - p.x, dy = p.ty - p.y
        const d = Math.hypot(dx, dy)
        if (d > 0.6) {
          const st = Math.min(d, 1500 * dt)
          p.x += dx / d * st
          p.y += dy / d * st
          p.roll += (clamp(dx / 60, -0.4, 0.4) - p.roll) * Math.min(1, dt * 8)
        } else {
          p.roll += (0 - p.roll) * Math.min(1, dt * 8)
        }
      }
      p.x = clamp(p.x, 26, VW - 26)
      p.y = clamp(p.y, 108, VH - 84)

      p.trailT -= dt
      if (p.trailT <= 0) {
        p.trailT = 0.016
        S.parts.push({ x: p.x + rand(-4, 4), y: p.y + 16, h: 0.5, vx: rand(-14, 14), vy: rand(90, 190), vh: rand(-4, 10), r: rand(1.6, 3.2), life: 0.3, max: 0.3, c: '90,200,255', kind: 'dot' })
      }
      if (p.weapon === 'laser') updateBeam(p, dt)
      else {
        p.cd -= dt
        if (p.cd <= 0) { shoot(p); p.cd = fireRate(p) }
      }
      updateWings(p, dt)
    }

    for (let i = S.enemies.length - 1; i >= 0; i--) {
      const e = S.enemies[i]
      stepEnemy(e, dt)
      if (e.dead) { S.enemies.splice(i, 1); continue }
      if (e.y > VH + 90 || (e.retreat && e.y < -160) || e.x < -160 || e.x > VW + 160) { S.enemies.splice(i, 1); continue }
    }
    if (S.boss) {
      stepBoss(S.boss, dt)
      if (S.boss && S.boss.y > VH + 200) S.boss = null
    }
    if (p.dead) return

    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i]
      let hit = false
      for (const en of S.enemies) {
        if (en.dead || en.kind === 'boss') continue
        if (Math.abs(b.x - en.x) < en.r + b.r && Math.abs(b.y - en.y) < en.r + b.r) {
          hitEnemy(en, b.dmg)
          hit = true
          break
        }
      }
      if (!hit && S.boss && !S.boss.entering && S.boss.hp > 0) {
        const bo = S.boss
        if (Math.abs(b.x - bo.x) < bo.r + b.r && Math.abs(b.y - bo.y) < bo.r * 0.82 + b.r) {
          hitEnemy(bo, b.dmg)
          hit = true
        }
      }
      if (hit) { spark(b.x, b.y, b.h, 2, '180,240,255'); S.bullets.splice(i, 1) }
    }

    for (let i = S.ebullets.length - 1; i >= 0; i--) {
      const b = S.ebullets[i]
      if (Math.abs(b.x - p.x) < p.r + b.r * 0.7 && Math.abs(b.y - p.y) < p.r + b.r * 0.7) {
        S.ebullets.splice(i, 1)
        playerHit(22)
        break
      }
    }
    for (const ce of S.enemies) {
      if (ce.dead) continue
      if (ce.kind === 'beamer' && ce.firing > 0 && Math.abs(p.x - ce.x) < 16 + p.r * 0.5 && p.y > ce.y) playerBurn(52 * dt)
      if (Math.hypot(ce.x - p.x, ce.y - p.y) < ce.r * 0.8 + p.r) { hitEnemy(ce, 40); playerHit(34); break }
    }
    if (S.boss && !S.boss.entering && Math.hypot(S.boss.x - p.x, S.boss.y - p.y) < S.boss.r * 0.85 + p.r) playerHit(40)
  }

  function stepEnemy(e, dt) {
    e.t += dt
    if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 4.2)

    /* 滞空到期后向上撤退 —— 防止打不死的残留敌人把波次永久卡住 */
    if (e.linger > 0) {
      if (e.retreat) { e.y -= 260 * dt; e.h += 0.8 * dt; return }
      if (e.t > e.linger) { e.retreat = true; return }
    }

    const p = S.p
    const aim = p && !p.dead ? Math.atan2(p.y - e.y, p.x - e.x) : Math.PI / 2
    const bs = 168 + Math.min(120, S.wave * 5)
    const fm = fireMul(S.wave)

    if (e.kind === 'drone') {
      if (e.y < e.baseY) e.y += 130 * dt
      else e.y += (e.baseY - e.y) * Math.min(1, dt * 2)
      e.x += Math.cos(e.t * e.freq) * e.amp * dt * 1.5
      e.x = clamp(e.x, 30, VW - 30)
      e.h = KIND.drone.h + Math.sin(e.t * 1.7) * 0.35
      e.fireT -= dt
      if (e.fireT <= 0 && e.y > 0) {
        e.fireT = (1.7 + Math.random() * 1.0) * fm
        ebullet(e.x, e.y + 14, e.h, Math.cos(aim) * bs * 0.8, Math.max(90, Math.sin(aim) * bs * 0.8), '255,90,170')
      }
    } else if (e.kind === 'dart') {
      e.y += e.vy * dt
      e.x += e.vx * dt
      e.vx *= 0.995
      e.h = KIND.dart.h + Math.sin(e.t * 6) * 0.2
      if (Math.random() < 0.5) {
        S.parts.push({ x: e.x + rand(-4, 4), y: e.y - 8, h: e.h, vx: rand(-10, 10), vy: rand(-70, -20), vh: rand(-6, 6), r: rand(1.2, 2.6), life: 0.24, max: 0.24, c: '255,180,80', kind: 'dot' })
      }
    } else if (e.kind === 'turret') {
      if (e.y < e.baseY) e.y += 110 * dt
      else e.x += Math.sin(e.t * 0.9) * (e.drift || 60) * dt
      e.x = clamp(e.x, 40, VW - 40)
      e.h = KIND.turret.h
      e.fireT -= dt
      if (e.fireT <= 0 && e.y > 0) {
        e.fireT = (1.9 + Math.random() * 0.6) * fm
        for (let s = -1; s <= 1; s++) {
          const a = aim + s * 0.26
          ebullet(e.x, e.y + 18, e.h, Math.cos(a) * bs, Math.sin(a) * bs, '255,175,60')
        }
      }
    } else if (e.kind === 'orb') {
      if (e.y < e.baseY) e.y += 92 * dt
      e.ang += dt * 0.85
      const cx = VW / 2 + Math.cos(e.ang) * (VW / 2 - 120)
      const cy = e.baseY + Math.sin(e.ang * 1.4) * 34
      e.x += (cx - e.x) * Math.min(1, dt * 2.2)
      e.y += (cy - e.y) * Math.min(1, dt * 2.2)
      e.h = KIND.orb.h + Math.sin(e.t * 2.2) * 0.4
      e.fireT -= dt
      if (e.fireT <= 0 && e.y > 0) {
        e.fireT = (2.8 + Math.random() * 0.7) * fm
        const n = S.wave > 14 ? 7 : 6
        for (let k = 0; k < n; k++) {
          const aa = e.t + k * TAU / n
          ebullet(e.x, e.y, e.h, Math.cos(aa) * bs * 0.72, Math.sin(aa) * bs * 0.72, '190,110,255')
        }
      }
    } else if (e.kind === 'sniper') {
      if (e.y < e.baseY) e.y += 120 * dt
      else e.x += Math.sin(e.t * 0.7) * 46 * dt
      e.x = clamp(e.x, 40, VW - 40)
      e.h = KIND.sniper.h
      if (e.chargeT > 0) {
        e.chargeT -= dt
        if (e.chargeT <= 0) {
          e.chargeT = 0
          ebullet(e.x, e.y + 16, e.h, Math.cos(aim) * 430, Math.sin(aim) * 430, '255,90,120', 7)
          if (api.sound) api.sound('hit')
          e.fireT = (2.4 + Math.random() * 1.0) * fm
        }
      } else {
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) { e.chargeT = 0.66; if (api.sound) api.sound('warn') }
      }
    } else if (e.kind === 'spinner') {
      if (e.y < e.baseY) e.y += 82 * dt
      e.ang += dt * 2.1
      const sx = VW / 2 + Math.cos(e.ang) * 172
      const sy = e.baseY + Math.sin(e.ang * 2) * 40
      e.x += (sx - e.x) * Math.min(1, dt * 1.5)
      e.y += (sy - e.y) * Math.min(1, dt * 1.5)
      e.h = KIND.spinner.h
      e.fireT -= dt
      if (e.fireT <= 0 && e.y > 0) {
        e.fireT = 0.3 * fm
        e.step++
        const sb = e.step * 0.95
        for (let w = 0; w < 3; w++) {
          const wa = sb + w * TAU / 3
          ebullet(e.x, e.y, e.h, Math.cos(wa) * bs * 0.7, Math.sin(wa) * bs * 0.7, '190,110,255')
        }
      }
    } else if (e.kind === 'beamer') {
      if (e.y < e.baseY) {
        e.y += 90 * dt
        e.x += Math.sin(e.t * 0.5) * 30 * dt
      }
      e.h = KIND.beamer.h
      if (e.firing > 0) {
        e.firing -= dt
        if (e.firing <= 0) e.fireT = 2.8 * fm
      } else if (e.charge > 0) {
        e.charge += dt / 1.05
        if (e.charge >= 1) {
          e.charge = 0
          e.firing = 0.75
          if (api.sound) api.sound('bomb')
          S.shake = Math.min(16, S.shake + 6)
          S.flash = Math.max(S.flash, 0.16)
          S.flashCol = '255,110,160'
        }
      } else {
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) e.charge = 0.001
      }
    }
  }

  function stepBoss(b, dt) {
    b.t += dt
    if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 4.2)
    b.h = KIND.boss.h + Math.sin(b.t * 1.6) * 0.5
    if (b.entering) {
      b.y += 96 * dt
      if (b.y >= b.baseY) { b.y = b.baseY; b.entering = false; b.patT = 0.6 }
      return
    }
    const p = S.p
    b.x += (VW / 2 + Math.sin(b.t * 0.62) * (VW / 2 - 118) - b.x) * Math.min(1, dt * 1.6)
    b.y = b.baseY + Math.sin(b.t * 1.1) * 12
    const aim = p && !p.dead ? Math.atan2(p.y - b.y, p.x - b.x) : Math.PI / 2
    const bs = (175 + Math.min(110, S.wave * 4)) * (1 + (b.tier - 1) * 0.08)

    b.patT -= dt
    b.fireT -= dt
    if (b.patT <= 0) {
      b.pat = (b.pat + 1) % 5
      b.patT = 4.4
      b.step = 0
      b.fireT = 0.3
      S.flash = Math.max(S.flash, 0.18)
      S.flashCol = '255,90,140'
    }
    const hpFrac = b.hp / b.maxHp
    const rage = hpFrac < 0.34 ? 1.45 : hpFrac < 0.67 ? 1.2 : 1

    if (b.pat === 0) {
      if (b.fireT <= 0) {
        b.fireT = 0.68 / rage
        b.step++
        for (let i = 0; i < 11; i++) {
          const a = b.step * 0.26 + i * TAU / 11
          ebullet(b.x, b.y + 10, b.h, Math.cos(a) * bs * 0.62, Math.sin(a) * bs * 0.62, '255,90,170')
        }
      }
    } else if (b.pat === 1) {
      if (b.fireT <= 0) {
        b.fireT = 0.6 / rage
        for (let s = -2; s <= 2; s++) {
          const a = aim + s * 0.15
          ebullet(b.x + s * 12, b.y + 30, b.h, Math.cos(a) * bs * 1.15, Math.sin(a) * bs * 1.15, '255,175,60')
        }
      }
    } else if (b.pat === 2) {
      if (b.fireT <= 0) {
        b.fireT = 0.105
        b.step++
        const base = b.step * 0.34
        ebullet(b.x - 44, b.y + 20, b.h, Math.cos(base) * bs * 0.8, Math.sin(base) * bs * 0.8, '190,110,255')
        ebullet(b.x + 44, b.y + 20, b.h, Math.cos(base + Math.PI) * bs * 0.8, Math.sin(base + Math.PI) * bs * 0.8, '190,110,255')
      }
    } else if (b.pat === 3) {
      if (b.fireT <= 0) {
        b.fireT = 0.44 / rage
        b.step++
        if (b.step % 4 === 0 && S.enemies.length < 12) {
          spawn({ kind: 'drone', x: b.x - 130, y: b.y + 20, baseY: 240, fireT: 1.9 })
          spawn({ kind: 'drone', x: b.x + 130, y: b.y + 20, baseY: 240, fireT: 2.2 })
        }
        const a2 = aim + rand(-0.12, 0.12)
        ebullet(b.x, b.y + 34, b.h, Math.cos(a2) * bs, Math.sin(a2) * bs, '90,200,255')
        ebullet(b.x - 46, b.y + 26, b.h, Math.cos(a2 + 0.3) * bs * 0.9, Math.sin(a2 + 0.3) * bs * 0.9, '90,200,255')
        ebullet(b.x + 46, b.y + 26, b.h, Math.cos(a2 - 0.3) * bs * 0.9, Math.sin(a2 - 0.3) * bs * 0.9, '90,200,255')
      }
    } else {
      if (b.fireT <= 0) {
        b.fireT = 1.5 / rage
        b.step++
        const cols = 11
        const gap = (b.step * 2) % (cols - 2)
        for (let c = 0; c < cols; c++) {
          if (c === gap || c === gap + 1 || c === gap + 2) continue
          ebullet(34 + c * (VW - 68) / (cols - 1), b.y + 46, b.h, 0, bs * 0.82, '90,200,255')
        }
        if (api.sound) api.sound('hit')
      }
    }
  }

  /* ---------------- 对外接口 ---------------- */

  function startRun() {
    S.mode = 'playing'
    S.score = 0; S.wave = 0; S.combo = 0; S.comboT = 0; S.bestCombo = 0; S.kills = 0
    S.mk = 0; S.energy = 0; S.mkFlash = 0
    S.bullets = []; S.ebullets = []; S.enemies = []; S.picks = []
    S.parts = []; S.rings = []; S.floats = []; S.queue = []
    S.boss = null
    S.waveDelay = 1.1; S.bannerT = 0; S.shake = 0; S.flash = 0; S.hitStop = 0
    S.err = ''; S.errN = 0
    S.p = newPlayer()
    if (api.onMode) api.onMode('playing')
  }

  S.p = newPlayer()

  function step(dt) {
    dt = dt || DT
    try {
      if (S.hitStop > 0) { S.hitStop -= dt; dt *= 0.25 }
      if (S.mode === 'paused') {
        S.t += dt * 0.3
        if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 3)
        return
      }
      S.t += dt
      if (S.mode === 'playing') stepPlay(dt)
      else if (S.mode === 'over') { stepBullets(dt); S.overT += dt }
      stepFx(dt)
    } catch (e) {
      S.errN++
      if (S.errN <= 3) S.err = String(e && e.message ? e.message : e)
    }
  }

  function togglePause() {
    if (S.mode === 'playing') { S.mode = 'paused'; if (api.onMode) api.onMode('paused') }
    else if (S.mode === 'paused') { S.mode = 'playing'; if (api.onMode) api.onMode('playing') }
  }
  function action() {
    if (S.mode === 'title') startRun()
    else if (S.mode === 'over') { if (S.overT > 0.5) startRun() }
    else if (S.mode === 'paused') togglePause()
    else if (S.mode === 'playing') useBomb()
  }
  function setKey(name, down) { if (name in S.keys) S.keys[name] = !!down }
  function pointerDown(x, y) {
    const p = S.p
    if (!p || p.dead) return
    p.drag = true
    p.offX = p.x - x
    p.offY = p.y - y
    p.lastX = x
    p.lastY = y
    p.tx = p.x
    p.ty = p.y
  }
  function pointerMove(x, y) {
    const p = S.p
    if (!p || !p.drag || p.dead) return
    const g = api.dragGain || 1
    p.tx = clamp(p.tx + (x - p.lastX) * g, 26, VW - 26)
    p.ty = clamp(p.ty + (y - p.lastY) * g, 108, VH - 84)
    p.lastX = x
    p.lastY = y
  }
  function pointerUp() { if (S.p) S.p.drag = false }

  return {
    state: S,
    step, action, togglePause, setKey, pointerDown, pointerMove, pointerUp,
    mode: () => S.mode,
    startRun,
    restart: startRun,
    bombs: () => (S.p ? S.p.bombs : 0),
    score: () => S.score,
    wave: () => S.wave,
    dmgMul,
    err: () => S.err
  }
}
