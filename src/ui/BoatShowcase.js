import * as THREE from 'three';
import { createGLTFLoader } from '../game/gltfLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { getBoat } from '../data/boats.js';
import { measureModelBox } from '../game/modelBounds.js';
import { getBoatWeapon, BOAT_WEAPONS } from '../data/boatWeapons.js';
import { loadEffectTexture } from '../game/effectTextures.js';
import { Effects } from '../game/Effects.js';
import { NITRO_JETS, nitroAttackFx } from '../game/nitroFx.js';
import { makePaintMaterial } from '../data/paintTint.js';

// 展示台只加载逐船氮气用到的几段素材，其余几十段 FX 不碰
const NITRO_FX_NAMES = [...new Set(
  Object.values(NITRO_JETS).flatMap((c) => (c.core ? [c.fx, c.core.fx] : [c.fx])),
)];

// 展示台加载的 Effekseer 素材：竞速氮气 + 怪物模式各船主炮的炮口特效。
// 命中 BOSS 的受击特效（fxHit / fxImpact）不在展示台播放，见 #demoImpact。
const DEMO_FX_NAMES = [...new Set([
  ...NITRO_FX_NAMES,
  ...Object.values(BOAT_WEAPONS).map((w) => w.fxMuzzle).filter(Boolean),
])];

// 怪物模式主炮演示用的特效贴图（与 BoatWeapons 同一套现成素材）
const FX_TEX = {
  flame: '/effects/Basic/Texture/Flame01.png',
  spark: '/effects/Basic/Texture/Particle01.png',
  splash: '/effects/Basic/Texture/Splash01.png',
  laser: '/effects/Basic/Texture/LaserMain01.png',
  wind: '/effects/Basic/Texture/Wind01.png',
};

// 主炮演示的循环间隔（秒）
const DEMO_CYCLE = 2.0;

// 氮气演出：点火时把展台转到船尾 3/4，让船尾专属尾焰露出来，收火后转回正面
const NITRO_SHOW_YAW = Math.PI * 0.62;
const NITRO_SHOW_RATE = 2.2; // rad/s

const modelCache = new Map();
/** 共享模型缓存：选艇台、大厅展示台和缩略图共用同一份 GLB，避免重复下载解析 */
export function loadModel(url) {
  if (!modelCache.has(url)) {
    const loader = createGLTFLoader();
    modelCache.set(url, new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject)));
  }
  return modelCache.get(url);
}

// 展示台上统一船长（世界单位）
// 归一化目标长度：合并屏里展示台变宽变矮，3.5 太小（船只占屏面 1/3），提到 4.4
const TARGET_LEN = 5.8;
// 角色型赛艇（牛来号）在展示台上的目标身高倍率：1.0 = 按 fitHeight 原尺寸上镜。
// 角色是竖长的，用船长归一化会变成巨兽；但比赛里的 fitHeight 是为了"看得见"而放大的
// （4.2m），照搬到展示台会顶穿顶棚，所以这里按 0.55 压回 ~2.3m。
const SHOWCASE_CHAR_HEIGHT = 0.55;

function easeOutBack(k) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
}

/**
 * 选艇界面的 3D 展示台：水面 + 魔法阵光环 + 环绕粒子 + 扩散涟漪，
 * 赛艇带待机动画（摆头、波浪浮动、横摇纵摇），切换时弹跳入场。
 * 风格参考 RPG 角色选择界面的角色展示台。
 */
export class BoatShowcase {
  constructor(container, boatId) {
    this.container = container;
    this.running = true;
    this.boatId = null;
    this.model = null;
    this.spawnT = -1e9;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
    this.camera.position.set(4.6, 2.5, 6.4);
    this.camera.lookAt(0, 0.8, 0);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);

    this.bossMode = false;
    this.demoWeapon = null;
    this.demoFx = [];
    this.demoT = 0;
    // 船体涂装（选艇抽屉里的色点驱动）：hex 为空 = 原色
    this.paintHex = '';
    this.paintKey = '';
    this.paintedMeshes = [];
    // 当前飞行体特效的 attached key（换船 / 命中 / 清理时要停掉）
    this.demoShotKey = null;
    this.demoShotSeq = 0;
    this.lastT = 0;
    this.texCache = {};
    this.texLoader = new THREE.TextureLoader();

