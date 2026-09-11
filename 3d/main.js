/*
 * 星刃 3D — 页面接线
 * 输入、音效、按钮、错误兜底。游戏逻辑在 sim.js，渲染在 render.js。
 */

import { boot } from './render.js'

const $ = id => document.getElementById(id)

/* ---------------- 音效（WebAudio 实时合成，失败静默降级） ---------------- */

function createAudio() {
  let Ctor = null
  try { Ctor = window.AudioContext || window.webkitAudioContext || null } catch (e) { Ctor = null }
  let ac = null
  let on = !!Ctor

  function ensure() {
    if (!on) return null
    try {
      if (!ac) ac = new Ctor()
      if (ac.state === 'suspended' && ac.resume) ac.resume()
      return ac
    } catch (e) { return null }
  }
  function tone(f0, f1, dur, type, vol) {
    const a = ensure(); if (!a) return
    try {
      const t0 = a.currentTime
      const o = a.createOscillator(), g = a.createGain()
      o.type = type
      o.frequency.setValueAtTime(f0, t0)
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(24, f1), t0 + dur)
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
      o.connect(g); g.connect(a.destination)
      o.start(t0); o.stop(t0 + dur + 0.03)
    } catch (e) {}
  }
  function noise(dur, vol, cutoff) {
    const a = ensure(); if (!a) return
    try {
      const n = Math.max(1, Math.floor(a.sampleRate * dur))
      const buf = a.createBuffer(1, n, a.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < n; i++) { const k = 1 - i / n; d[i] = (Math.random() * 2 - 1) * k * k }
      const src = a.createBufferSource(); src.buffer = buf
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.setValueAtTime(cutoff, a.currentTime)
      const g = a.createGain(); g.gain.value = vol
      src.connect(f); f.connect(g); g.connect(a.destination); src.start()
    } catch (e) {}
  }

  const SOUND = {
    shoot: () => tone(1180, 1720, 0.04, 'square', 0.010),
    hit: () => tone(360, 200, 0.05, 'sawtooth', 0.014),
    boom: () => { noise(0.2, 0.12, 1900) },
    bigBoom: () => { noise(0.55, 0.28, 900); tone(150, 44, 0.5, 'sawtooth', 0.07) },
    pick: () => tone(720, 1440, 0.14, 'triangle', 0.05),
    power: () => { tone(520, 1560, 0.22, 'triangle', 0.055); tone(780, 2340, 0.26, 'sine', 0.035) },
    bomb: () => { noise(0.85, 0.32, 760); tone(96, 32, 0.75, 'sawtooth', 0.075) },
    warn: () => tone(210, 210, 0.2, 'square', 0.03)
  }
  return {
    supported: !!Ctor,
    ensure,
    isOn: () => on,
    setOn(v) { on = !!v; if (on) ensure() },
    play(name) { const f = SOUND[name]; if (f) f() }
  }
}

/* ---------------- 启动 ---------------- */

