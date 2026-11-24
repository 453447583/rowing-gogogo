import * as THREE from 'three';
import { getBossAura } from '../data/bossAuras.js';

// 5 头 BOSS 的专属包围光环。
// 全部程序化生成（Canvas 符文贴图 + Ring/Plane/Points/Line），不依赖新美术资源。
//
// 结构：
//   root      挂在 boss.group 上，跟着 BOSS 走/转向（地面法阵、环绕粒子、爆发）
//   column    挂在 scene 上，按世界坐标跟随 BOSS，并每帧面向相机（背后竖向法阵）
//
// 只做画面表现，不参与任何命中/伤害判定。

const RUNE_CACHE = new Map();
const DISC_CACHE = new Map();
let SOFT_TEX = null;

/** 给外部（BOSS 眼睛等）复用的柔边光点贴图 */
export function getGlowTexture() {
  return softTexture();
}

function softTexture() {
  if (SOFT_TEX) return SOFT_TEX;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  SOFT_TEX = tex;
  return tex;
}

// ---------- 符文贴图 ----------

/** 圆形暗底贴图：让法阵在亮色水面/雪原上也有对比度 */
function discTexture(key = 'dark') {
  if (DISC_CACHE.has(key)) return DISC_CACHE.get(key);
  if (typeof document === 'undefined') return null;
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.93, 'rgba(255,255,255,0.22)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  DISC_CACHE.set(key, tex);
  return tex;
}

function circle(ctx, r) {
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
}

function ticks(ctx, r0, r1, n, width = 1.6) {
  ctx.lineWidth = width;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const long = i % 4 === 0;
    const rr = long ? r1 : r0 + (r1 - r0) * 0.32;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    ctx.stroke();
  }
}

function diamond(ctx, x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.6, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.6, y);
  ctx.closePath();
  ctx.stroke();
}

function polygon(ctx, r, n, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();
}

