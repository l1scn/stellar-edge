/*
 * 星刃 3D — 模拟层无头测试
 *
 * 3D 的渲染部分我无法在这里验证（没有 WebGL / 浏览器），
 * 但把模拟层做成不依赖 THREE 的纯模块之后，游戏逻辑就能像 2D 版一样被完整测到。
 *
 *   node smoke-test-3d.js
 */
'use strict'

const results = []
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra })
const say = s => process.stdout.write(s + '\n')

;(async () => {
  const { createSim, VW, VH, mkNeed } = await import('./3d/sim.js')

  const over = []
  const modes = []
  const buzzes = []
  const sim = createSim({
    onOver: (score, wave) => over.push({ score, wave }),
    onMode: m => modes.push(m),
    buzz: p => buzzes.push(p)
  })
  const S = sim.state
  const DT = 1 / 60

  const pump = n => { for (let i = 0; i < n; i++) sim.step(DT) }

  function keepAlive() {
    const p = S.p
    if (!p) return
    p.dead = false
    p.hp = p.maxHp
    p.invT = 5
    p.lives = 3
  }

  /* 每帧检查：不能出现 NaN / 越界坐标 */
  let badCoords = 0
  function auditCoords() {
    const lists = [S.bullets, S.ebullets, S.enemies, S.picks, S.parts]
    for (const list of lists) {
      for (const o of list) {
        if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) { badCoords++; return }
        if (o.x < -400 || o.x > VW + 400 || o.y < -400 || o.y > VH + 400) { badCoords++; return }
      }
    }
    const p = S.p
    if (p && (!Number.isFinite(p.x) || !Number.isFinite(p.y))) badCoords++
  }

  /* ---------- 1. 标题页 ---------- */
  pump(60)
  check('初始为标题页', S.mode === 'title', 'mode=' + S.mode)

  sim.action()
  pump(10)
  check('action() 进入 playing', S.mode === 'playing', 'mode=' + S.mode)

  /* ---------- 2. 会瞄准的试飞员跑 150 秒 ---------- */
  function aimPilot() {
    let target = null
    if (S.boss && !S.boss.entering) target = S.boss
    else {
      let bd = Infinity
      for (const e of S.enemies) {
        if (e.dead || e.kind === 'boss') continue
        const d = Math.abs(e.x - S.p.x) + (e.retreat ? 900 : 0)
        if (d < bd) { bd = d; target = e }
      }
    }
    sim.setKey('left', false); sim.setKey('right', false)
    if (!target) return
    const dx = target.x - S.p.x
    if (dx < -5) sim.setKey('left', true)
    else if (dx > 5) sim.setKey('right', true)
  }

  let lastWave = S.wave, lastWaveAt = 0, worstStall = 0
  for (let f = 0; f < 150 * 60; f++) {
    keepAlive()
    aimPilot()
    sim.step(DT)
    if (f % 7 === 0) auditCoords()
    if (S.wave !== lastWave) { lastWave = S.wave; lastWaveAt = f }
    else if (f - lastWaveAt > worstStall) worstStall = f - lastWaveAt
  }
  sim.setKey('left', false); sim.setKey('right', false)

  check('波次持续推进（无卡死）', S.wave >= 8 && worstStall < 60 * 60,
    'wave=' + S.wave + ' kills=' + S.kills + ' 最长无进展=' + (worstStall / 60).toFixed(1) + 's')
  check('分数在涨', S.score > 20000, 'score=' + S.score)
  check('强化 Mk 随击杀成长', S.mk >= 3, 'mk=' + S.mk + ' ×' + sim.dmgMul().toFixed(2))
  check('坐标全程有效（无 NaN / 越界）', badCoords === 0, '异常帧=' + badCoords)
  check('150 秒内未意外结束', S.mode === 'playing', 'mode=' + S.mode)

  /* ---------- 3. 四种武器都能造成伤害 ---------- */
  function clearField() {
    S.enemies.length = 0
    S.ebullets.length = 0
    S.bullets.length = 0
    S.picks.length = 0
    S.boss = null
    S.queue.length = 0
    S.waveDelay = 9999
  }
  function dummy(x, y, hp) {
    return {
      kind: 'drone', x, y, r: 15, h: 1.6, hp, maxHp: hp, score: 100,
      t: 0, fireT: 999, flash: 0, amp: 0, freq: 0, baseY: y, vx: 0, vy: 0,
      dead: false, ang: 0, pat: 0, patT: 0, step: 0, entering: false,
      drift: 0, tier: 1, chargeT: 0, charge: 0, firing: 0, retreat: false, linger: 0
    }
  }

  for (const w of ['plasma', 'laser', 'homing', 'scatter']) {
    clearField()
    S.mode = 'playing'
    keepAlive()
    S.p.weapon = w
    S.p.x = 300; S.p.y = 750; S.p.tx = 300; S.p.ty = 750
    const d = dummy(300, 430, 600)
    S.enemies.push(d)
    pump(600)
    keepAlive()
    const dealt = 600 - Math.max(0, d.hp)
    check('武器 ' + w + ' 能命中靶机', dealt >= 150,
      '造成 ' + Math.round(dealt) + '/600' + (d.hp <= 0 ? '（已击破）' : ''))
  }

  /* 霰弹正前方必须有弹丸：直接把机体摆在靶机正下方，贴脸打 */
  clearField()
  S.mode = 'playing'
  keepAlive()
  S.p.weapon = 'scatter'; S.p.power = 1
  S.p.x = 300; S.p.y = 750; S.p.tx = 300; S.p.ty = 750
  const near = dummy(300, 640, 400)   /* 正前方 110px */
  S.enemies.push(near)
  pump(120)
  check('霰弹贴脸正前方不会打空', near.hp < 400, '贴脸 2 秒造成 ' + Math.round(400 - Math.max(0, near.hp)) + ' 伤害')

  /* ---------- 4. 11 种道具 ---------- */
  clearField()
  keepAlive()
  for (const k of ['P', 'L', 'M', 'R', 'B', 'S', 'H', 'F', 'D', 'G', 'W']) {
    keepAlive()
    S.picks.push({ x: S.p.x, y: S.p.y, h: 0.7, vy: 0, t: 0, kind: k })
    pump(3)
  }
  check('11 种道具全部生效',
    S.p.rageT > 0 && S.p.doubleT > 0 && S.p.magnetT > 0 && S.p.wingT > 0 &&
    S.p.bombs >= 3 && S.p.shieldT > 0 && S.p.power >= 2 && S.p.weapon === 'scatter',
    '火力' + S.p.power + ' 武器' + S.p.weapon + ' 炸弹' + S.p.bombs + ' 护盾' + S.p.shieldT.toFixed(1))

  /* ---------- 5. BOSS 五套招式 + 狂暴 ---------- */
  clearField()
  S.mode = 'playing'
  S.wave = 4
  S.waveDelay = 0
  keepAlive()
  pump(200)
  check('第 5 波触发 BOSS', !!S.boss, S.boss ? 'hp=' + Math.round(S.boss.hp) : 'no boss')

  if (S.boss) {
    S.boss.maxHp = 1e9
    S.boss.hp = 1e9
    const seen = new Set()
    for (let i = 0; i < 70 && S.boss; i++) {
      keepAlive()
      seen.add(S.boss.pat)
      pump(40)
    }
    check('BOSS 五套招式都跑到', seen.size >= 5, 'patterns=' + [...seen].sort().join(','))
    if (S.boss) {
      S.boss.hp = S.boss.maxHp * 0.28
      keepAlive()
      pump(180)
      check('BOSS 狂暴分支可运行', S.mode === 'playing' && !!S.boss,
        '弹幕=' + S.ebullets.length)
    }
  }

  /* ---------- 6. 七种兵种都能跑 ---------- */
  for (const [kind, wave] of [['drone', 1], ['dart', 2], ['turret', 4], ['orb', 6], ['sniper', 6], ['spinner', 9], ['beamer', 11]]) {
    clearField()
    S.mode = 'playing'
    S.wave = wave
    keepAlive()
    S.picks.push({ x: S.p.x, y: S.p.y, h: 0.7, vy: 0, t: 0, kind: 'S' })
    const d = dummy(300, 150, 1e9)
    d.kind = kind
    d.linger = 0
    S.enemies.push(d)
    pump(360)
    check('兵种 ' + kind + ' 可运行', S.mode === 'playing' && S.enemies.length > 0,
      '弹幕=' + S.ebullets.length)
  }

  /* ---------- 7. 滞空到期撤退 ---------- */
  clearField()
  S.mode = 'playing'
  S.wave = 3
  keepAlive()
  S.p.x = 30; S.p.tx = 30; S.p.y = 750; S.p.ty = 750
  const stubborn = dummy(570, 100, 1e9)
  stubborn.linger = 22
  S.enemies.push(stubborn)
  let sawRetreat = false
  for (let f = 0; f < 60 * 32; f++) {
    keepAlive()
    sim.step(DT)
    if (S.enemies[0] && S.enemies[0].retreat) sawRetreat = true
    if (!S.enemies.length) break
  }
  check('打不死的悬停敌人会撤退离场', sawRetreat && S.enemies.length === 0,
    '进入撤退=' + sawRetreat + ' 剩余=' + S.enemies.length)

  /* ---------- 8. 炸弹 / 暂停 / 震动 ---------- */
  clearField()
  S.mode = 'playing'
  keepAlive()
  S.p.bombs = 3
  S.ebullets.push({ x: 300, y: 400, h: 1, vx: 0, vy: 0, c: '255,90,170', r: 6, life: 5 })
  const buzz0 = buzzes.length
  sim.action()
  pump(20)
  check('炸弹清屏并触发震动', S.p.bombs === 2 && S.ebullets.length === 0 && buzzes.length > buzz0,
    'bombs=' + S.p.bombs + ' 弹幕=' + S.ebullets.length + ' 震动+' + (buzzes.length - buzz0))

  sim.togglePause()
  check('暂停生效', S.mode === 'paused', 'mode=' + S.mode)
  const snapA = S.enemies.map(e => Math.round(e.x) + ',' + Math.round(e.y)).join('|') + '#' + S.ebullets.length + '#' + S.wave
  pump(120)
  const snapB = S.enemies.map(e => Math.round(e.x) + ',' + Math.round(e.y)).join('|') + '#' + S.ebullets.length + '#' + S.wave
  check('暂停时战场完全冻结', snapA === snapB, snapA === snapB ? '2 秒无变化' : 'A=' + snapA + ' B=' + snapB)
  sim.togglePause()
  check('恢复后继续跑', S.mode === 'playing', 'mode=' + S.mode)

  /* ---------- 9. 死亡 → 结算 → 重开 ---------- */
  S.mode = 'playing'
  keepAlive()
  S.p.lives = 1
  S.p.hp = 1
  S.p.invT = 0
  S.p.shieldT = 0
  S.ebullets.push({ x: S.p.x, y: S.p.y, h: 1, vx: 0, vy: 0, c: '255,90,170', r: 6, life: 5 })
  pump(300)
  check('能进入 GAME OVER', S.mode === 'over', 'mode=' + S.mode)
  check('结算回调拿到成绩', over.length > 0, 'onOver 调用 ' + over.length + ' 次')

  sim.action()
  pump(2)
  check('可重新开局', S.mode === 'playing', 'mode=' + S.mode)
  check('重开后进度归零', S.mk === 0 && S.score === 0 && S.wave <= 1,
    'mk=' + S.mk + ' score=' + S.score + ' wave=' + S.wave)

  /* ---------- 10. 模块依赖图完整性 ----------
     渲染层依赖 WebGL，无法在这里执行；至少确认整条 import 链都能解析到真实文件，
     避免出现「页面白屏、控制台一行 404」这种只能靠肉眼发现的问题。 */
  const fs = require('fs')
  const path = require('path')
  const ROOT = __dirname
  const specRe = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g
  const importsOf = src => {
    const out = []
    let m
    specRe.lastIndex = 0
    while ((m = specRe.exec(src)) !== null) out.push(m[1])
    return out
  }
  const resolveSpec = (fromFile, spec) => {
    if (spec === 'three') return path.join(ROOT, 'vendor', 'three.module.min.js')
    if (spec.startsWith('three/addons/')) return path.join(ROOT, 'vendor', 'addons', spec.slice('three/addons/'.length))
    if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
    return null
  }

  const seen = new Set()
  const queue = ['3d/main.js', '3d/render.js', '3d/sim.js'].map(f => path.join(ROOT, f))
  const missing = []
  while (queue.length) {
    const f = queue.shift()
    if (seen.has(f)) continue
    seen.add(f)
    if (!fs.existsSync(f)) { missing.push(path.relative(ROOT, f) + ' 不存在'); continue }
    for (const spec of importsOf(fs.readFileSync(f, 'utf8'))) {
      const r = resolveSpec(f, spec)
      if (!r) { missing.push(path.relative(ROOT, f) + ' -> 未解析的裸模块 "' + spec + '"'); continue }
      if (!fs.existsSync(r)) missing.push(path.relative(ROOT, f) + ' -> ' + spec + ' 不存在')
      else queue.push(r)
    }
  }
  check('3D 模块依赖图完整', missing.length === 0,
    missing.length ? missing.slice(0, 4).join(' ; ') : '解析了 ' + seen.size + ' 个模块')

  const html = fs.readFileSync(path.join(ROOT, '3d.html'), 'utf8')
  const mm = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  let mapOk = false, mapDetail = '未找到 importmap'
  if (mm) {
    try {
      const map = JSON.parse(mm[1]).imports
      const bad = Object.entries(map).filter(([, v]) => !fs.existsSync(path.join(ROOT, v)))
      mapOk = bad.length === 0
      mapDetail = mapOk ? Object.keys(map).join(' + ') + ' 均已就位' : bad.map(([k, v]) => k + ' -> ' + v).join(' ; ')
    } catch (e) { mapDetail = 'importmap 不是合法 JSON: ' + e.message }
  }
  check('3d.html 的 importmap 指向真实文件', mapOk, mapDetail)

  /* render.js 从 sim.js 具名导入的符号必须真的被导出（拼错名字只会表现为白屏） */
  const renderSrc = fs.readFileSync(path.join(ROOT, '3d', 'render.js'), 'utf8')
  const mSim = renderSrc.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/sim\.js'/)
  let namedOk = false
  let namedDetail = '未找到对 sim.js 的具名导入'
  if (mSim) {
    const names = mSim[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)
    const mod = await import('./3d/sim.js')
    const lack = names.filter(n => !(n in mod))
    namedOk = lack.length === 0
    namedDetail = namedOk ? names.length + ' 个符号均存在' : '缺失: ' + lack.join(', ')
  }
  check('render.js 从 sim.js 导入的符号都存在', namedOk, namedDetail)

  /* ---------- 汇总 ---------- */
  const bad = results.filter(r => !r.ok)
  say('')
  say('============ 3D 模拟层测试结果 ============')
  for (const r of results) say((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : ''))
  say('  模拟层内部报错: ' + (S.err ? S.err : '0'))
  say('  失败项: ' + bad.length + ' / ' + results.length)
  say('==========================================')
  process.exit(bad.length || S.err ? 1 : 0)
})().catch(e => {
  process.stderr.write('测试异常: ' + (e && e.stack ? e.stack : e) + '\n')
  process.exit(1)
})
