import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOSS_ARENA, BOSS_LANE, BOSS_SPAWN_DISTANCE } from '../data/bosses.js';
import { makeRockMaterial } from './Textures.js';
import { fallbackHullOutline } from '../utils/hull.js';

// 外圈栅栏半径 = boundary.r − 5（栅栏模型的实际摆放半径）。
// rail_post.glb 本地 x 向半宽 0.20m × 统一缩放 2.2 = 0.44m，即柱子内缘半径
// = 栅栏半径 − 0.44。船体轮廓点压到内缘就算碰撞，船壳不会再穿进柱子。
const FENCE_INSET = 5;
const FENCE_POST_HALF = 0.2 * 2.2;

// 默认浮岩布局（主题场景接管后会按关卡替换）
const DEFAULT_ROCK_LAYOUT = [
  { x: -24, z: 32, r: 4.6 },
  { x: 22, z: 28, r: 5.0 },
  { x: -36, z: 4, r: 5.4 },
  { x: 35, z: -2, r: 4.8 },
  { x: -20, z: -26, r: 5.2 },
  { x: 22, z: -27, r: 4.6 },
  { x: 0, z: -46, r: 5.6 },
];

// 怪物模式专用圆形竞技场：没有赛道门、没有护栏，只有一圈发光浮标和圆形边界。
// 接口刻意与 Track 对齐（spawnTransform / constrain / updateVisual / dispose），
// 这样 Game 里两套模式可以走同一套艇更新流程。
export class BossArena {
  constructor(scene, arenaDef = BOSS_ARENA) {
    this.scene = scene;
    this.def = arenaDef;
    this.gates = arenaDef.gates;
    this.gateWidth = arenaDef.gateWidth;
    this.mechColliders = [];
    // Game 的艇更新流程统一展开 [...colliders, ...track.shoreColliders, ...track.mechColliders]，
    // 竞技场没有岸边护栏，但必须给出空数组，否则展开 undefined 会直接抛错（BOSS 模式进不去）。
    this.shoreColliders = [];
    this.dives = [];
    this.radius = arenaDef.boundary.r;
    // 栅栏中心线半径 / 内侧碰撞半径（船体轮廓必须停在内缘之内）
    this.fenceRadius = this.radius - FENCE_INSET;
    this.fenceInnerRadius = this.fenceRadius - FENCE_POST_HALF;
    this.group = new THREE.Group();
    this.group.name = 'boss-arena';
    scene.add(this.group);
    // 外圈栅栏（GLB 异步加载完成前保持空场地）
    this.fence = null;
    this.disposed = false;
    // 场地障碍：浮岩当掩体（挡 BOSS 技能视线、也挡炮弹），漩涡会拉扯船
    this.rocks = [];
    this.whirlpools = [];
    this.#buildBoundaryRing();
    this.#buildGuideArc();
    this.#buildRocks(DEFAULT_ROCK_LAYOUT, {});
    this.#buildWhirlpools();
  }