/** 生成一张 512 的白色符文贴图（颜色由材质 color 染色） */
function makeRuneTexture(style, kind) {
  const key = `${style}:${kind}`;
  if (RUNE_CACHE.has(key)) return RUNE_CACHE.get(key);
  if (typeof document === 'undefined') return null;
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.translate(S / 2, S / 2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  const R = S * 0.44;

  if (kind === 'ground') {
    ctx.lineWidth = 5;
    circle(ctx, R);
    ctx.lineWidth = 2.2;
    circle(ctx, R * 0.84);
    circle(ctx, R * 0.56);
    ticks(ctx, R * 0.86, R * 0.99, 64, 1.8);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      diamond(ctx, Math.cos(a) * R * 0.7, Math.sin(a) * R * 0.7, R * 0.035);
    }

    if (style === 'lava') {
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate((i / 12) * Math.PI * 2);
        ctx.beginPath();
        ctx.arc(0, -R * 0.72, R * 0.14, Math.PI * 0.16, Math.PI * 0.84);
        ctx.stroke();
        ctx.restore();
      }
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((i / 8) * Math.PI * 2 + 0.2);
        ctx.beginPath();
        ctx.moveTo(R * 0.92, 0);
        ctx.quadraticCurveTo(R * 1.04, -R * 0.07, R * 1.13, 0);
        ctx.quadraticCurveTo(R * 1.04, R * 0.07, R * 0.92, 0);
        ctx.stroke();
        ctx.restore();
      }
      polygon(ctx, R * 0.42, 6, Math.PI / 6);
    } else if (style === 'flame') {
      for (let i = 0; i < 24; i++) {
        ctx.save();
        ctx.rotate((i / 24) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.86, 0);
        ctx.quadraticCurveTo(R * 0.98, -R * 0.05, R * 1.08, 0);
        ctx.quadraticCurveTo(R * 0.96, R * 0.06, R * 0.86, 0);
        ctx.stroke();
        ctx.restore();
      }
      polygon(ctx, R * 0.46, 6, 0);
      polygon(ctx, R * 0.34, 3, -Math.PI / 2);
      polygon(ctx, R * 0.34, 3, Math.PI / 2);
    } else if (style === 'thunder') {
      for (let i = 0; i < 8; i++) {
        ctx.save();
        ctx.rotate((i / 8) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.7, 0);
        ctx.lineTo(R * 0.86, -R * 0.06);
        ctx.lineTo(R * 0.92, R * 0.04);
        ctx.lineTo(R * 1.1, -R * 0.08);
        ctx.stroke();
        ctx.restore();
      }
      polygon(ctx, R * 0.42, 3, -Math.PI / 2);
      polygon(ctx, R * 0.42, 3, Math.PI / 2);
      for (let i = 0; i < 6; i++) {
        ctx.save();
        ctx.rotate((i / 6) * Math.PI * 2 + Math.PI / 6);
        ctx.beginPath();
        ctx.moveTo(R * 0.3, 0);
        ctx.lineTo(R * 0.4, -R * 0.1);
        ctx.lineTo(R * 0.5, 0);
        ctx.stroke();
        ctx.restore();
      }
    } else if (style === 'blood') {
      for (let i = 0; i < 16; i++) {
        ctx.save();
        ctx.rotate((i / 16) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.9, 0);
        ctx.quadraticCurveTo(R * 1.03, -R * 0.08, R * 1.12, R * 0.02);
        ctx.quadraticCurveTo(R * 1.0, R * 0.08, R * 0.9, 0);
        ctx.stroke();
        ctx.restore();
      }
      // 新月
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.34, Math.PI * 0.25, Math.PI * 1.75);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(R * 0.13, 0, R * 0.26, Math.PI * 0.3, Math.PI * 1.7, true);
      ctx.stroke();
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate((i / 12) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.5, 0);
        ctx.lineTo(R * 0.58, -R * 0.04);
        ctx.stroke();
        ctx.restore();
      }
    } else { // holy
      ctx.lineWidth = 4;
      polygon(ctx, R * 0.62, 3, -Math.PI / 2);
      ctx.save();
      ctx.rotate(Math.PI);
      polygon(ctx, R * 0.62, 3, -Math.PI / 2);
      ctx.restore();
      for (let i = 0; i < 12; i++) {
        ctx.save();
        ctx.rotate((i / 12) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.88, 0);
        ctx.lineTo(R * 1.1, 0);
        ctx.stroke();
        ctx.restore();
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62, R * 0.04, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  } else {
    // 竖立法阵：外圈 + 中央纹章
    ctx.lineWidth = 5;
    circle(ctx, R);
    ctx.lineWidth = 2;
    circle(ctx, R * 0.86);
    ticks(ctx, R * 0.87, R * 0.99, 32, 3);
    for (let i = 0; i < 8; i++) {
      ctx.save();
      ctx.rotate((i / 8) * Math.PI * 2);
      diamond(ctx, 0, -R * 0.74, R * 0.045);
      ctx.restore();
    }

    if (style === 'lava' || style === 'flame') {
      // 龙眼 / 火门
      if (style === 'lava') {
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.ellipse(0, 0, R * 0.24, R * 0.12, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.12);
        ctx.lineTo(0, R * 0.12);
        ctx.lineWidth = 6;
        ctx.stroke();
        for (let i = 0; i < 10; i++) {
          ctx.save();
          ctx.rotate((i / 10) * Math.PI * 2);
          ctx.beginPath();
          ctx.moveTo(R * 0.4, 0);
          ctx.quadraticCurveTo(R * 0.52, -R * 0.08, R * 0.64, 0);
          ctx.quadraticCurveTo(R * 0.52, R * 0.08, R * 0.4, 0);
          ctx.stroke();
          ctx.restore();
        }
      } else {
        ctx.lineWidth = 5;
        // 拱门
        ctx.beginPath();
        ctx.moveTo(-R * 0.34, R * 0.5);
        ctx.lineTo(-R * 0.34, -R * 0.04);
        ctx.arc(0, -R * 0.04, R * 0.34, Math.PI, 0);
        ctx.lineTo(R * 0.34, R * 0.5);
        ctx.stroke();
        polygon(ctx, R * 0.24, 6, Math.PI / 6);
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * R * 0.5, Math.sin(a) * R * 0.5);
          ctx.quadraticCurveTo(
            Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62 - R * 0.08,
            Math.cos(a) * R * 0.74, Math.sin(a) * R * 0.74,
          );
          ctx.stroke();
        }
      }
    } else if (style === 'thunder') {
      // 四支雷枪 + 中央折线闪电
      ctx.lineWidth = 4;
      for (let i = 0; i < 4; i++) {
        ctx.save();
        ctx.rotate((i / 4) * Math.PI * 2 + Math.PI / 4);
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.5);
        ctx.lineTo(R * 0.06, -R * 0.68);
        ctx.lineTo(0, -R * 0.64);
        ctx.lineTo(-R * 0.06, -R * 0.68);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.42);
        ctx.lineTo(0, -R * 0.2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(-R * 0.08, -R * 0.34);
      ctx.lineTo(R * 0.08, -R * 0.1);
      ctx.lineTo(-R * 0.06, R * 0.02);
      ctx.lineTo(R * 0.1, R * 0.3);
      ctx.stroke();
      polygon(ctx, R * 0.44, 3, -Math.PI / 2);
    } else if (style === 'blood') {
      // 血月 + 荆棘
      ctx.globalAlpha = 0.22;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.4, Math.PI * 0.2, Math.PI * 1.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(R * 0.16, 0, R * 0.3, Math.PI * 0.28, Math.PI * 1.72, true);
      ctx.stroke();
      for (let i = 0; i < 14; i++) {
        ctx.save();
        ctx.rotate((i / 14) * Math.PI * 2);
        ctx.beginPath();
        ctx.moveTo(R * 0.52, 0);
        ctx.quadraticCurveTo(R * 0.68, -R * 0.1, R * 0.8, 0);
        ctx.stroke();
        ctx.restore();
      }
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.moveTo(-R * 0.3 + i * R * 0.15, R * 0.42);
        ctx.lineTo(-R * 0.3 + i * R * 0.15, R * 0.58);
        ctx.stroke();
      }
    } else { // holy
      // 六翼光轮
      ctx.lineWidth = 4;
      polygon(ctx, R * 0.5, 3, -Math.PI / 2);
      ctx.save();
      ctx.rotate(Math.PI);
      polygon(ctx, R * 0.5, 3, -Math.PI / 2);
      ctx.restore();
      for (const side of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          ctx.save();
          ctx.scale(side, 1);
          ctx.beginPath();
          ctx.moveTo(R * 0.26, -R * 0.08 + i * R * 0.16);
          ctx.quadraticCurveTo(R * 0.55, -R * 0.34 + i * R * 0.18, R * 0.88, -R * 0.16 + i * R * 0.2);
          ctx.quadraticCurveTo(R * 0.56, -R * 0.1 + i * R * 0.18, R * 0.26, -R * 0.08 + i * R * 0.16);
          ctx.stroke();
          ctx.restore();
        }
      }
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((i / 3) * Math.PI * 2 + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, -R * 0.14);
        ctx.lineTo(0, -R * 0.34);
        ctx.stroke();
        ctx.restore();
      }
      // 碎裂圣环：断开的几段
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.68, (i / 5) * Math.PI * 2, (i / 5) * Math.PI * 2 + 0.7);
        ctx.stroke();
      }
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  RUNE_CACHE.set(key, tex);
  return tex;
}

