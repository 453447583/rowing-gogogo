import * as THREE from 'three';

/**
 * 熔岩主题布景（Magma Peak 风格）—— 只有带 `mapDef.lava` 的地图才会创建。
 *
 * 为什么单独一个文件：Environment.js 已经有 5300 行、十几个按 style 分的写实布景分支。
 * 新主题整块挂进来，Environment 只留 3 处 if 守卫，其余 7 张地图连一个分支都不会多走。
 *
 * 四层氛围（从远到近）：
 *   ① 火山锥：boundary 之外一圈低模截头锥，顶点色带纵向熔岩流条纹；
 *   ② 火山口 + 冲天光柱：HDR 自发光 + billboard 加法混合，交给 PostFx 的 bloom 出星芒；
 *   ③ 上升火星：全图上空的 Points，圆形软边贴图，逐帧上飘；
 *   ④ 航道熔岩柱：沿 gates 两侧等距的黑色石柱 + 顶端发光块，夜景里勾出赛道走向。
 *
 * 所有发光体都 `toneMapped: false` 且颜色值 > 1：夜景里靠"超 1 的亮度被 bloom 抓到"
 * 才有视频那种橙红星芒，用普通 sRGB 颜色只会得到一块平涂的橙。
 */

const VOLCANOES = [
  { a: 0.42, r: 386, h: 96, base: 80, top: 13, plume: 210, width: 26 },
  { a: 1.62, r: 438, h: 68, base: 62, top: 10, plume: 96, width: 14 },
  { a: 2.88, r: 374, h: 80, base: 72, top: 12, plume: 128, width: 17 },
  { a: 4.18, r: 452, h: 58, base: 56, top: 9, plume: 72, width: 12 },
  { a: 5.34, r: 404, h: 88, base: 76, top: 12, plume: 150, width: 19 },
];

function emberTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,194,96,0.78)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

const PLUME_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLUME_FRAG = /* glsl */`
  varying vec2 vUv;
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uSeed;
  void main() {
    float x = abs(vUv.x - 0.5) * 2.0;
    float core = pow(max(0.0, 1.0 - x), 3.2);
    // 顶部收干净、底部接住火山口；幂次越大光柱越像"一束"而不是一块矩形
    float up = pow(max(0.0, 1.0 - vUv.y), 1.7);
    float flick = 0.86 + 0.14 * sin(uTime * 2.2 + uSeed + vUv.y * 11.0);
    float a = core * up * flick * 0.52;
    // 别乘太狠：HDR 值一过 3 倍，ACES + bloom 会把整根光柱烧成纯白，
    // 视频里那根是"橙红芯 + 白色边缘"，所以要留一点色相。
    gl_FragColor = vec4(uColor * (0.55 + core * 0.95), a);
  }
`;

export class LavaScenery {
  constructor(parent, mapDef) {
    this.map = mapDef;
    this.cfg = mapDef.lava ?? {};
    this.group = new THREE.Group();
    this.group.name = 'lava_scenery';
    this.time = 0;
    this.plumes = [];
    this.craters = [];
    this.embers = null;
    this.emberVel = null;

    this.#buildVolcanoes();
    this.#buildBeacons();
    this.#buildEmbers();
    parent.add(this.group);
  }

  #buildVolcanoes() {
    const cfg = this.cfg;
    const crust = new THREE.Color(cfg.crust ?? 0x160b12);
    const mid = new THREE.Color(0x33110d);
    const peak = new THREE.Color(0x8a2608);
    const flow = new THREE.Color(cfg.hot ?? 0xd8340c);
    const glowColor = new THREE.Color(cfg.core ?? 0xffc24a).multiplyScalar(1.9);
    const glowMat = new THREE.MeshBasicMaterial({
      color: glowColor, toneMapped: false, side: THREE.DoubleSide,
    });