    // holder：缓慢摆头；tilt：波浪浮动/横摇/纵摇
    this.holder = new THREE.Group();
    this.scene.add(this.holder);
    this.tilt = new THREE.Group();
    this.holder.add(this.tilt);
    // 炮口锚点：挂在船头前方，演示时用它的世界坐标/朝向来发射
    this.bowAnchor = new THREE.Object3D();
    this.bowAnchor.position.set(0, 0.6, TARGET_LEN * 0.42);
    this.tilt.add(this.bowAnchor);

    // 氮气喷口：左 / 中 / 右三个，和 Boat.js 的 nitroNozzles 同一套布局，
    // 换船时按新模型包围盒重新定位（见 #swapModel）
    this.nitroNozzles = [0, 1, 2].map(() => {
      const node = new THREE.Object3D();
      this.tilt.add(node);
      return node;
    });
    this.nitroNozzleV = new THREE.Vector3();

    // 氮气展示：直接复用游戏里逐船差异化的 NITRO_JETS（Effekseer 素材），
    // 非怪物模式下每隔几秒点火一次；怪物模式保持原样不播
    this.nitroOn = false;
    this.nitroT = 1.8;
    this.nitroK = 0;
    this.nitroYaw = 0;
    this.fx = new Effects();
    this.fx.init(this.renderer, DEMO_FX_NAMES);

    this.#buildStage();
    this.#bindPointer();
    this.#resize();
    this.resizeObserver = new ResizeObserver(() => this.#resize());
    this.resizeObserver.observe(container);
    this.#animate();
    this.setBoat(boatId);
  }