// ---------- 光环本体 ----------

export class BossAura {
  constructor({ scene, group, def, getCamera, hexVariant = false }) {
    this.scene = scene;
    this.group = group;
    this.def = def;
    this.cfg = getBossAura(def.id);
    this.getCamera = getCamera || null;
    this.hexOn = !!hexVariant;
    this.R = def.radius || 5;
    this.H = def.height || 7;
    this.RUNE = makeRuneTexture(this.cfg.style, 'ground');
    this.COLUMN_RUNE = makeRuneTexture(this.cfg.style, 'column');

    this.time = Math.random() * 10;
    this.phase = 1;
    this.intensity = 1;
    this.fade = 1;
    this.targetFade = 1;
    this.dim = 1;
    this.heart = 1;
    this.groundMats = [];
    this.orbitMats = [];
    this.columnMats = [];
    this.spinners = [];
    this.pulses = [];

    this.root = new THREE.Group();
    this.root.position.y = 0.09;
    group.add(this.root);

    this.#buildGround();
    this.#buildOrbit();
    this.#buildColumn();
    this.#buildSignatures();
    this.#buildHexOverlay();
  }

  // ----- 地面法阵 -----
  #buildGround() {
    const g = this.cfg.ground;
    const addRune = (layer, dy) => {
      if (!layer) return;
      const color = layer.color ?? this.cfg.tint;
      const mat = new THREE.MeshBasicMaterial({
        map: this.RUNE, color, transparent: true, opacity: layer.opacity,
        depthWrite: false, blending: THREE.NormalBlending,
        side: THREE.DoubleSide, fog: false,
      });
      const geo = this.RUNE
        ? new THREE.PlaneGeometry(this.R * layer.scale, this.R * layer.scale)
        : new THREE.RingGeometry(this.R * layer.scale * 0.4, this.R * layer.scale * 0.5, 96);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = dy;
      mesh.renderOrder = 2;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.spinners.push({ mesh, spin: layer.spin || 0 });
      this.groundMats.push({ mat, base: layer.opacity });
    };
    addRune(g.outer, 0);
    addRune(g.inner, 0.012);

