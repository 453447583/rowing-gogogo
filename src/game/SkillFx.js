import * as THREE from 'three';
import { loadEffectTexture } from './effectTextures.js';

// 技能雪片贴图：六角雪花（中心实、六条短臂），比暴风雪降雪那张柔边圆点更“实”。
// 柔边圆点被喷到近景会放大成糊在屏幕上的白团，而六角形哪怕放大也还是雪片。
let flakeSprite = null;
function getFlakeSprite() {
  if (flakeSprite) return flakeSprite;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.translate(size / 2, size / 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const arm = (r0, r1, ang) => {
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
      ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
      ctx.stroke();
    };
    arm(4, 18, a);
    // 小枝晶：远看是一粒，凑近才看出是雪花
    arm(10, 14, a + 0.6);
    arm(10, 14, a - 0.6);
  }
  ctx.beginPath();
  ctx.arc(0, 0, 3.2, 0, Math.PI * 2);
  ctx.fill();
  flakeSprite = new THREE.CanvasTexture(canvas);
  flakeSprite.colorSpace = THREE.SRGBColorSpace;
  return flakeSprite;
}

// BOSS 技能的程序化粒子特效：直接用 effects 目录里现成的贴图
// （Flame01 / Thunder01 / Cloud01 / Splash01），不再复用“烟花”爆炸。
const TEX = {
  flame: '/effects/Basic/Texture/Flame01.png',
  thunder: '/effects/Basic/Texture/Thunder01.png',
  cloud: '/effects/Basic/Texture/Cloud01.png',
  splash: '/effects/Basic/Texture/Splash01.png',
  spark: '/effects/Basic/Texture/Particle01.png',
};

const PALETTE = {
  fire: { color: 0xff8a33, tint: 0xffd08a, size: 3.2, speed: 20 },
  ice: { color: 0x9fe8ff, tint: 0xffffff, size: 2.6, speed: 13 },
  thunder: { color: 0xa9c9ff, tint: 0xffffff, size: 2.4, speed: 26 },
  water: { color: 0x74d7ff, tint: 0xd8fbff, size: 2.8, speed: 15 },
  // 第四关血魔：吸取/瞬移/全屏血幕统一用暗红，和第三关的冰蓝彻底区分
  blood: { color: 0xc81f3c, tint: 0xff7d92, size: 2.9, speed: 18 },
};

/**
 * 技能视觉层：喷火 / 冰霜 / 闪电 / 水花。
 * 只负责画面表现，不参与任何命中判定。
 */
export class SkillFx {
  constructor(scene) {
    this.scene = scene;
    this.loader = new THREE.TextureLoader();
    this.tex = {};
    for (const [key, url] of Object.entries(TEX)) {
      this.tex[key] = loadEffectTexture(this.loader, url);
    }
    // 雪花用六角雪片贴图：喷出去是一粒一粒的雪，不再是 Cloud01 那种糊成一片的雾
    this.tex.snow = getFlakeSprite();
    this.particles = [];
    this.streams = [];
    this.charges = [];
    this.bolts = [];
    this.flashes = [];
    // 第四关专属：吸取漩涡 / 水柱 / 扩散浪
    this.vortices = [];
    this.pillars = [];
    this.waves = [];
  }