function fatal(msg, detail) {
  /* 统一走 3d.html 里那个普通脚本的兜底入口：它知道启动是否已经成功，
     并在成功后自动撤掉提示，避免这里的失败被静默吞掉 */
  if (window.__stellar3d && window.__stellar3d.show) {
    window.__stellar3d.show(msg, detail)
    return
  }
  const el = $('fatal')
  if (!el) return
  el.style.display = 'flex'
  el.innerHTML = '<div class="fatal-box"><h2>3D 版启动失败</h2><p>' + msg + '</p>' +
    (detail ? '<pre>' + String(detail).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</pre>' : '') +
    '<p class="fatal-hint">2D 版仍然可用：<a href="./index.html">返回 2D 版</a></p></div>'
  document.body.style.overflow = 'auto'
  document.body.style.alignItems = 'flex-start'
}

function main() {
  const glCanvas = $('gl')
  const hudCanvas = $('hud')
  const stageEl = $('stageWrap')
  if (!glCanvas || !hudCanvas || !stageEl) { fatal('页面结构缺失'); return }

  const audio = createAudio()
  let isCoarse = false
  try { isCoarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches) } catch (e) {}

  let game = null
  try {
    game = boot({
      glCanvas, hudCanvas, stageEl,
      bestStore: 'stellar-edge.3d.best',
      haptics: isCoarse,
      sound: name => audio.play(name),
      onMode: m => {
        const btn = $('btnPause')
        if (btn) btn.textContent = m === 'paused' ? '继续' : '暂停'
      },
      onScore: (score, wave) => {
        const el = $('bestTop')
        if (el) el.textContent = String(score)
        const last = $('lastRun')
        if (last) last.textContent = '上次 第 ' + wave + ' 波'
      }
    })
  } catch (e) {
    fatal('WebGL 初始化失败，可能是浏览器不支持或显卡被禁用。', e && e.message ? e.message : e)
    return
  }

  /* 启动成功：撤掉 3d.html 里那道兜底提示 */
  if (window.__stellar3d && window.__stellar3d.done) window.__stellar3d.done()

  const sim = game.sim
  const S = sim.state

  /* ---- 键盘 ---- */
  const MOVE = { arrowleft: 'left', a: 'left', arrowright: 'right', d: 'right', arrowup: 'up', w: 'up', arrowdown: 'down', s: 'down' }
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const k = String(e.key || '').toLowerCase()
    const dir = MOVE[k]
    if (dir) { sim.setKey(dir, true); e.preventDefault(); return }
    if (k === ' ' || k === 'spacebar' || k === 'enter') {
      if (!e.repeat) { audio.ensure(); sim.action() }
      e.preventDefault()
    } else if (k === 'p') {
      if (!e.repeat) sim.togglePause()
    }
  })
  window.addEventListener('keyup', e => {
    const dir = MOVE[String(e.key || '').toLowerCase()]
    if (dir) sim.setKey(dir, false)
  })
  window.addEventListener('blur', () => {
    for (const d of ['left', 'right', 'up', 'down']) sim.setKey(d, false)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && sim.mode() === 'playing') sim.togglePause()
  })

  /* ---- 指针（绑在 WebGL 画布上，HUD 与浮动按钮不会误触） ---- */
  function toLocal(e) {
    const r = glCanvas.getBoundingClientRect()
    if (!r.width || !r.height) return null
    return { x: (e.clientX - r.left) / r.width * 600, y: (e.clientY - r.top) / r.height * 900 }
  }
  glCanvas.addEventListener('pointerdown', e => {
    audio.ensure()
    const m = sim.mode()
    if (m === 'title' || m === 'over') sim.action()
    else if (m === 'paused') sim.togglePause()
    try { glCanvas.setPointerCapture(e.pointerId) } catch (x) {}
    const pos = toLocal(e)
    if (pos) sim.pointerDown(pos.x, pos.y)
  })
  glCanvas.addEventListener('pointermove', e => {
    const pos = toLocal(e)
    if (pos) sim.pointerMove(pos.x, pos.y)
  })
  const up = () => sim.pointerUp()
  glCanvas.addEventListener('pointerup', up)
  glCanvas.addEventListener('pointercancel', up)
  glCanvas.addEventListener('contextmenu', e => e.preventDefault())

  /* ---- 按钮 ---- */
  function wire(id, fn, alsoBlur) {
    const el = $(id)
    if (!el) return null
    el.addEventListener('click', () => { fn(el); if (alsoBlur !== false) el.blur() })
    return el
  }

  const bombBtn = $('btnBomb')
  if (bombBtn) {
    bombBtn.addEventListener('pointerdown', e => {
      e.preventDefault()
      audio.ensure()
      sim.action()
    })
    bombBtn.addEventListener('contextmenu', e => e.preventDefault())
  }

  wire('btnPause', () => sim.togglePause())
  wire('btnRestart', () => sim.restart())

  const soundBtn = $('btnSound')
  if (soundBtn) {
    if (!audio.supported) { soundBtn.classList.add('is-off'); soundBtn.textContent = '静音'; soundBtn.disabled = true }
    else wire('btnSound', el => {
      const on = !audio.isOn()
      audio.setOn(on)
      el.textContent = on ? '声音' : '静音'
      el.classList.toggle('is-off', !on)
    })
  }

  const fullBtn = $('btnFull')
  if (fullBtn) {
    const docEl = document.documentElement
    const reqFs = docEl.requestFullscreen || docEl.webkitRequestFullscreen
    const exitFs = document.exitFullscreen || document.webkitExitFullscreen
    const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement || null
    if (!reqFs) {
      fullBtn.classList.add('is-off')
      fullBtn.disabled = true
      fullBtn.title = '当前浏览器不支持全屏 API'
    } else {
      const sync = () => { fullBtn.textContent = fsEl() ? '退出' : '全屏' }
      wire('btnFull', () => {
        try {
          if (!fsEl()) { const p = reqFs.call(docEl); if (p && p.catch) p.catch(() => {}) }
          else if (exitFs) { const p = exitFs.call(document); if (p && p.catch) p.catch(() => {}) }
        } catch (e) {}
        setTimeout(() => { game.resize(); sync() }, 260)
      })
      document.addEventListener('fullscreenchange', () => { sync(); setTimeout(() => game.resize(), 120) })
      document.addEventListener('webkitfullscreenchange', () => { sync(); setTimeout(() => game.resize(), 120) })
      sync()
    }
  }

  /* ---- FPS / 后处理状态 ---- */
  const fpsEl = $('fps')
  if (fpsEl) {
    setInterval(() => {
      fpsEl.textContent = Math.round(game.fps()) + ' FPS · 相机高 ' + Math.round(game.cameraY())
    }, 700)
  }

  /* ---- 最高分回填 ---- */
  try {
    const b = window.localStorage.getItem('stellar-edge.3d.best')
    const el = $('bestTop')
    if (el) el.textContent = b || '0'
  } catch (e) {}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main)
else main()