    // 暗底圆盘：亮色水面/雪原上压一层，让符文有对比度
    const disc = discTexture();
    if (disc && g.outer) {
      const dsize = this.R * g.outer.scale * 0.98;
      const dmat = new THREE.MeshBasicMaterial({
        map: disc, color: 0x06030a, transparent: true, opacity: 0.22,
        depthWrite: false, side: THREE.DoubleSide, fog: false,
      });
      const dmesh = new THREE.Mesh(new THREE.PlaneGeometry(dsize, dsize), dmat);
      dmesh.rotation.x = -Math.PI / 2;
      dmesh.position.y = 0.05;
      dmesh.renderOrder = 1;
      dmesh.frustumCulled = false;
      this.root.add(dmesh);
      this.groundMats.push({ mat: dmat, base: 0.22 });
    }

    // 边界细环：远距离也能定位 BOSS（替代原来的纯红环）
    const ring = g.ring;
    if (ring) {
      const mat = new THREE.MeshBasicMaterial({
        color: ring.color ?? this.cfg.glow, transparent: true, opacity: ring.opacity,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const inner = Math.max(0.1, this.R * ring.radius - this.R * ring.width);
      const mesh = new THREE.Mesh(new THREE.RingGeometry(inner, this.R * ring.radius, 128), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.02;
      mesh.renderOrder = 3;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.boundaryRing = mesh;
      this.groundMats.push({ mat, base: ring.opacity });
    }

    // 扩散环池（招牌演出用）
    const p = g.pulse;
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: p?.color ?? this.cfg.tint, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.RingGeometry(0.965, 1, 128), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.04 + i * 0.004;
      mesh.renderOrder = 4;
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.root.add(mesh);
      this.pulses.push({ mesh, mat, life: 0, max: 1, from: 1, to: 2, base: 0.5 });
    }
  }

  #spawnPulse(strength = 1) {
    const p = this.cfg.ground.pulse;
    if (!p) return;
    const slot = this.pulses.find((s) => s.life <= 0);
    if (!slot) return;
    slot.life = slot.max = p.life;
    slot.from = p.from;
    slot.to = p.to;
    slot.base = p.opacity * strength;
    slot.mesh.visible = true;
  }