  #sprite(kind, color, size, opacity = 1) {
    const mat = new THREE.SpriteMaterial({
      map: this.tex[kind] || this.tex.spark,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      // 雪片走普通混合：加法混合会把白雪花叠成一团发光雾，反而更像“雾”
      blending: kind === 'snow' ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.setScalar(size);
    return sprite;
  }

  /**
   * 持续喷吐：从 (x,y,z) 沿 (dx,dz) 方向喷出锥形粒子流。
   * 粒子速度按 range 反推，保证真的能喷到 range 处（考虑阻力衰减），
   * 而不是在发射点附近糊一圈。
   */
  cone(visual, {
    x, y, z, dx, dz, angle = 55, range = 26, duration = 0.8,
  }) {
    const p = PALETTE[visual] || PALETTE.fire;
    const icy = visual === 'ice';
    // 阻力让实际位移约为 v0*0.38，所以 v0 ≈ range*2.6（雪片轻，喷得稍慢）
    const speed = Math.min(160, Math.max(24, range * (icy ? 2.0 : 2.6)));
    this.streams.push({
      visual, x, y, z, dx, dz,
      half: (angle * Math.PI) / 180 / 2,
      range, t: 0, duration, rate: icy ? 320 : 150, acc: 0,
      color: icy ? 0xeaf8ff : p.color, size: icy ? 0.34 : p.size, speed,
      // 雪片要“一粒一粒”落下去，不能像云一样越吹越大
      grow: icy ? 0.08 : 2.4,
      life: Math.min(0.95, Math.max(0.42, range / Math.max(1, speed) * 1.55)),
      tex: icy ? 'snow' : 'flame',
    });
  }

  /** 蓄力：粒子从四周向一点汇聚，读起来就是“在攒这一招” */
  charge(visual, { x, y, z, duration = 1.2, radius = 4 }) {
    this.charges.push({ visual, x, y, z, radius, t: 0, duration, rate: 80, acc: 0 });
  }

  /**
   * 命中火星：一小撮向上迸发、带重力的火星。
   * 玩家技能打中 BOSS 的"打中了"反馈就走这里——
   * 视觉主体交给 effekseer，这里只补一撮 three.js 粒子，不再画光圈。
   */
  sparks({ x, y, z, color = 0xffd28a, count = 14, up = 7, spread = 5 }) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = spread * (0.5 + Math.random());
      this.#push({
        tex: 'spark', color, size: 1.1 + Math.random() * 0.9,
        x, y, z,
        vx: Math.sin(a) * sp, vy: up * (0.5 + Math.random()), vz: Math.cos(a) * sp,
        life: 0.28 + Math.random() * 0.22, t: 0,
      });
    }
  }

  /** 一圈向外扩散的粒子 + 贴水冲击环（光环是技能落点/范围的主要可视反馈） */
  ringBurst(visual, { x, z, radius = 16, count = 48, up = 6, ring = true }) {
    const p = PALETTE[visual] || PALETTE.water;
    const icy = visual === 'ice';
    // 贴水冲击环：标出这一下打在哪里、范围多大。
    // 之前把光环一起去掉后，远距离技能只剩几粒火星，玩家根本看不出被什么打到。
    if (ring) {
      const mesh = new THREE.Mesh(
        new THREE.RingGeometry(Math.max(0.5, radius * 0.86), Math.max(0.9, radius), 96),
        new THREE.MeshBasicMaterial({
          color: icy ? 0xeaf8ff : p.color,
          transparent: true, opacity: 0.62,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.55, z);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      this.flashes.push({ mesh, t: 0, life: 0.6, mode: 'ring', base: 0.62 });
    }
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.12;
      const sp = p.speed * (0.55 + Math.random() * 0.6);
      this.#push({
        // 冰系爆点也用雪片，不然一圈 Cloud01 又是一团雾
        tex: icy ? 'snow' : visual === 'fire' ? 'flame' : 'splash',
        color: icy ? 0xeaf8ff : p.tint,
        size: icy ? 0.55 + Math.random() * 0.35 : p.size * (0.6 + Math.random() * 0.7),
        grow: icy ? 0.1 : 1.6,
        x: x + Math.sin(a) * Math.min(2.5, radius * 0.15),
        y: 0.9 + Math.random() * 1.2,
        z: z + Math.cos(a) * Math.min(2.5, radius * 0.15),
        vx: Math.sin(a) * sp, vy: up * (0.4 + Math.random()), vz: Math.cos(a) * sp,
        life: 0.55 + Math.random() * 0.35, t: 0,
      });
    }
  }

  /** 落雷：竖直闪电贴图 + 折线电弧 + 地面闪光 */
  bolt({ x, z, height = 26, color = 0xbfd4ff }) {
    const sprite = this.#sprite('thunder', color, 9, 0.95);
    sprite.position.set(x, height * 0.5, z);
    sprite.scale.set(3.2, height, 1);
    this.scene.add(sprite);
    this.flashes.push({ mesh: sprite, t: 0, life: 0.3, mode: 'fade', base: 0.95 });

    // 折线电弧：两三条分叉，短促闪烁
    for (let b = 0; b < 2; b++) {
      const pts = [];
      let px = x + (Math.random() - 0.5) * 2;
      let pz = z + (Math.random() - 0.5) * 2;
      for (let i = 0; i <= 8; i++) {
        const k = i / 8;
        pts.push(new THREE.Vector3(
          px + (Math.random() - 0.5) * (2 + k * 4),
          height * (1 - k),
          pz + (Math.random() - 0.5) * (2 + k * 4),
        ));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      this.scene.add(line);
      this.bolts.push({ line, t: 0, life: 0.16 + b * 0.05 });
    }

    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 6 + Math.random() * 12;
      this.#push({
        tex: 'spark', color, size: 1.8 + Math.random(),
        x, y: 1.2, z,
        vx: Math.sin(a) * sp, vy: 4 + Math.random() * 9, vz: Math.cos(a) * sp,
        life: 0.35 + Math.random() * 0.25, t: 0,
      });
    }
  }

  /** 冰霜新星：一片下落的小雪片（外观对齐暴风雪地图的降雪，不再是雾团） */
  frost({ x, z, radius = 20 }) {
    for (let i = 0; i < 60; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius;
      this.#push({
        tex: 'snow', color: 0xeaf8ff, size: 0.5 + Math.random() * 0.4,
        x: x + Math.sin(a) * r, y: 1 + Math.random() * 9, z: z + Math.cos(a) * r,
        vx: Math.sin(a) * 1.2, vy: -1.5 - Math.random() * 2, vz: Math.cos(a) * 1.2,
        // 雪片不能越飘越大，只能轻微膨胀
        life: 1.0 + Math.random() * 0.4, t: 0, grow: 0.1,
      });
    }
  }

  /**
   * 吸取漩涡：外圈粒子一边绕圈一边被拽向中心（"被吸过去"的读法），
   * 同时在水面压一圈向中心收拢的光环，把吸取范围讲清楚。
   * 持续 duration 秒，期间逐帧补粒子。
   */
  vortex(visual, { x, z, radius = 40, height = 10, duration = 2.6, rate = 170 }) {
    const p = PALETTE[visual] || PALETTE.blood;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0.6, radius * 0.9), Math.max(1, radius), 96),
      new THREE.MeshBasicMaterial({
        color: p.color, transparent: true, opacity: 0.55,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.55, z);
    ring.frustumCulled = false;
    this.scene.add(ring);
    this.vortices.push({
      visual, x, z, radius, height, duration, t: 0, acc: 0, rate, ring,
    });
  }

  /** 水柱：从水面竖直炸起的柱体 + 向上的水花，读起来是"脚下喷上来" */
  pillar(visual, { x, z, radius = 6, height = 22, duration = 1.1 }) {
    const p = PALETTE[visual] || PALETTE.water;
    const geo = new THREE.CylinderGeometry(radius * 0.45, radius * 0.85, height, 18, 1, true);
    geo.translate(0, height / 2, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: p.tint, transparent: true, opacity: 0.82,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.25, z);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.pillars.push({ mesh, mat, t: 0, life: duration });
    for (let i = 0; i < 56; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * radius * 0.85;
      this.#push({
        tex: 'splash', color: i % 3 === 0 ? 0xffffff : p.tint,
        size: p.size * (0.7 + Math.random() * 0.7),
        x: x + Math.sin(a) * r, y: 0.6 + Math.random() * height * 0.65, z: z + Math.cos(a) * r,
        vx: Math.sin(a) * 1.5, vy: 12 + Math.random() * 16, vz: Math.cos(a) * 1.5,
        life: 0.6 + Math.random() * 0.4, t: 0, grow: 0.8,
      });
    }
  }

  /**
   * 扩散浪：从 (x,z) 向外的圆环波。返回对象里带 radius，
   * BossMode 用它做"浪经过船时"的逐帧判定（视觉与判定同源）。
   */
  shockwave(visual, { x, z, speed = 24, maxRadius = 92, band = false }) {
    const p = PALETTE[visual] || PALETTE.water;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.94, 1, 128),
      new THREE.MeshBasicMaterial({
        color: p.color, transparent: true, opacity: 0.8,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.55, z);
    ring.frustumCulled = false;
    this.scene.add(ring);
    // band：在亮边后面加一圈更宽的半透明水带，读起来是“有厚度的浪”，而不是一根亮线
    let skirt = null;
    if (band) {
      skirt = new THREE.Mesh(
        new THREE.RingGeometry(0.82, 0.95, 128),
        new THREE.MeshBasicMaterial({
          color: p.tint, transparent: true, opacity: 0.32,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      skirt.rotation.x = -Math.PI / 2;
      skirt.position.set(x, 0.5, z);
      skirt.frustumCulled = false;
      this.scene.add(skirt);
    }
    const wave = { ring, skirt, x, z, speed, maxRadius, t: 0, radius: 0, acc: 0, visual };
    this.waves.push(wave);
    return wave;
  }

  /** 残影：瞬移起点留下的暗色雾团（不是新模型，避免 clone 骨骼动画的开销） */
  residue(visual, { x, z, height = 8, count = 34 }) {
    const p = PALETTE[visual] || PALETTE.blood;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 3.2;
      this.#push({
        tex: 'flame', color: i % 4 === 0 ? p.tint : p.color,
        size: 2.2 + Math.random() * 2.4,
        x: x + Math.sin(a) * r, y: 0.8 + Math.random() * height, z: z + Math.cos(a) * r,
        vx: Math.sin(a) * 1.2, vy: 1.5 + Math.random() * 3, vz: Math.cos(a) * 1.2,
        life: 0.45 + Math.random() * 0.3, t: 0, grow: 1.2,
      });
    }
    const glow = this.#sprite('cloud', p.color, height * 0.7, 0.5);
    glow.position.set(x, height * 0.5, z);
    this.scene.add(glow);
    this.flashes.push({ mesh: glow, t: 0, life: 0.5, mode: 'fade', base: 0.5 });
  }

  #push(p) {
    const sprite = this.#sprite(p.tex, p.color, p.size);
    sprite.position.set(p.x, p.y, p.z);
    this.scene.add(sprite);
    this.particles.push({ sprite, ...p, grow: p.grow ?? 1.6 });
  }

  update(dt, camera = null) {
    // 持续喷吐
    for (let i = this.streams.length - 1; i >= 0; i--) {
      const s = this.streams[i];
      s.t += dt;
      s.acc += s.rate * dt;
      while (s.acc >= 1) {
        s.acc -= 1;
        const spread = (Math.random() - 0.5) * s.half * 2;
        const c = Math.cos(spread);
        const sn = Math.sin(spread);
        const dx = s.dx * c - s.dz * sn;
        const dz = s.dx * sn + s.dz * c;
        const sp = s.speed * (0.75 + Math.random() * 0.5);
        const life = s.life * (0.85 + Math.random() * 0.3);
        this.#push({
          tex: s.tex,
          color: Math.random() < 0.35 ? PALETTE[s.visual]?.tint ?? 0xffffff : s.color,
          size: s.size * (0.7 + Math.random() * 0.6),
          x: s.x + dx * 1.2 + (Math.random() - 0.5) * 1.6,
          y: s.y + (Math.random() - 0.5) * 1.4,
          z: s.z + dz * 1.2 + (Math.random() - 0.5) * 1.6,
          vx: dx * sp,
          // 雪片刚喷出去就该往下掉，火/水/雷还是保持原来的上飘手感
          vy: s.visual === 'ice' ? -0.8 - Math.random() * 2.4 : (Math.random() - 0.4) * 2.2,
          vz: dz * sp,
          life, t: 0, grow: s.grow,
        });
      }
      if (s.t >= s.duration) this.streams.splice(i, 1);
    }

    // 蓄力：四周粒子向一点汇聚
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.t += dt;
      c.acc += c.rate * dt;
      const pal = PALETTE[c.visual] || PALETTE.fire;
      const tex = c.visual === 'ice' ? 'snow'
        : c.visual === 'thunder' ? 'spark'
        : c.visual === 'water' ? 'splash' : 'flame';
      while (c.acc >= 1) {
        c.acc -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = c.radius * (0.75 + Math.random() * 0.5);
        const px = c.x + Math.sin(a) * r;
        const pz = c.z + Math.cos(a) * r;
        const py = c.y + (Math.random() - 0.5) * c.radius * 1.6;
        const sp = 22;
        this.#push({
          tex, color: Math.random() < 0.4 ? pal.tint : pal.color,
          // 冰系蓄力也是小雪片：大颗的会糊成棉絮团
          size: c.visual === 'ice' ? 0.22 + Math.random() * 0.18 : pal.size * (0.5 + Math.random() * 0.5),
          x: px, y: py, z: pz,
          vx: (c.x - px) / r * sp,
          vy: (c.y - py) / r * sp * 0.7,
          vz: (c.z - pz) / r * sp,
          life: Math.min(0.45, c.duration * 0.8), t: 0, grow: -0.55,
        });
      }
      if (c.t >= c.duration) this.charges.splice(i, 1);
    }

    // 吸取漩涡：粒子绕圈 + 向心收束
    for (let i = this.vortices.length - 1; i >= 0; i--) {
      const v = this.vortices[i];
      v.t += dt;
      v.acc += (v.rate || 160) * dt;
      const pal = PALETTE[v.visual] || PALETTE.blood;
      const tex = v.visual === 'ice' ? 'snow' : v.visual === 'water' ? 'splash' : 'flame';
      while (v.acc >= 1) {
        v.acc -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = v.radius * (0.5 + Math.random() * 0.5);
        const px = v.x + Math.sin(a) * r;
        const pz = v.z + Math.cos(a) * r;
        const py = 0.6 + Math.random() * v.height;
        const inward = 16 + Math.random() * 10;
        const spin = 9 + Math.random() * 6;
        this.#push({
          tex,
          color: Math.random() < 0.4 ? pal.tint : pal.color,
          size: pal.size * (0.55 + Math.random() * 0.5),
          x: px, y: py, z: pz,
          vx: (-Math.sin(a) * inward + Math.cos(a) * spin),
          vy: (Math.random() - 0.4) * 2.2,
          vz: (-Math.cos(a) * inward - Math.sin(a) * spin),
          life: 0.42 + Math.random() * 0.25, t: 0, grow: -0.3,
        });
      }
      // 地面光环：向中心收拢并淡出，读起来就是“吸取范围在收缩”
      if (v.ring) {
        const k = Math.min(1, v.t / v.duration);
        const s = 1 - k * 0.55;
        v.ring.scale.set(s, s, 1);
        v.ring.material.opacity = 0.55 * (1 - k * 0.85);
      }
      if (v.t >= v.duration) {
        if (v.ring) {
          this.scene.remove(v.ring);
          v.ring.geometry.dispose();
          v.ring.material.dispose();
          v.ring = null;
        }
        this.vortices.splice(i, 1);
      }
    }

    // 水柱：快速拔高，然后整根淡出
    for (let i = this.pillars.length - 1; i >= 0; i--) {
      const p = this.pillars[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.life);
      p.mesh.scale.y = 0.22 + Math.min(1, p.t / 0.16) * 0.78;
      p.mesh.scale.x = 1 - k * 0.25;
      p.mesh.scale.z = 1 - k * 0.25;
      p.mat.opacity = 0.82 * (1 - k) * (k < 0.25 ? k / 0.25 : 1);
      if (p.t >= p.life) {
        this.scene.remove(p.mesh);
        p.mesh.geometry.dispose();
        p.mat.dispose();
        this.pillars.splice(i, 1);
      }
    }

    // 扩散浪：半径 = 速度 × 时间，波前持续补一圈水花
    for (let i = this.waves.length - 1; i >= 0; i--) {
      const w = this.waves[i];
      w.t += dt;
      w.radius = Math.min(w.maxRadius, w.speed * w.t);
      w.ring.scale.set(w.radius, w.radius, 1);
      w.ring.material.opacity = 0.8 * (1 - w.radius / Math.max(1, w.maxRadius) * 0.85);
      if (w.skirt) {
        w.skirt.scale.set(w.radius, w.radius, 1);
        w.skirt.material.opacity = 0.32 * (1 - w.radius / Math.max(1, w.maxRadius) * 0.8);
      }
      w.acc += dt;
      if (w.acc >= 0.09 && w.radius < w.maxRadius) {
        w.acc = 0;
        const pal = PALETTE[w.visual] || PALETTE.water;
        for (let n = 0; n < 7; n++) {
          const a = Math.random() * Math.PI * 2;
          const r = w.radius + (Math.random() - 0.5) * 2.5;
          this.#push({
            tex: 'splash', color: n % 3 === 0 ? 0xffffff : pal.tint,
            size: pal.size * (0.7 + Math.random() * 0.6),
            x: w.x + Math.sin(a) * r, y: 0.7, z: w.z + Math.cos(a) * r,
            vx: Math.sin(a) * 7, vy: 6 + Math.random() * 9, vz: Math.cos(a) * 7,
            life: 0.4 + Math.random() * 0.3, t: 0, grow: 0.6,
          });
        }
      }
      if (w.t * w.speed >= w.maxRadius + 3) {
        this.scene.remove(w.ring);
        w.ring.geometry.dispose();
        w.ring.material.dispose();
        if (w.skirt) {
          this.scene.remove(w.skirt);
          w.skirt.geometry.dispose();
          w.skirt.material.dispose();
        }
        this.waves.splice(i, 1);
      }
    }

    // 粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) {
        this.scene.remove(p.sprite);
        p.sprite.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.vy -= 3.5 * dt;
      p.vx *= 1 - 1.6 * dt;
      p.vz *= 1 - 1.6 * dt;
      let scale = p.size * (1 + k * p.grow);
      // 雪片飘到镜头前会变成糊在屏幕上的大白团（暴风雪地图用近景安全圈解决同样的问题）。
      // 这里按距离收一下尺寸：4.5m 内按比例缩小，远距离保持不变。
      if (camera && p.tex === 'snow') {
        const d = p.sprite.position.distanceTo(camera.position);
        if (d < 4.5) scale *= Math.max(0.22, d / 4.5);
      }
      p.sprite.scale.setScalar(scale);
      p.sprite.material.opacity = 1 - k;
    }

    // 闪光/光环
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.life);
      if (f.mode === 'ring') {
        f.mesh.scale.setScalar(1 + k * 0.25);
        f.mesh.material.opacity = (f.base ?? 0.7) * (1 - k);
      } else {
        f.mesh.material.opacity = f.base * (1 - k) * (k < 0.4 ? 1 : 0.6);
      }
      if (k >= 1) {
        this.scene.remove(f.mesh);
        f.mesh.material?.dispose();
        f.mesh.geometry?.dispose();
        this.flashes.splice(i, 1);
      }
    }

    // 电弧
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t += dt;
      const k = Math.min(1, b.t / b.life);
      b.line.material.opacity = 0.95 * (1 - k);
      if (k >= 1) {
        this.scene.remove(b.line);
        b.line.geometry.dispose();
        b.line.material.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  clear() {
    for (const p of this.particles) {
      this.scene.remove(p.sprite);
      p.sprite.material.dispose();
    }
    for (const f of this.flashes) {
      this.scene.remove(f.mesh);
      f.mesh.material?.dispose();
      f.mesh.geometry?.dispose();
    }
    for (const b of this.bolts) {
      this.scene.remove(b.line);
      b.line.geometry.dispose();
      b.line.material.dispose();
    }
    for (const v of this.vortices) {
      if (!v.ring) continue;
      this.scene.remove(v.ring);
      v.ring.geometry.dispose();
      v.ring.material.dispose();
    }
    for (const p of this.pillars) {
      this.scene.remove(p.mesh);
      p.mesh.geometry.dispose();
      p.mat.dispose();
    }
    for (const w of this.waves) {
      this.scene.remove(w.ring);
      w.ring.geometry.dispose();
      w.ring.material.dispose();
      if (w.skirt) {
        this.scene.remove(w.skirt);
        w.skirt.geometry.dispose();
        w.skirt.material.dispose();
      }
    }
    this.particles = [];
    this.streams = [];
    this.charges = [];
    this.flashes = [];
    this.bolts = [];
    this.vortices = [];
    this.pillars = [];
    this.waves = [];
  }
}
