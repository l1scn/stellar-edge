/*
 * 星刃 3D — 渲染层
 *
 * 只做两件事：把模拟层的 (x, y) 映射到 3D 世界空间，以及画 HUD。
 * 判定全部在模拟层，这里不改游戏状态。
 *
 * 相机自动取景：初始化与每次 resize 时，把 600×900 的战场四角投影到 NDC，
 * 逐步抬高相机直到四角全部可见 —— 这样不同宽高比、不同机型都不用我肉眼调参。
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createSim, VW, VH, fmt, BUFF_ROWS, WEAPON_NAME, PICK_COL, mkNeed } from './sim.js'

const SCALE = 1 / 24                  /* 600×900 游戏单位 → 世界单位 */
const FOV = 52
const CAM_TILT = 62 * Math.PI / 180   /* 俯角：越大越接近正俯视 */
const BASE_Y = 0.9                    /* 实体离地基准高度 */

const ENEMY_COLOR = {
  drone: 0xff5ea8, dart: 0xffb040, turret: 0x9fb6d6, orb: 0xb06cff,
  sniper: 0xff3c50, spinner: 0xa25cff, beamer: 0xd080ff, boss: 0xff3d7f
}
const ENEMY_GEO = {
  drone: () => new THREE.OctahedronGeometry(0.78, 0),
  dart: () => new THREE.ConeGeometry(0.42, 1.5, 4),
  turret: () => new THREE.CylinderGeometry(0.85, 1.05, 0.8, 6),
  orb: () => new THREE.IcosahedronGeometry(1.0, 1),
  sniper: () => new THREE.TetrahedronGeometry(0.95, 0),
  spinner: () => new THREE.TorusGeometry(1.0, 0.22, 8, 6),
  beamer: () => new THREE.BoxGeometry(1.7, 1.0, 1.7),
  boss: () => new THREE.IcosahedronGeometry(2.6, 1)
}
/* 各几何体的标称半径：用来把机身缩放成与判定半径一致，
   否则「几何体本来就大」×「按 r 再放大一次」会让 BOSS 占满整个屏幕 */
const GEO_R = {
  drone: 0.78, dart: 0.42, turret: 1.0, orb: 1.0,
  sniper: 0.95, spinner: 1.22, beamer: 0.85, boss: 2.6
}

const col = s => new THREE.Color('rgb(' + s + ')')
const toWorldX = sx => (sx - VW / 2) * SCALE
const toWorldZ = sy => (sy - VH) * SCALE
const toWorldY = h => BASE_Y + (h || 0)

/* ---------------- 程序化贴图（不引入任何图片资源） ---------------- */

function glowTexture() {
  const s = 128
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(255,255,255,1)')
  grd.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  grd.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function gridTexture() {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  g.clearRect(0, 0, s, s)
  g.strokeStyle = 'rgba(110,200,255,0.55)'
  g.lineWidth = 2
  g.strokeRect(1, 1, s - 2, s - 2)
  g.strokeStyle = 'rgba(110,200,255,0.16)'
  g.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const p = i * s / 4
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, s); g.stroke()
    g.beginPath(); g.moveTo(0, p); g.lineTo(s, p); g.stroke()
  }
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

function nebulaTexture(rgb) {
  const s = 256
  const c = document.createElement('canvas')
  c.width = c.height = s
  const g = c.getContext('2d')
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2)
  grd.addColorStop(0, 'rgba(' + rgb + ',0.55)')
  grd.addColorStop(0.45, 'rgba(' + rgb + ',0.16)')
  grd.addColorStop(1, 'rgba(' + rgb + ',0)')
  g.fillStyle = grd
  g.fillRect(0, 0, s, s)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/* ---------------- 星刃机体（沿用 2D 版的机身轮廓，挤出成 3D） ---------------- */

const SHIP_OUTLINE = [
  [0, -31], [6, -10], [21, 8], [9, 6], [6, 17],
  [0, 13], [-6, 17], [-9, 6], [-21, 8], [-6, -10]
]

function shipGeometry() {
  const shape = new THREE.Shape()
  SHIP_OUTLINE.forEach(([x, y], i) => {
    const px = x * SCALE, py = -y * SCALE      /* 轮廓的 +y 是机头，映射到 -z */
    if (i === 0) shape.moveTo(px, py); else shape.lineTo(px, py)
  })
  shape.closePath()
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: false })
  geo.rotateX(-Math.PI / 2)                     /* 轮廓平面 → 水平面 */
  geo.computeVertexNormals()
  return geo
}

/* ---------------- 主流程 ---------------- */

