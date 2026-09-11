/*!
 * 星刃 STELLAR EDGE — 霓虹纵向弹幕射击
 * 纯 Canvas 2D 实现，零运行时依赖。
 */
(function () {
  'use strict'

  /* ============================================================
   *  常量与工具
   * ============================================================ */

  var VW = 600
  var VH = 900
  var DT = 1 / 60
  var TAU = Math.PI * 2
  var FONT = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'

  var WEAPON_NAME = { plasma: '等离子', laser: '激光', homing: '追踪', scatter: '霰弹' }

  var PICK_COL = {
    P: '255,220,120', L: '140,240,255', M: '255,180,90', R: '255,120,150',
    B: '130,225,255', S: '150,255,220', H: '255,150,190',
    F: '255,140,80', D: '255,225,120', G: '140,210,255', W: '160,255,200'
  }

  var BUFF_ROWS = [
    { key: 'rageT', name: '狂怒', col: '255,150,90', total: 8 },
    { key: 'doubleT', name: '双倍', col: '255,225,120', total: 10 },
    { key: 'magnetT', name: '磁力', col: '150,220,255', total: 9 },
    { key: 'wingT', name: '僚机', col: '180,255,200', total: 14 }
  ]

  var DROPS = [
    ['P', 24], ['L', 10], ['M', 10], ['R', 10], ['F', 7], ['D', 5], ['G', 5], ['W', 7],
    ['B', 10], ['S', 8], ['H', 4]
  ]

  var DROP_RATE = { drone: 0.13, dart: 0.11, turret: 0.5, orb: 0.7, sniper: 0.45, spinner: 0.62, beamer: 0.8 }

  var ENERGY = { drone: 2, dart: 2, turret: 4, orb: 5, sniper: 4, spinner: 6, beamer: 8, boss: 40 }

  var MK_STEP = 0.11

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v) }
  function rand(a, b) { return a + Math.random() * (b - a) }

  function fmt(n) {
    var s = String(Math.max(0, Math.floor(n)))
    var out = ''
    var c = 0
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out
      c++
      if (c % 3 === 0 && i > 0) out = ',' + out
    }
    return out
  }

  /* 敌人血量随波数成长 */
  function hpMul(w) {
    var x = Math.max(0, w - 1)
    return 1 + x * 0.17 + Math.max(0, w - 10) * 0.14
  }

  /* 第 10 波后敌人射速加快（返回的是间隔倍率，越小越快） */
  function fireMul(w) { return 1 / (1 + Math.max(0, w - 10) * 0.035) }

  /* 强化 Mk 升级所需能量 */
  function mkNeed(mk) { return Math.round(4 + mk * 2.4) }

  function rollDrop() {
    var total = 0
    var i
    for (i = 0; i < DROPS.length; i++) total += DROPS[i][1]
    var r = Math.random() * total
    for (i = 0; i < DROPS.length; i++) {
      r -= DROPS[i][1]
      if (r <= 0) return DROPS[i][0]
    }
    return 'P'
  }

  /* ============================================================
   *  音效（WebAudio 实时合成，失败时静默降级）
   * ============================================================ */

  function createAudio() {
    var Ctor = null
    try {
      var w = window
      if (w) Ctor = w.AudioContext || w.webkitAudioContext || null
    } catch (e) { Ctor = null }

    var api = {
      supported: !!Ctor,
      on: !!Ctor,
      ensure: function () {},
      isOn: function () { return api.on },
      setOn: function (v) { api.on = !!v; if (api.on) api.ensure() },
      shoot: function () {}, hit: function () {}, boom: function () {},
      pick: function () {}, power: function () {}, bomb: function () {}, warn: function () {}
    }
    if (!Ctor) return api

    var ac = null

    function ensure() {
      if (!api.on) return null
      try {
        if (!ac) ac = new Ctor()
        if (ac.state === 'suspended' && ac.resume) ac.resume()
        return ac
      } catch (e) { return null }
    }

    function tone(f0, f1, dur, type, vol) {
      var a = ensure()
      if (!a) return
      try {
        var t0 = a.currentTime
        var o = a.createOscillator()
        var gn = a.createGain()
        o.type = type
        o.frequency.setValueAtTime(f0, t0)
        if (f1 && f1 !== f0 && o.frequency.exponentialRampToValueAtTime) {
          o.frequency.exponentialRampToValueAtTime(Math.max(24, f1), t0 + dur)
        }
        gn.gain.setValueAtTime(0.0001, t0)
        gn.gain.exponentialRampToValueAtTime(vol, t0 + 0.008)
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
        o.connect(gn)
        gn.connect(a.destination)
        o.start(t0)
        o.stop(t0 + dur + 0.03)
      } catch (e) {}
    }

    function noise(dur, vol, cutoff) {
      var a = ensure()
      if (!a) return
      try {
        var n = Math.max(1, Math.floor(a.sampleRate * dur))
        var buf = a.createBuffer(1, n, a.sampleRate)
        var d = buf.getChannelData(0)
        for (var i = 0; i < n; i++) {
          var k = 1 - i / n
          d[i] = (Math.random() * 2 - 1) * k * k
        }
        var src = a.createBufferSource()
        src.buffer = buf
        var f = a.createBiquadFilter()
        f.type = 'lowpass'
        f.frequency.setValueAtTime(cutoff, a.currentTime)
        var gn = a.createGain()
        gn.gain.value = vol
        src.connect(f)
        f.connect(gn)
        gn.connect(a.destination)
        src.start()
      } catch (e) {}
    }

    api.ensure = ensure
    api.shoot = function () { tone(1180, 1720, 0.04, 'square', 0.012) }
    api.hit = function () { tone(360, 200, 0.05, 'sawtooth', 0.016) }
    api.boom = function (big) {
      noise(big ? 0.55 : 0.2, big ? 0.3 : 0.13, big ? 900 : 1900)
      if (big) tone(150, 44, 0.5, 'sawtooth', 0.07)
    }
    api.pick = function () { tone(720, 1440, 0.14, 'triangle', 0.05) }
    api.power = function () { tone(520, 1560, 0.22, 'triangle', 0.06); tone(780, 2340, 0.26, 'sine', 0.04) }
    api.bomb = function () { noise(0.85, 0.34, 760); tone(96, 32, 0.75, 'sawtooth', 0.08) }
    api.warn = function () { tone(210, 210, 0.2, 'square', 0.035) }

    return api
  }

  /* ============================================================
   *  游戏本体
   * ============================================================ */

  function createGame(g, bctx, api) {
    var A = api.audio
    var BW = 150
    var BH = 225
    var SILENT = { silent: true }

    /* 悬停类敌人不会自己离场。给它们一个滞空预算，到点撤退 ——
       否则只要有一架打不死（例如缩在屏幕边缘），波次就永远不会推进。 */
    var HOVER = { drone: 1, turret: 1, orb: 1, sniper: 1, spinner: 1, beamer: 1 }
    var LINGER = { drone: 22, turret: 26, orb: 28, sniper: 24, spinner: 26, beamer: 20 }

    /* 触屏上把手指位移放大，否则手指从屏幕下方出发时飞机够不到上半屏 */
    var TOUCH = !!(api.touch && api.touch())
    var DRAG_GAIN = TOUCH ? 1.35 : 1

    /* 触觉反馈（仅移动端有意义），静默降级 */
    function buzz(pattern) {
      if (!api.buzz) return
      try { api.buzz(pattern) } catch (e) {}
    }

    var S = {
      mode: 'title', t: 0, score: 0, wave: 0,
      combo: 0, comboT: 0, bestCombo: 0, kills: 0,
      mk: 0, energy: 0, mkFlash: 0,
      shake: 0, flash: 0, flashCol: '255,255,255',
      banner: '', bannerSub: '', bannerT: 0,
      stars: [], parts: [], bullets: [], ebullets: [], enemies: [],
      picks: [], floats: [], rings: [], queue: [],
      waveDelay: 1.1, boss: null, p: null, overT: 0,
      drag: false, offX: 0, offY: 0, lastX: 0, lastY: 0, hitStop: 0,
      keys: { left: false, right: false, up: false, down: false },
      err: '', errN: 0
    }

    /* ---------- 能力探测：canvas filter 是否可用（泛光通道） ---------- */
    var canFilter = false
    try {
      g.filter = 'blur(1px)'
      canFilter = g.filter === 'blur(1px)'
      g.filter = 'none'
    } catch (e) { canFilter = false }

    /* ---------- 预建渐变（避免逐帧分配） ---------- */
    var bgGrad = g.createLinearGradient(0, 0, 0, VH)
    bgGrad.addColorStop(0, '#04050e')
    bgGrad.addColorStop(0.42, '#070c20')
    bgGrad.addColorStop(1, '#03040c')

    var hudTop = g.createLinearGradient(0, 0, 0, 92)
    hudTop.addColorStop(0, 'rgba(9,18,40,.92)')
    hudTop.addColorStop(1, 'rgba(6,12,28,0.18)')

    var hudBot = g.createLinearGradient(0, VH - 74, 0, VH)
    hudBot.addColorStop(0, 'rgba(6,12,28,0.2)')
    hudBot.addColorStop(1, 'rgba(9,18,40,.94)')

    var vig = g.createRadialGradient(VW / 2, VH * 0.44, VH * 0.22, VW / 2, VH * 0.5, VH * 0.8)
    vig.addColorStop(0, 'rgba(0,0,0,0)')
    vig.addColorStop(0.72, 'rgba(0,0,0,.2)')
    vig.addColorStop(1, 'rgba(0,0,0,.62)')

    var neb1 = g.createRadialGradient(0, 0, 0, 0, 0, 340)
    neb1.addColorStop(0, 'rgba(52,120,255,.2)')
    neb1.addColorStop(0.55, 'rgba(40,90,220,.07)')
    neb1.addColorStop(1, 'rgba(30,70,200,0)')

    var neb2 = g.createRadialGradient(0, 0, 0, 0, 0, 400)
    neb2.addColorStop(0, 'rgba(180,60,255,.17)')
    neb2.addColorStop(0.5, 'rgba(140,50,220,.06)')
    neb2.addColorStop(1, 'rgba(120,40,200,0)')

    var neb3 = g.createRadialGradient(0, 0, 0, 0, 0, 430)
    neb3.addColorStop(0, 'rgba(0,210,255,.13)')
    neb3.addColorStop(0.55, 'rgba(0,160,230,.05)')
    neb3.addColorStop(1, 'rgba(0,140,220,0)')

    var boltGrad = g.createLinearGradient(0, -30, 0, 6)
    boltGrad.addColorStop(0, 'rgba(110,240,255,0)')
    boltGrad.addColorStop(0.45, 'rgba(120,245,255,.55)')
    boltGrad.addColorStop(1, 'rgba(255,255,255,.98)')

    var hullGrad = g.createLinearGradient(-22, 0, 22, 0)
    hullGrad.addColorStop(0, '#123457')
    hullGrad.addColorStop(0.34, '#8fdcff')
    hullGrad.addColorStop(0.5, '#f2fdff')
    hullGrad.addColorStop(0.66, '#6fd0ff')
    hullGrad.addColorStop(1, '#0f2c4c')

    var droneGrad = g.createLinearGradient(0, -14, 0, 18)
    droneGrad.addColorStop(0, '#6a2a68'); droneGrad.addColorStop(0.5, '#c2437f'); droneGrad.addColorStop(1, '#3a1039')

    var dartGrad = g.createLinearGradient(0, -18, 0, 16)
    dartGrad.addColorStop(0, '#8a4a10'); dartGrad.addColorStop(0.45, '#ffb040'); dartGrad.addColorStop(1, '#7a2c08')

    var turretGrad = g.createLinearGradient(0, -20, 0, 22)
    turretGrad.addColorStop(0, '#3d4d66'); turretGrad.addColorStop(0.5, '#8fa8c8'); turretGrad.addColorStop(1, '#2a3648')

    var orbGrad = g.createRadialGradient(0, -4, 2, 0, 0, 26)
    orbGrad.addColorStop(0, '#b06cff'); orbGrad.addColorStop(0.55, '#6a34a8'); orbGrad.addColorStop(1, '#25103f')

    var bossGrad = g.createLinearGradient(0, -80, 0, 84)
    bossGrad.addColorStop(0, '#5c1b3f'); bossGrad.addColorStop(0.42, '#c2316d')
    bossGrad.addColorStop(0.62, '#8e2050'); bossGrad.addColorStop(1, '#2a0a1e')

    var sniperGrad = g.createLinearGradient(0, -16, 0, 20)
    sniperGrad.addColorStop(0, '#3a1030'); sniperGrad.addColorStop(0.5, '#e2405f'); sniperGrad.addColorStop(1, '#2a0a24')

    var spinnerGrad = g.createLinearGradient(0, -26, 0, 26)
    spinnerGrad.addColorStop(0, '#441a70'); spinnerGrad.addColorStop(0.5, '#a25cff'); spinnerGrad.addColorStop(1, '#240c40')

    var beamerGrad = g.createLinearGradient(0, -24, 0, 26)
    beamerGrad.addColorStop(0, '#2c2036'); beamerGrad.addColorStop(0.45, '#7a6a90')
    beamerGrad.addColorStop(0.6, '#5a3a5c'); beamerGrad.addColorStop(1, '#1c1424')

    function glowGrad(r, col) {
      var gr = g.createRadialGradient(0, 0, 0, 0, 0, r)
      gr.addColorStop(0, 'rgba(' + col + ',.95)')
      gr.addColorStop(0.4, 'rgba(' + col + ',.38)')
      gr.addColorStop(1, 'rgba(' + col + ',0)')
      return gr
    }

    var EG = {
      '255,90,170': glowGrad(15, '255,90,170'),
      '255,175,60': glowGrad(15, '255,175,60'),
      '190,110,255': glowGrad(15, '190,110,255'),
      '90,200,255': glowGrad(15, '90,200,255'),
      '255,90,120': glowGrad(15, '255,90,120'),
      '255,255,255': glowGrad(15, '255,255,255')
    }
    var EG_DEF = glowGrad(15, '255,120,200')

    function roundRect(x, y, w, h, r) {
      g.beginPath()
      g.moveTo(x + r, y)
      g.lineTo(x + w - r, y)
      g.quadraticCurveTo(x + w, y, x + w, y + r)
      g.lineTo(x + w, y + h - r)
      g.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
      g.lineTo(x + r, y + h)
      g.quadraticCurveTo(x, y + h, x, y + h - r)
      g.lineTo(x, y + r)
      g.quadraticCurveTo(x, y, x + r, y)
      g.closePath()
    }

    /* 全局伤害倍率 */
    function dmgMul() { return 1 + S.mk * MK_STEP }

    /* ---------------- 特效 ---------------- */

    function burst(x, y, n, col, power) {
      if (S.parts.length > 400) S.parts.splice(0, 40)
      var pw = power || 1
      for (var i = 0; i < n; i++) {
        var a = rand(0, TAU)
        var sp = rand(30, 210) * pw
        var lf = rand(0.24, 0.72)
        S.parts.push({
          kind: 'dot', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          r: rand(1.6, 4.2) * pw, life: lf, max: lf, c: col, w: 1
        })
      }
    }

    function spark(x, y, n, col, dir) {
      for (var i = 0; i < n; i++) {
        var a = dir !== undefined ? dir + rand(-0.9, 0.9) : rand(0, TAU)
        var sp = rand(120, 420)
        var lf = rand(0.12, 0.3)
        S.parts.push({
          kind: 'spark', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          r: 1, life: lf, max: lf, c: col, w: rand(1.4, 2.8)
        })
      }
    }

    function ring(x, y, maxR, col, life, w) {
      S.rings.push({ x: x, y: y, r: 4, max: maxR, life: life, maxLife: life, c: col, w: w || 3 })
    }

    function floatText(x, y, text, col) {
      S.floats.push({ x: x, y: y, t: 0, life: 0.95, text: text, c: col || '200,240,255' })
    }

    function boom(x, y, size, col) {
      var c = col || '255,180,90'
      S.shake = Math.min(26, S.shake + size * 0.26)
      S.flash = Math.min(0.5, S.flash + size * 0.0035)
      S.flashCol = '255,220,170'
      ring(x, y, size * 3.1, c, 0.5, 3 + size * 0.06)
      burst(x, y, Math.min(34, 8 + Math.floor(size * 0.7)), c, size > 40 ? 1.5 : 1)
      spark(x, y, Math.min(20, 5 + Math.floor(size * 0.35)), '255,240,200')
      A.boom(size > 40)
    }

    /* ---------------- 强化 Mk ---------------- */

    function addEnergy(n) {
      S.energy += n
      var need = mkNeed(S.mk)
      var guard = 0
      while (S.energy >= need && guard < 40) {
        S.energy -= need
        S.mk++
        guard++
        need = mkNeed(S.mk)
        onMkUp()
      }
    }

    function onMkUp() {
      var p = S.p
      S.mkFlash = 1.3
      A.power()
      buzz(14)
      if (!p) return
      ring(p.x, p.y, 175, '255,230,150', 0.6, 5)
      burst(p.x, p.y, 16, '255,235,170', 1.1)
      floatText(p.x, p.y - 54, '强化 Mk.' + S.mk + '  ×' + dmgMul().toFixed(2), '255,232,150')
    }

    /* ---------------- 实体 ---------------- */

    function newPlayer() {
      return {
        x: VW / 2, y: VH - 150, tx: VW / 2, ty: VH - 150,
        r: 11, hp: 100, maxHp: 100, lives: 3, power: 1, bombs: 2,
        invT: 1.8, cd: 0, shieldT: 0, dead: false, deadT: 0, trailT: 0, roll: 0,
        weapon: 'plasma', rageT: 0, doubleT: 0, magnetT: 0, wingT: 0,
        beamHits: [],
        wings: [
          { x: VW / 2 - 44, y: VH - 128, cd: 0.1 },
          { x: VW / 2 + 44, y: VH - 128, cd: 0.2 }
        ]
      }
    }

    function spawn(o) {
      var e = {
        kind: 'drone', x: 0, y: -50, vx: 0, vy: 0, r: 15, hp: 14, maxHp: 14,
        t: 0, fireT: 1.4, flash: 0, score: 120, amp: 60, freq: 1.8, baseY: 130,
        dead: false, ang: 0, pat: 0, patT: 0, step: 0, entering: true,
        drift: 0, tier: 1, chargeT: 0, charge: 0, firing: 0, beamX: 0,
        retreat: false, linger: 0
      }
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) e[k] = o[k]
      if (e.kind === 'boss') {
        e.maxHp = e.hp
      } else {
        e.hp = Math.max(1, Math.round(e.hp * hpMul(S.wave)))
        e.maxHp = e.hp
        if (HOVER[e.kind]) e.linger = LINGER[e.kind] || 24
      }
      S.enemies.push(e)
      return e
    }

    function later(t, fn) { S.queue.push({ t: t, fn: fn }) }

    function addDrone(i, w, delay, x, baseY, freq) {
      later(delay, function () {
        spawn({
          kind: 'drone', x: x, y: -50, r: 15, hp: 14, score: 125,
          amp: 52 + (i % 4) * 14, freq: freq, baseY: baseY, fireT: 1.7 + Math.random() * 0.9
        })
      })
    }

    function addSniper(x, delay, fireT) {
      later(delay, function () {
        spawn({ kind: 'sniper', x: x, y: -70, r: 16, hp: 30, score: 280, baseY: 152, fireT: fireT })
      })
    }

    function form(w) {
      var i
      var shape = (w - 1) % 4

      if (shape === 0) {
        var n = 6 + Math.min(8, Math.floor(w / 3))
        for (i = 0; i < n; i++) addDrone(i, w, i * 0.3, 90 + (i % 3) * 210, 110 + Math.floor(i / 3) * 72, 1.7)
      } else if (shape === 1) {
        var m = 7
        for (i = 0; i < m; i++) {
          (function (i) {
            var s = i - (m - 1) / 2
            later(i * 0.09, function () {
              spawn({ kind: 'dart', x: VW / 2 + s * 46, y: -60 - Math.abs(s) * 26, r: 12, hp: 10, score: 95, vy: 185 + Math.abs(s) * 9, vx: -s * 11, fireT: 99 })
            })
          })(i)
        }
        later(1.2, function () {
          if (w >= 6) spawn({ kind: 'spinner', x: VW / 2, y: -84, r: 26, hp: 70, score: 700, baseY: 230, ang: 0.7, fireT: 1.4 })
          else spawn({ kind: 'orb', x: VW / 2, y: -80, r: 24, hp: 58, score: 620, baseY: 210, ang: 0, fireT: 2.6 })
        })
      } else if (shape === 2) {
        later(0, function () { spawn({ kind: 'turret', x: 148, y: -70, r: 22, hp: 46, score: 420, baseY: 168, drift: 70, fireT: 1.8 }) })
        later(0.45, function () { spawn({ kind: 'turret', x: VW - 148, y: -70, r: 22, hp: 46, score: 420, baseY: 168, drift: -70, fireT: 2.4 }) })
        var q = 4 + Math.floor(w / 2)
        for (i = 0; i < q; i++) addDrone(i, w, 1.3 + i * 0.42, 85 + i * (VW - 170) / Math.max(1, q - 1), 100 + (i % 2) * 62, 2.2)
      } else {
        var k = 2 + Math.floor(w / 7)
        for (i = 0; i < k; i++) {
          (function (i) {
            later(i * 0.95, function () {
              spawn({ kind: 'orb', x: VW / 2 + (i % 2 ? 1 : -1) * (110 + i * 16), y: -80, r: 24, hp: 62, score: 640, baseY: 190 + i * 46, ang: i * 1.9, fireT: 2.6 })
            })
          })(i)
        }
        for (i = 0; i < 4; i++) {
          (function (i) {
            later(1.6 + i * 0.5, function () {
              spawn({ kind: 'dart', x: i % 2 ? VW - 80 : 80, y: -60, r: 12, hp: 11, score: 95, vy: 210, vx: i % 2 ? -40 : 40, fireT: 99 })
            })
          })(i)
        }
      }

      if (w >= 4 && w % 2 === 0) {
        addSniper(112, 0.6, 2.8)
        addSniper(VW - 112, 1.0, 3.4)
      }
      if (w >= 9 && w % 3 === 0) {
        later(1.5, function () { spawn({ kind: 'spinner', x: 152, y: -84, r: 26, hp: 72, score: 720, baseY: 236, ang: 0.4, fireT: 1.7 }) })
      }
      if (w >= 11 && w % 3 === 2) {
        later(1.3, function () {
          var bx = VW / 2 + (Math.random() < 0.5 ? -128 : 128)
          spawn({ kind: 'beamer', x: bx, y: -92, r: 26, hp: 108, score: 950, baseY: 134, fireT: 2.4, beamX: bx })
        })
      }
    }

    function spawnBoss(w) {
      var tier = Math.max(1, Math.floor(w / 5))
      var b = spawn({
        kind: 'boss', x: VW / 2, y: -170, r: 74, hp: 980 + tier * 820, score: 6000 * tier,
        baseY: 168, pat: 0, patT: 0, step: 0, entering: true, tier: tier, fireT: 0
      })
      S.boss = b
      A.warn()
      buzz(45)
    }

    function nextWave() {
      S.wave++
      var w = S.wave
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

    function pbullet(x, y, vx, vy, dmg, kind) {
      S.bullets.push({ x: x, y: y, vx: vx, vy: vy, r: 7, dmg: dmg, kind: kind || 'bolt' })
    }

    function missile(x, y, ang, dmg) {
      S.bullets.push({
        x: x, y: y, vx: Math.cos(ang) * 520, vy: Math.sin(ang) * 520,
        r: 7, dmg: dmg, kind: 'missile', ang: ang, homing: true, life: 3.2
      })
    }

    function fireRate(p) {
      var base = p.weapon === 'homing' ? 0.3
        : p.weapon === 'scatter' ? 0.22
          : (0.125 - Math.min(0.05, p.power * 0.009))
      return p.rageT > 0 ? base / 1.85 : base
    }

    function shoot(p) {
      var lvl = p.power

      if (p.weapon === 'homing') {
        var nh = lvl
        for (var a = 0; a < nh; a++) {
          var t = nh === 1 ? 0.5 : a / (nh - 1)
          var ang = -Math.PI / 2 + (t - 0.5) * 1.15
          missile(p.x + (t - 0.5) * 34, p.y - 10, ang, 20)
        }
        A.shoot()
        return
      }

      if (p.weapon === 'scatter') {
        /* 正前方必有一发，再成对向两侧铺开。
           早先按「总发数在 ±0.51 之间等分」的做法，偶数发时正中间没有弹丸，
           会在最该命中的方向留出约 65px 空洞 —— 敌机贴脸站正前方反而全打空。
           散布收到 ±0.24 弧度：320px 处约 5 发命中，贴脸约 19 发命中，
           形成「越近越强」而不是「离远了几乎打不中」。 */
        var pairs = 5 + lvl
        var stepA = 0.24 / pairs
        S.bullets.push({
          x: p.x, y: p.y - 12, vx: 0, vy: -900,
          r: 5, dmg: 8, kind: 'pellet', life: 0.7
        })
        for (var s = 1; s <= pairs; s++) {
          var off = s * stepA
          for (var sg = -1; sg <= 1; sg += 2) {
            var ab = -Math.PI / 2 + sg * off
            S.bullets.push({
              x: p.x, y: p.y - 12,
              vx: Math.cos(ab) * 900, vy: Math.sin(ab) * 900,
              r: 5, dmg: 8, kind: 'pellet', life: 0.7
            })
          }
        }
        A.shoot()
        return
      }

      var spd = -900
      pbullet(p.x, p.y - 26, 0, spd, 12)
      if (lvl >= 2) {
        pbullet(p.x - 11, p.y - 16, 0, spd, 9)
        pbullet(p.x + 11, p.y - 16, 0, spd, 9)
      }
      if (lvl >= 3) {
        pbullet(p.x - 16, p.y - 6, -150, spd * 0.98, 8)
        pbullet(p.x + 16, p.y - 6, 150, spd * 0.98, 8)
      }
      if (lvl >= 4) {
        pbullet(p.x - 20, p.y + 2, -320, spd * 0.92, 7)
        pbullet(p.x + 20, p.y + 2, 320, spd * 0.92, 7)
      }
      if (lvl >= 5) {
        pbullet(p.x - 24, p.y + 8, -520, spd * 0.8, 7)
        pbullet(p.x + 24, p.y + 8, 520, spd * 0.8, 7)
      }
      A.shoot()
    }

    function ebullet(x, y, vx, vy, col, r) {
      if (S.ebullets.length > 460) return
      S.ebullets.push({ x: x, y: y, vx: vx, vy: vy, c: col || '255,90,170', r: r || 6, life: 6.5 })
    }

    function nearestTarget(x, y) {
      var best = null
      var bd = Infinity
      for (var i = 0; i < S.enemies.length; i++) {
        var e = S.enemies[i]
        if (e.dead || e.y < -20) continue
        var d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y)
        if (d < bd) { bd = d; best = e }
      }
      var b = S.boss
      if (b && !b.entering && b.hp > 0) {
        var d2 = (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y)
        if (d2 < bd) best = b
      }
      return best
    }

    function updateBeam(p, dt) {
      var hw = 7 + p.power * 2.4
      var dps = 58 + p.power * 26
      p.beamHits.length = 0

      for (var i = 0; i < S.enemies.length; i++) {
        var e = S.enemies[i]
        /* boss 也在 S.enemies 里，这里跳过它走下面那段专属判定，
           否则激光会对 BOSS 结算两次（双倍伤害） */
        if (e.dead || e.kind === 'boss' || e.y > p.y - 20) continue
        if (Math.abs(e.x - p.x) < e.r + hw) {
          hitEnemy(e, dps * dt, SILENT)
          if (!e.dead) {
            p.beamHits.push({ x: e.x, y: e.y + e.r * 0.4, r: e.r * 0.7 })
            if (Math.random() < 0.5) spark(e.x + rand(-e.r, e.r), e.y + e.r * 0.5, 1, '200,250,255')
          }
        }
      }

      var b = S.boss
      if (b && !b.entering && b.hp > 0 && b.y < p.y - 20 && Math.abs(b.x - p.x) < b.r + hw) {
        hitEnemy(b, dps * dt, SILENT)
        if (!b.dead) {
          p.beamHits.push({ x: b.x, y: b.y + b.r * 0.5, r: b.r * 0.6 })
          if (Math.random() < 0.7) spark(b.x + rand(-b.r, b.r), b.y + b.r * 0.5, 1, '255,230,245')
        }
      }
    }

    function updateWings(p, dt) {
      if (p.wingT <= 0) return
      var rate = p.rageT > 0 ? 0.16 : 0.24
      for (var i = 0; i < 2; i++) {
        var sgn = i === 0 ? -1 : 1
        var w = p.wings[i]
        var tx = p.x + sgn * 46
        var ty = p.y + 24 + Math.sin(S.t * 3 + i * 1.6) * 3
        w.x += (tx - w.x) * Math.min(1, dt * 5)
        w.y += (ty - w.y) * Math.min(1, dt * 5)
        w.cd -= dt
        if (w.cd <= 0) {
          w.cd = rate
          S.bullets.push({ x: w.x, y: w.y - 14, vx: 0, vy: -900, r: 5, dmg: 7, kind: 'bolt' })
        }
      }
    }

    function addScore(n) {
      var p = S.p
      S.score += Math.round(n * (p && p.doubleT > 0 ? 2 : 1))
    }

    function killEnemy(e) {
      e.dead = true
      S.kills++
      addEnergy(ENERGY[e.kind] || 1)
      S.combo++
      S.comboT = 2.3
      if (S.combo > S.bestCombo) S.bestCombo = S.combo
      var mult = 1 + Math.min(60, S.combo) * 0.02
      var gain = Math.floor(e.score * mult)
      addScore(gain)
      floatText(e.x, e.y - 12, '+' + gain, '190,245,255')

      if (e.kind === 'boss') { bigBossDeath(e); return }

      boom(e.x, e.y, e.r + 8, e.kind === 'dart' ? '255,190,90' : '255,140,110')
      var ch = DROP_RATE[e.kind]
      if (ch === undefined) ch = 0.14
      if (Math.random() < ch) dropPick(e.x, e.y)
    }

    /* 所有伤害的唯一结算入口：统一吃 Mk 倍率 */
    function hitEnemy(e, dmg, opt) {
      if (e.dead) return
      e.hp -= dmg * dmgMul()
      if (opt && opt.silent) {
        if (e.flash < 0.15) e.flash = 0.5
      } else {
        e.flash = 0.7
        spark(e.x + rand(-6, 6), e.y + rand(-6, 6), 2, '255,225,180')
      }
      if (e.hp <= 0) killEnemy(e)
    }

    function dropPick(x, y, force) {
      if (S.picks.length > 14) return
      S.picks.push({ x: x, y: y, vy: 62, t: 0, kind: force || rollDrop() })
    }

    function bigBossDeath(b) {
      S.boss = null
      S.flash = 0.9
      S.flashCol = '255,240,220'
      S.shake = 30
      A.boom(true)
      addScore(b.score)
      floatText(b.x, b.y, '+' + fmt(b.score), '255,235,180')
      for (var i = 0; i < 9; i++) {
        (function (i) {
          later(i * 0.13, function () {
            boom(b.x + rand(-70, 70), b.y + rand(-52, 52), 34 + rand(0, 26), '255,170,90')
          })
        })(i)
      }
      later(0.7, function () { ring(b.x, b.y, 460, '255,220,180', 0.9, 9) })
      dropPick(b.x - 50, b.y, 'P')
      dropPick(b.x, b.y, ['L', 'M', 'R'][Math.floor(Math.random() * 3)])
      dropPick(b.x + 50, b.y, Math.random() < 0.5 ? 'B' : 'H')
      S.waveDelay = 2.6
    }

    function playerHit(dmg) {
      var p = S.p
      if (!p || S.mode !== 'playing' || p.dead || p.invT > 0) return
      if (p.shieldT > 0) {
        p.shieldT = 0
        p.invT = 1.3
        ring(p.x, p.y, 90, '120,225,255', 0.45, 5)
        burst(p.x, p.y, 14, '140,230,255', 1.1)
        floatText(p.x, p.y - 34, '护盾破碎', '150,235,255')
        A.hit()
        S.shake = Math.min(20, S.shake + 7)
        return
      }
      p.hp -= dmg
      S.shake = Math.min(20, S.shake + 6)
      p.invT = 0.42
      A.hit()
      buzz(16)
      burst(p.x, p.y, 7, '255,200,140', 1)
      if (p.hp <= 0) killPlayer()
    }

    /* 持续伤害（激光塔光束）：不吃无敌帧的位移判定 */
    function playerBurn(dmg) {
      var p = S.p
      if (!p || S.mode !== 'playing' || p.dead || p.invT > 0) return
      if (p.shieldT > 0) { playerHit(1); return }
      p.hp -= dmg
      S.shake = Math.min(14, S.shake + dmg * 0.25)
      S.flash = Math.max(S.flash, 0.08)
      S.flashCol = '255,120,160'
      if (Math.random() < 0.4) spark(p.x + rand(-8, 8), p.y + rand(-8, 8), 1, '255,160,180')
      if (p.hp <= 0) killPlayer()
    }

    function killPlayer() {
      var p = S.p
      p.dead = true
      p.deadT = 1.35
      p.hp = 0
      p.lives--
      p.rageT = 0
      p.doubleT = 0
      p.magnetT = 0
      p.wingT = 0
      S.ebullets.length = 0
      boom(p.x, p.y, 62, '255,190,96')
      buzz([0, 45, 35, 65])
      S.flash = 0.72
      S.flashCol = '255,210,170'
      S.shake = 28
      S.combo = 0
    }

    function respawn() {
      var p = S.p
      p.dead = false
      p.hp = p.maxHp
      p.invT = 2.6
      p.power = Math.max(1, p.power - 1)
      p.x = VW / 2
      p.y = VH - 150
      p.tx = p.x
      p.ty = p.y
      S.ebullets.length = 0
      ring(p.x, p.y, 130, '130,230,255', 0.5, 5)
    }

    function gameOver() {
      S.mode = 'over'
      S.overT = 0
      if (api.onOver) api.onOver(S.score, S.wave)
      if (api.onMode) api.onMode('over')
    }

    function useBomb() {
      var p = S.p
      if (!p || p.dead) return
      if (p.bombs <= 0) {
        floatText(p.x, p.y - 40, '炸弹不足', '255,150,150')
        return
      }
      p.bombs--
      S.flash = 0.9
      S.flashCol = '190,240,255'
      S.shake = 26
      ring(p.x, p.y, 900, '150,240,255', 1.1, 9)
      ring(p.x, p.y, 620, '255,255,255', 0.8, 4)
      A.bomb()
      buzz(30)
      for (var i = 0; i < S.ebullets.length; i++) {
        var b = S.ebullets[i]
        burst(b.x, b.y, 2, '160,240,255', 0.7)
        addScore(12)
      }
      S.ebullets.length = 0
      for (var j = S.enemies.length - 1; j >= 0; j--) hitEnemy(S.enemies[j], 155 + p.power * 45)
      if (S.boss) hitEnemy(S.boss, 320)
      S.hitStop = 0.12
    }

    /* ---------------- 每帧推进 ---------------- */

    function stepStars(dt) {
      for (var i = 0; i < S.stars.length; i++) {
        var s = S.stars[i]
        s.y += s.sp * dt
        if (s.y > VH + 12) { s.y = -12; s.x = rand(0, VW) }
      }
    }

    function stepFx(dt) {
      var i
      for (i = S.parts.length - 1; i >= 0; i--) {
        var p = S.parts[i]
        p.life -= dt
        if (p.life <= 0) { S.parts.splice(i, 1); continue }
        p.x += p.vx * dt
        p.y += p.vy * dt
        var dr = p.kind === 'spark' ? 0.9 : 0.86
        p.vx *= dr
        p.vy *= dr
        if (p.kind === 'dot') p.vy -= 12 * dt
      }
      for (i = S.rings.length - 1; i >= 0; i--) {
        var r = S.rings[i]
        r.life -= dt
        if (r.life <= 0) { S.rings.splice(i, 1); continue }
        r.r += (r.max - r.r) * Math.min(1, dt * 7)
      }
      for (i = S.floats.length - 1; i >= 0; i--) {
        var f = S.floats[i]
        f.t += dt
        f.y -= 34 * dt
        if (f.t >= f.life) S.floats.splice(i, 1)
      }
      if (S.shake > 0.2) S.shake *= Math.pow(0.0025, dt)
      else S.shake = 0
      if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 2.4)
      if (S.bannerT > 0) S.bannerT -= dt
      if (S.mkFlash > 0) S.mkFlash -= dt
    }

    function stepBullets(dt) {
      var i
      for (i = S.bullets.length - 1; i >= 0; i--) {
        var b = S.bullets[i]
        if (b.homing) {
          var tgt = nearestTarget(b.x, b.y)
          if (tgt) {
            var want = Math.atan2(tgt.y - b.y, tgt.x - b.x)
            var diff = want - b.ang
            while (diff > Math.PI) diff -= TAU
            while (diff < -Math.PI) diff += TAU
            b.ang += clamp(diff, -6.2 * dt, 6.2 * dt)
          }
          var sp = 540
          b.vx = Math.cos(b.ang) * sp
          b.vy = Math.sin(b.ang) * sp
          if (Math.random() < 0.5) {
            S.parts.push({
              kind: 'dot', x: b.x - b.vx * 0.012, y: b.y - b.vy * 0.012,
              vx: rand(-20, 20), vy: rand(-20, 20), r: rand(1.4, 2.4),
              life: 0.26, max: 0.26, c: '255,170,90', w: 1
            })
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

      for (i = S.ebullets.length - 1; i >= 0; i--) {
        var eb = S.ebullets[i]
        eb.x += eb.vx * dt
        eb.y += eb.vy * dt
        eb.life -= dt
        if (eb.y < -60 || eb.y > VH + 60 || eb.x < -60 || eb.x > VW + 60 || eb.life <= 0) S.ebullets.splice(i, 1)
      }

      for (i = S.picks.length - 1; i >= 0; i--) {
        var pk = S.picks[i]
        pk.t += dt
        pk.y += pk.vy * dt
        pk.x += Math.sin(pk.t * 2.4) * 22 * dt
        var pp = S.p
        if (pp && !pp.dead && pp.magnetT > 0) {
          var dx = pp.x - pk.x
          var dy = pp.y - pk.y
          var d = Math.hypot(dx, dy) || 1
          if (d < 460) {
            pk.x += dx / d * 700 * dt
            pk.y += dy / d * 700 * dt
          }
        }
        if (pk.y > VH + 30) { S.picks.splice(i, 1); continue }
        if (pp && !pp.dead && Math.hypot(pk.x - pp.x, pk.y - pp.y) < 32) {
          collect(pk)
          S.picks.splice(i, 1)
        }
      }
    }

    function collect(pk) {
      var p = S.p
      ring(pk.x, pk.y, 70, PICK_COL[pk.kind] || '180,255,220', 0.35, 3)
      burst(pk.x, pk.y, 10, PICK_COL[pk.kind] || '180,255,220', 0.8)
      var k = pk.kind

      if (k === 'P') {
        A.pick()
        if (p.power < 5) { p.power++; floatText(p.x, p.y - 36, '火力 ×' + p.power, '255,225,140') }
        else { addScore(600); floatText(p.x, p.y - 36, '火力满级 +600', '255,225,140') }
      } else if (k === 'L' || k === 'M' || k === 'R') {
        var wp = k === 'L' ? 'laser' : k === 'M' ? 'homing' : 'scatter'
        A.power()
        if (p.weapon === wp) {
          if (p.power < 5) { p.power++; floatText(p.x, p.y - 36, WEAPON_NAME[wp] + '同调 · 火力 ×' + p.power, PICK_COL[k]) }
          else { addScore(500); floatText(p.x, p.y - 36, '模组同调 +500', PICK_COL[k]) }
        } else {
          p.weapon = wp
          floatText(p.x, p.y - 36, '武器切换 · ' + WEAPON_NAME[wp], PICK_COL[k])
          ring(p.x, p.y, 150, PICK_COL[k], 0.6, 4)
          S.flash = Math.max(S.flash, 0.22)
          S.flashCol = PICK_COL[k]
        }
      } else if (k === 'B') {
        A.pick()
        p.bombs = Math.min(4, p.bombs + 1)
        floatText(p.x, p.y - 36, '炸弹 +1', '160,230,255')
      } else if (k === 'S') {
        A.pick()
        p.shieldT = 9
        floatText(p.x, p.y - 36, '护盾展开', '140,235,255')
      } else if (k === 'H') {
        A.pick()
        p.hp = Math.min(p.maxHp, p.hp + 45)
        p.lives = Math.min(5, p.lives + 1)
        floatText(p.x, p.y - 36, '生命 +1', '255,170,200')
      } else if (k === 'F') {
        A.power()
        p.rageT = 8
        floatText(p.x, p.y - 36, '狂怒 · 射速 ×1.85', '255,150,90')
      } else if (k === 'D') {
        A.power()
        p.doubleT = 10
        floatText(p.x, p.y - 36, '双倍得分', '255,225,120')
      } else if (k === 'G') {
        A.power()
        p.magnetT = 9
        floatText(p.x, p.y - 36, '磁力场展开', '150,220,255')
      } else if (k === 'W') {
        A.power()
        p.wingT = 14
        floatText(p.x, p.y - 36, '僚机出击 ×2', '180,255,200')
      }
    }

    function stepPlay(dt) {
      var p = S.p
      var i
      stepBullets(dt)

      if (S.comboT > 0) {
        S.comboT -= dt
        if (S.comboT <= 0) S.combo = 0
      }

      for (i = S.queue.length - 1; i >= 0; i--) {
        S.queue[i].t -= dt
        if (S.queue[i].t <= 0) {
          var fn = S.queue[i].fn
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
        if (p.deadT <= 0) {
          if (p.lives <= 0) gameOver()
          else respawn()
        }
      } else {
        if (p.rageT > 0) p.rageT -= dt
        if (p.doubleT > 0) p.doubleT -= dt
        if (p.magnetT > 0) p.magnetT -= dt
        if (p.wingT > 0) p.wingT -= dt
        if (p.invT > 0) p.invT -= dt
        if (p.shieldT > 0) p.shieldT -= dt

        var kx = (S.keys.right ? 1 : 0) - (S.keys.left ? 1 : 0)
        var ky = (S.keys.down ? 1 : 0) - (S.keys.up ? 1 : 0)

        if (kx || ky) {
          var n = Math.hypot(kx, ky)
          p.x = clamp(p.x + kx / n * 620 * dt, 26, VW - 26)
          p.y = clamp(p.y + ky / n * 620 * dt, 108, VH - 84)
          p.tx = p.x
          p.ty = p.y
          p.roll += (kx * 0.34 - p.roll) * Math.min(1, dt * 10)
        } else {
          var dx = p.tx - p.x
          var dy = p.ty - p.y
          var d = Math.hypot(dx, dy)
          if (d > 0.6) {
            var st = Math.min(d, 1500 * dt)
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
          S.parts.push({
            kind: 'dot', x: p.x + rand(-4, 4), y: p.y + 16,
            vx: rand(-14, 14), vy: rand(90, 190), r: rand(1.6, 3.2),
            life: 0.3, max: 0.3, c: '90,200,255', w: 1
          })
        }

        if (p.weapon === 'laser') updateBeam(p, dt)
        else {
          p.cd -= dt
          if (p.cd <= 0) { shoot(p); p.cd = fireRate(p) }
        }
        updateWings(p, dt)
      }

      for (i = S.enemies.length - 1; i >= 0; i--) {
        var e = S.enemies[i]
        stepEnemy(e, dt)
        if (e.dead) { S.enemies.splice(i, 1); continue }
        if (e.y > VH + 90 || (e.retreat && e.y < -160) || e.x < -160 || e.x > VW + 160) { S.enemies.splice(i, 1); continue }
      }

      if (S.boss) {
        stepBoss(S.boss, dt)
        if (S.boss && S.boss.y > VH + 200) S.boss = null
      }

      if (p.dead) return

      /* 我方子弹 → 敌人 */
      for (i = S.bullets.length - 1; i >= 0; i--) {
        var b = S.bullets[i]
        var hit = false
        for (var j = 0; j < S.enemies.length; j++) {
          var en = S.enemies[j]
          /* 同上：boss 走下面那段椭圆命中判定，不用这里的方形判定 */
          if (en.dead || en.kind === 'boss') continue
          if (Math.abs(b.x - en.x) < en.r + b.r && Math.abs(b.y - en.y) < en.r + b.r) {
            hitEnemy(en, b.dmg)
            hit = true
            break
          }
        }
        if (!hit && S.boss && !S.boss.entering && S.boss.hp > 0) {
          var bo = S.boss
          if (Math.abs(b.x - bo.x) < bo.r + b.r && Math.abs(b.y - bo.y) < bo.r * 0.82 + b.r) {
            hitEnemy(bo, b.dmg)
            hit = true
          }
        }
        if (hit) {
          spark(b.x, b.y, 2, '180,240,255')
          S.bullets.splice(i, 1)
        }
      }

      /* 敌方子弹 → 我方 */
      for (i = S.ebullets.length - 1; i >= 0; i--) {
        var eb = S.ebullets[i]
        if (Math.abs(eb.x - p.x) < p.r + eb.r * 0.7 && Math.abs(eb.y - p.y) < p.r + eb.r * 0.7) {
          S.ebullets.splice(i, 1)
          playerHit(22)
          break
        }
      }

      /* 敌机本体 + 激光塔光束 → 我方 */
      for (i = 0; i < S.enemies.length; i++) {
        var ce = S.enemies[i]
        if (ce.dead) continue
        if (ce.kind === 'beamer' && ce.firing > 0 && Math.abs(p.x - ce.x) < 16 + p.r * 0.5 && p.y > ce.y) {
          playerBurn(52 * dt)
        }
        if (Math.hypot(ce.x - p.x, ce.y - p.y) < ce.r * 0.8 + p.r) {
          hitEnemy(ce, 40)
          playerHit(34)
          break
        }
      }

      if (S.boss && !S.boss.entering && Math.hypot(S.boss.x - p.x, S.boss.y - p.y) < S.boss.r * 0.85 + p.r) playerHit(40)
    }

    function stepEnemy(e, dt) {
      e.t += dt
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt * 4.2)

      /* 滞空到期：向上撤退离场，让波次能收尾 */
      if (e.linger > 0) {
        if (e.retreat) { e.y -= 260 * dt; return }
        if (e.t > e.linger) { e.retreat = true; return }
      }

      var p = S.p
      var aim = p && !p.dead ? Math.atan2(p.y - e.y, p.x - e.x) : Math.PI / 2
      var bs = 168 + Math.min(120, S.wave * 5)
      var fm = fireMul(S.wave)

      if (e.kind === 'drone') {
        if (e.y < e.baseY) e.y += 130 * dt
        else e.y += (e.baseY - e.y) * Math.min(1, dt * 2)
        e.x += Math.cos(e.t * e.freq) * e.amp * dt * 1.5
        e.x = clamp(e.x, 30, VW - 30)
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) {
          e.fireT = (1.7 + Math.random() * 1.0) * fm
          ebullet(e.x, e.y + 14, Math.cos(aim) * bs * 0.8, Math.max(90, Math.sin(aim) * bs * 0.8), '255,90,170')
        }
      } else if (e.kind === 'dart') {
        e.y += e.vy * dt
        e.x += e.vx * dt
        e.vx *= 0.995
        if (Math.random() < 0.5) {
          S.parts.push({
            kind: 'dot', x: e.x + rand(-4, 4), y: e.y - 8, vx: rand(-10, 10), vy: rand(-70, -20),
            r: rand(1.2, 2.6), life: 0.24, max: 0.24, c: '255,180,80', w: 1
          })
        }
      } else if (e.kind === 'turret') {
        if (e.y < e.baseY) e.y += 110 * dt
        else e.x += Math.sin(e.t * 0.9) * (e.drift || 60) * dt
        e.x = clamp(e.x, 40, VW - 40)
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) {
          e.fireT = (1.9 + Math.random() * 0.6) * fm
          for (var s = -1; s <= 1; s++) {
            var a = aim + s * 0.26
            ebullet(e.x, e.y + 18, Math.cos(a) * bs, Math.sin(a) * bs, '255,175,60')
          }
        }
      } else if (e.kind === 'orb') {
        if (e.y < e.baseY) e.y += 92 * dt
        e.ang += dt * 0.85
        var cx = VW / 2 + Math.cos(e.ang) * (VW / 2 - 120)
        var cy = e.baseY + Math.sin(e.ang * 1.4) * 34
        e.x += (cx - e.x) * Math.min(1, dt * 2.2)
        e.y += (cy - e.y) * Math.min(1, dt * 2.2)
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) {
          e.fireT = (2.8 + Math.random() * 0.7) * fm
          var n = S.wave > 14 ? 7 : 6
          var base = e.t
          for (var k = 0; k < n; k++) {
            var aa = base + k * TAU / n
            ebullet(e.x, e.y, Math.cos(aa) * bs * 0.72, Math.sin(aa) * bs * 0.72, '190,110,255')
          }
        }
      } else if (e.kind === 'sniper') {
        if (e.y < e.baseY) e.y += 120 * dt
        else e.x += Math.sin(e.t * 0.7) * 46 * dt
        e.x = clamp(e.x, 40, VW - 40)
        if (e.chargeT > 0) {
          e.chargeT -= dt
          if (e.chargeT <= 0) {
            e.chargeT = 0
            ebullet(e.x, e.y + 16, Math.cos(aim) * 430, Math.sin(aim) * 430, '255,90,120', 7)
            A.hit()
            e.fireT = (2.4 + Math.random() * 1.0) * fm
          }
        } else {
          e.fireT -= dt
          if (e.fireT <= 0 && e.y > 0) { e.chargeT = 0.66; A.warn() }
        }
      } else if (e.kind === 'spinner') {
        if (e.y < e.baseY) e.y += 82 * dt
        e.ang += dt * 2.1
        var sx = VW / 2 + Math.cos(e.ang) * 172
        var sy = e.baseY + Math.sin(e.ang * 2) * 40
        e.x += (sx - e.x) * Math.min(1, dt * 1.5)
        e.y += (sy - e.y) * Math.min(1, dt * 1.5)
        e.fireT -= dt
        if (e.fireT <= 0 && e.y > 0) {
          e.fireT = 0.3 * fm
          e.step++
          var sb = e.step * 0.95
          for (var w = 0; w < 3; w++) {
            var wa = sb + w * TAU / 3
            ebullet(e.x, e.y, Math.cos(wa) * bs * 0.7, Math.sin(wa) * bs * 0.7, '190,110,255')
          }
        }
      } else if (e.kind === 'beamer') {
        if (e.y < e.baseY) {
          e.y += 90 * dt
          e.x += Math.sin(e.t * 0.5) * 30 * dt
        }
        if (e.firing > 0) {
          e.firing -= dt
          if (e.firing <= 0) e.fireT = 2.8 * fm
        } else if (e.charge > 0) {
          e.charge += dt / 1.05
          if (e.charge >= 1) {
            e.charge = 0
            e.firing = 0.75
            A.bomb()
            S.shake = Math.min(16, S.shake + 6)
            S.flash = Math.max(S.flash, 0.16)
            S.flashCol = '255,110,160'
          }
        } else {
          e.fireT -= dt
          if (e.fireT <= 0 && e.y > 0) { e.charge = 0.001; e.beamX = e.x }
        }
      }
    }

    function stepBoss(b, dt) {
      b.t += dt
      if (b.flash > 0) b.flash = Math.max(0, b.flash - dt * 4.2)

      if (b.entering) {
        b.y += 96 * dt
        if (b.y >= b.baseY) { b.y = b.baseY; b.entering = false; b.patT = 0.6 }
        return
      }

      var p = S.p
      b.x += (VW / 2 + Math.sin(b.t * 0.62) * (VW / 2 - 118) - b.x) * Math.min(1, dt * 1.6)
      b.y = b.baseY + Math.sin(b.t * 1.1) * 12

      var aim = p && !p.dead ? Math.atan2(p.y - b.y, p.x - b.x) : Math.PI / 2
      var bs = (175 + Math.min(110, S.wave * 4)) * (1 + (b.tier - 1) * 0.08)

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

      var hpFrac = b.hp / b.maxHp
      var rage = hpFrac < 0.34 ? 1.45 : hpFrac < 0.67 ? 1.2 : 1

      if (b.pat === 0) {
        /* 环形弹幕 */
        if (b.fireT <= 0) {
          b.fireT = 0.68 / rage
          b.step++
          var off = b.step * 0.26
          var n0 = 11
          for (var i = 0; i < n0; i++) {
            var a = off + i * TAU / n0
            ebullet(b.x, b.y + 10, Math.cos(a) * bs * 0.62, Math.sin(a) * bs * 0.62, '255,90,170')
          }
        }
      } else if (b.pat === 1) {
        /* 瞄准扇形 */
        if (b.fireT <= 0) {
          b.fireT = 0.6 / rage
          for (var s = -2; s <= 2; s++) {
            var aa2 = aim + s * 0.15
            ebullet(b.x + s * 12, b.y + 30, Math.cos(aa2) * bs * 1.15, Math.sin(aa2) * bs * 1.15, '255,175,60')
          }
        }
      } else if (b.pat === 2) {
        /* 双臂螺旋 */
        if (b.fireT <= 0) {
          b.fireT = 0.105
          b.step++
          var base = b.step * 0.34
          ebullet(b.x - 44, b.y + 20, Math.cos(base) * bs * 0.8, Math.sin(base) * bs * 0.8, '190,110,255')
          ebullet(b.x + 44, b.y + 20, Math.cos(base + Math.PI) * bs * 0.8, Math.sin(base + Math.PI) * bs * 0.8, '190,110,255')
        }
      } else if (b.pat === 3) {
        /* 召唤僚机 + 三向扫射 */
        if (b.fireT <= 0) {
          b.fireT = 0.44 / rage
          b.step++
          if (b.step % 4 === 0 && S.enemies.length < 12) {
            spawn({ kind: 'drone', x: b.x - 130, y: b.y + 20, r: 15, hp: 16, score: 150, amp: 60, freq: 2.2, baseY: 240, fireT: 1.9 })
            spawn({ kind: 'drone', x: b.x + 130, y: b.y + 20, r: 15, hp: 16, score: 150, amp: 60, freq: 2.2, baseY: 240, fireT: 2.2 })
          }
          var a2 = aim + rand(-0.12, 0.12)
          ebullet(b.x, b.y + 34, Math.cos(a2) * bs, Math.sin(a2) * bs, '90,200,255')
          ebullet(b.x - 46, b.y + 26, Math.cos(a2 + 0.3) * bs * 0.9, Math.sin(a2 + 0.3) * bs * 0.9, '90,200,255')
          ebullet(b.x + 46, b.y + 26, Math.cos(a2 - 0.3) * bs * 0.9, Math.sin(a2 - 0.3) * bs * 0.9, '90,200,255')
        }
      } else {
        /* 弹幕墙：3 格缺口横向游走 */
        if (b.fireT <= 0) {
          b.fireT = 1.5 / rage
          b.step++
          var cols = 11
          var gap = (b.step * 2) % (cols - 2)
          for (var c = 0; c < cols; c++) {
            if (c === gap || c === gap + 1 || c === gap + 2) continue
            var wx = 34 + c * (VW - 68) / (cols - 1)
            ebullet(wx, b.y + 46, 0, bs * 0.82, '90,200,255')
          }
          A.hit()
        }
      }
    }

    /* ---------------- 绘制 ---------------- */

    function drawBg() {
      g.fillStyle = bgGrad
      g.fillRect(0, 0, VW, VH)
      g.save()
      g.globalCompositeOperation = 'lighter'
      g.save(); g.translate(VW * 0.24 + Math.sin(S.t * 0.07) * 44, VH * 0.22 + Math.cos(S.t * 0.05) * 30); g.fillStyle = neb1; g.fillRect(-360, -360, 720, 720); g.restore()
      g.save(); g.translate(VW * 0.82 + Math.cos(S.t * 0.06) * 52, VH * 0.58 + Math.sin(S.t * 0.04) * 40); g.fillStyle = neb2; g.fillRect(-420, -420, 840, 840); g.restore()
      g.save(); g.translate(VW * 0.5 + Math.sin(S.t * 0.09) * 30, VH * 1.0); g.fillStyle = neb3; g.fillRect(-450, -450, 900, 900); g.restore()
      g.restore()
    }

    function drawStars() {
      for (var L = 0; L < 3; L++) {
        var st = S.stars[L]
        if (!st) continue
        g.fillStyle = L === 0 ? 'rgba(150,190,255,.42)' : L === 1 ? 'rgba(210,235,255,.62)' : 'rgba(255,255,255,.9)'
        g.beginPath()
        for (var i = 0; i < st.list.length; i++) {
          var s = st.list[i]
          g.rect(s.x, s.y, s.s, s.s * (L + 1.4))
        }
        g.fill()
      }
    }

    function drawLaser(p) {
      var hw = 7 + p.power * 2.4
      var y0 = 0
      var y1 = p.y - 22
      if (y1 <= y0) return
      var hot = p.rageT > 0

      g.save()
      g.globalCompositeOperation = 'lighter'

      var grd = g.createLinearGradient(0, y1, 0, y0)
      grd.addColorStop(0, hot ? 'rgba(255,240,220,.9)' : 'rgba(200,255,255,.85)')
      grd.addColorStop(0.3, hot ? 'rgba(255,170,110,.55)' : 'rgba(110,230,255,.5)')
      grd.addColorStop(1, hot ? 'rgba(255,110,60,.2)' : 'rgba(70,170,255,.18)')
      g.fillStyle = grd
      g.fillRect(p.x - hw, y0, hw * 2, y1 - y0)

      g.fillStyle = 'rgba(255,255,255,.95)'
      g.fillRect(p.x - hw * 0.32, y0, hw * 0.64, y1 - y0)

      var bandY = (S.t * 900) % 130
      g.fillStyle = hot ? 'rgba(255,230,200,.24)' : 'rgba(220,255,255,.22)'
      for (var i = 0; i < 8; i++) {
        var by = y1 - bandY - i * 130
        if (by + 26 < y0) continue
        var top = Math.max(y0, by - 26)
        g.fillRect(p.x - hw * 0.82, top, hw * 1.64, Math.min(26, by - top))
      }

      g.save()
      g.translate(p.x, y1 + 4)
      g.fillStyle = glowGrad(34 + Math.sin(S.t * 30) * 5, hot ? '255,200,150' : '160,245,255')
      g.beginPath(); g.arc(0, 0, 44, 0, TAU); g.fill()
      g.restore()

      for (var j = 0; j < p.beamHits.length; j++) {
        var hh = p.beamHits[j]
        g.save()
        g.translate(hh.x, hh.y)
        g.fillStyle = glowGrad(hh.r * 1.5, hot ? '255,220,180' : '200,250,255')
        g.beginPath(); g.arc(0, 0, hh.r * 2.2, 0, TAU); g.fill()
        g.restore()
      }
      g.restore()
    }

    function drawWings(p) {
      if (p.wingT <= 0 || p.dead) return
      var low = p.wingT < 3 && Math.floor(S.t * 8) % 2 === 0
      for (var i = 0; i < 2; i++) {
        var w = p.wings[i]
        g.save()
        g.translate(w.x, w.y)
        if (low) g.globalAlpha = 0.45
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(160,255,210,.4)'
        g.beginPath(); g.moveTo(-4, 6); g.lineTo(0, 16); g.lineTo(4, 6); g.closePath(); g.fill()
        g.restore()
        g.beginPath()
        g.moveTo(0, -14); g.lineTo(6, -2); g.lineTo(10, 9); g.lineTo(0, 6); g.lineTo(-10, 9); g.lineTo(-6, -2)
        g.closePath()
        g.fillStyle = 'rgba(38,86,74,.95)'
        g.fill()
        g.lineWidth = 1.3
        g.strokeStyle = 'rgba(170,255,215,.9)'
        g.stroke()
        g.fillStyle = 'rgba(220,255,240,.95)'
        g.beginPath(); g.arc(0, -3, 2.6, 0, TAU); g.fill()
        g.restore()
      }
    }

    function drawShip() {
      var p = S.p
      if (!p || p.dead) return
      var blink = p.invT > 0 && Math.floor(S.t * 22) % 2 === 0
      var hot = p.rageT > 0

      g.save()
      g.translate(p.x, p.y)
      g.rotate(p.roll * 0.5)
      if (blink) g.globalAlpha = 0.4

      g.save()
      g.globalCompositeOperation = 'lighter'
      var f = 1 + Math.sin(S.t * 34) * 0.22
      g.fillStyle = hot ? 'rgba(255,180,120,.55)' : 'rgba(120,235,255,.5)'
      g.beginPath()
      g.moveTo(-7, 8); g.lineTo(0, 14 + 30 * f); g.lineTo(7, 8)
      g.closePath(); g.fill()
      g.fillStyle = 'rgba(255,255,255,.85)'
      g.beginPath()
      g.moveTo(-3.4, 8); g.lineTo(0, 12 + 15 * f); g.lineTo(3.4, 8)
      g.closePath(); g.fill()
      g.restore()

      g.beginPath()
      g.moveTo(0, -31); g.lineTo(6, -10); g.lineTo(21, 8); g.lineTo(9, 6); g.lineTo(6, 17)
      g.lineTo(0, 13); g.lineTo(-6, 17); g.lineTo(-9, 6); g.lineTo(-21, 8); g.lineTo(-6, -10)
      g.closePath()
      g.fillStyle = hullGrad
      g.fill()
      g.lineWidth = 1.4
      g.strokeStyle = hot ? 'rgba(255,200,160,.95)' : 'rgba(180,240,255,.9)'
      g.stroke()

      g.beginPath()
      g.ellipse(0, -6, 4.2, 8, 0, 0, TAU)
      g.fillStyle = 'rgba(255,255,255,.95)'
      g.fill()

      g.fillStyle = hot ? 'rgba(255,150,90,.95)' : 'rgba(255,110,180,.95)'
      g.beginPath(); g.arc(-19, 8, 2.1, 0, TAU); g.fill()
      g.beginPath(); g.arc(19, 8, 2.1, 0, TAU); g.fill()

      if (p.shieldT > 0) {
        var a = 0.28 + Math.sin(S.t * 8) * 0.1
        g.strokeStyle = 'rgba(130,230,255,' + (p.shieldT < 2.5 ? a * (0.4 + 0.6 * Math.abs(Math.sin(S.t * 14))) : a) + ')'
        g.lineWidth = 2.2
        g.beginPath(); g.arc(0, 0, 34, 0, TAU); g.stroke()
        g.strokeStyle = 'rgba(255,255,255,.16)'
        g.beginPath(); g.arc(0, 0, 28, S.t * 3, S.t * 3 + 2.1); g.stroke()
        g.beginPath(); g.arc(0, 0, 28, S.t * 3 + Math.PI, S.t * 3 + Math.PI + 2.1); g.stroke()
      }
      g.restore()
    }

    function pathDrone() { g.beginPath(); g.moveTo(0, 16); g.lineTo(-15, -4); g.lineTo(-9, -13); g.lineTo(9, -13); g.lineTo(15, -4); g.closePath() }
    function pathDart() { g.beginPath(); g.moveTo(0, 17); g.lineTo(-7, 0); g.lineTo(-5, -16); g.lineTo(5, -16); g.lineTo(7, 0); g.closePath() }
    function pathTurret() { g.beginPath(); g.moveTo(-20, -8); g.lineTo(-11, -18); g.lineTo(11, -18); g.lineTo(20, -8); g.lineTo(14, 16); g.lineTo(-14, 16); g.closePath() }
    function pathOrb() { g.beginPath(); g.arc(0, 0, 24, 0, TAU) }
    function pathSniper() { g.beginPath(); g.moveTo(0, 19); g.lineTo(-10, 5); g.lineTo(-17, -7); g.lineTo(-7, -14); g.lineTo(7, -14); g.lineTo(17, -7); g.lineTo(10, 5); g.closePath() }
    function pathSpinner() { g.beginPath(); g.moveTo(0, 27); g.lineTo(-10, 7); g.lineTo(-25, 0); g.lineTo(-10, -7); g.lineTo(0, -27); g.lineTo(10, -7); g.lineTo(25, 0); g.lineTo(10, 7); g.closePath() }
    function pathBeamer() { g.beginPath(); g.moveTo(-22, -14); g.lineTo(-14, -22); g.lineTo(14, -22); g.lineTo(22, -14); g.lineTo(22, 16); g.lineTo(12, 24); g.lineTo(-12, 24); g.lineTo(-22, 16); g.closePath() }

    var EPATH = { drone: pathDrone, dart: pathDart, turret: pathTurret, orb: pathOrb, sniper: pathSniper, spinner: pathSpinner, beamer: pathBeamer }
    var EFILL = { drone: droneGrad, dart: dartGrad, turret: turretGrad, orb: orbGrad, sniper: sniperGrad, spinner: spinnerGrad, beamer: beamerGrad }
    var ESTROKE = {
      drone: 'rgba(255,130,200,.85)', dart: 'rgba(255,210,130,.9)', turret: 'rgba(190,220,255,.8)',
      orb: 'rgba(200,150,255,.85)', sniper: 'rgba(255,120,150,.9)', spinner: 'rgba(200,150,255,.9)',
      beamer: 'rgba(220,180,230,.85)'
    }

    function drawEnemy(e) {
      var path = EPATH[e.kind] || pathDrone
      var fill = EFILL[e.kind] || droneGrad

      g.save()
      g.translate(e.x, e.y)
      path()
      g.fillStyle = fill
      g.fill()
      g.lineWidth = 1.5
      g.strokeStyle = ESTROKE[e.kind] || 'rgba(255,130,200,.85)'
      g.stroke()

      if (e.flash > 0.02) {
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(255,255,255,' + Math.min(0.85, e.flash) + ')'
        path()
        g.fill()
        g.globalCompositeOperation = 'source-over'
      }

      if (e.kind === 'orb') {
        g.save()
        g.rotate(e.t * 1.1)
        g.strokeStyle = 'rgba(225,180,255,.9)'
        g.lineWidth = 2.4
        g.beginPath()
        for (var i = 0; i < 6; i++) {
          var a = i * TAU / 6
          g.moveTo(Math.cos(a) * 10, Math.sin(a) * 10)
          g.lineTo(Math.cos(a) * 18, Math.sin(a) * 18)
        }
        g.stroke()
        g.restore()
        g.fillStyle = 'rgba(235,200,255,.95)'
        g.beginPath(); g.arc(0, 0, 6.5 + Math.sin(S.t * 5) * 1.1, 0, TAU); g.fill()
      } else if (e.kind === 'turret') {
        g.fillStyle = 'rgba(255,240,150,.95)'
        g.beginPath(); g.arc(0, 6, 5.4, 0, TAU); g.fill()
        g.fillStyle = 'rgba(120,150,190,.9)'
        g.fillRect(-3.2, 14, 6.4, 9)
      } else if (e.kind === 'drone') {
        g.fillStyle = 'rgba(255,120,190,.95)'
        g.beginPath(); g.arc(0, 0, 4.4 + Math.sin(e.t * 7) * 0.7, 0, TAU); g.fill()
      } else if (e.kind === 'dart') {
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(255,200,120,.85)'
        g.beginPath(); g.arc(0, -10, 3.4, 0, TAU); g.fill()
        g.restore()
      } else if (e.kind === 'sniper') {
        var cr = e.chargeT > 0 ? 1 - e.chargeT / 0.66 : 0
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(255,110,140,.9)'
        g.beginPath(); g.arc(0, 5, 4 + cr * 5, 0, TAU); g.fill()
        g.restore()
        if (e.chargeT > 0) {
          var pp = S.p
          if (pp && !pp.dead) {
            var ang = Math.atan2(pp.y - e.y, pp.x - e.x)
            g.save()
            g.globalCompositeOperation = 'lighter'
            g.strokeStyle = 'rgba(255,80,110,' + (0.2 + 0.5 * cr) + ')'
            g.lineWidth = 1 + cr * 2
            g.beginPath()
            g.moveTo(Math.cos(ang) * 20, Math.sin(ang) * 20)
            g.lineTo(Math.cos(ang) * 1000, Math.sin(ang) * 1000)
            g.stroke()
            g.restore()
          }
        }
      } else if (e.kind === 'spinner') {
        g.save()
        g.rotate(-e.t * 2.4)
        g.strokeStyle = 'rgba(220,170,255,.9)'
        g.lineWidth = 2.4
        g.beginPath()
        for (var k = 0; k < 3; k++) {
          var ka = k * TAU / 3
          g.moveTo(Math.cos(ka) * 9, Math.sin(ka) * 9)
          g.lineTo(Math.cos(ka) * 22, Math.sin(ka) * 22)
        }
        g.stroke()
        g.restore()
        g.fillStyle = 'rgba(240,215,255,.95)'
        g.beginPath(); g.arc(0, 0, 7 + Math.sin(S.t * 6) * 1.2, 0, TAU); g.fill()
      } else if (e.kind === 'beamer') {
        var ch = e.charge
        g.fillStyle = e.firing > 0
          ? 'rgba(255,255,255,.98)'
          : 'rgba(255,' + Math.round(120 + (1 - ch) * 130) + ',' + Math.round(150 + (1 - ch) * 100) + ',.95)'
        g.beginPath(); g.arc(0, 16, 7 + (1 - ch) * 5, 0, TAU); g.fill()
        g.fillStyle = 'rgba(70,60,80,.9)'
        g.fillRect(-20, -6, 40, 5)
        g.fillRect(-20, 4, 40, 5)
      }

      /* 受损血条 */
      if (e.hp < e.maxHp * 0.98 && e.r >= 16) {
        var w = e.r * 1.8
        g.fillStyle = 'rgba(0,0,0,.55)'
        g.fillRect(-w / 2, -e.r - 14, w, 4)
        g.fillStyle = 'rgba(255,110,140,.95)'
        g.fillRect(-w / 2 + 0.5, -e.r - 13.5, (w - 1) * Math.max(0, e.hp / e.maxHp), 3)
      }
      g.restore()
    }

    function drawEnemyBeams() {
      for (var i = 0; i < S.enemies.length; i++) {
        var e = S.enemies[i]
        if (e.kind !== 'beamer') continue
        var y0 = e.y + 18

        if (e.charge > 0) {
          g.save()
          g.globalCompositeOperation = 'lighter'
          g.fillStyle = 'rgba(255,120,160,' + (0.07 + 0.3 * e.charge) + ')'
          g.fillRect(e.x - 3 - 7 * e.charge, y0, 6 + 14 * e.charge, VH - y0)
          g.restore()
        }

        if (e.firing > 0) {
          g.save()
          g.globalCompositeOperation = 'lighter'
          var grd = g.createLinearGradient(0, y0, 0, VH)
          grd.addColorStop(0, 'rgba(255,205,235,.95)')
          grd.addColorStop(0.5, 'rgba(255,90,160,.6)')
          grd.addColorStop(1, 'rgba(255,60,140,.25)')
          g.fillStyle = grd
          g.fillRect(e.x - 15, y0, 30, VH - y0)
          g.fillStyle = 'rgba(255,255,255,.95)'
          g.fillRect(e.x - 4.5, y0, 9, VH - y0)
          var off = (S.t * 700) % 95
          g.fillStyle = 'rgba(255,240,250,.22)'
          for (var k = 0; k < 12; k++) {
            var by = y0 + off + k * 95
            if (by > VH) break
            g.fillRect(e.x - 13, by, 26, 22)
          }
          g.restore()
        }
      }
    }

    function drawBoss(b) {
      g.save()
      g.translate(b.x, b.y)
      var hpFrac = b.hp / b.maxHp
      var warm = 1 - hpFrac

      g.save()
      g.rotate(S.t * 0.42)
      g.strokeStyle = 'rgba(255,110,170,.4)'
      g.lineWidth = 2
      g.beginPath()
      for (var i = 0; i < 6; i++) {
        var a = i * TAU / 6
        g.moveTo(Math.cos(a) * (b.r + 26), Math.sin(a) * (b.r + 26))
        g.lineTo(Math.cos(a + TAU / 12) * (b.r + 38), Math.sin(a + TAU / 12) * (b.r + 38))
      }
      g.stroke()
      g.restore()

      g.save()
      g.rotate(-S.t * 0.26)
      g.strokeStyle = 'rgba(255,180,210,.28)'
      g.lineWidth = 1.4
      g.beginPath(); g.arc(0, 0, b.r + 14, 0, TAU); g.stroke()
      if (g.setLineDash) g.setLineDash([12, 16])
      g.strokeStyle = 'rgba(255,220,240,.4)'
      g.beginPath(); g.arc(0, 0, b.r + 6, 0, TAU); g.stroke()
      if (g.setLineDash) g.setLineDash([])
      g.restore()

      g.beginPath()
      g.moveTo(0, 62); g.lineTo(-30, 46); g.lineTo(-62, 34); g.lineTo(-74, 4); g.lineTo(-52, -26)
      g.lineTo(-24, -44); g.lineTo(0, -52); g.lineTo(24, -44); g.lineTo(52, -26)
      g.lineTo(74, 4); g.lineTo(62, 34); g.lineTo(30, 46)
      g.closePath()
      g.fillStyle = bossGrad
      g.fill()
      g.lineWidth = 2
      g.strokeStyle = 'rgba(255,140,190,.85)'
      g.stroke()

      if (b.flash > 0.02) {
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(255,255,255,' + Math.min(0.75, b.flash) + ')'
        g.fill()
        g.globalCompositeOperation = 'source-over'
      }

      g.strokeStyle = 'rgba(255,190,220,.35)'
      g.lineWidth = 1.2
      g.beginPath()
      g.moveTo(-46, -18); g.lineTo(-18, -6); g.lineTo(0, -20)
      g.moveTo(46, -18); g.lineTo(18, -6); g.lineTo(0, -20)
      g.moveTo(-40, 22); g.lineTo(0, 34); g.lineTo(40, 22)
      g.stroke()

      g.fillStyle = 'rgba(120,40,76,.95)'
      g.fillRect(-58, 26, 14, 22)
      g.fillRect(44, 26, 14, 22)
      g.fillStyle = 'rgba(255,170,210,.7)'
      g.fillRect(-56, 44, 10, 5)
      g.fillRect(46, 44, 10, 5)

      g.save()
      g.globalCompositeOperation = 'lighter'
      var pulse = 0.6 + Math.sin(S.t * (5 + warm * 6)) * 0.4
      var cg = glowGrad(34 + pulse * 12, warm > 0.6 ? '255,90,90' : '255,110,180')
      g.translate(0, 4)
      g.fillStyle = cg
      g.beginPath(); g.arc(0, 0, 46, 0, TAU); g.fill()
      g.restore()

      g.fillStyle = 'rgba(255,255,255,.95)'
      g.beginPath(); g.arc(0, 4, 11 + pulse * 2.4, 0, TAU); g.fill()

      if (warm > 0.3) {
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(255,90,60,' + (warm - 0.3) * 0.35 * (0.5 + 0.5 * Math.sin(S.t * 12)) + ')'
        g.fillRect(-70, -50, 140, 110)
        g.globalCompositeOperation = 'source-over'
      }
      g.restore()
    }

    function drawBullets() {
      if (!S.bullets.length) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      for (var i = 0; i < S.bullets.length; i++) {
        var b = S.bullets[i]
        if (b.kind === 'missile') {
          g.save()
          g.translate(b.x, b.y)
          g.fillStyle = glowGrad(20, '255,180,90')
          g.beginPath(); g.arc(0, 0, 22, 0, TAU); g.fill()
          g.rotate(b.ang + Math.PI / 2)
          g.beginPath()
          g.moveTo(0, -11); g.lineTo(6, 9); g.lineTo(0, 5); g.lineTo(-6, 9)
          g.closePath()
          g.fillStyle = 'rgba(255,235,190,.98)'
          g.fill()
          g.restore()
        } else if (b.kind === 'pellet') {
          g.save()
          g.translate(b.x, b.y)
          g.fillStyle = glowGrad(13, '255,120,150')
          g.beginPath(); g.arc(0, 0, 14, 0, TAU); g.fill()
          g.fillStyle = 'rgba(255,240,245,.95)'
          g.beginPath(); g.arc(0, 0, 2.6, 0, TAU); g.fill()
          g.restore()
        } else {
          g.save()
          g.translate(b.x, b.y)
          g.fillStyle = boltGrad
          g.beginPath()
          g.ellipse(0, -6, 4.6, 15, 0, 0, TAU)
          g.fill()
          g.restore()
        }
      }
      g.restore()
    }

    function drawEBullets() {
      if (!S.ebullets.length) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      for (var i = 0; i < S.ebullets.length; i++) {
        var b = S.ebullets[i]
        g.save()
        g.translate(b.x, b.y)
        g.fillStyle = EG[b.c] || EG_DEF
        g.beginPath(); g.arc(0, 0, 15, 0, TAU); g.fill()
        g.fillStyle = 'rgba(255,255,255,.95)'
        g.beginPath(); g.arc(0, 0, b.r * 0.62, 0, TAU); g.fill()
        g.restore()
      }
      g.restore()
    }

    function drawParts() {
      if (!S.parts.length) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      for (var i = 0; i < S.parts.length; i++) {
        var p = S.parts[i]
        var a = clamp(p.life / p.max, 0, 1)
        if (p.kind === 'spark') {
          g.strokeStyle = 'rgba(' + p.c + ',' + (a * 0.9) + ')'
          g.lineWidth = p.w
          g.beginPath()
          g.moveTo(p.x, p.y)
          g.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03)
          g.stroke()
        } else {
          g.fillStyle = 'rgba(' + p.c + ',' + (a * 0.26) + ')'
          g.beginPath(); g.arc(p.x, p.y, p.r * (1.7 + (1 - a) * 1.6), 0, TAU); g.fill()
          g.fillStyle = 'rgba(' + p.c + ',' + (a * 0.95) + ')'
          g.beginPath(); g.arc(p.x, p.y, p.r * a, 0, TAU); g.fill()
        }
      }
      g.restore()
    }

    function drawRings() {
      if (!S.rings.length) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      for (var i = 0; i < S.rings.length; i++) {
        var r = S.rings[i]
        var a = clamp(r.life / r.maxLife, 0, 1)
        g.strokeStyle = 'rgba(' + r.c + ',' + (a * 0.75) + ')'
        g.lineWidth = r.w * a + 0.6
        g.beginPath(); g.arc(r.x, r.y, r.r, 0, TAU); g.stroke()
      }
      g.restore()
    }

    function drawPicks() {
      for (var i = 0; i < S.picks.length; i++) {
        var pk = S.picks[i]
        var c = PICK_COL[pk.kind] || '255,255,255'
        g.save()
        g.translate(pk.x, pk.y)
        g.save()
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = 'rgba(' + c + ',.38)'
        g.beginPath(); g.arc(0, 0, 23 + Math.sin(pk.t * 4) * 2.4, 0, TAU); g.fill()
        g.restore()
        g.rotate(pk.t * 1.4)
        g.beginPath()
        g.moveTo(0, -14); g.lineTo(14, 0); g.lineTo(0, 14); g.lineTo(-14, 0)
        g.closePath()
        g.fillStyle = 'rgba(' + c + ',.28)'
        g.fill()
        g.lineWidth = 1.8
        g.strokeStyle = 'rgba(' + c + ',.95)'
        g.stroke()
        g.rotate(-pk.t * 1.4)
        g.fillStyle = 'rgba(255,255,255,.97)'
        g.font = '700 14px ' + FONT
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(pk.kind, 0, 0.5)
        g.restore()
      }
    }

    function drawFloats() {
      if (!S.floats.length) return
      g.save()
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      for (var i = 0; i < S.floats.length; i++) {
        var f = S.floats[i]
        var a = clamp(1 - f.t / f.life, 0, 1)
        g.font = '700 16px ' + FONT
        g.fillStyle = 'rgba(' + f.c + ',' + a + ')'
        g.shadowColor = 'rgba(' + f.c + ',' + (a * 0.8) + ')'
        g.shadowBlur = 10
        g.fillText(f.text, f.x, f.y)
        g.shadowBlur = 0
      }
      g.restore()
    }

    function drawHUD() {
      var p = S.p
      g.save()
      g.fillStyle = hudTop
      g.fillRect(0, 0, VW, 92)
      g.strokeStyle = 'rgba(120,220,255,.22)'
      g.lineWidth = 1
      g.beginPath(); g.moveTo(0, 92.5); g.lineTo(VW, 92.5); g.stroke()

      g.textAlign = 'left'
      g.textBaseline = 'alphabetic'
      g.font = '600 13px ' + FONT
      g.fillStyle = 'rgba(140,220,255,.72)'
      g.fillText('分数 SCORE', 22, 26)
      g.font = '700 33px ' + FONT
      g.fillStyle = '#eafcff'
      g.shadowColor = 'rgba(80,220,255,.85)'
      g.shadowBlur = 14
      g.fillText(fmt(S.score), 22, 60)
      g.shadowBlur = 0

      if (p && p.doubleT > 0) {
        g.font = '700 12px ' + FONT
        g.fillStyle = 'rgba(255,225,120,.95)'
        g.fillText('×2', 24 + g.measureText(fmt(S.score)).width + 8, 60)
      }

      if (p) {
        g.font = '600 12px ' + FONT
        g.fillStyle = 'rgba(160,230,255,.62)'
        g.fillText('机体', 22, 82)
        for (var i = 0; i < Math.max(0, p.lives); i++) {
          var lx = 56 + i * 17
          g.fillStyle = 'rgba(140,240,255,.95)'
          g.beginPath()
          g.moveTo(lx, 74); g.lineTo(lx + 6, 84); g.lineTo(lx, 82); g.lineTo(lx - 6, 84)
          g.closePath()
          g.fill()
        }
        var bx = 56 + Math.max(0, p.lives) * 17 + 10
        if (bx < 300) {
          g.fillStyle = 'rgba(255,170,190,.85)'
          g.fillRect(bx, 74, p.hp >= p.maxHp ? 92 : 92 * (p.hp / p.maxHp), 7)
          g.strokeStyle = 'rgba(180,235,255,.3)'
          g.strokeRect(bx + 0.5, 74.5, 92, 7)
        }
      }

      g.textAlign = 'right'
      g.font = '600 13px ' + FONT
      g.fillStyle = 'rgba(255,170,210,.75)'
      g.fillText('波次 WAVE', VW - 22, 26)
      g.font = '700 30px ' + FONT
      g.fillStyle = '#ffe9f4'
      g.shadowColor = 'rgba(255,110,180,.8)'
      g.shadowBlur = 12
      g.fillText(String(S.wave), VW - 22, 56)
      g.shadowBlur = 0
      if (S.combo > 1) {
        g.font = '700 15px ' + FONT
        g.fillStyle = 'rgba(255,225,150,.95)'
        g.fillText('连击 ×' + S.combo, VW - 22, 80)
      }

      /* 强化等级 + 能量条 */
      var tierCol = S.mk >= 15 ? '255,150,200' : S.mk >= 10 ? '255,190,120' : S.mk >= 5 ? '255,225,150' : '170,235,255'
      g.textAlign = 'center'
      g.font = '700 13.5px ' + FONT
      g.fillStyle = 'rgba(' + tierCol + ',.98)'
      g.shadowColor = 'rgba(' + tierCol + ',.8)'
      g.shadowBlur = 10
      g.fillText('强化 Mk.' + S.mk + '  ×' + dmgMul().toFixed(2), VW / 2, 30)
      g.shadowBlur = 0

      var ewx = VW / 2 - 84
      var ewn = mkNeed(S.mk)
      g.fillStyle = 'rgba(10,20,40,.78)'
      g.fillRect(ewx, 40, 168, 6)
      g.fillStyle = 'rgba(' + tierCol + ',.85)'
      g.fillRect(ewx + 1, 41, 166 * clamp(S.energy / ewn, 0, 1), 4)
      g.strokeStyle = 'rgba(' + tierCol + ',.35)'
      g.lineWidth = 1
      g.strokeRect(ewx + 0.5, 40.5, 167, 5)

      /* BOSS 血条 */
      if (S.boss && !S.boss.entering) {
        var b = S.boss
        var bw = VW - 260
        g.textAlign = 'center'
        g.font = '700 13px ' + FONT
        g.fillStyle = 'rgba(255,170,205,.9)'
        g.fillText('旗舰 · VANGUARD', VW / 2, 116)
        g.fillStyle = 'rgba(10,4,14,.7)'
        g.fillRect(130, 124, bw, 10)
        var frac = clamp(b.hp / b.maxHp, 0, 1)
        var bgr = g.createLinearGradient(130, 0, 130 + bw, 0)
        bgr.addColorStop(0, '#ff3d7f')
        bgr.addColorStop(0.55, '#ff8ac0')
        bgr.addColorStop(1, '#ffd0e8')
        g.fillStyle = bgr
        g.fillRect(130, 124, bw * frac, 10)
        g.strokeStyle = 'rgba(255,170,210,.55)'
        g.lineWidth = 1
        g.strokeRect(130.5, 124.5, bw - 1, 9)
      }

      /* 底栏 */
      g.fillStyle = hudBot
      g.fillRect(0, VH - 74, VW, 74)
      g.strokeStyle = 'rgba(120,220,255,.2)'
      g.beginPath(); g.moveTo(0, VH - 74.5); g.lineTo(VW, VH - 74.5); g.stroke()

      g.textAlign = 'left'
      g.textBaseline = 'middle'
      var r1 = VH - 52
      g.font = '600 12px ' + FONT
      g.fillStyle = 'rgba(140,220,255,.7)'
      g.fillText('火力', 22, r1)
      for (var k = 0; k < 5; k++) {
        var px = 58 + k * 16
        var on = p && k < p.power
        g.fillStyle = on ? 'rgba(140,240,255,.95)' : 'rgba(120,180,220,.2)'
        g.fillRect(px, r1 - 7, 11, 14)
      }

      if (p) {
        var wcol = p.weapon === 'laser' ? '140,240,255' : p.weapon === 'homing' ? '255,180,90' : p.weapon === 'scatter' ? '255,120,150' : '200,230,255'
        var wname = WEAPON_NAME[p.weapon] + ' Lv' + p.power
        g.font = '700 12px ' + FONT
        var ww = g.measureText(wname).width + 18
        roundRect(152, r1 - 11, ww, 22, 7)
        g.fillStyle = 'rgba(' + wcol + ',.16)'
        g.fill()
        g.strokeStyle = 'rgba(' + wcol + ',.7)'
        g.lineWidth = 1
        g.stroke()
        g.fillStyle = 'rgba(' + wcol + ',.98)'
        g.fillText(wname, 161, r1 + 1)

        g.textAlign = 'right'
        g.fillStyle = 'rgba(255,200,140,.8)'
        g.font = '600 12px ' + FONT
        g.fillText('炸弹', VW - 92, r1)
        for (var m = 0; m < 4; m++) {
          var qx = VW - 76 + m * 17
          var on2 = m < p.bombs
          g.beginPath()
          g.arc(qx, r1, 5.6, 0, TAU)
          g.fillStyle = on2 ? 'rgba(255,205,120,.95)' : 'rgba(140,150,180,.2)'
          g.fill()
          if (on2) {
            g.strokeStyle = 'rgba(255,240,190,.8)'
            g.lineWidth = 1.2
            g.beginPath(); g.arc(qx, r1, 9, 0, TAU); g.stroke()
          }
        }
      }

      /* 增幅计时块 */
      var r2 = VH - 22
      if (p) {
        g.textAlign = 'left'
        var cx2 = 22
        for (var n = 0; n < BUFF_ROWS.length; n++) {
          var br = BUFF_ROWS[n]
          var left = p[br.key]
          if (left <= 0) continue
          var label = br.name + ' ' + left.toFixed(1) + 's'
          g.font = '700 11.5px ' + FONT
          var lw = g.measureText(label).width + 16
          roundRect(cx2, r2 - 11, lw, 22, 7)
          g.fillStyle = 'rgba(' + br.col + ',.15)'
          g.fill()
          g.strokeStyle = 'rgba(' + br.col + ',.6)'
          g.lineWidth = 1
          g.stroke()
          g.fillStyle = 'rgba(0,0,0,.45)'
          g.fillRect(cx2 + 1, r2 + 8, lw - 2, 2.5)
          g.fillStyle = 'rgba(' + br.col + ',.95)'
          g.fillRect(cx2 + 1, r2 + 8, (lw - 2) * clamp(left / br.total, 0, 1), 2.5)
          g.fillStyle = 'rgba(' + br.col + ',1)'
          g.fillText(label, cx2 + 8, r2 - 1)
          cx2 += lw + 6
        }

        g.textAlign = 'right'
        g.font = '700 12px ' + FONT
        if (p.weapon === 'laser') {
          g.fillStyle = 'rgba(150,240,255,.85)'
          g.fillText('贯穿光束 · ' + Math.round((58 + p.power * 26) * dmgMul()) + ' /s', VW - 22, r2)
        } else {
          g.fillStyle = 'rgba(' + tierCol + ',.85)'
          g.fillText('总伤害加成 ×' + dmgMul().toFixed(2), VW - 22, r2)
        }
      }

      if (S.mkFlash > 0) {
        g.textAlign = 'center'
        g.globalAlpha = clamp(S.mkFlash, 0, 1)
        g.font = '800 21px ' + FONT
        g.fillStyle = 'rgba(' + tierCol + ',1)'
        g.shadowColor = 'rgba(' + tierCol + ',.9)'
        g.shadowBlur = 14
        g.fillText('火力强化  Mk.' + S.mk, VW / 2, 72)
        g.shadowBlur = 0
        g.globalAlpha = 1
      }

      if (S.err) {
        g.textAlign = 'center'
        g.font = '600 11px ' + FONT
        g.fillStyle = 'rgba(255,150,150,.9)'
        g.fillText('运行异常: ' + S.err, VW / 2, VH - 88)
      }
      g.restore()
    }

    function centerText(text, y, size, col, weight, glowCol, spacing) {
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.font = (weight || 700) + ' ' + size + 'px ' + FONT
      if (spacing !== undefined) g.letterSpacing = spacing + 'px'
      if (glowCol) {
        g.shadowColor = glowCol
        g.shadowBlur = size * 0.5
      }
      g.fillStyle = col
      g.fillText(text, VW / 2, y)
      g.shadowBlur = 0
      if (spacing !== undefined) g.letterSpacing = '0px'
    }

    function drawTitleShip() {
      var p = S.p
      if (!p) return
      var save = { x: p.x, y: p.y, roll: p.roll, invT: p.invT }
      p.x = VW / 2 + Math.sin(S.t * 0.8) * 26
      p.y = VH - 176 + Math.sin(S.t * 1.6) * 9
      p.roll = Math.sin(S.t * 0.8) * 0.14
      p.invT = 0
      drawShip()
      p.x = save.x
      p.y = save.y
      p.roll = save.roll
      p.invT = save.invT
    }

    function drawScreens() {
      var best = api.best ? api.best() : 0

      if (S.mode === 'title') {
        g.save()
        g.fillStyle = 'rgba(3,6,16,.5)'
        g.fillRect(0, 0, VW, VH)
        var pulse = 0.62 + Math.sin(S.t * 2.4) * 0.38
        centerText('星  刃', 238, 80, '#f2fdff', 800, 'rgba(90,215,255,.95)', 10)
        centerText('S T E L L A R   E D G E', 290, 16, 'rgba(160,230,255,.9)', 600, 'rgba(80,200,255,.8)', 2)
        g.strokeStyle = 'rgba(120,220,255,.4)'
        g.lineWidth = 1
        g.beginPath(); g.moveTo(120, 314); g.lineTo(VW - 120, 314); g.stroke()
        centerText('霓虹纵向弹幕射击', 342, 15, 'rgba(190,220,240,.75)', 500, null, 0)
        g.globalAlpha = pulse
        centerText(TOUCH ? '点击画面开始' : '点击画面 · 按空格 开始', 442, 20, '#aef0ff', 700, 'rgba(90,215,255,.9)', 0)
        g.globalAlpha = 1
        g.textAlign = 'center'
        g.font = '500 13px ' + FONT
        g.fillStyle = 'rgba(170,205,230,.72)'
        g.fillText(
          TOUCH
            ? '拖动画面移动      右下角按钮放炸弹      底栏暂停'
            : '移动  方向键 / WASD / 拖动      炸弹  空格      暂停  P',
          VW / 2, 486)
        g.font = '700 12.5px ' + FONT
        g.fillStyle = 'rgba(220,240,255,.86)'
        g.fillText('武器模组   ', VW / 2 - 96, 520)
        g.fillStyle = 'rgba(140,240,255,.95)'; g.fillText('L 激光', VW / 2 - 30, 520)
        g.fillStyle = 'rgba(255,180,90,.95)'; g.fillText('M 追踪', VW / 2 + 34, 520)
        g.fillStyle = 'rgba(255,120,150,.95)'; g.fillText('R 霰弹', VW / 2 + 98, 520)
        g.fillStyle = 'rgba(255,220,120,.95)'; g.fillText('P 火力', VW / 2 + 162, 520)
        g.fillStyle = 'rgba(255,150,90,.95)'; g.fillText('F 狂怒', VW / 2 - 130, 546)
        g.fillStyle = 'rgba(255,225,120,.95)'; g.fillText('D 双倍', VW / 2 - 62, 546)
        g.fillStyle = 'rgba(150,220,255,.95)'; g.fillText('G 磁力', VW / 2 + 6, 546)
        g.fillStyle = 'rgba(180,255,200,.95)'; g.fillText('W 僚机', VW / 2 + 74, 546)
        g.fillStyle = 'rgba(255,170,200,.95)'; g.fillText('H 生命', VW / 2 + 142, 546)
        g.font = '600 12.5px ' + FONT
        g.fillStyle = 'rgba(255,232,150,.9)'
        g.fillText('击落敌机积累能量 → 自动强化火力（Mk 每级 +11% 伤害）', VW / 2, 578)
        g.font = '600 15px ' + FONT
        g.fillStyle = 'rgba(255,225,160,.9)'
        g.fillText('最高分  ' + fmt(best), VW / 2, 612)
        g.restore()
        drawTitleShip()
        return
      }

      if (S.mode === 'paused') {
        g.save()
        g.fillStyle = 'rgba(3,6,16,.66)'
        g.fillRect(0, 0, VW, VH)
        centerText('已  暂  停', VH / 2 - 20, 44, '#eafcff', 800, 'rgba(90,215,255,.9)', 4)
        centerText('按 P 继续', VH / 2 + 40, 16, 'rgba(180,225,255,.85)', 500, null, 0)
        g.restore()
        return
      }

      if (S.mode === 'over') {
        var a = clamp(S.overT / 0.8, 0, 1)
        g.save()
        g.fillStyle = 'rgba(3,6,16,' + (0.7 * a) + ')'
        g.fillRect(0, 0, VW, VH)
        g.globalAlpha = a
        centerText('GAME OVER', VH / 2 - 116, 46, '#ffd9e6', 800, 'rgba(255,70,130,.9)', 6)
        centerText('任 务 失 败', VH / 2 - 62, 22, 'rgba(255,180,205,.9)', 600, 'rgba(255,90,140,.6)', 1)
        g.textAlign = 'center'
        g.font = '600 15px ' + FONT
        g.fillStyle = 'rgba(190,225,245,.8)'
        g.fillText('得分', VW / 2, VH / 2 - 6)
        g.font = '800 42px ' + FONT
        g.fillStyle = '#eafcff'
        g.shadowColor = 'rgba(80,220,255,.85)'
        g.shadowBlur = 16
        g.fillText(fmt(S.score), VW / 2, VH / 2 + 40)
        g.shadowBlur = 0
        g.font = '600 14px ' + FONT
        g.fillStyle = 'rgba(255,225,160,.92)'
        g.fillText('最高分  ' + fmt(Math.max(best, S.score)), VW / 2, VH / 2 + 78)
        g.fillStyle = 'rgba(175,215,240,.78)'
        g.font = '500 13.5px ' + FONT
        g.fillText('第 ' + S.wave + ' 波   ·   强化 Mk.' + S.mk + ' (×' + dmgMul().toFixed(2) + ')   ·   击落 ' + S.kills + '   ·   最高连击 ×' + S.bestCombo, VW / 2, VH / 2 + 110)
        g.globalAlpha = a * (0.6 + Math.sin(S.t * 3) * 0.4)
        g.font = '700 17px ' + FONT
        g.fillStyle = '#aef0ff'
        g.fillText('点击画面 · 按空格 再来一局', VW / 2, VH / 2 + 176)
        g.globalAlpha = 1
        g.restore()
      }
    }

    function drawBanner() {
      if (S.bannerT <= 0) return
      var a = clamp(S.bannerT / 0.5, 0, 1)
      if (S.bannerT > 1.6) a = clamp((2.1 - S.bannerT) / 0.5, 0, 1)
      g.save()
      g.globalAlpha = a
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      var big = S.wave % 5 === 0 && S.wave > 0
      g.font = (big ? 800 : 700) + ' ' + (big ? 46 : 34) + 'px ' + FONT
      g.shadowColor = big ? 'rgba(255,60,110,.95)' : 'rgba(80,210,255,.9)'
      g.shadowBlur = 18
      g.fillStyle = big ? '#ffd7e4' : '#e7fbff'
      g.fillText(S.banner, VW / 2, VH * 0.34)
      g.shadowBlur = 0
      g.font = '600 15px ' + FONT
      g.fillStyle = big ? 'rgba(255,150,185,.92)' : 'rgba(160,225,255,.85)'
      g.fillText(S.bannerSub, VW / 2, VH * 0.34 + 34)
      g.globalAlpha = 1
      g.restore()
    }

    function drawVignette() {
      g.save()
      g.fillStyle = vig
      g.fillRect(0, 0, VW, VH)
      g.globalAlpha = 0.05
      g.strokeStyle = '#9fe4ff'
      g.lineWidth = 1
      g.beginPath()
      for (var y = 0; y < VH; y += 5) {
        g.moveTo(0, y + 0.5)
        g.lineTo(VW, y + 0.5)
      }
      g.stroke()
      g.restore()
    }

    function drawFlash() {
      if (S.flash <= 0.001) return
      g.save()
      g.globalCompositeOperation = 'lighter'
      g.fillStyle = 'rgba(' + S.flashCol + ',' + Math.min(0.85, S.flash) + ')'
      g.fillRect(0, 0, VW, VH)
      g.restore()
    }

    /* 泛光：降采样到 1/4 画布 → 高斯模糊 → 加性回叠 */
    function bloomPass() {
      if (!bctx) return
      try {
        bctx.setTransform(1, 0, 0, 1, 0, 0)
        bctx.globalCompositeOperation = 'source-over'
        bctx.globalAlpha = 1
        bctx.fillStyle = '#000'
        bctx.fillRect(0, 0, BW, BH)
        if (canFilter) bctx.filter = 'blur(2.5px)'
        bctx.drawImage(g.canvas, 0, 0, VW, VH, 0, 0, BW, BH)
        if (canFilter) bctx.filter = 'none'
      } catch (e) { return }
      g.save()
      g.globalCompositeOperation = 'lighter'
      g.globalAlpha = 0.32
      g.imageSmoothingEnabled = true
      g.drawImage(bctx.canvas, 0, 0, BW, BH, 0, 0, VW, VH)
      g.restore()
    }

    function draw() {
      var sx = 0
      var sy = 0
      if (S.shake > 0.3) {
        sx = rand(-1, 1) * S.shake
        sy = rand(-1, 1) * S.shake
      }
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.globalCompositeOperation = 'source-over'
      g.globalAlpha = 1
      g.fillStyle = '#03040c'
      g.fillRect(0, 0, VW, VH)

      g.save()
      g.translate(sx, sy)
      drawBg()
      drawStars()
      drawPicks()
      drawEnemyBeams()
      for (var i = 0; i < S.enemies.length; i++) if (!S.enemies[i].dead) drawEnemy(S.enemies[i])
      if (S.boss && !S.boss.dead) drawBoss(S.boss)
      drawBullets()
      drawEBullets()
      drawParts()
      drawRings()
      if (S.p && !S.p.dead) {
        if (S.p.weapon === 'laser' && (S.mode === 'playing' || S.mode === 'paused')) drawLaser(S.p)
        drawWings(S.p)
        if (S.mode === 'playing' || S.mode === 'paused') drawShip()
      }
      drawFloats()
      g.restore()

      drawVignette()
      drawHUD()
      drawBanner()
      drawScreens()
      bloomPass()
      drawFlash()
    }

    /* ---------------- 启动 / 控制 ---------------- */

    function initStars() {
      S.stars = []
      var conf = [
        { n: 70, sp: [26, 54], s: [0.9, 1.5] },
        { n: 46, sp: [70, 130], s: [1.3, 2.1] },
        { n: 26, sp: [150, 250], s: [1.8, 2.8] }
      ]
      for (var L = 0; L < 3; L++) {
        var list = []
        for (var i = 0; i < conf[L].n; i++) {
          list.push({
            x: rand(0, VW), y: rand(0, VH),
            sp: rand(conf[L].sp[0], conf[L].sp[1]),
            s: rand(conf[L].s[0], conf[L].s[1])
          })
        }
        S.stars.push({ list: list })
      }
    }

    function startRun() {
      S.mode = 'playing'
      S.score = 0
      S.wave = 0
      S.combo = 0
      S.comboT = 0
      S.bestCombo = 0
      S.kills = 0
      S.mk = 0
      S.energy = 0
      S.mkFlash = 0
      S.bullets = []
      S.ebullets = []
      S.enemies = []
      S.picks = []
      S.floats = []
      S.rings = []
      S.queue = []
      S.parts = []
      S.boss = null
      S.waveDelay = 1.1
      S.bannerT = 0
      S.shake = 0
      S.flash = 0
      S.hitStop = 0
      S.drag = false
      S.err = ''
      S.errN = 0
      S.p = newPlayer()
      if (api.onMode) api.onMode('playing')
    }

    S.p = newPlayer()
    initStars()

    /* 固定步长推进一帧 */
    function step() {
      try {
        var dt = DT
        if (S.hitStop > 0) {
          S.hitStop -= dt
          dt *= 0.25
        }
        /* 暂停：战场完全冻结，只留背景 30% 速漂移，避免画面死寂得像卡住 */
        if (S.mode === 'paused') {
          S.t += dt * 0.3
          stepStars(dt * 0.3)
          if (S.flash > 0) S.flash = Math.max(0, S.flash - dt * 3)
          return
        }

        S.t += dt
        stepStars(dt)
        if (S.mode === 'playing') stepPlay(dt)
        else if (S.mode === 'over') stepBullets(dt)
        stepFx(dt)
        if (S.mode === 'over') S.overT += dt
      } catch (e) {
        S.errN++
        if (S.errN <= 3) {
          S.err = String(e && e.message ? e.message : e)
          if (window.console) window.console.error('[STELLAR EDGE] step error', e)
        }
      }
    }

    function render() {
      try {
        draw()
      } catch (e) {
        S.errN++
        if (S.errN <= 3) {
          S.err = String(e && e.message ? e.message : e)
          if (window.console) window.console.error('[STELLAR EDGE] render error', e)
        }
      }
    }

    function togglePause() {
      if (S.mode === 'playing') {
        S.mode = 'paused'
        if (api.onMode) api.onMode('paused')
      } else if (S.mode === 'paused') {
        S.mode = 'playing'
        if (api.onMode) api.onMode('playing')
      }
    }

    function action() {
      if (S.mode === 'title') {
        A.ensure()
        startRun()
      } else if (S.mode === 'over') {
        if (S.overT > 0.5) startRun()
      } else if (S.mode === 'paused') {
        togglePause()
      } else if (S.mode === 'playing') {
        useBomb()
      }
    }

    function setKey(name, down) {
      if (name in S.keys) S.keys[name] = !!down
    }

    function pointerDown(x, y) {
      var p = S.p
      if (!p || p.dead) return
      S.drag = true
      S.offX = p.x - x
      S.offY = p.y - y
      S.lastX = x
      S.lastY = y
      p.tx = p.x
      p.ty = p.y
    }

    /* 增量式拖动：按手指的位移驱动目标点，触屏上乘一个增益 */
    function pointerMove(x, y) {
      if (!S.drag) return
      var p = S.p
      if (!p || p.dead) return
      p.tx = clamp(p.tx + (x - S.lastX) * DRAG_GAIN, 26, VW - 26)
      p.ty = clamp(p.ty + (y - S.lastY) * DRAG_GAIN, 108, VH - 84)
      S.lastX = x
      S.lastY = y
    }

    function pointerUp() { S.drag = false }

    return {
      step: step,
      render: render,
      action: action,
      togglePause: togglePause,
      mode: function () { return S.mode },
      setKey: setKey,
      pointerDown: pointerDown,
      pointerMove: pointerMove,
      pointerUp: pointerUp,
      restart: function () { startRun() },
      score: function () { return S.score },
      wave: function () { return S.wave },
      bombs: function () { return S.p ? S.p.bombs : 0 },
      err: function () { return S.err }
    }
  }

  /* ============================================================
   *  页面接线
   * ============================================================ */

  function boot() {
    var cv = document.getElementById('stage')
    var bl = document.getElementById('bloom')
    if (!cv) return

    var g = null
    try { g = cv.getContext('2d', { alpha: false }) } catch (e) { g = null }
    if (!g) {
      cv.insertAdjacentHTML('afterend', '<p style="color:#ffb0b0;padding:20px">当前浏览器不支持 Canvas 2D。</p>')
      return
    }

    var b = null
    if (bl) {
      try { b = bl.getContext('2d', { alpha: false }) } catch (e) { b = null }
    }

    var audio = createAudio()

    /* --- 最高分持久化 --- */
    var STORE_KEY = 'stellar-edge.best'
    function loadBest() {
      try {
        var v = window.localStorage.getItem(STORE_KEY)
        return v ? (parseInt(v, 10) || 0) : 0
      } catch (e) { return 0 }
    }
    function saveBest(v) {
      try { window.localStorage.setItem(STORE_KEY, String(v)) } catch (e) {}
    }

    var best = loadBest()
    var bestEl = document.getElementById('bestTop')
    function paintBest() { if (bestEl) bestEl.textContent = fmt(best) }
    paintBest()

    var btnPause = document.getElementById('btnPause')
    var btnSound = document.getElementById('btnSound')
    var btnRestart = document.getElementById('btnRestart')
    var btnBomb = document.getElementById('btnBomb')
    var bombNumEl = document.getElementById('bombNum')
    var fpsEl = document.getElementById('fps')
    var lastBombs = -1

    /* 浮动炸弹键的剩余数量同步（只在变化时写 DOM） */
    function syncBomb() {
      if (!btnBomb) return
      var n = game.bombs()
      if (n === lastBombs) return
      lastBombs = n
      if (bombNumEl) bombNumEl.textContent = String(n)
      btnBomb.classList.toggle('is-empty', n <= 0)
    }

    function paintMode(m) {
      if (btnPause) btnPause.textContent = m === 'paused' ? '继续' : '暂停'
      if (m === 'playing' || m === 'over') document.body.dataset.playing = '1'
      else delete document.body.dataset.playing
    }
    paintMode('title')

    /* 是否触摸设备：决定拖动增益、标题页文案、浮动炸弹键的语义 */
    var isCoarse = false
    try {
      isCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    } catch (e) { isCoarse = false }

    var buzzOn = true

    var game = createGame(g, b, {
      audio: audio,
      touch: function () { return isCoarse },
      buzz: function (pattern) {
        if (!buzzOn || !isCoarse) return
        try {
          if (navigator && navigator.vibrate) navigator.vibrate(pattern)
        } catch (e) {}
      },
      best: function () { return best },
      onOver: function (score) {
        if (score > best) { best = score; saveBest(best); paintBest() }
      },
      onMode: paintMode
    })

    /* --- 主循环：rAF 渲染 + 固定 60Hz 逻辑步长 --- */
    var acc = 0
    var last = 0
    var frames = 0
    var fpsAcc = 0

    function frame(now) {
      if (!last) last = now
      var dt = (now - last) / 1000
      last = now
      if (dt > 0.25) dt = 0.25   /* 切回标签页时不要一次补太多帧 */
      acc += dt

      var steps = 0
      while (acc >= DT && steps < 6) {
        game.step()
        acc -= DT
        steps++
      }
      if (steps >= 6) acc = 0

      game.render()
      syncBomb()

      frames++
      fpsAcc += dt
      if (fpsAcc >= 0.5 && fpsEl) {
        fpsEl.textContent = Math.round(frames / fpsAcc) + ' FPS'
        frames = 0
        fpsAcc = 0
      }
      window.requestAnimationFrame(frame)
    }
    window.requestAnimationFrame(frame)

    /* --- 键盘 --- */
    var MOVE_KEYS = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down' }

    window.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      var k = String(e.key || '').toLowerCase()
      var dir = MOVE_KEYS[k]
      if (dir) {
        game.setKey(dir, true)
        e.preventDefault()
        return
      }
      if (k === ' ' || k === 'spacebar') {
        if (!e.repeat) game.action()
        e.preventDefault()
      } else if (k === 'enter') {
        if (!e.repeat) game.action()
        e.preventDefault()
      } else if (k === 'p') {
        if (!e.repeat) game.togglePause()
      }
    })

    window.addEventListener('keyup', function (e) {
      var dir = MOVE_KEYS[String(e.key || '').toLowerCase()]
      if (dir) game.setKey(dir, false)
    })

    window.addEventListener('blur', function () {
      game.setKey('left', false)
      game.setKey('right', false)
      game.setKey('up', false)
      game.setKey('down', false)
    })

    /* 切到别的标签页 / 最小化时自动暂停 */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && game.mode() === 'playing') game.togglePause()
    })

    /* --- 指针 / 触屏 --- */
    function toLocal(e) {
      var r = cv.getBoundingClientRect()
      if (!r.width || !r.height) return null
      return {
        x: (e.clientX - r.left) / r.width * VW,
        y: (e.clientY - r.top) / r.height * VH
      }
    }

    cv.addEventListener('pointerdown', function (e) {
      audio.ensure()
      var m = game.mode()
      /* 注意：这里不 return。开局/重开/继续之后继续往下走，让同一根手指立刻
         就能拖飞机 —— 否则手机上点开游戏后必须抬手再按一次才动得了。 */
      if (m === 'title' || m === 'over') game.action()
      else if (m === 'paused') game.togglePause()
      if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId) } catch (x) {} }
      var pos = toLocal(e)
      if (pos) game.pointerDown(pos.x, pos.y)
    })

    cv.addEventListener('pointermove', function (e) {
      var pos = toLocal(e)
      if (pos) game.pointerMove(pos.x, pos.y)
    })

    cv.addEventListener('pointerup', function () { game.pointerUp() })
    cv.addEventListener('pointercancel', function () { game.pointerUp() })
    cv.addEventListener('contextmenu', function (e) { e.preventDefault() })

    /* --- 按钮 --- */
    if (btnPause) {
      btnPause.addEventListener('click', function () {
        game.togglePause()
        btnPause.blur()
      })
    }
    if (btnSound) {
      btnSound.addEventListener('click', function () {
        var on = !audio.isOn()
        audio.setOn(on)
        btnSound.textContent = on ? '声音' : '静音'
        btnSound.classList.toggle('is-off', !on)
        btnSound.blur()
      })
      if (!audio.supported) {
        btnSound.classList.add('is-off')
        btnSound.textContent = '静音'
        btnSound.title = '当前环境不支持 WebAudio'
      }
    }
    if (btnRestart) {
      btnRestart.addEventListener('click', function () {
        game.restart()
        btnRestart.blur()
      })
    }

    /* 浮动炸弹键：用 pointerdown 而非 click，手机上零延迟、跟手 */
    if (btnBomb) {
      btnBomb.addEventListener('pointerdown', function (e) {
        e.preventDefault()
        audio.ensure()
        game.action()   /* 标题页=开局，游戏中=放炸弹，与空格键语义一致 */
        syncBomb()
      })
      btnBomb.addEventListener('contextmenu', function (e) { e.preventDefault() })
      syncBomb()
    }

    /* 全屏：手机浏览器地址栏会吃掉一大截竖向空间 */
    var btnFull = document.getElementById('btnFull')
    if (btnFull) {
      var docEl = document.documentElement
      var reqFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen
      var exitFs = document.exitFullscreen || document.webkitExitFullscreen

      function fsElement() {
        return document.fullscreenElement || document.webkitFullscreenElement || null
      }
      function syncFsLabel() {
        btnFull.textContent = fsElement() ? '退出' : '全屏'
      }
      function toggleFs() {
        try {
          if (!fsElement()) {
            if (!reqFs) return
            var r = reqFs.call(docEl)
            if (r && r.catch) r.catch(function () {})
          } else if (exitFs) {
            var r2 = exitFs.call(document)
            if (r2 && r2.catch) r2.catch(function () {})
          }
        } catch (e) {}
      }

      if (!reqFs) {
        btnFull.classList.add('is-off')
        btnFull.title = '当前浏览器不支持全屏 API'
        btnFull.disabled = true
      } else {
        btnFull.addEventListener('click', function () {
          toggleFs()
          btnFull.blur()
        })
        document.addEventListener('fullscreenchange', syncFsLabel)
        document.addEventListener('webkitfullscreenchange', syncFsLabel)
        syncFsLabel()
      }
    }

    /* 双击页面不选中文字 */
    document.addEventListener('selectstart', function (e) {
      if (e.target === cv) e.preventDefault()
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
