/*
 * 星刃 STELLAR EDGE — P0 缺陷回归断言
 *
 * 运行：node smoke-test-p0.mjs        （仓库根目录，Node ≥ 18，无需依赖）
 *
 * 覆盖 4 条曾经真实存在、且 2D / 3D 两份实现同时中招的缺陷：
 *   1. 撞机伤害按逻辑帧结算（不乘 dt），每秒刷出上千伤害，远超任何武器
 *   2. 无敌帧内撞机仍然输出伤害 → 复活后的 2.6 秒可以零代价撞死 BOSS
 *   3. BOSS 分数被结算两次（通用击杀路径 + BOSS 专属路径）
 *   4. 炸弹对 BOSS 结算两次；以及 BOSS 入场动画期间就参与机身碰撞
 *
 * 脚本驱动 3D 的逻辑层 3d/sim.js（可无头 import）；2D 版 game.js 是同一套逻辑，
 * 对应的行为断言在 smoke-test.js 的既有覆盖之外，这里用同样的判定口径。
 * 修复前本脚本会全部失败（实测 1796 伤害 / 12120 分 / 520 伤害）。
 */

import { createSim } from './3d/sim.js'

const results = []
const check = (name, cond, extra) => results.push({ name, ok: !!cond, extra })

/* ---------- 通用：推进到第 5 波 BOSS 入场完毕 ---------- */
function toBoss() {
  const sim = createSim({})
  sim.startRun()
  const S = sim.state
  S.wave = 4; S.queue.length = 0; S.enemies.length = 0; S.boss = null; S.waveDelay = 0.001
  for (let i = 0; i < 2400 && !S.boss; i++) sim.step()
  for (let i = 0; i < 2400 && S.boss && S.boss.entering; i++) sim.step()
  return { sim, S, boss: S.boss }
}

/* ---------- 1 / 2. 撞机：伤害有限速，且无敌帧内不输出伤害 ---------- */
{
  const { sim, S, boss } = toBoss()
  const hp0 = boss.hp
  const pHp0 = S.p.hp
  S.bullets.length = 0                          // 清掉入场前在途的子弹，只留撞机
  for (let i = 0; i < 60; i++) {
    const p = S.p
    p.cd = 1e9                                  // 停止开火
    p.x = boss.x; p.y = boss.y
    p.tx = boss.x; p.ty = boss.y
    S.bullets.length = 0
    sim.step()
  }
  const ram = Math.round(hp0 - boss.hp)
  const taken = Math.round(pHp0 - S.p.hp)
  // 0.5 秒一次的接触结算：1 秒最多 4 次 × 40 × dmgMul（修复前是每帧一次，约 60 次）
  const cap = Math.round(40 * sim.dmgMul() * 4)
  check('撞机伤害有冷却（1 秒最多 4 次接触结算）', ram > 0 && ram <= cap,
    `1 秒贴住 BOSS 掉血 ${ram}（上限 ${cap}，修复前 1796）`)
  check('撞机对玩家同样结算（不是单向白嫖）', taken > 0,
    `玩家掉血 ${taken}`)
}

{
  const { sim, S, boss } = toBoss()
  const hp0 = boss.hp
  for (let i = 0; i < 60; i++) {
    const p = S.p
    p.cd = 1e9
    p.x = boss.x; p.y = boss.y
    p.tx = boss.x; p.ty = boss.y
    p.invT = 5                                   // 持续无敌（模拟复活保护期）
    S.bullets.length = 0                         // 排除在途子弹的武器伤害
    sim.step()
  }
  check('无敌帧内撞机不输出伤害（复活后不能白撞）', Math.round(hp0 - boss.hp) === 0,
    `无敌 1 秒贴住 BOSS 掉血 ${Math.round(hp0 - boss.hp)}（修复前 1796）`)
}

/* ---------- 3. BOSS 分数只结算一次 ---------- */
{
  const { sim, S, boss } = toBoss()
  const before = S.score
  const panel = boss.score
  const comboAtKill = S.combo + 1
  boss.hp = 1
  for (let i = 0; i < 6000 && S.boss; i++) {
    S.enemies = S.enemies.filter((e) => e.kind === 'boss')   // 排除小怪分数干扰
    if (S.p) { S.p.hp = 1e9; S.p.invT = 5 }
    sim.step()
  }
  const delta = S.score - before
  const expect = Math.floor(panel * (1 + Math.min(60, comboAtKill) * 0.02))
  check('BOSS 分数按连击结算一次', delta === expect,
    `面板 ${panel} → 入账 ${delta}，应为 ${expect}（修复前 12120）`)
}

/* ---------- 4a. 炸弹对 BOSS 只结算一次 ---------- */
{
  const { sim, S, boss } = toBoss()
  const hp0 = boss.hp
  S.p.bombs = 5
  sim.action()                                   // playing 状态下 = 放炸弹
  const real = Math.round(hp0 - boss.hp)
  const expect = 320                             // BOSS 专属伤害
  check('炸弹对 BOSS 只打一次（320，不是 320+155+45×power）', real === expect,
    `实际掉血 ${real}（修复前 520）`)
}

/* ---------- 4b. BOSS 入场动画期间不参与机身碰撞 ---------- */
{
  const sim = createSim({})
  sim.startRun()
  const S = sim.state
  S.wave = 4; S.queue.length = 0; S.enemies.length = 0; S.boss = null; S.waveDelay = 0.001
  for (let i = 0; i < 2400 && !S.boss; i++) sim.step()
  const b = S.boss
  const hp0 = b.hp
  let frames = 0
  let playerTaken = 0
  let bossLost = 0
  /* 注意：BOSS 走完入场动画的那一帧，stepBoss 已把 entering 置 false，
     之后的碰撞判定已属正常战斗，所以那一帧的伤害不计入「入场期间」。 */
  while (b.entering && frames < 1200) {
    S.bullets.length = 0
    S.p.x = b.x; S.p.y = b.y; S.p.tx = b.x; S.p.ty = b.y; S.p.invT = 0
    const hp = S.p.hp
    const bhp = b.hp
    sim.step()
    frames++
    if (!b.entering) break
    playerTaken += Math.max(0, hp - S.p.hp)
    bossLost += Math.max(0, bhp - b.hp)
    S.p.hp = 100
  }
  check('入场动画期间既不能撞 BOSS 也不被 BOSS 撞', bossLost === 0 && playerTaken === 0,
    `贴身 ${frames} 帧：BOSS 掉血 ${Math.round(bossLost)}，玩家掉血 ${playerTaken}`)
}

/* ---------- 汇总 ---------- */
const bad = results.filter((r) => !r.ok)
console.log('')
console.log('============ P0 回归断言 ============')
for (const r of results) console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : ''))
console.log('  失败项: ' + bad.length + ' / ' + results.length)
console.log('=====================================')
process.exit(bad.length ? 1 : 0)