export function boot(opts) {
  const glCanvas = opts.glCanvas
  const hudCanvas = opts.hudCanvas
  const stageEl = opts.stageEl
  const onMode = opts.onMode || (() => {})
  const bestStore = opts.bestStore

  /* ---- WebGL ---- */
  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, powerPreference: 'high-performance' })
  } catch (e) {
    throw new Error('无法创建 WebGL 上下文：' + (e && e.message ? e.message : e))
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.05
  renderer.outputColorSpace = THREE.SRGBColorSpace

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x03040c)
  scene.fog = new THREE.FogExp2(0x03040c, 0.016)

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 400)

  /* ---- 灯光 ---- */
  scene.add(new THREE.AmbientLight(0x557799, 1.1))
  const key = new THREE.DirectionalLight(0xbfe8ff, 2.2)
  key.position.set(6, 22, 14)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0xff4d8f, 1.5)
  rim.position.set(-10, 8, -22)
  scene.add(rim)
  const below = new THREE.PointLight(0x3aa0ff, 60, 60)
  below.position.set(0, 2, -8)
  scene.add(below)

  /* ---- 地面网格（无限滚动：移动网格并取模） ---- */
  const gridTex = gridTexture()
  gridTex.repeat.set(14, 22)
  const gridMat = new THREE.MeshBasicMaterial({
    map: gridTex, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(80, 130), gridMat)
  grid.rotation.x = -Math.PI / 2
  grid.position.set(0, 0, -30)
  scene.add(grid)
  const CELL = 80 / 14

  /* ---- 星云背景板 ---- */
  const nebs = []
  const nebDefs = [
    ['60,130,255', -14, 16, -70, 70],
    ['180,60,255', 16, 20, -95, 84],
    ['0,200,255', 0, 12, -120, 96]
  ]
  for (const [rgb, x, y, z, size] of nebDefs) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({
        map: nebulaTexture(rgb), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false
      })
    )
    m.position.set(x, y, z)
    m.renderOrder = -10
    scene.add(m)
    nebs.push({ mesh: m, base: { x, y, z } })
  }

  /* ---- 玩家 ---- */
  const player = new THREE.Group()
  const shipMat = new THREE.MeshStandardMaterial({
    color: 0x8fdcff, emissive: 0x1d6fa8, emissiveIntensity: 1.6,
    metalness: 0.75, roughness: 0.28
  })
  const ship = new THREE.Mesh(shipGeometry(), shipMat)
  player.add(ship)
  const engineMat = new THREE.MeshBasicMaterial({
    color: 0x8ff0ff, transparent: true, opacity: 0.75,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
  const engine = new THREE.Mesh(new THREE.ConeGeometry(0.28, 1.5, 8), engineMat)
  engine.position.set(0, 0.16, 0.75)
  engine.rotation.x = Math.PI / 2
  player.add(engine)
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x7ce6ff, transparent: true, opacity: 0.28, wireframe: true,
    blending: THREE.AdditiveBlending, depthWrite: false
  })
  const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), shieldMat)
  shield.visible = false
  player.add(shield)
  scene.add(player)

  /* ---- 僚机 ---- */
  const wings = []
  for (let i = 0; i < 2; i++) {
    const w = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.9, 6),
      new THREE.MeshStandardMaterial({ color: 0xa9ffd8, emissive: 0x1f8f66, emissiveIntensity: 1.8, metalness: 0.6, roughness: 0.35 })
    )
    w.rotation.x = -Math.PI / 2
    w.visible = false
    scene.add(w)
    wings.push(w)
  }

  /* ---- 对象池 ---- */
  const glowTex = glowTexture()

  function makePool(n, factory) {
    const items = []
    for (let i = 0; i < n; i++) {
      const o = factory()
      o.visible = false
      scene.add(o)
      items.push(o)
    }
    return { items, i: 0, begin() { this.i = 0 } , take() { const o = this.items[this.i++]; return o } }
  }

  const bulletPool = makePool(260, () => new THREE.Mesh(
    new THREE.CapsuleGeometry(0.16, 0.62, 4, 8),
    new THREE.MeshBasicMaterial({ color: 0x9ff4ff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
  ))
  const pelletPool = makePool(220, () => new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff8fb0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
  ))
  const missilePool = makePool(40, () => {
    const g = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffd08a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
    )
    body.rotation.x = -Math.PI / 2
    g.add(body)
    return g
  })
  const ebulletPool = makePool(480, () => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
    )
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.8 }))
    halo.scale.set(1.9, 1.9, 1)
    m.add(halo)
    return m
  })
  const enemyPool = {}
  for (const k of Object.keys(ENEMY_GEO)) {
    enemyPool[k] = makePool(k === 'boss' ? 2 : 40, () => {
      const g = new THREE.Group()
      const mat = new THREE.MeshStandardMaterial({
        color: ENEMY_COLOR[k], emissive: ENEMY_COLOR[k], emissiveIntensity: 1.1,
        metalness: 0.7, roughness: 0.3
      })
      const m = new THREE.Mesh(ENEMY_GEO[k](), mat)
      g.add(m)
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: ENEMY_COLOR[k], blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.5 }))
      halo.scale.set(3.4, 3.4, 1)
      g.add(halo)
      g.userData.mat = mat
      g.userData.core = m
      g.userData.halo = halo
      return g
    })
  }
  const pickPool = makePool(18, () => {
    const g = new THREE.Group()
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.52, 0),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 2.0, metalness: 0.3, roughness: 0.2 })
    )
    g.add(core)
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.85 }))
    halo.scale.set(2.6, 2.6, 1)
    g.add(halo)
    g.userData.mat = core.material
    return g
  })
  const ringPool = makePool(24, () => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
    )
    m.rotation.x = -Math.PI / 2
    return m
  })

  /* ---- 激光塔光束（轴向沿 Z：模拟层里它就是一条「屏幕纵向」的列） ---- */
  const beamGeo = new THREE.CylinderGeometry(0.55, 0.55, 1, 12, 1, true)
  beamGeo.rotateX(Math.PI / 2)
  const beamCoreGeo = new THREE.CylinderGeometry(0.16, 0.16, 1, 8, 1, true)
  beamCoreGeo.rotateX(Math.PI / 2)
  const beams = []
  for (let i = 0; i < 2; i++) {
    const g = new THREE.Group()
    g.add(new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color: 0xff5aa0, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false
    })))
    g.add(new THREE.Mesh(beamCoreGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.95,
      side: THREE.DoubleSide, depthWrite: false
    })))
    g.visible = false
    scene.add(g)
    beams.push(g)
  }

  /* ---- 玩家激光（同样沿 Z） ---- */
  const laserGroup = new THREE.Group()
  const laserBody = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: 0x8ff0ff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.45,
    side: THREE.DoubleSide, depthWrite: false
  }))
  const laserCore = new THREE.Mesh(beamCoreGeo, new THREE.MeshBasicMaterial({
    color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, opacity: 0.9,
    side: THREE.DoubleSide, depthWrite: false
  }))
  laserGroup.add(laserBody, laserCore)
  laserGroup.visible = false
  scene.add(laserGroup)

  /* ---- 粒子（单个 Points，自定义着色器给每点独立尺寸与颜色） ---- */
  const P_MAX = 700
  const pGeo = new THREE.BufferGeometry()
  const pPos = new Float32Array(P_MAX * 3)
  const pCol = new Float32Array(P_MAX * 3)
  const pSize = new Float32Array(P_MAX)
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
  pGeo.setAttribute('aColor', new THREE.BufferAttribute(pCol, 3))
  pGeo.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1))
  const pMat = new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 900 } },
    vertexShader: `
      attribute float aSize;
      attribute vec3 aColor;
      varying vec3 vColor;
      uniform float uScale;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uScale / max(1.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  })
  const points = new THREE.Points(pGeo, pMat)
  points.frustumCulled = false
  scene.add(points)

  /* ---- 星空 ---- */
  const STAR_N = 900
  const sPos = new Float32Array(STAR_N * 3)
  const sCol = new Float32Array(STAR_N * 3)
  const sSize = new Float32Array(STAR_N)
  const starTint = [[0.6, 0.75, 1], [0.85, 0.93, 1], [1, 1, 1], [0.75, 0.9, 1]]
  for (let i = 0; i < STAR_N; i++) {
    sPos[i * 3] = (Math.random() - 0.5) * 90
    sPos[i * 3 + 1] = Math.random() * 26 - 2
    sPos[i * 3 + 2] = -Math.random() * 190 + 10
    const t = starTint[(Math.random() * starTint.length) | 0]
    const b = 0.35 + Math.random() * 0.65
    sCol[i * 3] = t[0] * b; sCol[i * 3 + 1] = t[1] * b; sCol[i * 3 + 2] = t[2] * b
    sSize[i] = 0.9 + Math.random() * 2.2
  }
  const starGeo = new THREE.BufferGeometry()
  starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3))
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3))
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1))
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uPR: { value: 1 } },
    vertexShader: `
      attribute float aSize;
      attribute vec3 aColor;
      varying vec3 vColor;
      uniform float uPR;
      void main() {
        vColor = aColor;
        gl_PointSize = aSize * uPR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false
  })
  const stars = new THREE.Points(starGeo, starMat)
  stars.frustumCulled = false
  scene.add(stars)

  /* ---- 后处理 ---- */
  let composer = null
  let bloomPass = null
  let usePost = true
  try {
    composer = new EffectComposer(renderer)
    composer.addPass(new RenderPass(scene, camera))
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.28)
    composer.addPass(bloomPass)
    composer.addPass(new OutputPass())
  } catch (e) {
    composer = null
    usePost = false
    console.warn('[星刃3D] 后处理不可用，退化为直出渲染:', e)
  }

  /* ---------------- 相机自动取景 ---------------- */

  const CORNERS = [
    new THREE.Vector3(toWorldX(0), 0, toWorldZ(0)),
    new THREE.Vector3(toWorldX(VW), 0, toWorldZ(0)),
    new THREE.Vector3(toWorldX(0), 0, toWorldZ(VH)),
    new THREE.Vector3(toWorldX(VW), 0, toWorldZ(VH))
  ]
  const lookZ = toWorldZ(VH * 0.42)
  const tmp = new THREE.Vector3()

  function applyCamera(camY) {
    const camZ = lookZ + camY / Math.tan(CAM_TILT)
    camera.position.set(0, camY, camZ)
    camera.lookAt(0, 0, lookZ)
    camera.updateMatrixWorld(true)
    camera.updateProjectionMatrix()
  }

  /* 抬高相机直到战场四角都在画面内（留 8% 边距） */
  function fitCamera() {
    let camY = 26
    let lastScale = 1
    for (let iter = 0; iter < 60; iter++) {
      applyCamera(camY)
      lastScale = 1
      for (const c of CORNERS) {
        tmp.copy(c).project(camera)
        lastScale = Math.max(lastScale, Math.abs(tmp.x), Math.abs(tmp.y))
      }
      if (lastScale <= 0.92) break
      camY *= 1.06
    }
    applyCamera(camY)
    return camY
  }

  /* ---------------- 尺寸 ---------------- */

  let camY = 30
  function resize() {
    const rect = stageEl.getBoundingClientRect()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    renderer.setSize(w, h, false)
    if (composer) composer.setSize(w, h)
    camera.aspect = w / h
    camY = fitCamera()
    /* 粒子的 gl_PointSize 是帧缓冲像素：按透视投影换算，uScale 就取缓冲高度 */
    const buf = renderer.getContext().drawingBufferHeight || Math.round(h * renderer.getPixelRatio())
    pMat.uniforms.uScale.value = buf
    starMat.uniforms.uPR.value = renderer.getPixelRatio()
  }
  window.addEventListener('resize', resize)
  window.addEventListener('orientationchange', () => setTimeout(resize, 120))

  /* ---------------- HUD ---------------- */

  const hud = hudCanvas.getContext('2d')
  const FONT = '"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif'

  function syncHudSize() {
    if (hudCanvas.width !== VW || hudCanvas.height !== VH) {
      hudCanvas.width = VW
      hudCanvas.height = VH
    }
  }

  function drawHud(S, best) {
    syncHudSize()
    hud.setTransform(1, 0, 0, 1, 0, 0)
    hud.clearRect(0, 0, VW, VH)
    const p = S.p
    const tierCol = S.mk >= 15 ? '255,150,200' : S.mk >= 10 ? '255,190,120' : S.mk >= 5 ? '255,225,150' : '170,235,255'
    const mul = 1 + S.mk * 0.11

    const txt = (t, x, y, size, c, weight, align, glow) => {
      hud.font = (weight || 600) + ' ' + size + 'px ' + FONT
      hud.textAlign = align || 'left'
      hud.textBaseline = 'alphabetic'
      if (glow) { hud.shadowColor = glow; hud.shadowBlur = size * 0.45 }
      hud.fillStyle = c
      hud.fillText(t, x, y)
      hud.shadowBlur = 0
    }

    /* 顶栏 */
    const top = hud.createLinearGradient(0, 0, 0, 92)
    top.addColorStop(0, 'rgba(6,12,28,0.82)')
    top.addColorStop(1, 'rgba(6,12,28,0)')
    hud.fillStyle = top
    hud.fillRect(0, 0, VW, 92)

    txt('分数 SCORE', 22, 26, 13, 'rgba(140,220,255,.72)')
    txt(fmt(S.score), 22, 60, 33, '#eafcff', 700, 'left', 'rgba(80,220,255,.85)')
    txt('波次 WAVE', VW - 22, 26, 13, 'rgba(255,170,210,.75)', 600, 'right')
    txt(String(S.wave), VW - 22, 56, 30, '#ffe9f4', 700, 'right', 'rgba(255,110,180,.8)')
    if (S.combo > 1) txt('连击 ×' + S.combo, VW - 22, 80, 15, 'rgba(255,225,150,.95)', 700, 'right')

    txt('强化 Mk.' + S.mk + '  ×' + mul.toFixed(2), VW / 2, 30, 13.5, 'rgba(' + tierCol + ',.98)', 700, 'center', 'rgba(' + tierCol + ',.8)')
    const ewx = VW / 2 - 84
    hud.fillStyle = 'rgba(10,20,40,.78)'
    hud.fillRect(ewx, 40, 168, 6)
    hud.fillStyle = 'rgba(' + tierCol + ',.85)'
    hud.fillRect(ewx + 1, 41, 166 * Math.min(1, S.energy / mkNeed(S.mk)), 4)
    hud.strokeStyle = 'rgba(' + tierCol + ',.35)'
    hud.lineWidth = 1
    hud.strokeRect(ewx + 0.5, 40.5, 167, 5)

    if (p) {
      txt('机体', 22, 82, 12, 'rgba(160,230,255,.62)')
      for (let i = 0; i < Math.max(0, p.lives); i++) {
        const lx = 56 + i * 17
        hud.fillStyle = 'rgba(140,240,255,.95)'
        hud.beginPath()
        hud.moveTo(lx, 74); hud.lineTo(lx + 6, 84); hud.lineTo(lx, 82); hud.lineTo(lx - 6, 84)
        hud.closePath(); hud.fill()
      }
      const bx = 56 + Math.max(0, p.lives) * 17 + 10
      if (bx < 300) {
        hud.fillStyle = 'rgba(255,170,190,.85)'
        hud.fillRect(bx, 74, p.hp >= p.maxHp ? 92 : 92 * (p.hp / p.maxHp), 7)
        hud.strokeStyle = 'rgba(180,235,255,.3)'
        hud.strokeRect(bx + 0.5, 74.5, 92, 7)
      }
    }

    /* BOSS 血条 */
    if (S.boss && !S.boss.entering) {
      const b = S.boss, bw = VW - 260
      txt('旗舰 · VANGUARD', VW / 2, 116, 13, 'rgba(255,170,205,.9)', 700, 'center')
      hud.fillStyle = 'rgba(10,4,14,.7)'
      hud.fillRect(130, 124, bw, 10)
      const grd = hud.createLinearGradient(130, 0, 130 + bw, 0)
      grd.addColorStop(0, '#ff3d7f'); grd.addColorStop(0.55, '#ff8ac0'); grd.addColorStop(1, '#ffd0e8')
      hud.fillStyle = grd
      hud.fillRect(130, 124, bw * Math.max(0, Math.min(1, b.hp / b.maxHp)), 10)
      hud.strokeStyle = 'rgba(255,170,210,.55)'
      hud.strokeRect(130.5, 124.5, bw - 1, 9)
    }

    /* 底栏 */
    const bot = hud.createLinearGradient(0, VH - 74, 0, VH)
    bot.addColorStop(0, 'rgba(6,12,28,0)')
    bot.addColorStop(1, 'rgba(6,12,28,0.86)')
    hud.fillStyle = bot
    hud.fillRect(0, VH - 74, VW, 74)

    hud.textBaseline = 'middle'
    const r1 = VH - 52
    txt('火力', 22, r1, 12, 'rgba(140,220,255,.7)')
    for (let k = 0; k < 5; k++) {
      hud.fillStyle = (p && k < p.power) ? 'rgba(140,240,255,.95)' : 'rgba(120,180,220,.2)'
      hud.fillRect(58 + k * 16, r1 - 7, 11, 14)
    }
    if (p) {
      const wcol = p.weapon === 'laser' ? '140,240,255' : p.weapon === 'homing' ? '255,180,90' : p.weapon === 'scatter' ? '255,120,150' : '200,230,255'
      const wname = WEAPON_NAME[p.weapon] + ' Lv' + p.power
      hud.font = '700 12px ' + FONT
      const ww = hud.measureText(wname).width + 18
      hud.fillStyle = 'rgba(' + wcol + ',.16)'
      hud.fillRect(152, r1 - 11, ww, 22)
      hud.strokeStyle = 'rgba(' + wcol + ',.7)'
      hud.lineWidth = 1
      hud.strokeRect(152.5, r1 - 10.5, ww - 1, 21)
      txt(wname, 161, r1 + 1, 12, 'rgba(' + wcol + ',.98)', 700)

      txt('炸弹', VW - 92, r1, 12, 'rgba(255,200,140,.8)', 600, 'right')
      for (let m = 0; m < 4; m++) {
        const qx = VW - 76 + m * 17
        const on = m < p.bombs
        hud.beginPath()
        hud.arc(qx, r1, 5.6, 0, Math.PI * 2)
        hud.fillStyle = on ? 'rgba(255,205,120,.95)' : 'rgba(140,150,180,.2)'
        hud.fill()
        if (on) {
          hud.strokeStyle = 'rgba(255,240,190,.8)'
          hud.lineWidth = 1.2
          hud.beginPath(); hud.arc(qx, r1, 9, 0, Math.PI * 2); hud.stroke()
        }
      }

      const r2 = VH - 22
      let cx = 22
      for (const br of BUFF_ROWS) {
        const left = p[br.key]
        if (left <= 0) continue
        const label = br.name + ' ' + left.toFixed(1) + 's'
        hud.font = '700 11.5px ' + FONT
        const lw = hud.measureText(label).width + 16
        hud.fillStyle = 'rgba(' + br.col + ',.15)'
        hud.fillRect(cx, r2 - 11, lw, 22)
        hud.strokeStyle = 'rgba(' + br.col + ',.6)'
        hud.lineWidth = 1
        hud.strokeRect(cx + 0.5, r2 - 10.5, lw - 1, 21)
        hud.fillStyle = 'rgba(' + br.col + ',.95)'
        hud.fillRect(cx + 1, r2 + 8, (lw - 2) * Math.min(1, left / br.total), 2.5)
        txt(label, cx + 8, r2 - 1, 11.5, 'rgba(' + br.col + ',1)', 700)
        cx += lw + 6
      }
      txt('总伤害加成 ×' + mul.toFixed(2), VW - 22, r2, 12, 'rgba(' + tierCol + ',.85)', 700, 'right')
    }

    /* 波次横幅 */
    if (S.bannerT > 0) {
      let a = Math.min(1, S.bannerT / 0.5)
      if (S.bannerT > 1.6) a = Math.min(1, (2.1 - S.bannerT) / 0.5)
      const big = S.wave % 5 === 0 && S.wave > 0
      hud.globalAlpha = a
      txt(S.banner, VW / 2, VH * 0.34, big ? 46 : 34, big ? '#ffd7e4' : '#e7fbff', big ? 800 : 700, 'center',
        big ? 'rgba(255,60,110,.95)' : 'rgba(80,210,255,.9)')
      txt(S.bannerSub, VW / 2, VH * 0.34 + 34, 15, big ? 'rgba(255,150,185,.92)' : 'rgba(160,225,255,.85)', 600, 'center')
      hud.globalAlpha = 1
    }

    /* 强化升级提示 */
    if (S.mkFlash > 0) {
      hud.globalAlpha = Math.min(1, S.mkFlash)
      txt('火力强化  Mk.' + S.mk, VW / 2, 72, 21, 'rgba(' + tierCol + ',1)', 800, 'center', 'rgba(' + tierCol + ',.9)')
      hud.globalAlpha = 1
    }

    /* 标题 / 暂停 / 结算 */
    if (S.mode === 'title') {
      hud.fillStyle = 'rgba(3,6,16,.55)'
      hud.fillRect(0, 0, VW, VH)
      const pulse = 0.62 + Math.sin(S.t * 2.4) * 0.38
      txt('星  刃', VW / 2, 250, 78, '#f2fdff', 800, 'center', 'rgba(90,215,255,.95)')
      txt('3 D   E D I T I O N', VW / 2, 296, 15, 'rgba(160,230,255,.9)', 600, 'center', 'rgba(80,200,255,.8)')
      hud.strokeStyle = 'rgba(120,220,255,.4)'
      hud.lineWidth = 1
      hud.beginPath(); hud.moveTo(120, 322); hud.lineTo(VW - 120, 322); hud.stroke()
      txt('霓虹纵向弹幕射击 · 真 3D 渲染', 342, 15, 'rgba(190,220,240,.75)', 500, 'center')
      hud.globalAlpha = pulse
      txt('点击画面开始', VW / 2, 452, 20, '#aef0ff', 700, 'center', 'rgba(90,215,255,.9)')
      hud.globalAlpha = 1
      txt('拖动画面移动      右下角按钮放炸弹      底栏暂停 / 全屏', VW / 2, 494, 13, 'rgba(170,205,230,.72)', 500, 'center')
      txt('武器模组  L 激光 · M 追踪 · R 霰弹 · P 火力', VW / 2, 526, 12.5, 'rgba(200,235,255,.8)', 600, 'center')
      txt('限时增幅  F 狂怒 · D 双倍 · G 磁力 · W 僚机 · H 生命', VW / 2, 550, 12.5, 'rgba(200,235,255,.8)', 600, 'center')
      txt('击落敌机积累能量 → 自动强化火力（Mk 每级 +11% 伤害）', VW / 2, 582, 12.5, 'rgba(255,232,150,.9)', 600, 'center')
      txt('最高分  ' + fmt(best), VW / 2, 622, 15, 'rgba(255,225,160,.9)', 600, 'center')
    } else if (S.mode === 'paused') {
      hud.fillStyle = 'rgba(3,6,16,.62)'
      hud.fillRect(0, 0, VW, VH)
      txt('已  暂  停', VW / 2, VH / 2 - 20, 44, '#eafcff', 800, 'center', 'rgba(90,215,255,.9)')
      txt('按 P 继续', VW / 2, VH / 2 + 40, 16, 'rgba(180,225,255,.85)', 500, 'center')
    } else if (S.mode === 'over') {
      const a = Math.min(1, S.overT / 0.8)
      hud.fillStyle = 'rgba(3,6,16,' + (0.7 * a) + ')'
      hud.fillRect(0, 0, VW, VH)
      hud.globalAlpha = a
      txt('GAME OVER', VW / 2, VH / 2 - 116, 46, '#ffd9e6', 800, 'center', 'rgba(255,70,130,.9)')
      txt('任 务 失 败', VW / 2, VH / 2 - 62, 22, 'rgba(255,180,205,.9)', 600, 'center')
      txt('得分', VW / 2, VH / 2 - 6, 15, 'rgba(190,225,245,.8)', 600, 'center')
      txt(fmt(S.score), VW / 2, VH / 2 + 44, 42, '#eafcff', 800, 'center', 'rgba(80,220,255,.85)')
      txt('最高分  ' + fmt(Math.max(best, S.score)), VW / 2, VH / 2 + 78, 14, 'rgba(255,225,160,.92)', 600, 'center')
      txt('第 ' + S.wave + ' 波  ·  强化 Mk.' + S.mk + '  ·  击落 ' + S.kills + '  ·  最高连击 ×' + S.bestCombo,
        VW / 2, VH / 2 + 110, 13.5, 'rgba(175,215,240,.78)', 500, 'center')
      hud.globalAlpha = a * (0.6 + Math.sin(S.t * 3) * 0.4)
      txt('点击画面 · 按空格 再来一局', VW / 2, VH / 2 + 176, 17, '#aef0ff', 700, 'center')
      hud.globalAlpha = 1
    }

    if (S.err) txt('模拟层异常: ' + S.err, VW / 2, VH - 88, 11, 'rgba(255,150,150,.9)', 600, 'center')
  }

  /* ---------------- 3D 同步 ---------------- */

  let best = 0
  try { best = parseInt(window.localStorage.getItem(bestStore) || '0', 10) || 0 } catch (e) { best = 0 }

  const sim = createSim({
    dragGain: 1.35,
    buzz: p => { try { if (opts.haptics && navigator.vibrate) navigator.vibrate(p) } catch (e) {} },
    sound: name => { if (opts.sound) opts.sound(name) },
    onOver: (score, wave) => {
      if (score > best) {
        best = score
        try { window.localStorage.setItem(bestStore, String(score)) } catch (e) {}
      }
      if (opts.onScore) opts.onScore(score, wave)
    },
    onMode: onMode
  })
  const S = sim.state

  function syncScene(dt) {
    /* 玩家 */
    const p = S.p
    player.visible = !!(p && !p.dead && (S.mode === 'playing' || S.mode === 'paused'))
    if (p) {
      player.position.set(toWorldX(p.x), toWorldY(0), toWorldZ(p.y))
      player.rotation.set(0, -p.roll * 0.7, -p.roll * 0.55)
      const flick = p.invT > 0 && Math.floor(S.t * 22) % 2 === 0
      ship.visible = !flick
      engine.visible = !flick
      engine.scale.set(1, 0.8 + Math.sin(S.t * 34) * 0.25, 1)
      shield.visible = p.shieldT > 0
      if (shield.visible) {
        shield.rotation.set(S.t * 1.4, S.t * 1.7, 0)
        shieldMat.opacity = p.shieldT < 2.5 ? 0.12 + 0.3 * Math.abs(Math.sin(S.t * 12)) : 0.26
      }
      shipMat.emissive.setHex(p.rageT > 0 ? 0xb0541a : 0x1d6fa8)
      engineMat.color.setHex(p.rageT > 0 ? 0xffb070 : 0x8ff0ff)

      for (let i = 0; i < 2; i++) {
        const w = wings[i]
        const on = p.wingT > 0 && !p.dead
        w.visible = on
        if (on) {
          w.position.set(toWorldX(p.wings[i].x), toWorldY(0.2), toWorldZ(p.wings[i].y))
          w.rotation.z = Math.sin(S.t * 3 + i) * 0.2
        }
      }
    }

    /* 玩家激光：几何体长度 1、轴向沿 Z，所以 scale.z 就是长度、scale.x/y 是半径 */
    const laserOn = p && !p.dead && p.weapon === 'laser' && (S.mode === 'playing' || S.mode === 'paused')
    laserGroup.visible = !!laserOn
    if (laserOn) {
      const hw = (7 + p.power * 2.4) * SCALE
      const zNear = toWorldZ(p.y)
      const zFar = toWorldZ(-120)
      laserGroup.position.set(toWorldX(p.x), toWorldY(0.6), (zNear + zFar) / 2)
      laserGroup.scale.set(hw / 0.55, hw / 0.55, Math.abs(zFar - zNear))
      laserBody.material.color.setHex(p.rageT > 0 ? 0xffb070 : 0x8ff0ff)
    }

    /* 子弹 */
    bulletPool.begin(); pelletPool.begin(); missilePool.begin()
    for (const b of S.bullets) {
      const kind = b.kind || 'bolt'
      const pool = kind === 'missile' ? missilePool : kind === 'pellet' ? pelletPool : bulletPool
      const o = pool.take()
      if (!o) continue
      o.visible = true
      o.position.set(toWorldX(b.x), toWorldY(b.h), toWorldZ(b.y))
      if (kind === 'missile') o.rotation.y = -b.ang + Math.PI / 2
      else if (kind === 'pellet') o.rotation.set(0, 0, 0)
      else o.rotation.set(0, 0, 0)
    }
    for (const pool of [bulletPool, pelletPool, missilePool]) {
      for (let i = pool.i; i < pool.items.length; i++) pool.items[i].visible = false
    }

    /* 敌弹 */
    ebulletPool.begin()
    for (const b of S.ebullets) {
      const o = ebulletPool.take()
      if (!o) continue
      o.visible = true
      o.position.set(toWorldX(b.x), toWorldY(b.h), toWorldZ(b.y))
      const c = col(b.c || '255,90,170')
      o.material.color.copy(c)
      o.children[0].material.color.copy(c)
    }
    for (let i = ebulletPool.i; i < ebulletPool.items.length; i++) ebulletPool.items[i].visible = false

    /* 敌机 */
    for (const k of Object.keys(enemyPool)) enemyPool[k].begin()
    for (const e of S.enemies) {
      if (e.dead) continue
      const pool = enemyPool[e.kind] || enemyPool.drone
      const g = pool.take()
      if (!g) continue
      g.visible = true
      g.position.set(toWorldX(e.x), toWorldY(e.h), toWorldZ(e.y))
      g.scale.setScalar((e.r * SCALE) / (GEO_R[e.kind] || 1))
      const core = g.userData.core
      const mat = g.userData.mat
      if (e.kind === 'spinner') core.rotation.set(Math.PI / 2, e.t * 2.4, 0)
      else if (e.kind === 'drone') core.rotation.set(e.t * 1.1, e.t * 1.6, 0)
      else if (e.kind === 'orb') core.rotation.set(e.t * 0.7, e.t * 1.1, 0)
      else if (e.kind === 'boss') core.rotation.set(e.t * 0.4, e.t * 0.55, 0)
      else if (e.kind === 'dart') core.rotation.set(Math.PI / 2, 0, 0)   /* 锥尖朝 +Z，即朝向玩家 */
      else core.rotation.set(0, Math.sin(e.t * 0.8) * 0.4, 0)
      const flash = Math.min(1, e.flash)
      mat.emissiveIntensity = 1.0 + flash * 3.5
      const haloSize = e.r * SCALE * (e.kind === 'boss' ? 3.2 : 2.6)
      g.userData.halo.material.opacity = 0.4 + flash * 0.5
      g.userData.halo.scale.set(haloSize, haloSize, 1)
    }
    for (const k of Object.keys(enemyPool)) {
      const pool = enemyPool[k]
      for (let i = pool.i; i < pool.items.length; i++) pool.items[i].visible = false
    }

    /* 道具 */
    pickPool.begin()
    for (const pk of S.picks) {
      const o = pickPool.take()
      if (!o) continue
      o.visible = true
      o.position.set(toWorldX(pk.x), toWorldY(pk.h), toWorldZ(pk.y))
      o.rotation.y = pk.t * 1.6
      const c = col(PICK_COL[pk.kind] || '255,255,255')
      o.userData.mat.color.copy(c)
      o.userData.mat.emissive.copy(c)
      o.children[1].material.color.copy(c)
    }
    for (let i = pickPool.i; i < pickPool.items.length; i++) pickPool.items[i].visible = false

    /* 冲击环 */
    ringPool.begin()
    for (const r of S.rings) {
      const o = ringPool.take()
      if (!o) continue
      o.visible = true
      const a = Math.max(0, Math.min(1, r.life / r.maxLife))
      o.position.set(toWorldX(r.x), toWorldY(r.h) + 0.06, toWorldZ(r.y))
      o.scale.setScalar(Math.max(0.02, r.r * SCALE))
      o.material.color.copy(col(r.c))
      o.material.opacity = a * 0.7
    }
    for (let i = ringPool.i; i < ringPool.items.length; i++) ringPool.items[i].visible = false

    /* 激光塔光束：从机体沿 Z 一直打到战场近端 */
    for (let i = 0; i < beams.length; i++) beams[i].visible = false
    let bi = 0
    for (const e of S.enemies) {
      if (e.kind !== 'beamer' || (e.charge <= 0 && e.firing <= 0)) continue
      if (bi >= beams.length) break
      const g = beams[bi++]
      const z = toWorldZ(e.y)
      const zEnd = toWorldZ(VH)
      g.visible = true
      g.position.set(toWorldX(e.x), toWorldY(e.h), (z + zEnd) / 2)
      const rw = e.firing > 0 ? 1 : 0.2 + 0.8 * e.charge
      g.scale.set(rw, rw, Math.abs(zEnd - z))
      const m0 = g.children[0].material
      const m1 = g.children[1].material
      if (e.firing > 0) { m0.opacity = 0.55; m1.opacity = 0.95 }
      else { m0.opacity = 0.08 + 0.3 * e.charge; m1.opacity = 0.05 + 0.35 * e.charge }
    }

    /* 粒子 */
    const parts = S.parts
    const n = Math.min(parts.length, P_MAX)
    for (let i = 0; i < n; i++) {
      const q = parts[i]
      pPos[i * 3] = toWorldX(q.x)
      pPos[i * 3 + 1] = toWorldY(q.h)
      pPos[i * 3 + 2] = toWorldZ(q.y)
      const a = Math.max(0, Math.min(1, q.life / q.max))
      const c = q._c || (q._c = col(q.c))
      pCol[i * 3] = c.r * a
      pCol[i * 3 + 1] = c.g * a
      pCol[i * 3 + 2] = c.b * a
      pSize[i] = q.r * SCALE * (q.kind === 'spark' ? 3.2 : 2.4) * (0.4 + a * 0.6)
    }
    pGeo.setDrawRange(0, n)
    pGeo.attributes.position.needsUpdate = true
    pGeo.attributes.aColor.needsUpdate = true
    pGeo.attributes.aSize.needsUpdate = true

    /* 星空与网格滚动 */
    const sp = starGeo.attributes.position.array
    const flow = 26 * dt
    for (let i = 0; i < STAR_N; i++) {
      sp[i * 3 + 2] += flow
      if (sp[i * 3 + 2] > 14) {
        sp[i * 3 + 2] = -190
        sp[i * 3] = (Math.random() - 0.5) * 90
      }
    }
    starGeo.attributes.position.needsUpdate = true

    gridTex.offset.y -= (flow / 130) * 22
    if (gridTex.offset.y < -1) gridTex.offset.y += 1

    for (let i = 0; i < nebs.length; i++) {
      const nb = nebs[i]
      nb.mesh.position.x = nb.base.x + Math.sin(S.t * 0.06 + i) * 5
      nb.mesh.position.y = nb.base.y + Math.cos(S.t * 0.05 + i) * 3
    }

    /* 命中闪光照到场景（用一点环境光强度的抖动代替） */
    below.intensity = 50 + S.flash * 260
  }

  /* ---------------- 主循环 ---------------- */

  const acc = { v: 0, last: 0 }
  const DT = 1 / 60
  let frames = 0, fpsAcc = 0, fps = 60

  function frame(now) {
    if (!acc.last) acc.last = now
    let dt = (now - acc.last) / 1000
    acc.last = now
    if (dt > 0.25) dt = 0.25
    acc.v += dt

    let steps = 0
    while (acc.v >= DT && steps < 6) { sim.step(DT); acc.v -= DT; steps++ }
    if (steps >= 6) acc.v = 0

    syncScene(dt)

    if (usePost && composer) composer.render()
    else renderer.render(scene, camera)

    drawHud(S, best)

    frames++
    fpsAcc += dt
    if (fpsAcc >= 0.5) { fps = frames / fpsAcc; frames = 0; fpsAcc = 0 }
    window.requestAnimationFrame(frame)
  }

  resize()
  window.requestAnimationFrame(frame)

  return { sim, camera, scene, renderer, resize, fps: () => fps, cameraY: () => camY }
}
