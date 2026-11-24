import * as THREE from 'three';
import { getBossTheme } from '../data/bossThemes.js';
import { waveHeight, setWaveScale } from '../utils/waves.js';
import { instantiateMonsterModel, loadMonsterModel } from './Boss.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 主题布景用的 GLB 缓存：同一关反复进出只加载一次，实例共享几何/贴图。
const decorCache = new Map();
function loadDecorScene(url) {
  if (!decorCache.has(url)) {
    decorCache.set(url, new Promise((resolve) => {
      new GLTFLoader().load(url, (g) => resolve(g.scene), undefined, (err) => {
        console.warn('BOSS 布景模型加载失败', url, err);
        resolve(null);
      });
    }));
  }
  return decorCache.get(url);
}

// 只服务于怪物模式：每关换一套天空/水色/浮岩外观 + 专属布景。
// 所有物件都挂在自己的 Group 下，换关时整组销毁，不会污染竞速等其它模式。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 径向柔光贴图（蒸汽/烟雾/薄雾共用） */
function radialTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255,255,255,0.9)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.34)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** 极光幕布贴图：竖向渐变 + 几条垂帘，横向可重复滚动 */
function auroraTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext('2d');
  const base = ctx.createLinearGradient(0, 0, 0, 256);
  base.addColorStop(0, 'rgba(120,255,210,0)');
  base.addColorStop(0.35, 'rgba(110,255,200,0.55)');
  base.addColorStop(0.62, 'rgba(150,110,255,0.42)');
  base.addColorStop(1, 'rgba(90,60,200,0)');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * 512;
    const w = 4 + Math.random() * 14;
    const grad = ctx.createLinearGradient(0, 20, 0, 250);
    grad.addColorStop(0, 'rgba(180,255,230,0)');
    grad.addColorStop(0.4, `rgba(120,255,205,${0.12 + Math.random() * 0.22})`);
    grad.addColorStop(1, 'rgba(140,110,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, 15, w, 240);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

// 四关的远景山体色调：第一关熔岩（本色），其后压绿/压灰/压蓝
const MOUNTAIN_TINT = {
  1: 0xffffff,
  2: 0xa8cfae,
  3: 0xc2c0b8,
  4: 0xa9c6e6,
};

export class BossThemes {
  constructor(scene, { env, arena, water }) {
    this.scene = scene;
    this.env = env;
    this.arena = arena;
    this.water = water;
    this.current = null;
    this.stage = 0;
    this.group = null;
    this.time = 0;
    this.floaters = [];
    this.spinners = [];
    this.risers = [];
    this.pulsers = [];
    this.points = [];
    this.rockLayout = [];
    // 第四关的背景鲸鱼：单独一组 + 独立 mixer，不跟主题布景一起销毁，
    // 避免把 GLB 缓存里共享的贴图释放掉。
    this.ambientGroup = null;
    this.ambientWhales = [];
    this.mixers = [];
  }

  /** 切换关卡主题：天气/水色/浮岩布局/专属布景一次性重建 */
  setTheme(stage) {
    const theme = getBossTheme(stage);
    if (this.current === theme.id) return;
    this.current = theme.id;
    this.stage = stage;
    this.rockLayout = theme.rocks.layout;

    this.env.setWeather(theme.weather);
    // RealSky 模式下天空随主题天气自动换（雾/太阳/云都由 setWeather 接管），
    // 渐变穹顶模式则要重建穹顶配色
    this.env.refreshBossSky?.(theme.weather);
    this.water.setWeather(theme.weather);
    setWaveScale(theme.weather.waveScale ?? 1);
    // 主题自带远景与海面装饰，隐藏通用地形/海鸥浮标浮冰，避免两套背景打架
    // 远景山体：试过峡谷那套分层山脊，观感和熔岩主题打架（灰褐山脊抢戏），
    // 恢复为主题自带的 5 座火山锥 + 火山口熔岩光。山体调色板/tint 基础设施保留，以后要用随时开。
    this.env.setTerrainVisible(false);
    this.env.setMountainTint?.(MOUNTAIN_TINT[this.stage] ?? 0xffffff);
    this.env.dressing?.setDecorVisible(false);
    this.env.dayTint = null;
    this.arena.setRockLayout(theme.rocks.layout, theme.rocks.style);

    this.#clear();
    // 换主题时先撤掉上一关的浮冰碰撞体，冰海重建时再重新上报
    this.arena?.setDecorColliders?.([]);
    this.floaters = [];
    this.spinners = [];
    this.risers = [];
    this.pulsers = [];
    this.points = [];
    this.time = 0;
    this.rng = mulberry32(1000 + stage * 137);

    this.group = new THREE.Group();
    this.group.name = `boss-theme-${theme.id}`;
    this.scene.add(this.group);

    if (theme.props === 'volcano') this.#buildVolcano();
    else if (theme.props === 'tropical') this.#buildTropical();
    else if (theme.props === 'harbor') this.#buildHarbor();
    else if (theme.props === 'ice') {
      this.#buildIce();
      this.#buildAmbientWhale();
    }
    this.update(0, 0);
  }

  update(dt, t) {
    this.time += dt;
    const time = t || this.time;
    for (const f of this.floaters) {
      const m = f.mesh;
      m.position.y = waveHeight(m.position.x, m.position.z, time) + f.baseY;
      m.rotation.z = Math.sin(this.time * f.wobble + f.phase) * f.tilt;
      if (f.spin) m.rotation.y += f.spin * dt;
    }
    for (const s of this.spinners) s.mesh.rotation.y += s.speed * dt;
    for (const r of this.risers) {
      r.mesh.position.y += r.speed * dt;
      r.mesh.material.opacity = r.opacity * Math.max(0, 1 - (r.mesh.position.y - r.baseY) / r.span);
      if (r.mesh.position.y > r.baseY + r.span) r.mesh.position.y = r.baseY;
    }
    for (const p of this.pulsers) {
      p.mat.opacity = p.base + Math.sin(this.time * p.speed + p.phase) * p.amp;
    }
    for (const pt of this.points) pt.update(this.time, dt);
    if (this.aurora) {
      for (const a of this.aurora) {
        a.tex.offset.x = (a.tex.offset.x + dt * a.scroll) % 1;
        a.mat.opacity = a.base + Math.sin(this.time * a.speed + a.phase) * 0.12;
      }
    }
    // 第四关背景鲸鱼：绕场慢游 + 上下起伏，头朝切线方向
    for (const w of this.ambientWhales) {
      w.angle += w.speed * dt;
      w.mesh.position.set(
        Math.cos(w.angle) * w.radius,
        w.y + Math.sin(this.time * 0.5 + 1.2) * 0.35,
        Math.sin(w.angle) * w.radius,
      );
      w.mesh.rotation.y = -w.angle;
    }
    for (const m of this.mixers) m.update(dt);
  }

  // ---------- 通用小工具 ----------
  #std(opts) {
    return new THREE.MeshStandardMaterial({ flatShading: true, ...opts });
  }

  #sprite(tex, color, opacity, scale) {
    const mat = new THREE.SpriteMaterial({
      map: tex, color, transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.scale.setScalar(scale);
    this.group.add(s);
    return s;
  }

  #riseSprite(tex, color, opacity, scale, span, speed) {
    const s = this.#sprite(tex, color, opacity, scale);
    s.position.y = this.rng() * span;
    this.risers.push({
      mesh: s, baseY: 0, span, speed, opacity,
    });
    return s;
  }

  /** 粒子云：update 回调里改 positions，做到零 shader 依赖 */
  #particles(count, color, size, opacity, build, update) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const data = [];
    for (let i = 0; i < count; i++) {
      const p = build(i);
      data.push(p);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size, transparent: true, opacity, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    this.group.add(pts);
    this.points.push({
      update: (time, dt) => update(data, pos, geo, time, dt),
    });
    return pts;
  }

  // ---------- 第一关：火山熔岩海 ----------
  #buildVolcano() {
    const rng = this.rng;
    // 远景火山：五座高低错落、集中在出生点正前方 ±64° 的扇形里排成一片。
    // 距离必须收到 190~260m —— 雾密度 0.0066，放到 300m 开外会被雾吃干净（看不清）。
    const rockMat = this.#std({ color: 0x1d1614, roughness: 1.0, metalness: 0.02 });
    // 扇形收在 ±40° 内：追尾镜头的横向视野约 ±45°，张太开会拍到画外去
    const VOLC = [
      { deg: -40, dist: 250, h: 56 },
      { deg: -20, dist: 215, h: 78 },
      { deg: 0, dist: 192, h: 96 },
      { deg: 20, dist: 225, h: 64 },
      { deg: 40, dist: 255, h: 84 },
    ];
    for (let i = 0; i < VOLC.length; i++) {
      const spec = VOLC[i];
      const a = Math.PI + THREE.MathUtils.degToRad(spec.deg); // 正前方 = -Z
      const dist = spec.dist;
      const h = spec.h;
      const r = h * 0.8;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), rockMat);
      cone.position.set(Math.cos(a) * dist, h / 2 - 12, Math.sin(a) * dist);
      this.group.add(cone);
      // 火山口熔岩光
      if (h < 70) continue;
      const crater = new THREE.Mesh(
        new THREE.CircleGeometry(r * 0.17, 18),
        new THREE.MeshBasicMaterial({
          color: 0xff5a1e, transparent: true, opacity: 0.85,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      crater.rotation.x = -Math.PI / 2;
      crater.position.set(cone.position.x, h - 13, cone.position.z);
      this.group.add(crater);
      this.pulsers.push({ mat: crater.material, base: 0.7, amp: 0.18, speed: 1.6 + i * 0.4, phase: i });
    }

    // 开场镜头右侧（+X 那侧）补三座同款火山锥，两侧都有山才有"山谷包围"感
    const VOLC_RIGHT = [
      { deg: -28, dist: 270, h: 52 },
      { deg: 2, dist: 238, h: 86 },
      { deg: 32, dist: 264, h: 64 },
    ];
    for (const spec of VOLC_RIGHT) {
      const a = THREE.MathUtils.degToRad(spec.deg);
      const r = spec.h * 0.8;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(r, spec.h, 7), rockMat);
      cone.position.set(Math.cos(a) * spec.dist, spec.h / 2 - 12, Math.sin(a) * spec.dist);
      this.group.add(cone);
      if (spec.h > 70) {
        const crater = new THREE.Mesh(
          new THREE.CircleGeometry(r * 0.17, 18),
          new THREE.MeshBasicMaterial({
            color: 0xff5a1e, transparent: true, opacity: 0.85,
            blending: THREE.AdditiveBlending, depthWrite: false,
          }),
        );
        crater.rotation.x = -Math.PI / 2;
        crater.position.set(cone.position.x, spec.h - 13, cone.position.z);
        this.group.add(crater);
        this.pulsers.push({ mat: crater.material, base: 0.7, amp: 0.18, speed: 2 + spec.deg * 0.05, phase: spec.deg });
      }
    }

    const smokeTex = radialTexture();
    for (const spec of VOLC) {
      if (spec.h < 70) continue;
      const a = Math.PI + THREE.MathUtils.degToRad(spec.deg);
      for (let k = 0; k < 5; k++) {
        const s = this.#riseSprite(smokeTex, 0x35201a, 0.3, 40 + rng() * 26, 110, 5 + rng() * 4);
        s.position.set(
          Math.cos(a) * spec.dist + (rng() - 0.5) * 26,
          spec.h - 10 + k * 18,
          Math.sin(a) * spec.dist + (rng() - 0.5) * 26,
        );
      }
    }

    // 浮岩上的熔岩裂纹 + 接触海面处的蒸汽
    const lavaMat = new THREE.MeshBasicMaterial({
      color: 0xff5a1a, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.pulsers.push({ mat: lavaMat, base: 0.75, amp: 0.2, speed: 2.4, phase: 0 });
    for (const spec of this.rockLayout) {
      // 地面上的橙色圆盘 + 橙色长条已经删掉（就是用户说的"随机橙色方块"）：
      // 地面只留三种标记——引导弧线、BOSS 脚下红环、技能红预警圈。
      // 裂缝发光条（贴着岩石表面）
      for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const y = 0.6 + rng() * spec.r * 0.8;
        const crack = new THREE.Mesh(new THREE.BoxGeometry(0.28, spec.r * 0.9, 0.12), lavaMat);
        crack.position.set(
          spec.x + Math.cos(a) * spec.r * 0.92,
          y,
          spec.z + Math.sin(a) * spec.r * 0.92,
        );
        crack.rotation.y = -a;
        crack.rotation.z = (rng() - 0.5) * 0.5;
        this.group.add(crack);
      }
      // 蒸汽柱
      for (let i = 0; i < 3; i++) {
        const a = rng() * Math.PI * 2;
        const s = this.#riseSprite(smokeTex, 0xe8e2dd, 0.24, 9 + rng() * 8, 16, 3 + rng() * 2);
        s.position.set(spec.x + Math.cos(a) * spec.r * 1.2, 0.4, spec.z + Math.sin(a) * spec.r * 1.2);
      }
    }

    // 火山灰：缓慢飘落（PointsMaterial 默认是硬方块，套一张径向柔光贴图）
    const ashPts = this.#particles(
      520, 0x3a2620, 0.5, 0.5,
      () => ({
        x: (rng() - 0.5) * 190,
        y: 4 + rng() * 70,
        z: (rng() - 0.5) * 190,
        fall: 1.2 + rng() * 2.4,
        drift: (rng() - 0.5) * 3,
      }),
      (data, pos, geo, time, dt) => {
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          d.y -= d.fall * dt;
          d.x += d.drift * dt;
          d.z += Math.sin(time * 0.4 + i) * dt * 0.6;
          if (d.y < 1) { d.y = 60 + rng() * 16; d.x = (rng() - 0.5) * 190; d.z = (rng() - 0.5) * 190; }
          pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
        }
        geo.attributes.position.needsUpdate = true;
      },
    );
    // 上升火星：**绑发射点**（火山口 + 岩石裂缝）。
    // 旧版是 (rng-0.5)*150 整片随机撒，看起来像"天上凭空冒火花"，看不出从哪来的。
    const sparkSources = [];
    for (const spec of VOLC) {
      if (spec.h < 70) continue;
      const a = Math.PI + THREE.MathUtils.degToRad(spec.deg);
      sparkSources.push({
        x: Math.cos(a) * spec.dist,
        z: Math.sin(a) * spec.dist,
        y: spec.h - 13,
        spread: spec.h * 0.09,
        rise: 26,
        weight: 2,
      });
    }
    for (const spec of this.rockLayout) {
      sparkSources.push({
        x: spec.x, z: spec.z, y: 0.7, spread: spec.r * 0.75, rise: 16, weight: 1,
      });
    }
    const pickSource = () => {
      // 按权重抽（火山口的火星更多）
      let total = 0;
      for (const src of sparkSources) total += src.weight;
      let r = rng() * total;
      for (const src of sparkSources) {
        r -= src.weight;
        if (r <= 0) return src;
      }
      return sparkSources[0];
    };
    const sparkPts = this.#particles(
      140, 0xff7a30, 0.55, 0.85,
      () => {
        const src = pickSource();
        const a = rng() * Math.PI * 2;
        const rad = rng() * src.spread;
        return {
          sx: src.x, sz: src.z, baseY: src.y, rise: src.rise,
          x: src.x + Math.cos(a) * rad,
          y: src.y + rng() * 3,
          z: src.z + Math.sin(a) * rad,
          sp: 2 + rng() * 5,
        };
      },
      (data, pos, geo, time, dt) => {
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          d.y += d.sp * dt;
          d.x += Math.sin(time + i) * dt * 1.2;
          if (d.y > d.baseY + d.rise) {
            // 回到自己的发射点，而不是随机落到全图某处
            const a = Math.random() * Math.PI * 2;
            d.x = d.sx + Math.cos(a) * 2.5;
            d.z = d.sz + Math.sin(a) * 2.5;
            d.y = d.baseY + 0.4;
          }
          pos[i * 3] = d.x;
          pos[i * 3 + 1] = d.y;
          pos[i * 3 + 2] = d.z;
        }
        geo.attributes.position.needsUpdate = true;
      },
    );
    const softDot = radialTexture();
    for (const pts of [ashPts, sparkPts]) {
      if (!pts) continue;
      pts.material.map = softDot;
      pts.material.needsUpdate = true;
    }
  }

  // ---------- 第二关：珊瑚浅海 ----------
  #buildTropical() {
    const rng = this.rng;
    // 远景热带岛
    const sandMat = this.#std({ color: 0xf2e3b8, roughness: 0.95 });
    // 岛上的树换成和赛道边同一份真实松树 GLB：原来是"圆柱树干 + 四片锥形叶子"
    // 拼出来的卡通棕榈，远看就是几个绿色三角插在沙堆上。
    const pineSlots = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + rng() * 0.3;
      const dist = 175 + rng() * 70;
      const r = 26 + rng() * 26;
      const h = 7 + rng() * 8;
      const isle = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.25, h, 9), sandMat);
      base.position.y = h * 0.32;
      isle.add(base);
      isle.position.set(Math.cos(a) * dist, -2, Math.sin(a) * dist);
      this.group.add(isle);
      // 落地面：圆柱中心在 0.32h、半高 0.5h，再加岛的 -2 → 坡顶约 0.7h。
      // 往下埋 0.1h 让树根咬进沙坡，不会悬空。
      const topY = isle.position.y + h * 0.6;
      for (let p = 0; p < 4; p++) {
        pineSlots.push({
          x: isle.position.x + (rng() - 0.5) * r * 1.1,
          y: topY,
          z: isle.position.z + (rng() - 0.5) * r * 1.1,
          h: 6 + rng() * 4.5,
          rotY: rng() * Math.PI * 2,
          slim: 0.88 + rng() * 0.24,
          variant: pineSlots.length % 3,
        });
      }
    }
    this.env?.addPineStand?.(pineSlots, this.group, { name: 'coral-pines' });

    // 浅海礁盘：原来是无贴图的彩色锥体珊瑚，用户觉得丑，且明确不要 coral_reef.glb。
    // 改用两种带贴图的小礁石 GLB 拼成礁盘，露出水面一点点，保留原分布范围。
    const coralColors = [0xff5a6e, 0xb06cff, 0xffd24a, 0xff8ad0, 0x5de0c0];
    const reefSlotsA = [];
    const reefSlotsB = [];
    for (let c = 0; c < 16; c++) {
      const a = rng() * Math.PI * 2;
      const dist = 58 + rng() * 24;
      const cx = Math.cos(a) * dist;
      const cz = Math.sin(a) * dist;
      const count = rng() < 0.45 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        (k === 0 ? reefSlotsA : reefSlotsB).push({
          x: cx + (rng() - 0.5) * 4.5,
          z: cz + (rng() - 0.5) * 4.5,
          y: -0.3 - rng() * 0.25,
          ry: rng() * Math.PI * 2,
          scale: 1.15 + rng() * 1.05,
        });
      }
    }
    this.#addDecorInstances('/models/props/rock_hazard_a.glb', reefSlotsA, 'reef-rock-a');
    this.#addDecorInstances('/models/props/rock_hazard_b.glb', reefSlotsB, 'reef-rock-b');

    // 海草：细长面片换成有体积的 hazard_kelp.glb，随风/浪轻轻摆动
    const kelpSlots = [];
    for (let i = 0; i < 34; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 50 + rng() * 32;
      kelpSlots.push({
        x: Math.cos(a) * dist,
        z: Math.sin(a) * dist,
        // 根部略没入水下，随浪上下时不会整棵浮在水面
        y: -0.15,
        ry: rng() * Math.PI,
        scale: 1.0 + rng() * 1.0,
      });
    }
    this.#addDecorInstances('/models/hazards/hazard_kelp.glb', kelpSlots, 'kelp', { float: true });

    // 木船残骸的位置不再放大型道具：shipwreck.glb 露出水面只剩一根斜插的木板，
    // 而 12m 的礁石/残骸没有碰撞体（会穿模），所以这块留给上面的礁盘。

    // 彩色浮标
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const dist = 68 + rng() * 12;
      const mat = this.#std({ color: coralColors[i % coralColors.length], roughness: 0.5, emissive: 0x111111 });
      const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.85, 10, 8), mat);
      buoy.position.set(Math.cos(a) * dist, 0.4, Math.sin(a) * dist);
      this.group.add(buoy);
      this.floaters.push({
        mesh: buoy, baseY: 0.4, wobble: 2, phase: i, tilt: 0.14, spin: 0,
      });
    }

    // 水下游鱼群：贴着水面穿梭
    this.#particles(
      110, 0x8ff0ff, 0.42, 0.9,
      () => ({ r: 20 + rng() * 50, a: rng() * Math.PI * 2, y: 0.35 + rng() * 1.2, sp: 0.18 + rng() * 0.25 }),
      (data, pos, geo, time) => {
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          const a = d.a + time * d.sp;
          pos[i * 3] = Math.cos(a) * d.r;
          pos[i * 3 + 1] = d.y + Math.sin(time * 2 + i) * 0.2;
          pos[i * 3 + 2] = Math.sin(a) * d.r;
        }
        geo.attributes.position.needsUpdate = true;
      },
    );
  }

  // ---------- 第三关：锈蚀港口 ----------
  #buildHarbor() {
    const rng = this.rng;
    // 岸边码头：原来 18 个锈色集装箱 Box 换成 dock_wood 木码头段，
    // 再用航道浮标点出港口纵深（没有现成的集装箱模型，Box 堆又太丑）
    const dockSlots = [];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + rng() * 0.16;
      const dist = 96 + rng() * 18;
      dockSlots.push({
        x: Math.cos(a) * dist,
        z: Math.sin(a) * dist,
        y: 0.2 + rng() * 0.25,
        ry: a + (rng() - 0.5) * 0.35,
        scale: 0.9 + rng() * 0.3,
      });
    }
    this.#addDecorInstances('/models/shore/dock_wood.glb', dockSlots, 'harbor-dock');

    const buoySlots = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4 + rng() * 0.3;
      const dist = 92 + rng() * 14;
      buoySlots.push({
        x: Math.cos(a) * dist, z: Math.sin(a) * dist,
        y: -0.9, ry: rng() * Math.PI * 2, scale: 1,
      });
    }
    this.#addDecorInstances('/models/props/nav_buoy.glb', buoySlots, 'harbor-buoy');

    // 半沉货轮：Box 船体换成带 3 张贴图的 yacht.glb（40m）。
    // 这个模型重心很低（甲板在包围盒下半部），y 要抬到 6 以上才露得出舷侧；
    // 半径放到 100 左右，船头船尾都不会捅进栅栏。
    this.#addDecorInstances('/models/yacht.glb', [
      { x: -96, z: 30, y: 6.8, ry: 0.55, rz: 0.12, scale: 1.05 },
    ], 'harbor-wreck');

    // 岸边起重机剪影（没有现成的起重机模型，远处剪影保留 Box 拼法）
    const hullMat = this.#std({ color: 0x4a3a32, roughness: 1.0, metalness: 0.2 });
    for (let i = 0; i < 2; i++) {
      const a = 2.2 + i * 1.5;
      const dist = 128;
      const crane = new THREE.Group();
      const tower = new THREE.Mesh(new THREE.BoxGeometry(3, 36, 3), hullMat);
      tower.position.y = 18;
      crane.add(tower);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(30, 2, 2), hullMat);
      arm.position.set(12, 35, 0);
      crane.add(arm);
      const drop = new THREE.Mesh(new THREE.BoxGeometry(0.4, 12, 0.4), hullMat);
      drop.position.set(24, 29, 0);
      crane.add(drop);
      crane.position.set(Math.cos(a) * dist, -1, Math.sin(a) * dist);
      crane.rotation.y = a;
      this.group.add(crane);
    }

    // 断裂码头桩：Cylinder 换成 boardwalk_pile（细长木桩，非等比缩放）
    const pileSlots = [];
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 96 + rng() * 22;
      pileSlots.push({
        x: Math.cos(a) * dist, z: Math.sin(a) * dist,
        y: -1.0, ry: rng() * Math.PI * 2, rz: (rng() - 0.5) * 0.16,
        scale: [1.9 + rng() * 0.5, 4.5 + rng() * 3, 1.9 + rng() * 0.5],
      });
    }
    this.#addDecorInstances('/models/track/boardwalk_pile.glb', pileSlots, 'harbor-pile');

    // 漂浮垃圾：垃圾桶 / 木板（原来是桶 / 木箱 / 木板三个纯色几何体）
    const binSlots = [];
    const plankSlots = [];
    for (let i = 0; i < 20; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 46 + rng() * 38;
      const x = Math.cos(a) * dist;
      const z = Math.sin(a) * dist;
      const ry = rng() * Math.PI * 2;
      if (i % 2 === 0) {
        binSlots.push({
          x, z, y: 0.05, ry, scale: 1.5 + rng() * 0.7,
          wobble: 1.4 + rng(), tilt: 0.1, spin: (rng() - 0.5) * 0.12,
        });
      } else {
        plankSlots.push({
          x, z, y: 0.05, ry, scale: 0.32 + rng() * 0.12,
          wobble: 1.6 + rng(), tilt: 0.1, spin: (rng() - 0.5) * 0.08,
        });
      }
    }
    this.#addDecorInstances('/models/hazards/hazard_bin.glb', binSlots, 'harbor-debris-bin', { float: true });
    this.#addDecorInstances('/models/track/boardwalk_plank.glb', plankSlots, 'harbor-debris-plank', { float: true });

    // 油污膜：暗色镜面 + 一点紫色反光
    for (let i = 0; i < 6; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 40 + rng() * 40;
      const slick = new THREE.Mesh(
        new THREE.CircleGeometry(5 + rng() * 5, 22),
        new THREE.MeshBasicMaterial({
          color: 0x10161a, transparent: true, opacity: 0.62, depthWrite: false,
        }),
      );
      slick.rotation.x = -Math.PI / 2;
      slick.scale.set(1.5, 0.7, 1);
      slick.position.set(Math.cos(a) * dist, 0.05, Math.sin(a) * dist);
      this.group.add(slick);
      const sheen = new THREE.Mesh(
        new THREE.CircleGeometry(3 + rng() * 3, 18),
        new THREE.MeshBasicMaterial({
          color: 0x8a5cff, transparent: true, opacity: 0.12,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      sheen.rotation.x = -Math.PI / 2;
      sheen.position.set(slick.position.x, 0.07, slick.position.z);
      this.group.add(sheen);
      this.pulsers.push({ mat: sheen.material, base: 0.12, amp: 0.06, speed: 0.7 + rng(), phase: rng() * 6 });
    }

    // 低空薄雾
    const tex = radialTexture();
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const s = this.#sprite(tex, 0x9aa8a8, 0.1, 60 + rng() * 50);
      s.position.set(Math.cos(a) * (80 + rng() * 60), 6 + rng() * 10, Math.sin(a) * (80 + rng() * 60));
    }
  }

  // ---------- 第四关：极夜冰海 ----------
  #buildIce() {
    const rng = this.rng;
    // 远景冰山环：Icosahedron 换成 iceberg_large / iceberg_small
    // 两个模型的原点都在冰体中部（minY 为负），按 -0.34×入水深度摆，出水约 2/3
    const largeBergs = [];
    const smallBergs = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + rng() * 0.3;
      const dist = 105 + rng() * 85;
      const x = Math.cos(a) * dist;
      const z = Math.sin(a) * dist;
      if (i % 3 === 2) {
        const s = 1.8 + rng() * 1.2;
        smallBergs.push({ x, z, y: -9.9 * s * 0.34, ry: rng() * Math.PI * 2, scale: s });
      } else {
        const s = 1.0 + rng() * 0.8;
        largeBergs.push({ x, z, y: -25.9 * s * 0.34, ry: rng() * Math.PI * 2, scale: s });
      }
    }
    this.#addDecorInstances('/models/props/iceberg_large.glb', largeBergs, 'iceberg-large');
    this.#addDecorInstances('/models/props/iceberg_small.glb', smallBergs, 'iceberg-small');

    // 场内漂浮碎冰：按原 Icosahedron 的直径（5~10m）缩 iceberg_small
    const chunkSlots = [];
    for (let i = 0; i < 8; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 48 + rng() * 34;
      const s = 0.34 + rng() * 0.26;
      chunkSlots.push({
        x: Math.cos(a) * dist, z: Math.sin(a) * dist,
        y: -9.9 * s * 0.35, ry: rng() * Math.PI * 2, scale: s,
        wobble: 1.2 + rng(), tilt: 0.12, spin: (rng() - 0.5) * 0.06,
      });
    }
    this.#addDecorInstances('/models/props/iceberg_small.glb', chunkSlots, 'ice-chunk', { float: true });
    // 场内浮冰上报碰撞体：iceberg_small 水线截面半径 ≈ 7.4 × scale
    // （实测顶点数据：整模高 19.85，水线处 R/H ≈ 0.372），
    // 交给竞技场用和礁石同一套推离逻辑，船不会再穿冰而过。
    this.arena?.setDecorColliders?.(chunkSlots.map((c) => ({
      x: c.x, z: c.z, r: 7.4 * c.scale,
    })));

    // 冻在冰里的半沉船：Box 船体 + 圆柱桅杆换成 shipwreck.glb。
    // 极夜光照下这个模型是一团深色剪影，离栅栏太近会变成挡视线的黑块，
    // 所以放到 r≈165 的远景，并让船身大半没入海面（只露出船背和桅杆）。
    // 船体没有碰撞体，放场内同样会被赛艇穿过去。
    this.#addDecorInstances('/models/shipwreck.glb', [
      { x: 136, z: -93, y: -3.5, ry: 0.9, rz: 0.08, scale: 1.25 },
    ], 'ice-wreck');

    // 沉船方向的碎冰（栅栏外侧，和沉船同一条视线）
    const shardSlots = [];
    for (let i = 0; i < 6; i++) {
      const s = 0.28 + rng() * 0.22;
      shardSlots.push({
        x: 82 + rng() * 14, z: -60 + (rng() - 0.5) * 16,
        y: -9.9 * s * 0.35, ry: rng() * Math.PI * 2, scale: s,
      });
    }
    this.#addDecorInstances('/models/props/iceberg_small.glb', shardSlots, 'ice-shard');

    // 极光
    const auroraTex = auroraTexture();
    this.aurora = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: auroraTex, transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      });
      const w = 320;
      const h = 120;
      const ribbon = new THREE.Mesh(new THREE.PlaneGeometry(w, h, 1, 1), mat);
      ribbon.position.set((i - 1) * 90, 96 + i * 16, -150);
      ribbon.rotation.y = (i - 1) * 0.25;
      this.group.add(ribbon);
      this.aurora.push({
        tex: auroraTex, mat, base: 0.3, speed: 0.5 + i * 0.2, phase: i * 2, scroll: 0.012 + i * 0.008,
      });
    }

    // 雪花
    this.#particles(
      700, 0xdff2ff, 0.38, 0.85,
      () => ({
        x: (rng() - 0.5) * 170,
        y: 3 + rng() * 55,
        z: (rng() - 0.5) * 170,
        fall: 1.6 + rng() * 3,
        sway: rng() * 6,
      }),
      (data, pos, geo, time, dt) => {
        for (let i = 0; i < data.length; i++) {
          const d = data[i];
          d.y -= d.fall * dt;
          d.x += Math.sin(time * 0.8 + d.sway) * dt * 1.4;
          if (d.y < 0.4) { d.y = 50 + rng() * 10; d.x = (rng() - 0.5) * 170; d.z = (rng() - 0.5) * 170; }
          pos[i * 3] = d.x; pos[i * 3 + 1] = d.y; pos[i * 3 + 2] = d.z;
        }
        geo.attributes.position.needsUpdate = true;
      },
    );

    // 冰面寒雾
    const tex = radialTexture();
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const dist = 30 + rng() * 60;
      const s = this.#sprite(tex, 0xbfe8ff, 0.12, 18 + rng() * 22);
      s.position.set(Math.cos(a) * dist, 1.2 + rng() * 2, Math.sin(a) * dist);
    }
  }

  /**
   * 第四关背景鲸鱼：只在冰海关卡的场地外围绕圈慢游，纯氛围、不参与战斗。
   * 模型走 Boss.js 的缓存加载，材质按实例克隆，共享贴图不在这里释放。
   */
  #buildAmbientWhale() {
    const holder = new THREE.Group();
    holder.name = 'ambient-whale';
    this.scene.add(holder);
    this.ambientGroup = holder;
    loadMonsterModel('/monsters/cartoon_whale.glb').then((gltf) => {
      // 加载回来时可能已经换关：只认当前这一关、且 holder 还是同一个
      // 第 4 / 5 关都是 ice 主题（雪原），都允许挂背景鲸
      if (this.ambientGroup !== holder || getBossTheme(this.stage).props !== 'ice') return;
      const whale = instantiateMonsterModel(gltf, { height: 7.2, sink: 1.6 });
      holder.add(whale);
      const clip = gltf.animations.find((c) => /swim/i.test(c.name)) || gltf.animations[0];
      let mixer = null;
      if (clip) {
        mixer = new THREE.AnimationMixer(whale);
        mixer.clipAction(clip).play();
        this.mixers.push(mixer);
      }
      this.ambientWhales.push({
        mesh: whale, mixer, angle: Math.PI * 1.35, radius: 112, speed: 0.045, y: -1.6,
      });
    }).catch(() => { /* 背景鲸加载失败不影响关卡 */ });
  }

  /**
   * 挂载 GLB 布景实例。几何/贴图来自模块级缓存，实例只克隆节点；
   * 统一打 sharedAsset 标记，换关时 #clear 跳过贴图释放（否则下次进关卡会白模）。
   */
  #addDecorInstances(url, slots, name, { float = false } = {}) {
    if (!slots.length) return;
    const group = this.group;
    loadDecorScene(url).then((src) => {
      if (!src || !group || !group.parent) return;
      slots.forEach((s, i) => {
        const root = src.clone(true);
        root.position.set(s.x, s.y ?? 0, s.z);
        root.rotation.set(s.rx || 0, s.ry || 0, s.rz || 0);
        // scale 支持数字或 [x,y,z]：木桩这类要"细长"的件不能等比放大
        if (Array.isArray(s.scale)) root.scale.set(s.scale[0], s.scale[1], s.scale[2]);
        else root.scale.setScalar(s.scale ?? 1);
        root.name = name;
        root.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;
          o.userData.sharedAsset = true;
        });
        group.add(root);
        if (float) {
          // baseY 默认取落点高度（碎冰/漂垃圾贴水面），海草在 slots 里显式给 -0.15
          this.floaters.push({
            mesh: root,
            baseY: s.baseY ?? (s.y ?? 0),
            wobble: s.wobble ?? 0.8 + (i % 6) * 0.12,
            phase: i * 1.7,
            tilt: s.tilt ?? 0.05,
            spin: s.spin ?? 0,
          });
        }
      });
    });
  }

  #clear() {
    // 背景鲸独立于主题布景：取下即可，别去遍历释放它共享的 GLB 贴图
    if (this.ambientGroup) {
      this.scene.remove(this.ambientGroup);
      this.ambientGroup = null;
    }
    for (const m of this.mixers) m.stopAllAction();
    this.mixers = [];
    this.ambientWhales = [];
    if (!this.group) return;
    this.group.traverse((o) => {
      // 松树实例共享模块级 GLB 缓存：释放掉下次进同一关会白模/黑块
      if (o.userData?.sharedAsset) return;
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const list = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of list) {
          for (const key of Object.keys(m)) {
            const v = m[key];
            if (v && v.isTexture) v.dispose();
          }
          m.dispose();
        }
      }
    });
    this.scene.remove(this.group);
    this.group = null;
    this.aurora = null;
  }

  dispose() {
    this.#clear();
    // 主题撤掉后浮冰碰撞体也要一起清掉（否则下一关还会撞到"看不见的冰"）
    this.arena?.setDecorColliders?.([]);
    this.floaters = [];
    this.spinners = [];
    this.risers = [];
    this.pulsers = [];
    this.points = [];
  }
}