    VOLCANOES.forEach((v, vi) => {
      const x = Math.cos(v.a) * v.r;
      const z = Math.sin(v.a) * v.r;
      const geo = new THREE.CylinderGeometry(v.top, v.base, v.h, 18, 6, false);
      const pos = geo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const tmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        const t = (py + v.h * 0.5) / v.h;                 // 0 = 山脚，1 = 山顶
        tmp.copy(crust)
          .lerp(mid, Math.min(1, t * 1.7))
          .lerp(peak, Math.max(0, (t - 0.62) / 0.38) * 0.6);
        // 纵向熔岩流：角度上 5 条亮带，越靠山顶越亮（低模卡通感，不做贴图）
        const ang = Math.atan2(pz, px);
        const streak = Math.pow(Math.max(0, Math.sin(ang * 5 + vi * 1.7)), 6);
        tmp.lerp(flow, streak * (0.12 + 0.58 * t));
        colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const cone = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 1, metalness: 0, flatShading: true,
        emissive: 0x2a0800, emissiveIntensity: 0.45,
      }));
      cone.position.set(x, v.h * 0.5, z);
      cone.name = `lava_volcano_${vi}`;
      this.group.add(cone);

      // 火山口：熔岩池 + 一圈亮环，都是 HDR 自发光（bloom 的主要来源之一）
      const pool = new THREE.Mesh(new THREE.CircleGeometry(v.top * 0.92, 20), glowMat);
      pool.rotation.x = -Math.PI / 2;
      pool.position.set(x, v.h + 0.35, z);
      this.group.add(pool);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(v.top * 1.02, 1.25, 6, 20), glowMat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(x, v.h + 0.25, z);
      this.group.add(ring);
      this.craters.push({ pool, ring, seed: vi * 1.3 });

      // 冲天光柱：billboard plane，update 里只绕 Y 轴转向相机
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uColor: {
            value: new THREE.Color(cfg.hot ?? 0xd8340c)
              .lerp(new THREE.Color(cfg.core ?? 0xffc24a), 0.35)
              .multiplyScalar(1.25),
          },
          uTime: { value: 0 },
          uSeed: { value: vi * 2.1 },
        },
        vertexShader: PLUME_VERT,
        fragmentShader: PLUME_FRAG,
        transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        toneMapped: false,
      });
      const plume = new THREE.Mesh(new THREE.PlaneGeometry(v.width, v.plume), mat);
      // plane 的 uv.y=0 在底部 → 把中心抬到 v.h + plume/2，底边正好接住火山口
      plume.position.set(x, v.h + v.plume * 0.5, z);
      plume.frustumCulled = false;
      this.group.add(plume);
      this.plumes.push({ mesh: plume, mat });
    });
  }

  /** 航道两侧的黑色石柱 + 顶端发光块：夜景里唯一能读出"赛道往哪拐"的近景节奏 */
  #buildBeacons() {
    const gates = this.map.gates;
    if (!gates || gates.length < 3) return;
    const N = gates.length;
    const HW = this.map.gateWidth;
    const places = [];
    for (let i = 0; i < N; i++) {
      const a = gates[i], b = gates[(i + 1) % N];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const n = Math.max(1, Math.round(len / 26));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const cx = a[0] + dx * t, cz = a[1] + dz * t;
        for (const s of [-1, 1]) {
          places.push({ x: cx + nx * s * (HW + 5), z: cz + nz * s * (HW + 5), nx, nz });
        }
      }
    }
    if (!places.length) return;

    const pillar = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.7, 1.15, 3.2, 6),
      new THREE.MeshStandardMaterial({
        color: 0x1a0d0e, roughness: 1, metalness: 0, flatShading: true,
        emissive: 0x3a0d04, emissiveIntensity: 0.35,
      }),
      places.length,
    );
    const lamp = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.95, 0.95, 0.95),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(this.cfg.core ?? 0xffc24a).multiplyScalar(2.1),
        toneMapped: false,
      }),
      places.length,
    );
    const dummy = new THREE.Object3D();
    places.forEach((p, i) => {
      const jitter = ((i * 9301 + 49297) % 233280) / 233280;   // 确定性伪随机，联机两端一致
      const sc = 0.82 + jitter * 0.5;
      dummy.position.set(p.x, 1.6 * sc, p.z);
      dummy.rotation.set(0, jitter * Math.PI, 0);
      dummy.scale.setScalar(sc);
      dummy.updateMatrix();
      pillar.setMatrixAt(i, dummy.matrix);
      dummy.position.set(p.x, 3.2 * sc + 0.55, p.z);
      dummy.rotation.set(0, jitter * 1.7, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      lamp.setMatrixAt(i, dummy.matrix);
    });
    pillar.instanceMatrix.needsUpdate = true;
    lamp.instanceMatrix.needsUpdate = true;
    pillar.frustumCulled = false;
    lamp.frustumCulled = false;
    this.group.add(pillar, lamp);
  }

  #buildEmbers() {
    const n = 760;
    const pos = new Float32Array(n * 3);
    const vel = new Float32Array(n * 3);
    const R = (this.map.boundary?.r ?? 300) * 1.5;
    let seed = 20261112;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * R;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = rnd() * 130;
      pos[i * 3 + 2] = Math.sin(a) * r;
      vel[i * 3] = (rnd() - 0.5) * 1.6;
      vel[i * 3 + 1] = 3.5 + rnd() * 7;
      vel[i * 3 + 2] = (rnd() - 0.5) * 1.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      map: emberTexture(), color: 0xffb257, size: 2.6, sizeAttenuation: true,
      transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, alphaTest: 0.01, toneMapped: false,
    }));
    pts.frustumCulled = false;
    pts.name = 'lava_embers';
    this.group.add(pts);
    this.embers = { pts, pos, vel, n, R };
  }

  update(dt, camera) {
    this.time += dt;
    const t = this.time;
    for (const p of this.plumes) {
      p.mat.uniforms.uTime.value = t;
      if (camera) {
        p.mesh.rotation.y = Math.atan2(
          camera.position.x - p.mesh.position.x,
          camera.position.z - p.mesh.position.z,
        );
      }
    }
    for (const c of this.craters) {
      const s = 1 + Math.sin(t * 1.6 + c.seed) * 0.08;
      c.pool.scale.setScalar(s);
      c.ring.scale.setScalar(s);
    }
    const e = this.embers;
    if (e) {
      for (let i = 0; i < e.n; i++) {
        const k = i * 3;
        e.pos[k] += e.vel[k] * dt;
        e.pos[k + 1] += e.vel[k + 1] * dt;
        e.pos[k + 2] += e.vel[k + 2] * dt;
        if (e.pos[k + 1] > 138) {
          const a = (i * 2.399963) % (Math.PI * 2);
          const r = Math.sqrt(((i * 7919) % 1000) / 1000) * e.R;
          e.pos[k] = Math.cos(a) * r;
          e.pos[k + 1] = -2;
          e.pos[k + 2] = Math.sin(a) * r;
        }
      }
      e.pts.geometry.attributes.position.needsUpdate = true;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material?.dispose?.();
    });
    this.group.removeFromParent();
  }
}