  // ----- 环绕粒子 -----
  #makePoints(count, size, color, opacity) {
    const pos = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color, size, map: softTexture(), transparent: true, opacity,
      depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: true, alphaTest: 0.01, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.root.add(pts);
    this.orbitMats.push({ mat, base: opacity });
    return { pts, geo, pos, mat };
  }

  #buildOrbit() {
    const o = this.cfg.orbit;
    if (!o) return;
    this.orbit = {};

    if (o.embers) {
      const e = o.embers;
      const sys = this.#makePoints(e.count, e.size, e.color, 0.85);
      const data = [];
      for (let i = 0; i < e.count; i++) {
        data.push(this.#emberSeed(e, i, true));
      }
      this.orbit.embers = { ...sys, data, cfg: e };
    }

    if (o.satellites) {
      this.#buildSatellites(o.satellites);
    }

    if (o.arcs) {
      this.#buildArcs(o.arcs);
    }

    if (o.mist) {
      this.orbit.mist = this.#buildSwirl(o.mist);
    }
  }

  #emberSeed(cfg, i, initial) {
    const a = Math.random() * Math.PI * 2;
    const rad = this.R * cfg.radius * (0.55 + Math.random() * 0.55);
    const h = this.H;
    const up = cfg.rise >= 0;
    return {
      a,
      rad,
      // 上升粒子从低处起，下落的从高处起
      y: initial
        ? (up ? Math.random() * h * 1.1 : Math.random() * h * 1.25)
        : (up ? 0.15 : h * 1.15),
      sp: (0.8 + Math.random() * 1.6) * Math.abs(cfg.rise) * (up ? 1 : -1),
      drift: 0.35 + Math.random() * 0.9,
      phase: Math.random() * 6.28,
      wobble: 0.15 + Math.random() * 0.35,
    };
  }

  #buildSatellites(cfg) {
    this.orbit.satellites = [];
    const tex = softTexture();
    for (let i = 0; i < cfg.count; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: cfg.color, transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      const size = Math.max(0.5, this.R * cfg.size);
      sprite.scale.setScalar(size);
      sprite.frustumCulled = false;
      this.root.add(sprite);
      this.orbit.satellites.push({
        sprite, mat, size,
        a: (i / cfg.count) * Math.PI * 2,
        r: this.R * cfg.radius,
        y: this.H * cfg.y,
        yVar: this.H * (cfg.yVar || 0),
        speed: cfg.speed,
        phase: Math.random() * 6.28,
      });
      this.orbitMats.push({ mat, base: 0.95 });
    }
  }

  #buildArcs(cfg) {
    const count = cfg.count;
    const seg = cfg.segments;
    const pos = new Float32Array(count * seg * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: cfg.color, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const lines = new THREE.LineSegments(geo, mat);
    lines.frustumCulled = false;
    this.root.add(lines);
    this.orbitMats.push({ mat, base: 0.85 });
    this.orbit.arcs = { lines, geo, pos, mat, count, seg, cfg, timer: 0 };
    this.#regenArcs();
  }

  #regenArcs() {
    const a = this.orbit?.arcs;
    if (!a) return;
    const { pos, count, seg, cfg } = a;
    const R = this.R;
    const H = this.H;
    for (let b = 0; b < count; b++) {
      const sa = Math.random() * Math.PI * 2;
      const ea = sa + (0.5 + Math.random() * 0.9) * (Math.random() < 0.5 ? 1 : -1);
      const r0 = R * (0.68 + Math.random() * 0.28);
      const r1 = R * (1.0 + Math.random() * 0.38);
      const y0 = H * (0.08 + Math.random() * 0.5);
      const y1 = H * (0.42 + Math.random() * 0.62);
      const pts = [];
      for (let s = 0; s <= seg; s++) {
        const t = s / seg;
        const ang = sa + (ea - sa) * t;
        const rr = r0 + (r1 - r0) * t;
        const j = s === 0 || s === seg ? 0 : 1;
        pts.push([
          Math.cos(ang) * rr + (Math.random() - 0.5) * R * 0.2 * j,
          y0 + (y1 - y0) * t + (Math.random() - 0.5) * R * 0.14 * j,
          Math.sin(ang) * rr + (Math.random() - 0.5) * R * 0.2 * j,
        ]);
      }
      for (let s = 0; s < seg; s++) {
        const base = ((b * seg + s) * 2) * 3;
        const p0 = pts[s];
        const p1 = pts[s + 1];
        pos[base] = p0[0]; pos[base + 1] = p0[1]; pos[base + 2] = p0[2];
        pos[base + 3] = p1[0]; pos[base + 4] = p1[1]; pos[base + 5] = p1[2];
      }
    }
    a.geo.attributes.position.needsUpdate = true;
  }

  #buildSwirl(cfg) {
    const sys = this.#makePoints(cfg.count, cfg.size, cfg.color, cfg.opacity ?? 0.2);
    const data = [];
    for (let i = 0; i < cfg.count; i++) {
      data.push({
        a: Math.random() * Math.PI * 2,
        rad: this.R * cfg.radius * (0.5 + Math.random() * 0.8),
        y: 0.3 + Math.random() * this.H * 0.5,
        speed: (0.2 + Math.random() * 0.5) * (cfg.speed || 1),
        phase: Math.random() * 6.28,
        bob: 0.2 + Math.random() * 0.5,
      });
    }
    return { ...sys, data, cfg };
  }

  // ----- 背后竖立法阵 -----
  #buildColumn() {
    const c = this.cfg.column;
    this.columnGroup = new THREE.Group();
    this.columnGroup.renderOrder = 3;
    this.scene.add(this.columnGroup);

    const size = this.H * c.size;
    const color = c.color ?? this.cfg.glow;
    const mat = new THREE.MeshBasicMaterial({
      map: this.COLUMN_RUNE, transparent: true, opacity: c.opacity, color,
      depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, fog: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
    plane.renderOrder = 2;
    plane.frustumCulled = false;
    this.columnGroup.add(plane);
    this.columnMats.push({ mat, base: c.opacity });

    // 暗底：让法阵在明亮天空/雪原前也能看清
    const disc = discTexture();
    if (disc) {
      const dmat = new THREE.MeshBasicMaterial({
        map: disc, color: this.cfg.style === 'holy' ? 0x140a2a : 0x030207,
        transparent: true, opacity: 0.62, depthWrite: false, fog: false,
      });
      const dplane = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.99, size * 0.99), dmat);
      dplane.position.z = -0.04;
      dplane.renderOrder = 1;
      dplane.frustumCulled = false;
      this.columnGroup.add(dplane);
      this.columnMats.push({ mat: dmat, base: 0.62 });
    }

    // 内层反向旋转的小法阵
    // 内层用普通混合而不是加色：亮天空/雪原前加色会把整张盘冲成白雾，
    // 内层只需要有颜色，不需要自己发光（外圈主符文已经够亮）。
    const innerMat = new THREE.MeshBasicMaterial({
      map: this.RUNE, transparent: true, opacity: c.opacity * 0.5, color: this.cfg.accent,
      depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, fog: false,
    });
    const inner = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.66, size * 0.66), innerMat);
    inner.position.z = 0.02;
    inner.renderOrder = 3;
    inner.frustumCulled = false;
    this.columnGroup.add(inner);
    this.columnMats.push({ mat: innerMat, base: c.opacity * 0.5 });
    this.columnInner = inner;

    // 背后的柔光，增强泛光
    const glowMat = new THREE.SpriteMaterial({
      map: softTexture(), color: this.cfg.tint, transparent: true, opacity: 0.1,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(size * 1.15);
    glow.renderOrder = 1;
    this.columnGroup.add(glow);
    this.columnMats.push({ mat: glowMat, base: 0.1 });

    this.columnSize = size;
  }

  // ----- 招牌演出 -----
  #buildSignatures() {
    // 爆发火星池
    this.bursts = [];
    const tex = softTexture();
    for (let i = 0; i < 26; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: 0xffffff, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      this.root.add(sprite);
      this.bursts.push({ sprite, mat, life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 1 });
    }

    // 天雷竖线（雷霆龙骑士）
    const skyMat = new THREE.LineBasicMaterial({
      color: this.cfg.signature?.color ?? 0xd8f0ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    });
    const skyPos = new Float32Array(12 * 3);
    const skyGeo = new THREE.BufferGeometry();
    skyGeo.setAttribute('position', new THREE.BufferAttribute(skyPos, 3));
    const skyLine = new THREE.Line(skyGeo, skyMat);
    skyLine.frustumCulled = false;
    skyLine.visible = false;
    this.scene.add(skyLine);
    this.skybolt = { line: skyLine, geo: skyGeo, pos: skyPos, mat: skyMat, life: 0 };

    this.sigTimer = this.cfg.signature?.every || 0;
    this.sigPhase = 1;
  }

  #spawnBurst(x, y, z, color, count, spread = 1) {
    let n = 0;
    for (const b of this.bursts) {
      if (n >= count) break;
      if (b.life > 0) continue;
      b.life = b.max = 0.7 + Math.random() * 0.5;
      const a = Math.random() * Math.PI * 2;
      const sp = (1.6 + Math.random() * 3.4) * spread;
      b.vx = Math.cos(a) * sp;
      b.vz = Math.sin(a) * sp;
      b.vy = (1.2 + Math.random() * 3.4) * spread;
      b.size = 0.35 + Math.random() * 0.5;
      b.sprite.visible = true;
      b.sprite.position.set(x, y, z);
      b.sprite.scale.setScalar(b.size * this.R * 0.45);
      b.mat.color.set(color);
      b.mat.opacity = 0;
      n++;
    }
  }

  #triggerSignature() {
    const s = this.cfg.signature;
    if (!s) return;
    const color = s.color ?? this.cfg.glow;
    if (s.kind === 'eruption') {
      this.#spawnPulse(1.2);
      this.#spawnBurst(0, 0.6, 0, color, s.count, 1.1);
    } else if (s.kind === 'fireball') {
      this.#spawnPulse(1);
      const sat = this.orbit?.satellites?.[Math.floor(Math.random() * (this.orbit.satellites.length || 1))];
      if (sat) this.#spawnBurst(sat.sprite.position.x, sat.sprite.position.y, sat.sprite.position.z, color, s.count, 1.3);
      else this.#spawnBurst(0, this.H * 0.5, 0, color, s.count, 1.3);
    } else if (s.kind === 'skybolt') {
      this.#flashSkybolt();
      this.#spawnPulse(0.8);
    } else if (s.kind === 'heartbeat') {
      this.heart = 1.3;
      this.#spawnPulse(0.55);
      this.#spawnBurst(0, this.H * 0.15, 0, color, 8, 0.5);
    } else if (s.kind === 'shockwave') {
      this.#spawnPulse(1.6);
      this.#spawnBurst(0, this.H * 0.2, 0, color, s.count, 1.5);
    } else {
      this.#spawnPulse(1);
    }
  }

  #flashSkybolt() {
    const b = this.skybolt;
    if (!b) return;
    const h = this.group.rotation.y;
    const back = this.R * (this.cfg.column.back || 1);
    const cx = this.group.position.x - Math.sin(h) * back;
    const cz = this.group.position.z - Math.cos(h) * back;
    const top = this.group.position.y + this.H * 2.6;
    const bottom = this.group.position.y + this.H * 0.55;
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const j = i === 0 || i === 11 ? 0 : 1;
      b.pos[i * 3] = cx + (Math.random() - 0.5) * this.R * 0.5 * j;
      b.pos[i * 3 + 1] = top + (bottom - top) * t;
      b.pos[i * 3 + 2] = cz + (Math.random() - 0.5) * this.R * 0.5 * j;
    }
    b.geo.attributes.position.needsUpdate = true;
    b.mat.opacity = 0.95;
    b.line.visible = true;
    b.life = 0.3;
  }

  // ----- 海克斯深渊变体叠色 -----
  #buildHexOverlay() {
    if (!this.hexOn) return;
    const tint = this.cfg.hex?.tint ?? 0x7a46c8;
    const opacity = this.cfg.hex?.opacity ?? 0.3;
    const mat = new THREE.MeshBasicMaterial({
      map: this.RUNE, color: tint, transparent: true, opacity,
      depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide, fog: false,
    });
    const scale = this.R * (this.cfg.ground.outer.scale + 0.8);
    const geo = this.RUNE
      ? new THREE.PlaneGeometry(scale, scale)
      : new THREE.RingGeometry(scale * 0.42, scale * 0.5, 96);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.03;
    mesh.frustumCulled = false;
    this.root.add(mesh);
    this.spinners.push({ mesh, spin: -0.16 });
    this.groundMats.push({ mat, base: opacity });

    // 紫色暗雾：低空缓慢盘旋
    this.hexMist = this.#buildSwirl({
      count: 30, radius: 1.5, size: 2.4, color: tint, opacity: 0.16, speed: 0.55,
    });

    // 竖法阵叠暗紫
    const purple = new THREE.Color(tint);
    for (const it of this.columnMats) it.mat.color.lerp(purple, 0.45);
  }

  // ----- 每帧更新 -----
  update(dt, { visible = true, dim = 1, dead = false } = {}) {
    this.time += dt;
    this.targetFade = dead ? 0 : (visible ? 1 : 0);
    this.fade += (this.targetFade - this.fade) * Math.min(1, dt * 4);
    this.dim += (dim - this.dim) * Math.min(1, dt * 5);
    this.heart += (1 - this.heart) * Math.min(1, dt * 3.2);
    this.root.visible = this.fade > 0.01;
    this.columnGroup.visible = this.fade > 0.01;

    const g = Math.max(0, this.fade * this.dim * this.intensity) * this.heart;
    const speed = this.phase >= 2 ? 1.35 : 1;

    for (const s of this.spinners) s.mesh.rotation.z += s.spin * dt * speed;

    for (const p of this.pulses) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        p.mat.opacity = 0;
        continue;
      }
      const k = 1 - p.life / p.max;
      p.mesh.scale.setScalar(this.R * (p.from + (p.to - p.from) * k));
      p.mat.opacity = p.base * (1 - k) * g;
    }

    for (const it of this.groundMats) it.mat.opacity = it.base * g;
    for (const it of this.columnMats) it.mat.opacity = it.base * g;
    for (const it of this.orbitMats) it.mat.opacity = it.base * g;

    this.#updateOrbit(dt, g);
    this.#updateBursts(dt, g);
    this.#updateColumn(dt, g);
    this.#updateSignatures(dt);
  }

  #updateOrbit(dt, g) {
    const o = this.orbit;
    if (!o) return;

    if (o.embers) {
      const { pos, geo, data, cfg } = o.embers;
      const up = cfg.rise >= 0;
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        d.y += d.sp * dt;
        if (up ? d.y > this.H * 1.25 : d.y < -0.4) {
          Object.assign(d, this.#emberSeed(cfg, i, false));
          d.sp = Math.abs(d.sp) * (up ? 1 : -1);
        }
        d.a += Math.sin(this.time * 0.9 + d.phase) * d.wobble * dt;
        const rad = d.rad + Math.sin(this.time * 1.3 + d.phase) * this.R * 0.06;
        pos[i * 3] = Math.cos(d.a) * rad;
        pos[i * 3 + 1] = d.y;
        pos[i * 3 + 2] = Math.sin(d.a) * rad;
      }
      geo.attributes.position.needsUpdate = true;
    }

    if (o.satellites) {
      for (const s of o.satellites) {
        s.a += s.speed * dt * (this.phase >= 2 ? 1.35 : 1);
        const y = s.y + Math.sin(this.time * 1.4 + s.phase) * s.yVar;
        s.sprite.position.set(Math.cos(s.a) * s.r, y, Math.sin(s.a) * s.r);
        const pulse = 1 + Math.sin(this.time * 3.2 + s.phase) * 0.12;
        s.sprite.scale.setScalar(s.size * pulse);
      }
    }

    if (o.arcs) {
      o.arcs.timer += dt;
      if (o.arcs.timer >= o.arcs.cfg.refresh) {
        o.arcs.timer = 0;
        this.#regenArcs();
      }
    }

    if (o.mist) this.#updateSwirl(o.mist, dt);
    if (this.hexMist) this.#updateSwirl(this.hexMist, dt);
  }

  #updateSwirl(sys, dt) {
    if (!sys) return;
    const { pos, geo, data, cfg } = sys;
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      d.a += d.speed * dt;
      const rad = d.rad + Math.sin(this.time * 0.7 + d.phase) * this.R * 0.08;
      const y = d.y + Math.sin(this.time * 0.9 + d.phase) * d.bob;
      pos[i * 3] = Math.cos(d.a) * rad;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(d.a) * rad;
    }
    geo.attributes.position.needsUpdate = true;
  }

  #updateBursts(dt, g) {
    for (const b of this.bursts) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.sprite.visible = false;
        b.mat.opacity = 0;
        continue;
      }
      b.vy -= 4.2 * dt;
      b.sprite.position.x += b.vx * dt;
      b.sprite.position.y += b.vy * dt;
      b.sprite.position.z += b.vz * dt;
      const k = b.life / b.max;
      b.mat.opacity = k * 0.9 * Math.max(0.15, g);
      b.sprite.scale.setScalar(b.size * this.R * (0.45 + (1 - k) * 0.5));
    }
  }

  #updateColumn(dt, g) {
    const c = this.cfg.column;
    const h = this.group.rotation.y;
    const back = this.R * c.back;
    const cx = this.group.position.x - Math.sin(h) * back;
    const cz = this.group.position.z - Math.cos(h) * back;
    const cy = this.group.position.y + this.H * c.y;
    this.columnGroup.position.set(cx, cy, cz);
    const cam = this.getCamera?.();
    const yaw = cam
      ? Math.atan2(cam.position.x - cx, cam.position.z - cz)
      : Math.PI;
    this.columnGroup.rotation.set(0, yaw, this.time * c.spin * (this.phase >= 2 ? 1.4 : 1));
    if (this.columnInner) this.columnInner.rotation.z = -this.time * c.spin * 2.4;
    const s = 1 + Math.sin(this.time * 1.5) * 0.015;
    this.columnGroup.scale.setScalar(s);
  }

  #updateSignatures(dt) {
    const s = this.cfg.signature;
    if (!s) return;
    if (this.sigTimer > 0) {
      this.sigTimer -= dt * (this.phase >= 2 ? 1.45 : 1);
      if (this.sigTimer <= 0) {
        this.#triggerSignature();
        this.sigTimer = s.every;
      }
    }
    const b = this.skybolt;
    if (b && b.life > 0) {
      b.life -= dt;
      b.mat.opacity = Math.max(0, b.life / 0.3) * 0.95;
      if (b.life <= 0) b.line.visible = false;
    }
  }

  /** 血量跌破 1/3 时由 Boss 调用：整体加强 + 主题色偏移 */
  setPhase(n) {
    this.phase = n;
    const p2 = this.cfg.phase2;
    this.intensity = n >= 2 ? (p2?.intensity || 1.4) : 1;
    if (n < 2 || this.phaseApplied || !p2) return;
    this.phaseApplied = true;
    const tint = new THREE.Color(p2.tint ?? this.cfg.tint);
    for (const it of this.groundMats) it.mat.color.lerp(tint, 0.32);
    for (const it of this.columnMats) it.mat.color.lerp(tint, 0.3);
    for (const it of this.orbitMats) it.mat.color.lerp(tint, 0.18);
    if (this.cfg.style === 'holy') {
      const purple = new THREE.Color(p2.tint ?? 0xb066ff);
      for (const it of this.columnMats) it.mat.color.lerp(purple, 0.5);
    }
  }

  dispose() {
    if (this.columnGroup?.parent) this.columnGroup.parent.remove(this.columnGroup);
    if (this.skybolt?.line?.parent) this.skybolt.line.parent.remove(this.skybolt.line);
    if (this.root?.parent) this.root.parent.remove(this.root);
    this.root?.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
      else obj.material?.dispose?.();
    });
    this.columnGroup?.traverse((obj) => {
      obj.geometry?.dispose?.();
      if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose?.());
      else obj.material?.dispose?.();
    });
  }
}
