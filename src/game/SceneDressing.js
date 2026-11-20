import * as THREE from 'three';
import { waveHeight } from '../utils/waves.js';
import { makeWoodTexture, makeRockMaterial } from './Textures.js';

// 场景氛围层：HDR 环境贴图 / 体积光柱 / 海鸥 / 浮标 / 浮冰 / 水下礁石。
// 全部程序化生成，不依赖外部贴图；只在 Environment 里挂一次，随后逐帧更新。

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 光柱贴图：上浓下淡 + 左右羽化，读起来就是穿云而下的丁达尔光
function beamTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const v = ctx.createLinearGradient(0, 0, 0, 256);
  v.addColorStop(0, 'rgba(255,255,255,0.9)');
  v.addColorStop(0.3, 'rgba(255,255,255,0.34)');
  v.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 64, 256);
  ctx.globalCompositeOperation = 'destination-in';
  const h = ctx.createLinearGradient(0, 0, 64, 0);
  h.addColorStop(0, 'rgba(0,0,0,0)');
  h.addColorStop(0.5, 'rgba(0,0,0,1)');
  h.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = h;
  ctx.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 路灯木纹：共享一张，纵向 repeat 拉长，灯柱的竖直纤维才明显
let lampWoodTexture = null;
function getLampWoodTexture() {
  if (lampWoodTexture) return lampWoodTexture;
  lampWoodTexture = makeWoodTexture();
  lampWoodTexture.repeat.set(1, 3);
  return lampWoodTexture;
}

export class SceneDressing {
  /**
   * @param {THREE.Scene} scene
   * @param {object} map 地图定义
   * @param {object} weather 天气预设
   * @param {THREE.WebGLRenderer} renderer 用于一次性烘焙 PMREM 环境贴图
   */
  constructor(scene, map, weather, renderer) {
    this.scene = scene;
    this.map = map;
    this.renderer = renderer || null;
    this.rng = mulberry32(24681357);
    this.group = new THREE.Group();
    // 通用海面装饰（海鸥/浮标/浮冰/礁石）：BOSS 主题场景会整组隐藏，换成自己的布景
    this.decor = new THREE.Group();
    this.group.add(this.decor);
    this.time = 0;
    this.envRT = null;
    this.pmrem = null;
    this.shafts = [];
    this.shaftsEnabled = true; // 写实天空自带太阳辉光，此时关掉屏幕对齐的体积光柱
    this.gulls = [];
    this.floaters = [];
    this.skyTop = new THREE.Color(map.skyTop);
    this.skyBottom = new THREE.Color(map.skyBottom);
    this.sunColor = new THREE.Color(map.sunColor);
    this.sunDir = new THREE.Vector3(0.45, 0.7, 0.3).normalize();

    // 熔岩主题没有海鸟、没有浮冰浮标：那几样是写实海面的专属装饰。
    // HDR 环境贴图（refreshEnvMap）照旧烘，PBR 的岩石/船体还要靠它出反射。
    if (!map.lava) {
      this.#buildSeagulls();
      this.#buildFloaters();
    }
    if (map.style === 'arena') this.#buildLamps();
    this.#buildShafts();
    if (weather) this.setWeather(weather);
    else this.refreshEnvMap();
    scene.add(this.group);
  }