  /**
   * 浮岩掩体：固定坐标（双方客户端一致，不需要网络同步）。
   * 放在第一阶段走位带的两侧，玩家可以贴着岩石躲扇形技能，也能绕后打弱点。
   * 每关的布局与外观由 BOSS 主题决定，换关时会整组重建。
   */
  #buildRocks(layout, style = {}) {
    const rockMat = makeRockMaterial({ seed: 7, repeat: 2.4 });
    rockMat.color.set(style.color ?? 0xcfd8dd);
    rockMat.roughness = style.roughness ?? 1.0;
    rockMat.metalness = style.metalness ?? 0.04;
    if (style.emissive != null) {
      rockMat.emissive.set(style.emissive);
      rockMat.emissiveIntensity = style.emissiveIntensity ?? 0.1;
    }
    const iceMat = new THREE.MeshStandardMaterial({
      color: style.cap ?? 0xbfe9ff, roughness: 0.35, metalness: 0.1,
      transparent: true, opacity: style.capOpacity ?? 0.85,
      emissive: style.capEmissive ?? 0x1a4a63, emissiveIntensity: 0.35,
    });
    const foamMat = new THREE.MeshBasicMaterial({
      color: 0xd8fbff, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (const spec of layout) {
      // h：纵向缩放（0.7 矮 / 0.85 高）；y：入水深度（负数 = 半沉）
      const vScale = spec.h ?? 0.85;
      const sink = spec.y ?? 0;
      const holder = new THREE.Group();
      holder.position.set(spec.x, sink, spec.z);
      const geo = new THREE.IcosahedronGeometry(spec.r, 2);
      // 顶点扰动：两层不同频率的形变，做出崎岖崖壁而不是圆球
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const k = 1
          + Math.sin(x * 0.9 + spec.z) * 0.16
          + Math.cos(z * 1.37 - spec.x) * 0.13
          + Math.sin(y * 2.1 + i * 0.11) * 0.05;
        pos.setXYZ(i, x * k, y * k * 1.15, z * k);
      }
      geo.computeVertexNormals();
      const rock = new THREE.Mesh(geo, rockMat);
      rock.position.y = spec.r * 0.35;
      rock.scale.y = vScale;
      rock.castShadow = true;
      holder.add(rock);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(spec.r * 0.62, 12, 8), iceMat);
      // 帽要跟着纵向缩放走，否则矮石头会"顶着一顶浮在空中的帽子"
      cap.position.y = spec.r * (0.35 + 1.15 * vScale * 0.62);
      cap.scale.set(1.15, 0.42, 1.15);
      holder.add(cap);
      // 水面泡沫环，视觉上把“这里不能撞”讲清楚
      const foam = new THREE.Mesh(
        new THREE.RingGeometry(spec.r * 0.98, spec.r * 1.22, 36),
        foamMat,
      );
      foam.rotation.x = -Math.PI / 2;
      foam.position.y = 0.08;
      holder.add(foam);
      this.group.add(holder);
      this.rocks.push({
        x: spec.x, z: spec.z, r: spec.r, holder, rock, foam, seed: spec.x, baseY: sink,
      });
    }
  }

  /** 换关：撤掉旧浮岩，按新主题重建（碰撞用的 rocks 数组同步更新） */
  setRockLayout(layout, style = {}) {
    // 主题布局单独存一份：海克斯随机变体是在它之上旋转/镜像，不能把变体当基准
    this.baseLayout = layout || [];
    this.baseStyle = style;
    this.#clearRocks();
    if (layout?.length) this.#buildRocks(layout, style);
  }

  /**
   * 海克斯：按 seed 旋转 / 镜像 / 轻微缩放浮岩布局。
   * 纯函数式变换（只依赖 seed + 主题布局），房主客机各自算一遍就能对上，
   * 不需要额外网络同步；classic 模式不会调用这里。
   */
  setRockVariant(seed) {
    if (!this.baseLayout?.length) return;
    const s = seed >>> 0;
    const baseAng = ((s % 360) / 180) * Math.PI;
    const flip = (s & 0x200) ? -1 : 1;
    // 出生点在南侧一条横线上（z=40，x=-22~22）：落位太近会让玩家一开局卡在石头里。
    // 依次试几个旋转角，第一个不压出生线的就用；都不行则退回原布局（极少见）。
    let layout = null;
    for (const delta of [0, 45, -45, 90, -90, 135, -135]) {
      const ang = baseAng + (delta / 180) * Math.PI;
      const candidate = this.baseLayout.map((spec, i) => {
        // 每块石头再抖 ±0.09rad / ±11% 半径，避免旋转后仍是"同一个阵型"
        const jitter = ((((s >>> ((i * 3) % 27)) & 7) / 7) - 0.5) * 0.18;
        const a = ang + jitter;
        const x0 = spec.x * flip;
        const x = x0 * Math.cos(a) - spec.z * Math.sin(a);
        const z = x0 * Math.sin(a) + spec.z * Math.cos(a);
        const rr = 0.9 + ((((s >>> ((i * 5 + 7) % 29)) & 15) / 15) * 0.22);
        return { ...spec, x, z, r: Math.max(3, spec.r * rr) };
      });
      if (candidate.every((rock) => !this.#blocksSpawn(rock))) {
        layout = candidate;
        break;
      }
    }
    if (!layout) return;
    this.#clearRocks();
    this.#buildRocks(layout, this.baseStyle || {});
  }

  /** 浮岩是否压到南侧出生线（4 人最外侧 x=±22，留 4m 余量） */
  #blocksSpawn(rock) {
    for (let x = -22; x <= 22; x += 11) {
      if (Math.hypot(rock.x - x, rock.z - 40) < rock.r + 4) return true;
    }
    return false;
  }

  #clearRocks() {
    for (const rock of this.rocks) {
      this.group.remove(rock.holder);
      rock.holder.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          for (const key of ['map', 'normalMap', 'roughnessMap']) m[key]?.dispose?.();
          m.dispose();
        }
      });
    }
    this.rocks = [];
  }

  /** 漩涡：持续把范围内的船往中心拽，逼玩家在躲技能时还要对抗水流 */
  #buildWhirlpools() {
    const layout = [
      { x: -40, z: 20, r: 17 },
      { x: 42, z: -14, r: 17 },
    ];
    for (const spec of layout) {
      const holder = new THREE.Group();
      holder.position.set(spec.x, 0, spec.z);
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(spec.r, 40),
        new THREE.MeshBasicMaterial({
          color: 0x06283a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false,
        }),
      );
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.04;
      holder.add(disc);
      const arms = [];
      for (let i = 0; i < 3; i++) {
        const arm = new THREE.Mesh(
          new THREE.RingGeometry(spec.r * (0.35 + i * 0.2), spec.r * (0.42 + i * 0.2), 48, 1, i * 1.9, 2.4),
          new THREE.MeshBasicMaterial({
            color: 0x74d7ff, transparent: true, opacity: 0.42 - i * 0.08,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
          }),
        );
        // 环形叶片放进已压平的枢轴里，之后只转叶片自身的 Z 轴（绕水面法线旋转）
        const pivot = new THREE.Group();
        pivot.rotation.x = -Math.PI / 2;
        pivot.position.y = 0.06 + i * 0.01;
        pivot.add(arm);
        holder.add(pivot);
        arms.push(arm);
      }
      this.group.add(holder);
      this.whirlpools.push({ x: spec.x, z: spec.z, r: spec.r, holder, arms });
    }
  }

  /** 线段是否被浮岩挡住（BOSS 的扇形/冲锋会被掩体挡下） */
  blocksLine(x1, z1, x2, z2, pad = 0) {
    for (const rock of this.rocks) {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((rock.x - x1) * dx + (rock.z - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = x1 + dx * t;
      const cz = z1 + dz * t;
      if (Math.hypot(cx - rock.x, cz - rock.z) < rock.r + pad) return true;
    }
    return false;
  }

  // ---------- 场地装饰 ----------
  /**
   * 场地外圈：用栈桥护栏模型（rail_post + rail_beam）拼一圈有木纹的栅栏，
   * 替换原来那圈发光蓝色浮标 + 蓝色贴水圆环。
   * 两个模型先合并几何体再走 InstancedMesh，64 根柱子 + 128 根横梁只占 4 个 draw call。
   */
  #buildBoundaryRing() {
    const N = 64;
    const r = this.fenceRadius;
    const loader = new GLTFLoader();
    const load = (url) => new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
    Promise.all([
      load('/models/track/rail_post.glb'),
      load('/models/track/rail_beam.glb'),
    ]).then(([postGltf, beamGltf]) => {
      if (this.disposed) return;
      // 把一个 GLB 里的多个网格（多材质）合到一块几何体上，保留原贴图材质
      const bake = (gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const geos = [];
        const mats = [];
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          const g = o.geometry.clone();
          g.applyMatrix4(o.matrixWorld);
          geos.push(g);
          mats.push(o.material);
        });
        if (!geos.length) return null;
        let merged = null;
        try { merged = mergeGeometries(geos, true); } catch { /* 属性不一致时退回单块 */ }
        if (!merged) {
          merged = geos[0];
          mats.length = 1;
        }
        // 合并成功后原几何体数据已经拷进 merged，可以释放
        for (const g of geos) {
          if (g !== merged) g.dispose?.();
        }
        return { geo: merged, mat: mats.length > 1 ? mats : mats[0] };
      };
      const postSrc = bake(postGltf);
      const beamSrc = bake(beamGltf);
      if (!postSrc || !beamSrc) return;

      const fence = new THREE.Group();
      fence.name = 'boss-arena-fence';
      const postMesh = new THREE.InstancedMesh(postSrc.geo, postSrc.mat, N);
      const beamMesh = new THREE.InstancedMesh(beamSrc.geo, beamSrc.mat, N * 2);
      const m = new THREE.Matrix4();
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scl = new THREE.Vector3();
      const UP = new THREE.Vector3(0, 1, 0);
      const chord = 2 * r * Math.sin(Math.PI / N); // 相邻柱子之间的弦长
      const rm = r * Math.cos(Math.PI / N);         // 横梁中点所在半径
      const postScale = 2.2;                        // 模型高 1.65m → 约 3.6m
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        pos.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        quat.setFromAxisAngle(UP, -a);
        scl.setScalar(postScale);
        m.compose(pos, quat, scl);
        postMesh.setMatrixAt(i, m);

        const am = a + Math.PI / N;
        for (let row = 0; row < 2; row++) {
          pos.set(Math.cos(am) * rm, 1.02 + row * 1.05, Math.sin(am) * rm);
          quat.setFromAxisAngle(UP, -am);
          scl.set(2.4, 2.4, chord);
          m.compose(pos, quat, scl);
          beamMesh.setMatrixAt(i * 2 + row, m);
        }
      }
      postMesh.instanceMatrix.needsUpdate = true;
      beamMesh.instanceMatrix.needsUpdate = true;
      for (const mesh of [postMesh, beamMesh]) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        fence.add(mesh);
      }
      this.fence = fence;
      this.group.add(fence);
    }).catch(() => { /* 模型加载失败时保持空场地，不影响玩法 */ });
  }

  /**
   * 地面引导线：三段弧，提示"大致绕这条线跑"。
   * 半径 46m（BOSS_LANE.far = 52，玩家够得着），纯视觉、不参与判定。
   * 原来场中心的两个静态同心环已删除——BOSS 脚下现在有自己的红环。
   */
  #buildGuideArc() {
    const cfg = this.def.marks || {};
    const r = cfg.guideR ?? 46;
    this.guideMat = new THREE.MeshBasicMaterial({
      color: cfg.guideColor ?? 0xff8a3a,
      transparent: true, opacity: 0.16, side: THREE.DoubleSide,
      depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.guide = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const start = (i / 3) * Math.PI * 2 + 0.18;
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.45, r + 0.45, 96, 1, start, (Math.PI * 2) / 3 - 0.4),
        this.guideMat,
      );
      arc.rotation.x = -Math.PI / 2;
      arc.position.y = 0.06;
      arc.frustumCulled = false;
      this.guide.add(arc);
    }
    this.group.add(this.guide);
  }

  // ---------- 出生点：所有玩家在南侧排开，面朝中央的 BOSS ----------
  spawnTransform(index, count = 1) {
    const n = Math.max(1, count);
    const span = Math.min(44, 13 * (n - 1));
    const lateral = n === 1 ? 0 : (index / (n - 1) - 0.5) * span;
    // 出生点必须落在第一阶段通道内（离 BOSS ≤ BOSS_LANE.far），
    // 否则开打那一帧会被 constrainBoat 硬拉回来，看起来像瞬移/空气墙。
    const z = BOSS_SPAWN_DISTANCE;
    const x = lateral;
    const heading = Math.atan2(-x, -z); // 朝向 (0,0)
    return { x, z, heading };
  }

  /**
   * 外圈栅栏碰撞：和 Track.constrain 同一口径 —— 逐点把船体真实水平轮廓
   * （boat.hullFootprint，GLB 顶点凸包）变换到世界坐标，任何一个点冲出栅栏
   * 内缘就把整船沿径向推回。旧版只钳船中心（radius − 2.5 = 89.5m），而栅栏
   * 在 87m，船头/船尾还会再伸出 2~3.3m → 视觉上船已经穿进栅栏才被拦。
   */
  constrain(boat) {
    const bx = this.def.boundary.x;
    const bz = this.def.boundary.z;
    const limit = this.fenceInnerRadius;
    const fxx = Math.sin(boat.heading);
    const fzz = Math.cos(boat.heading);
    const lxx = fzz;
    const lzz = -fxx;
    const outline = boat.hullFootprint || fallbackHullOutline(boat.def?.hull);
    let worstOver = 0;
    let worstNx = 0, worstNz = 0;
    for (let i = 0; i < (outline.length >> 1); i++) {
      // 轮廓局部坐标：lx = 右舷分量、lz = 船头分量
      const lx = outline[i * 2];
      const lz = outline[i * 2 + 1];
      const dx = boat.pos.x + lxx * lx + fxx * lz - bx;
      const dz = boat.pos.z + lzz * lx + fzz * lz - bz;
      const d = Math.hypot(dx, dz);
      const over = d - limit;
      if (over > worstOver) {
        worstOver = over;
        worstNx = dx / (d || 1);
        worstNz = dz / (d || 1);
      }
    }
    if (worstOver > 0.001) {
      boat.pos.x -= worstNx * worstOver;
      boat.pos.z -= worstNz * worstOver;
      const nx = worstNx;
      const nz = worstNz;
      const outward = boat.vel.x * nx + boat.vel.y * nz;
      if (outward > 0) {
        const tx = boat.vel.x - outward * nx;
        const tz = boat.vel.y - outward * nz;
        const restitution = 0.10 + 0.34 * THREE.MathUtils.clamp((outward - 4) / 14, 0, 1);
        boat.vel.x = tx * 0.96 - outward * restitution * nx;
        boat.vel.y = tz * 0.96 - outward * restitution * nz;
        boat.speed = boat.vel.length();
      }
      boat.wallContactTimer = 0.35;
      boat.wallNx = nx;
      boat.wallNz = nz;
    }
    // 浮岩：圆形碰撞体，撞上会被推出去并损失横向速度（不反弹成弹球）
    for (const rock of this.rocks) {
      const rx = boat.pos.x - rock.x;
      const rz = boat.pos.z - rock.z;
      const rd = Math.hypot(rx, rz);
      const min = rock.r + 2.2;
      if (rd >= min || rd < 0.001) continue;
      const nx = rx / rd;
      const nz = rz / rd;
      boat.pos.x = rock.x + nx * min;
      boat.pos.z = rock.z + nz * min;
      const outward = boat.vel.x * nx + boat.vel.y * nz;
      if (outward < 0) {
        boat.vel.x -= nx * outward * 1.3;
        boat.vel.y -= nz * outward * 1.3;
        boat.speed = boat.vel.length();
      }
    }
  }

  applyMechs() {}
  updateCoaster() {}
  keepAfterFinishLine() {}
  checkGate() { return false; }
  progress() { return 0; }
  totalProgressUnits() { return 1; }
  gatePos(i) {
    return this.gates[i % this.gates.length];
  }
  nearestGate() { return 0; }
  diveHeightAt() { return 0; }
  isWrongWay() { return false; }
  aiShortcutTarget() { return null; }

  updateVisual(_gate, t) {
    if (this.guide) this.guide.rotation.y = t * 0.09;
    // 浮岩随水面轻轻起伏；漩涡叶片反向旋转，和“往中心吸”的方向一致
    for (const rock of this.rocks) {
      rock.holder.position.y = (rock.baseY || 0) + Math.sin(t * 0.8 + rock.seed) * 0.18;
      rock.foam.scale.setScalar(1 + Math.sin(t * 1.6 + rock.seed) * 0.04);
    }
    for (const w of this.whirlpools) {
      w.arms.forEach((arm, i) => {
        arm.rotation.z = t * (0.6 + i * 0.35) * (i % 2 ? -1 : 1);
      });
    }
  }

  updateMechs(dt, t) {
    this.updateVisual(0, t);
  }

  dispose() {
    this.disposed = true;
    const disposed = new Set();
    this.group.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m || disposed.has(m)) continue;
        disposed.add(m);
        // 程序化 PBR 贴图（岩石法线/粗糙度）也要一起释放
        for (const key of ['map', 'normalMap', 'roughnessMap']) m[key]?.dispose?.();
        m.dispose();
      }
    });
    this.scene.remove(this.group);
  }
}