  // ---------- 鼠标拖动转身 / 俯仰 ----------
  // 拖动：水平=左右转身（可整圈），垂直=机位升降看俯仰；松手 3 秒后平滑回到自动摆头。
  // manual 是 0~1 的混合系数，切换时自动/手动两套姿态按它插值，不会跳变。
  #bindPointer() {
    const el = this.renderer.domElement;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';
    this.dragging = false;
    this.userYaw = 0;
    this.userCamY = 2.5;
    this.manual = 0;
    this.idleAt = -1e9;
    this._px = 0;
    this._py = 0;

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.dragging = true;
      this._px = e.clientX;
      this._py = e.clientY;
      this.idleAt = -1e9;
      try { el.setPointerCapture(e.pointerId); } catch { /* 合成事件 / 指针已失效 */ }
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this._px;
      const dy = e.clientY - this._py;
      this._px = e.clientX;
      this._py = e.clientY;
      this.userYaw += dx * 0.012;
      // 垂直拖动改机位高度：贴水面 ~1.5 到俯瞰 ~4.6
      this.userCamY = Math.min(4.6, Math.max(1.5, this.userCamY - dy * 0.014));
    });
    const endDrag = (e) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.idleAt = performance.now();
      try { el.releasePointerCapture(e.pointerId); } catch { /* 已释放 */ }
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
  }

  /** 当前船只的氮气配置（与比赛内共用同一张 NITRO_JETS 表） */
  #nitroCfg() {
    return NITRO_JETS[this.boatId] || null;
  }

  /** 按 cfg.points 在选中喷口上开尾焰，参数与 Game.#updateNitroFx 完全一致 */
  #syncNitroJets() {
    const cfg = this.#nitroCfg();
    if (!cfg) return;
    for (let i = 0; i < 3; i++) {
      const key = `show:${i}`;
      const coreKey = `${key}:core`;
      // center = 只中间 / sides = 只左右 / triple = 左中右全开（与比赛内同一套口径）
      const on = cfg.points === 'triple'
        ? true
        : (cfg.points === 'center' ? i === 1 : i !== 1);
      if (!on) {
        this.fx.stopAttached(key);
        this.fx.stopAttached(coreKey);
        continue;
      }
      const anchor = this.nitroNozzles[i];
      const follow = () => anchor.getWorldPosition(this.nitroNozzleV);
      // 与比赛一致：素材默认朝 +Z，绕 X 转 90° 后沿船尾方向喷出
      const rot = () => ({ x: Math.PI / 2, y: this.holder.rotation.y + Math.PI, z: 0 });
      if (!this.fx.attached.has(key)) {
        this.fx.playAttached(key, cfg.fx, follow, {
          rot, loop: true, scale: cfg.scale, color: cfg.color,
          loopEvery: cfg.loopEvery, pool: cfg.pool, trail: cfg.trail === true,
        });
      }
      if (!cfg.core) {
        this.fx.stopAttached(coreKey);
      } else if (!this.fx.attached.has(coreKey)) {
        this.fx.playAttached(coreKey, cfg.core.fx, follow, {
          rot, loop: true, scale: cfg.core.scale, color: cfg.core.color,
          loopEvery: cfg.core.loopEvery || cfg.loopEvery,
          pool: cfg.core.pool || cfg.pool, trail: cfg.trail === true,
        });
      }
    }
  }

  #stopNitroJets() {
    for (let i = 0; i < 3; i++) {
      this.fx.stopAttached(`show:${i}`);
      this.fx.stopAttached(`show:${i}:core`);
    }
  }

  /** 氮气计时：点火 → 持续 → 收火；bossMode 下永不点火，怪物模式表现不变 */
  #updateNitro(dt) {
    if (this.bossMode) {
      if (this.nitroOn) {
        this.nitroOn = false;
        this.nitroK = 0;
        this.#stopNitroJets();
      }
      return;
    }
    if (!this.nitroOn) {
      this.nitroT -= dt;
      if (this.nitroT > 0) return;
      this.nitroOn = true;
      this.nitroT = 0;
    }
    this.nitroT += dt;
    const DUR = 2.4; // 与比赛内 boostDuration 对齐，留出转向船尾的时间
    if (this.nitroT >= DUR) {
      this.nitroOn = false;
      this.nitroK = 0;
      this.#stopNitroJets();
      this.nitroT = 3.2 + Math.random() * 2.6; // 下一次点火间隔
      return;
    }
    // 包络只用来驱动镜头前冲；尾焰本身是素材自己播的
    const rise = Math.min(1, this.nitroT / 0.14);
    const fall = Math.min(1, (DUR - this.nitroT) / 0.42);
    this.nitroK = Math.max(0, Math.min(rise, fall));
    // 素材是异步加载的：点火期间每帧确认一次，加载完就自动补上
    this.#syncNitroJets();
  }

  #buildStage() {
    this.scene.add(new THREE.HemisphereLight(0xbde9ff, 0x04263f, 2.4));
    const key = new THREE.DirectionalLight(0xfff1cf, 2.6);
    key.position.set(-5, 9, 6); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x59d8ff, 2.4);
    rim.position.set(4, 2, -6); this.scene.add(rim);

    // 水面：径向渐变圆盘，边缘淡出
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(256, 256, 40, 256, 256, 256);
    grad.addColorStop(0, 'rgba(96, 192, 226, 0.95)');
    grad.addColorStop(0.55, 'rgba(38, 128, 176, 0.85)');
    grad.addColorStop(1, 'rgba(16, 74, 116, 0)');
    g.fillStyle = grad; g.fillRect(0, 0, 512, 512);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const water = new THREE.Mesh(
      new THREE.CircleGeometry(7.5, 64),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = -0.02;
    water.renderOrder = 0;
    this.scene.add(water);
    this.waterTex = tex;

    // 中心光座
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 48),
      new THREE.MeshBasicMaterial({ color: 0x5fd0ff, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.01;
    pad.renderOrder = 1;
    this.scene.add(pad);

    // 魔法阵双环：环向条纹纹理沿 u 轴滚动，形成旋转流光
    this.rings = [];
    [2.15, 2.78].forEach((r, i) => {
      const stripe = document.createElement('canvas'); stripe.width = 512; stripe.height = 16;
      const sg = stripe.getContext('2d');
      for (let x = 0; x < 512; x += 26) {
        const lg = sg.createLinearGradient(x, 8, x + 16, 8);
        lg.addColorStop(0, 'rgba(140,235,255,0)');
        lg.addColorStop(0.5, 'rgba(170,242,255,1)');
        lg.addColorStop(1, 'rgba(140,235,255,0)');
        sg.fillStyle = lg; sg.fillRect(x, 4, 16, 8);
      }
      const stripeTex = new THREE.CanvasTexture(stripe);
      stripeTex.wrapS = THREE.RepeatWrapping;
      stripeTex.repeat.set(6 - i * 2, 1);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r, 0.024 + i * 0.014, 8, 120),
        new THREE.MeshBasicMaterial({
          map: stripeTex, transparent: true, opacity: 0.55 + i * 0.3,
          depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      ring.renderOrder = 2;
      this.scene.add(ring);
      this.rings.push({ mesh: ring, tex: stripeTex, dir: i ? -1 : 1 });
    });

    // 环绕粒子：绕船做椭圆轨道 + 上下浮动
    const pCount = 42;
    const pos = new Float32Array(pCount * 3);
    this.particleRefs = [];
    for (let i = 0; i < pCount; i++) {
      const a = (i / pCount) * Math.PI * 2;
      const r = 2.45 + (i % 3) * 0.33;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = 0.45 + Math.sin(i * 7.3) * 0.4;
      pos[i * 3 + 2] = Math.sin(a) * r;
      this.particleRefs.push({ a, r, y0: pos[i * 3 + 1], sp: 0.5 + (i % 5) * 0.12, ph: i * 1.7 });
    }
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.particles = new THREE.Points(
      pGeo,
      new THREE.PointsMaterial({
        color: 0x9feaff, size: 0.075, transparent: true, opacity: 0.85,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.particles.renderOrder = 4;
    this.scene.add(this.particles);

    // 扩散涟漪：两条错开的圆环不断放大淡出
    this.ripples = [];
    for (let i = 0; i < 2; i++) {
      const rip = new THREE.Mesh(
        new THREE.RingGeometry(2.1, 2.24, 64),
        new THREE.MeshBasicMaterial({
          color: 0xbfefff, transparent: true, opacity: 0,
          depthWrite: false, side: THREE.DoubleSide,
        }),
      );
      rip.rotation.x = -Math.PI / 2;
      rip.position.y = 0.03;
      rip.renderOrder = 3;
      this.scene.add(rip);
      this.ripples.push({ mesh: rip, t0: -i * 1.75 });
    }
  }

  setBoat(boatId) {
    if (!boatId) return;
    const def = getBoat(boatId);
    if (!def?.model) return;
    // 大厅每次重绘都会调 setBoat。已经在展这条船时直接返回：
    // 重新克隆一遍 2MB 的 GLB 不但浪费，还会把入场弹跳反复重置 ——
    // 表现是"模型永远卡在弹跳的第一帧、小得像个摆件"。
    if (this.boatId === boatId && this.model) {
      this.demoWeapon = getBoatWeapon(boatId);
      return;
    }
    this.boatId = boatId;
    this.demoWeapon = getBoatWeapon(boatId);
    this.#clearDemoFx();
    loadModel(def.model).then((gltf) => {
      if (!this.running || this.boatId !== boatId) return;
      this.#swapModel(gltf, def);
    }).catch(() => {});
  }

  /**
   * 换涂装：选艇抽屉里的色点驱动这里，关掉抽屉后大厅中央的船也要是这个颜色。
   * 只换材质，不动几何 / 喷口锚点 / 尾焰排程，所以可以随时切、随时切回来。
   */
  setPaint(paint) {
    const hex = paint?.hex || '';
    const key = paint?.key || '';
    if (hex === this.paintHex && key === this.paintKey) return;
    this.paintHex = hex;
    this.paintKey = key;
    this.#applyPaint();
  }

  #applyPaint() {
    // 先把上一轮换的漆还原：漆材质都是 clone 出来的，dispose 掉换回原材质
    for (const p of this.paintedMeshes) {
      if (p.mesh.material === p.mat) p.mesh.material = p.base;
      p.mat.dispose();
    }
    this.paintedMeshes = [];
    if (!this.model || !this.paintHex) return;
    this.model.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const base = o.userData.__paintBase || o.material;
      if (!base) return;
      // 蒙皮网格（牛来号）也染：纯材质替换，蒙皮不受影响
      o.userData.__paintBase = base;
      const mat = makePaintMaterial(THREE, base, this.paintHex, this.boatId, {
        paintKey: this.paintKey,
      });
      o.material = mat;
      this.paintedMeshes.push({ mesh: o, base, mat });
    });
  }

  /** 怪物模式：选艇台上循环播放该船主炮的发射演示 */  setBossMode(on) {
    const next = !!on;
    if (next === this.bossMode) return;
    this.bossMode = next;
    this.demoT = next ? 0.9 : 0;
    this.#clearDemoFx();
    // 怪物模式不播氮气；切回竞速时重新开始排程
    this.nitroOn = false;
    this.nitroK = 0;
    this.nitroT = next ? 1.8 : 1.2;
    this.#stopNitroJets();
  }

  #swapModel(gltf, def) {
    if (this.model) {
      this.tilt.remove(this.model);
      this.model.traverse((o) => {
        if (o.isMesh) {
          o.geometry?.dispose();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      this.model = null;
      this.paintedMeshes = [];
    }
    // 带骨骼的角色（牛来号）必须走 SkeletonUtils.clone，否则换艇后骨架是同一套
    const hasSkin = gltf.scene.getObjectByProperty('isSkinnedMesh', true) !== undefined;
    const model = hasSkin ? cloneSkinned(gltf.scene) : gltf.scene.clone(true);
    // 朝向/比例规整（与 Boat.js 一致），再归一化到展示尺寸
    // 注意：蒙皮模型要用蒙皮感知的包围盒，否则量出来的高度偏小、fitTo:'height' 会放大过头
    const box = measureModelBox(model);
    const size = box.getSize(new THREE.Vector3());
    const fwdLen = Math.max(size.x, size.z, 0.001);
    if (Number.isFinite(def.modelRotationX) || Number.isFinite(def.modelRotationY)) {
      model.rotation.x = Number.isFinite(def.modelRotationX) ? def.modelRotationX : 0;
      model.rotation.y = Number.isFinite(def.modelRotationY) ? def.modelRotationY : 0;
    } else {
      model.rotation.y = size.x > size.z ? -Math.PI / 2 : 0;
    }
    // 竖着站的角色（牛来号）按身高定标：套用"船长 = TARGET_LEN"会把它拉成
    // 5.8m 长的巨牛，展示台直接爆框。船用船身长轴，角色用高度。
    const charScale = !Number.isFinite(def.fitHeight)
      ? 0
      : (def.fitHeight * SHOWCASE_CHAR_HEIGHT) / Math.max(size.y, 0.001);
    const s = charScale > 0 ? charScale : TARGET_LEN / fwdLen;
    model.scale.setScalar(s);
    model.updateMatrixWorld(true);
    const box2 = measureModelBox(model);
    const c2 = box2.getCenter(new THREE.Vector3());
    model.position.x -= c2.x;
    model.position.z -= c2.z;
    model.position.y -= box2.min.y * 0.35;
    // 船的 lift 要按"展示船长 / 真实船长"折算；角色是按身高定标的，换算没有意义，
    // 直接用它自己的值（否则牛会被压进水里 0.43m）
    const lift = !Number.isFinite(def.modelLiftY)
      ? 0
      : def.fitTo === 'height'
        ? def.modelLiftY
        : def.modelLiftY * (TARGET_LEN / ((def.hull?.length || 4) * (def.modelScale || 1)));
    model.position.y += lift;
    model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });

    // 角色赛艇：在展示台上原地小跑当作待机动作（没有骨骼的模型直接跳过）
    let mixer = null;
    const walkClip = def.anim?.walk
      ? THREE.AnimationClip.findByName(gltf.animations || [], def.anim.walk)
      : null;
    if (walkClip) {
      mixer = new THREE.AnimationMixer(model);
      const act = mixer.clipAction(walkClip);
      act.play();
      act.timeScale = 0.45;
    }
    model.userData.mixer = mixer;

    model.userData.baseScale = s;
    model.userData.baseY = model.position.y;
    this.model = model;
    this.spawnT = performance.now();
    this.tilt.add(model);
    // 新模型是原色材质，把当前选中的涂装重新套上（换船不该把漆刷掉）
    this.paintedMeshes = [];
    this.#applyPaint();

    // 炮口锚点跟着艇型走：固定 2.4m 对 6m 长船正好，对 2.6m 的牛就飘在身前空中
    const near = Math.max(size.z, size.x) * s * 0.42;
    this.bowAnchor.position.z = Math.max(0.8, Math.min(TARGET_LEN * 0.42, near));
    this.bowAnchor.position.y = Math.min(0.6, size.y * s * 0.55);

    // 氮气喷口：与 Boat.js 同一套公式（船宽 42% 处、船尾略后、水线稍上）
    const boxF = box2.clone().translate(model.position);
    const sizeF = boxF.getSize(new THREE.Vector3());
    const halfW = Math.max(0.2, sizeF.x * 0.5 * 0.42);
    const sternZ = boxF.min.z - sizeF.z * 0.02;
    const nozzleY = boxF.min.y + sizeF.y * 0.4;
    this.nitroNozzles.forEach((n, i) => n.position.set((i - 1) * halfW, nozzleY, sternZ));

    // 换船后旧船的尾焰不能留着（特效名和喷口都变了），重新排一次点火
    this.#stopNitroJets();
    this.nitroOn = false;
    this.nitroK = 0;
    this.nitroT = 1.2 + Math.random() * 1.4;
  }

  // ---- 怪物模式主炮演示：炮口闪光 → 弹道 → 命中水花，每 2 秒一轮 ----
  #tex(key) {
    if (!this.texCache[key]) {
      this.texCache[key] = loadEffectTexture(this.texLoader, FX_TEX[key] || FX_TEX.spark);
    }
    return this.texCache[key];
  }

  #sprite(texKey, color, size) {
    const mat = new THREE.SpriteMaterial({
      map: this.#tex(texKey), color, transparent: true, opacity: 1,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(size);
    return s;
  }

  #addFx(obj, life, update, onEnd) {
    this.demoFx.push({ obj, t: 0, life, update, onEnd });
  }

  #killFx(f) {
    this.scene.remove(f.obj);
    f.obj.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const m = o.material;
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m?.dispose();
    });
  }

  #clearDemoFx() {
    this.#stopDemoShot();
    for (const f of this.demoFx) this.#killFx(f);
    this.demoFx.length = 0;
  }

  #stopDemoShot(key = null) {
    if (!this.demoShotKey) return;
    if (key && key !== this.demoShotKey) return;
    this.fx.stopAttached(this.demoShotKey);
    this.demoShotKey = null;
  }

  #updateDemo(dt) {
    for (let i = this.demoFx.length - 1; i >= 0; i--) {
      const f = this.demoFx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      f.update(f, dt, k);
      if (f.t >= f.life) {
        this.demoFx.splice(i, 1);
        this.#killFx(f);
        f.onEnd?.();
      }
    }
  }

  #fireDemo() {
    if (!this.model) return;
    const w = this.demoWeapon || getBoatWeapon(this.boatId);
    if (!w) return;
    const origin = new THREE.Vector3();
    const dir = new THREE.Vector3();
    this.bowAnchor.getWorldPosition(origin);
    this.tilt.getWorldQuaternion(this._q || (this._q = new THREE.Quaternion()));
    // 固定打向展示台右侧的水面靶点：不随船头摆动跑出画面，命中水花才始终看得见。
    // 注意机位在 (4.6,2.5,6.4) 且展示台画框很扁，靶点往镜头方向挪（如 z>1）会投影到
    // 画框下沿之外、整条弹道白打；这个点投影到 (0.61,-0.38)，水花炸开也完整在框内。
    const target = new THREE.Vector3(2.6, 0.12, -0.4);
    dir.copy(target).sub(origin);
    const dist = dir.length();
    if (dist < 0.8) return;
    dir.normalize();

    if (w.kind === 'beam') {
      // 青锋号：先蓄力，再打出和实战一致的高速风粒子弹（不再画旧版激光带）
      const charge = this.#sprite('spark', w.glow, 0.3);
      charge.position.copy(origin);
      this.scene.add(charge);
      this.#addFx(charge, 0.55, (f, dt, k) => {
        f.obj.scale.setScalar(0.3 + k * 2.0);
        f.obj.material.opacity = 0.55 + k * 0.45;
      }, () => this.#demoShot(w, origin, dir, dist, 9));
      return;
    }

    const speed = w.kind === 'blade' ? 4.8 : w.kind === 'torpedo' ? 4.4 : 8.4;
    this.#demoShot(w, origin, dir, dist, speed);
  }

  /**
   * 演示弹道：飞行体直接用实战里同一段氮气尾焰素材（nitroAttackFx），
   * 炮口用该船 weapon 定义里的 fxMuzzle —— 只演出发射端，不播 BOSS 受击特效。
   */
  #demoShot(w, origin, dir, dist, speed) {
    // 炮口闪光（贴片补一层亮度）+ 实战炮口特效
    const flashSize = w.kind === 'blade' ? 1.4 : 1.9;
    const flash = this.#sprite(w.muzzle, w.glow, flashSize);
    flash.position.copy(origin);
    this.scene.add(flash);
    this.#addFx(flash, 0.22, (f, dt, k) => {
      f.obj.scale.setScalar(flashSize * (0.4 + k * 0.85));
      f.obj.material.opacity = 0.95 * (1 - k);
    });
    if (w.fxMuzzle) this.fx.play(w.fxMuzzle, origin.x, origin.y, origin.z);

    // 飞行体：与 BoatWeapons.#spawnProjectile 使用同一份 cfg
    const cfg = nitroAttackFx(this.boatId) || { fx: 'itemBeam', scale: 0.22, color: null };
    const size = w.kind === 'blade' || w.kind === 'torpedo' ? 1.15 : 1;
    const marker = new THREE.Object3D();
    marker.position.copy(origin);
    this.scene.add(marker);
    this.#stopDemoShot();
    const key = `show:shot:${++this.demoShotSeq}`;
    this.demoShotKey = key;
    const travel = dist / speed;
    this.fx.playAttached(key, cfg.fx, () => marker.position, {
      life: travel + 0.25, loop: true, scale: cfg.scale * size * 2.4, color: cfg.color,
    });
    this.#addFx(marker, travel, (f, dt) => {
      f.obj.position.addScaledVector(dir, speed * dt);
    }, () => {
      this.#stopDemoShot(key);
      this.#demoImpact(marker.position.clone(), w);
    });
  }

  #demoImpact(pos, w) {
    // 只演示赛艇发射端的特效（炮口 + 飞行体）。击中 BOSS 的受击特效是给 BOSS
    // 加的反馈（像烟花），在选艇台上没有 BOSS，播放它只会让人误以为船带烟花，
    // 用户明确要求去掉，这里只保留落在水面的水花。
    const splash = this.#sprite('splash', w.glow, 1.3);
    splash.position.copy(pos);
    this.scene.add(splash);
    this.#addFx(splash, 0.5, (f, dt, k) => {
      f.obj.scale.setScalar(1.3 + k * 2.7);
      f.obj.material.opacity = 0.9 * (1 - k);
    });

    // 水面扩散圈
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.78, 40),
      new THREE.MeshBasicMaterial({
        color: w.color, transparent: true, opacity: 0.7,
        depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(pos.x, 0.05, pos.z);
    this.scene.add(ring);
    this.#addFx(ring, 0.55, (f, dt, k) => {
      f.obj.scale.setScalar(1 + k * 2.3);
      f.obj.material.opacity = 0.7 * (1 - k);
    });
  }

  #resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  #animate = () => {
    if (!this.running) return;
    requestAnimationFrame(this.#animate);
    if (this.container.clientWidth === 0 || document.hidden) return;
    const now = performance.now();
    const t = now * 0.001;
    const dt = Math.min(0.05, Math.max(0, t - (this.lastT || t)));
    this.lastT = t;

    // 待机动画：摆头 + 波浪浮动 + 横摇 + 纵摇
    // 鼠标接管期（拖动中 / 松手 3 秒内）：摆头和机位高度由用户拖动决定，
    // 两套姿态按 manual 系数插值，接管/交还都不跳变
    const manualOn = this.dragging || (now - this.idleAt < 3000);
    this.manual = Math.min(1, Math.max(0, this.manual + (manualOn ? 1 : -1) * dt * 3.2));
    const autoYaw = Math.sin(t * 0.32) * 0.42;
    // 氮气点火时转向船尾 3/4（玩家正在拖动时不抢镜头），收火后转回
    const showYaw = (!this.bossMode && this.nitroOn && this.manual < 0.5) ? NITRO_SHOW_YAW : 0;
    const yawStep = NITRO_SHOW_RATE * dt;
    this.nitroYaw += Math.max(-yawStep, Math.min(yawStep, showYaw - this.nitroYaw));
    if (this.manual >= 0.999) {
      this.holder.rotation.y = this.userYaw;
    } else {
      this.holder.rotation.y = autoYaw * (1 - this.manual) + this.userYaw * this.manual
        + this.nitroYaw * (1 - this.manual);
    }
    this.tilt.position.y = Math.sin(t * 1.15) * 0.1;
    this.tilt.rotation.z = Math.sin(t * 0.9) * 0.045;
    this.tilt.rotation.x = Math.sin(t * 0.62 + 1.3) * 0.03;

    // 入场弹跳
    if (this.model) {
      const k = Math.min(1, (performance.now() - this.spawnT) / 480);
      // k 到 1 也要再写一帧满尺寸：低帧率下最后一帧可能停在弹跳中途，
      // 只在 k<1 时赋值会让模型永远只有半截大
      const e = k < 1 ? easeOutBack(k) : 1;
      this.model.scale.setScalar(this.model.userData.baseScale * e);
      this.model.position.y = this.model.userData.baseY + (1 - e) * 0.55;
      // 角色赛艇的待机小跑（只有带骨骼动作的模型才有 mixer）
      this.model.userData.mixer?.update(dt);
    }

    // 魔法阵流光
    for (const { tex, dir } of this.rings) {
      tex.offset.x = (tex.offset.x + 0.0016 * dir) % 1;
    }

    // 环绕粒子轨道
    const arr = this.particles.geometry.attributes.position.array;
    for (let i = 0; i < this.particleRefs.length; i++) {
      const p = this.particleRefs[i];
      const a = p.a + t * p.sp * 0.35;
      arr[i * 3] = Math.cos(a) * p.r;
      arr[i * 3 + 1] = p.y0 + Math.sin(t * p.sp + p.ph) * 0.12;
      arr[i * 3 + 2] = Math.sin(a) * p.r;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;

    // 扩散涟漪
    for (const rip of this.ripples) {
      const k = ((t - rip.t0) % 3.5) / 3.5;
      rip.mesh.scale.setScalar(1 + k * 2.5);
      rip.mesh.material.opacity = (1 - k) * 0.5;
    }

    // 氮气展示（怪物模式下内部会整组停掉）+ 驱动 Effekseer 粒子
    this.#updateNitro(dt);
    this.fx.update(dt);

    const camBase = 2.5 + Math.sin(t * 0.5) * 0.06;
    const env = this.nitroK || 0;
    // 点火时镜头轻微前冲 + 抖动，配合 FOV 小幅拉大，速度感更明显
    const shakeX = Math.sin(t * 57) * 0.03 * env;
    const shakeY = Math.sin(t * 73 + 1.2) * 0.022 * env;
    this.camera.position.x = 4.6 + shakeX;
    this.camera.position.y = camBase * (1 - this.manual) + this.userCamY * this.manual + shakeY;
    const fovTarget = 38 + 2.6 * env;
    if (Math.abs(this.camera.fov - fovTarget) > 0.02) {
      this.camera.fov = fovTarget;
      this.camera.updateProjectionMatrix();
    }
    this.camera.lookAt(0, 0.8, 0);

    // 怪物模式：循环演示主炮
    if (this.bossMode) {
      this.demoT += dt;
      if (this.demoT >= DEMO_CYCLE) {
        this.demoT = 0;
        this.#fireDemo();
      }
    }
    this.#updateDemo(dt);

    this.renderer.render(this.scene, this.camera);
    // Effekseer 尾焰叠在 three.js 画面之上（内部会重置 GL 状态）
    this.fx.draw(this.camera);
  };

  dispose() {
    this.running = false;
    this.#clearDemoFx();
    this.#stopNitroJets();
    this.fx.dispose();
    for (const tex of Object.values(this.texCache)) tex.dispose();
    this.resizeObserver?.disconnect();
    this.waterTex?.dispose();
    this.rings.forEach(({ tex }) => tex.dispose());
    this.scene.traverse((obj) => {
      if (obj.isMesh || obj.isPoints) {
        obj.geometry?.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m?.dispose();
      }
    });
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
}