  // ---------- HDR 环境贴图 ----------
  /** 用当前天空色 + 太阳方向烘一张 PMREM，让岩石/船体的 PBR 反射有真实环境光 */
  refreshEnvMap() {
    if (!this.renderer) return;
    try {
      if (!this.pmrem) {
        this.pmrem = new THREE.PMREMGenerator(this.renderer);
        this.pmrem.compileEquirectangularShader();
      }
      const tmp = new THREE.Scene();
      const dome = new THREE.Mesh(
        new THREE.SphereGeometry(12, 24, 16),
        new THREE.ShaderMaterial({
          side: THREE.BackSide,
          uniforms: {
            uTop: { value: this.skyTop },
            uBottom: { value: this.skyBottom },
            uSun: { value: this.sunColor },
            uSunDir: { value: this.sunDir },
          },
          vertexShader: /* glsl */`
            varying vec3 vDir;
            void main() {
              vDir = normalize(position);
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: /* glsl */`
            uniform vec3 uTop;
            uniform vec3 uBottom;
            uniform vec3 uSun;
            uniform vec3 uSunDir;
            varying vec3 vDir;
            void main() {
              float t = pow(clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0), 1.3);
              vec3 col = mix(uBottom, uTop, t);
              float sunAmt = max(dot(normalize(vDir), normalize(uSunDir)), 0.0);
              col += uSun * (pow(sunAmt, 320.0) * 6.0 + pow(sunAmt, 12.0) * 0.5);
              gl_FragColor = vec4(col, 1.0);
            }
          `,
        }),
      );
      tmp.add(dome);
      const rt = this.pmrem.fromScene(tmp, 0.02);
      dome.geometry.dispose();
      dome.material.dispose();
      const prev = this.envRT;
      this.envRT = rt;
      this.scene.environment = rt.texture;
      prev?.dispose();
    } catch (err) {
      console.warn('[scene] 环境贴图烘焙失败', err);
    }
  }

  // ---------- 体积光柱 ----------
  #buildShafts() {
    this.beamTex = beamTexture();
    this.shaftGroup = new THREE.Group();
    this.group.add(this.shaftGroup);
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(this.sunDir, up).normalize();
    const up2 = new THREE.Vector3().crossVectors(right, this.sunDir).normalize();
    // 5 根：加性混合的大面片在整屏叠 9 层，代价远高于观感收益
    for (let i = 0; i < 5; i++) {
      const w = 22 + this.rng() * 38;
      const h = 480 + this.rng() * 420;
      const mat = new THREE.MeshBasicMaterial({
        map: this.beamTex,
        color: 0xffe6bd,
        transparent: true,
        opacity: 0.045 + this.rng() * 0.05,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      // 光柱集中在太阳方向附近，向四周散射
      const a = this.rng() * Math.PI * 2;
      const r = this.rng() * 220;
      mesh.position.copy(this.sunDir).multiplyScalar(900)
        .addScaledVector(right, Math.cos(a) * r)
        .addScaledVector(up2, Math.sin(a) * r);
      mesh.renderOrder = 2;
      this.shaftGroup.add(mesh);
      this.shafts.push({ mesh, spin: (this.rng() - 0.5) * 0.9, base: mat.opacity });
    }
  }

  // ---------- 木质路灯（竞技场外围，暖光在夜里/黄昏会泛光） ----------
  #buildLamps() {
    const R = (this.map.boundary?.r ?? 92) + 9;
    const wood = new THREE.MeshStandardMaterial({
      color: 0x6b4a33, map: getLampWoodTexture(), roughness: 0.85, metalness: 0.05,
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0xffe3a8, emissive: 0xffb74d, emissiveIntensity: 2.6, roughness: 0.35,
    });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 0.8 });
    this.lamps = [];
    const count = 14;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const g = new THREE.Group();
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.34, 5.4, 7), wood);
      post.position.y = 2.7;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, 0.22), wood);
      arm.position.set(0.6, 5.3, 0);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.44, 0.62, 6), capMat);
      head.position.set(1.25, 5.06, 0);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), glass);
      bulb.position.set(1.25, 4.76, 0);
      g.add(post, arm, head, bulb);
      g.position.set(Math.cos(a) * R, 0, Math.sin(a) * R);
      g.rotation.y = -a;
      this.decor.add(g);
      this.lamps.push({ bulb, base: 2.6, phase: this.rng() * Math.PI * 2 });
    }
  }

  // ---------- 海鸥 ----------
  #buildSeagulls() {
    const bodyMat = new THREE.MeshBasicMaterial({ color: 0x3b4a58, side: THREE.DoubleSide });
    this.gullGroup = new THREE.Group();
    this.decor.add(this.gullGroup);
    for (let i = 0; i < 9; i++) {
      const bird = new THREE.Group();
      const wingGeo = new THREE.PlaneGeometry(3.4, 0.95);
      const left = new THREE.Mesh(wingGeo, bodyMat);
      left.position.x = -1.75;
      left.rotation.x = -Math.PI / 2;
      const right = new THREE.Mesh(wingGeo, bodyMat);
      right.position.x = 1.75;
      right.rotation.x = -Math.PI / 2;
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.42, 6, 5), bodyMat);
      body.scale.set(1, 0.75, 2.1);
      bird.add(left, right, body);
      this.gullGroup.add(bird);
      this.gulls.push({
        bird, left, right,
        angle: this.rng() * Math.PI * 2,
        radius: 90 + this.rng() * 150,
        height: 26 + this.rng() * 34,
        speed: 0.1 + this.rng() * 0.12,
        phase: this.rng() * Math.PI * 2,
      });
    }
  }

  /**
   * 到主赛道中线的最近距离（米）。露头的礁石必须靠它避让，
   * 否则航道正中会冒出一块没有碰撞体的石头，船从中间穿过去。
   */
  #routeDistance() {
    const gates = this.map?.gates || [];
    const n = gates.length;
    if (n < 2) return () => Infinity;
    return (x, z) => {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const a = gates[i];
        const b = gates[(i + 1) % n];
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
        const d = Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
        if (d < best) best = d;
      }
      return best;
    };
  }

  // ---------- 浮标 / 浮冰 / 海面礁盘 ----------
  #buildFloaters() {
    const buoyBody = new THREE.MeshStandardMaterial({ color: 0xd9543f, roughness: 0.55, metalness: 0.15 });
    const buoyCap = new THREE.MeshStandardMaterial({
      color: 0xffd98a, emissive: 0xffb347, emissiveIntensity: 2.2, roughness: 0.4,
    });
    const iceMat = new THREE.MeshStandardMaterial({
      color: 0xdff2ff, roughness: 0.28, metalness: 0.08, flatShading: true,
      emissive: 0x1b3a4a, emissiveIntensity: 0.35,
    });
    // 礁盘材质原来是一块平涂的暗青色 + flatShading：低模二十面体配上这个材质，
    // 一旦抬出水面就变成"水面上的一张深绿桌子"，比沉在水下还难看。
    // 换成写实岩石 PBR（和岸边石头/礁石同一套贴图），十块共用一份材质。
    const rockMat = makeRockMaterial({ seed: 11, repeat: 2.4 });
    // 不要再乘一个深色：反照率贴图本身已经偏暗，再压就成水面上一团黑影
    rockMat.color.setScalar(1.0);
    rockMat.envMapIntensity = 1.0;

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + this.rng() * 0.35;
      const r = 78 + this.rng() * 90;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 1.5, 8), buoyBody);
      pole.position.y = 0.75;
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), buoyCap);
      lamp.position.y = 1.68;
      g.add(pole, lamp);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      this.decor.add(g);
      this.floaters.push({ obj: g, kind: 'buoy', y: 0, phase: this.rng() * Math.PI * 2 });
    }

    for (let i = 0; i < 14; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = 60 + this.rng() * 170;
      const size = 1.6 + this.rng() * 3.4;
      const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), iceMat);
      mesh.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      mesh.rotation.set(this.rng() * 0.4, this.rng() * Math.PI, this.rng() * 0.4);
      mesh.scale.y = 0.55;
      this.decor.add(mesh);
      this.floaters.push({
        obj: mesh, kind: 'ice', phase: this.rng() * Math.PI * 2,
        spin: (this.rng() - 0.5) * 0.05,
      });
    }

    // 海面礁盘：原来是整块沉在水下（顶点恒定在 -0.1*size，只能靠浪尖偶尔露个头），
    // 玩家看到的就是"水里一团看不清的暗影"。
    // 现在按 size 立起来：纵向压到 0.85（原来的 0.62 太扁，读作"水面上一块板"），
    // 底部沉 0.18*size，露出 0.72*size——size 5m 的礁盘上岸 3.6m，像块真石头。
    // 露头就必须避开航道：这些石头没有碰撞体，压在线上会让船直接从石头里穿过去。
    const routeDist = this.#routeDistance();
    let placedRocks = 0;
    for (let i = 0; i < 48 && placedRocks < 10; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = 45 + this.rng() * 120;
      const px = Math.cos(a) * r;
      const pz = Math.sin(a) * r;
      if (routeDist(px, pz) < 26) continue;   // 至少离中线 26m，弯道内侧不压线
      const size = 2.4 + this.rng() * 4.6;
      // detail 1：二十面体细分一次，轮廓不再是能数出棱角的二十面体
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 1), rockMat);
      rock.position.set(px, -size * 0.18, pz);
      rock.scale.set(1, 0.85, 1);
      rock.rotation.y = this.rng() * Math.PI;
      rock.castShadow = true;
      rock.receiveShadow = true;
      this.decor.add(rock);
      this.floaters.push({ obj: rock, kind: 'rock' });
      placedRocks++;
    }
  }

  /** 通用海面装饰整组显隐（BOSS 主题场景用自己的布景） */
  setDecorVisible(v) {
    if (this.decor) this.decor.visible = !!v;
  }

  /** 天气切换：更新光柱颜色/强度并重烘环境贴图 */
  setWeather(w) {
    this.skyTop.set(w.skyTop ?? this.map.skyTop);
    this.skyBottom.set(w.skyBottom ?? this.map.skyBottom);
    this.sunColor.set(w.sunColor ?? this.map.sunColor);
    this.sunDir.set(...(w.sunPos || [180, 260, 120])).normalize();
    // 夜间/暴雨/暴雪：太阳光柱要么不该有（夜里只有月光），要么被云挡住
    const nightish = w.id === 'storm' || w.id === 'blizzard' || w.id === 'starry';
    const dim = nightish ? 0.25 : 1;
    for (const s of this.shafts) {
      s.mesh.material.color.copy(this.sunColor).lerp(new THREE.Color(0xffffff), 0.45);
      s.mesh.material.opacity = s.base * dim;
    }
    this.shaftGroup.visible = this.shaftsEnabled && !nightish;
    this.refreshEnvMap();
  }

  /** 体积光柱开关（写实天空下由天空着色器自己画太阳光晕） */
  setShaftsEnabled(v) {
    this.shaftsEnabled = !!v;
    if (this.shaftGroup) this.shaftGroup.visible = this.shaftsEnabled;
  }

  setUnderwater(k) {
    // 熔岩主题不建海鸥组（#buildSeagulls 被跳过），所以这里必须判空：
    // 否则每帧从 Game.#loop 抛一次 TypeError，画面看起来"渲染了"但后续逻辑全断。
    if (this.shaftGroup) this.shaftGroup.visible = this.shaftsEnabled && k < 0.5;
    if (this.gullGroup) this.gullGroup.visible = k < 0.5;
  }

  update(dt, camera) {
    this.time += dt;
    const t = this.time;

    // 丁达尔光柱：屏幕对齐 + 各自绕视线旋转，制造放射状光束
    if (camera && this.shaftGroup.visible) {
      for (const s of this.shafts) {
        s.mesh.quaternion.copy(camera.quaternion);
        s.mesh.rotateZ(s.spin + Math.sin(t * 0.06 + s.spin * 5) * 0.04);
      }
    }

    // 海鸥：绕圈飞行 + 扇翅
    for (const g of this.gulls) {
      g.angle += g.speed * dt;
      const flap = Math.sin(t * 5 + g.phase) * 0.55;
      g.left.rotation.y = flap;
      g.right.rotation.y = -flap;
      const bob = Math.sin(t * 1.2 + g.phase) * 1.6;
      g.bird.position.set(
        Math.cos(g.angle) * g.radius,
        g.height + bob,
        Math.sin(g.angle) * g.radius,
      );
      g.bird.rotation.y = -g.angle + Math.PI / 2;
    }

    // 路灯：轻微跳动，让暖光有生命感（配合 Bloom 会很明显）
    if (this.lamps) {
      for (const l of this.lamps) {
        l.bulb.material.emissiveIntensity = l.base
          + Math.sin(t * 2.3 + l.phase) * 0.35
          + Math.sin(t * 7.1 + l.phase * 2) * 0.12;
      }
    }

    // 浮标/浮冰/礁石：跟随真实波高，浮冰还会缓慢自转
    for (const f of this.floaters) {
      const p = f.obj.position;
      if (f.kind === 'rock') continue;
      const h = waveHeight(p.x, p.z, t);
      p.y = f.kind === 'buoy' ? h : h - 0.25;
      if (f.kind === 'ice') {
        f.obj.rotation.y += f.spin * dt;
        f.obj.rotation.z = Math.sin(t * 0.6 + f.phase) * 0.06;
      } else if (f.kind === 'buoy') {
        f.obj.rotation.z = Math.sin(t * 1.4 + f.phase) * 0.12;
        f.obj.rotation.x = Math.cos(t * 1.1 + f.phase) * 0.1;
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose();
    });
    this.beamTex?.dispose();
    this.envRT?.dispose();
    this.pmrem?.dispose();
    this.scene.environment = null;
    this.scene.remove(this.group);
  }
}
