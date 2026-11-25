import * as THREE from 'three';
import { createGLTFLoader } from './gltfLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BOSS_ARENA, BOSS_LANE, BOSS_SPAWN_DISTANCE, ARENA_ITEM_SPOTS } from '../data/bosses.js';
import { planHexPropPlacements, planHexFormation, HEX_FORMATION_PARTS } from '../data/hexRun.js';
import { makeRockMaterial } from './Textures.js';
import { fallbackHullOutline } from '../utils/hull.js';

// 外圈栅栏半径 = boundary.r − 5（栅栏模型的实际摆放半径）。
// rail_post.glb 本地 x 向半宽 0.20m × 统一缩放 2.2 = 0.44m，即柱子内缘半径
// = 栅栏半径 − 0.44。船体轮廓点压到内缘就算碰撞，船壳不会再穿进柱子。
const FENCE_INSET = 5;
const FENCE_POST_HALF = 0.2 * 2.2;
const FORMATION_SPECS = new Map(HEX_FORMATION_PARTS.map((p) => [p.id, p]));

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
    // 海克斯场景道具（每关 2~3 件）：solidProps 参与碰撞与 BOSS 避障
    this.hexProps = [];
    this.solidProps = [];
    this.hexPropsToken = 0;
    // 海克斯阵型：每关用 1 个阵型替换/改造礁石阵
    this.formation = null;
    this.formationParts = [];
    this.formationToken = 0;
    // 主题布景里的场内漂浮物（第四关冰海的浮冰）：纯装饰，但必须能挡船
    this.decorColliders = [];
    this.launchPads = [];
    this.kelpZones = [];
    this.spikeZones = [];
    this.iceFormation = false;
    this.whirlpoolToken = 0;
    // 阵型 GLB 的主题色材质缓存（同一材质 + 同一色只克隆一次）
    this.tintCache = new Map();
    this.whirlpoolUsesGlb = false;
    // GLB 模型按 URL 缓存；道具/漩涡共用，避免重复下载与重复贴图上传
    this.propCache = new Map();
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

  /** BOSS 避障 / 炮弹阻挡用的障碍列表：浮岩 + 海克斯实体道具 */
  get obstacles() {
    return this.solidProps.length ? [...this.rocks, ...this.solidProps] : this.rocks;
  }

  /**
   * 主题布景的场内碰撞体（第四关冰海的漂浮碎冰）。
   * 布景本身是纯视觉的，但它们在水面看得见、挡路，玩家会直接撞上去，
   * 所以由主题在重建时把每块冰的圆形脚印报过来，这里只负责推开船。
   */
  setDecorColliders(list) {
    this.decorColliders = Array.isArray(list) ? list : [];
  }

  // ---------- 海克斯场景道具 ----------
  /**
   * 每关换一批场景道具。位置只依赖 seed + 浮岩布局，房主客机各算一遍即可，
   * 不需要新增联机消息；模型异步加载完成前不挂碰撞，避免“看不见的空气墙”。
   */
  setHexProps(specs, seed) {
    const token = ++this.hexPropsToken;
    this.#clearHexProps();
    if (!specs?.length) return;
    const plan = this.#planHexProps(specs, seed);
    Promise.all(plan.map(async (p) => {
      const gltf = await this.#loadPropModel(p.spec.model);
      if (this.disposed || token !== this.hexPropsToken) return null;
      // 建成即入列：换关时 #clearHexProps 才能把已经加进场地的模型一起撤掉
      const prop = this.#buildHexProp(p, gltf.scene);
      this.hexProps.push(prop);
      return prop;
    })).catch(() => {});
  }

  #clearHexProps() {
    for (const prop of this.hexProps) {
      const holder = prop.topper ? prop.model : prop.holder;
      holder?.parent?.remove(holder);
    }
    this.hexProps = [];
    // 只撤小道具自己的碰撞体，别把阵型实体一起清掉
    this.solidProps = this.solidProps.filter((p) => !p.hexProp);
  }

  /** 按 seed 在环形场地上挑位置：避开出生线、BOSS 区、浮岩、漩涡、道具箱 */
  #planHexProps(specs, seed) {
    return planHexPropPlacements(specs, seed, {
      rocks: this.rocks,
      whirlpools: this.whirlpools,
      itemSpots: ARENA_ITEM_SPOTS,
      fenceRadius: this.fenceRadius,
      spawnZ: BOSS_SPAWN_DISTANCE,
    });
  }

  #loadPropModel(url) {
    let pending = this.propCache.get(url);
    if (!pending) {
      const loader = createGLTFLoader();
      pending = new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
      pending.then((gltf) => {
        // 同一份模型的 clone 共用几何/材质，销毁时由缓存统一释放
        gltf.scene.traverse((obj) => { if (obj.isMesh) obj.userData.hexShared = true; });
      }).catch(() => this.propCache.delete(url));
      this.propCache.set(url, pending);
    }
    return pending;
  }

  /** 按目标最大边长归一化，并把模型底部对齐到 y=0、水平中心对齐到原点 */
  #normalizeProp(obj, target) {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    obj.scale.multiplyScalar(target / maxDim);
    obj.updateMatrixWorld(true);
    const fitted = new THREE.Box3().setFromObject(obj);
    const center = fitted.getCenter(new THREE.Vector3());
    obj.position.x -= center.x;
    obj.position.z -= center.z;
    obj.position.y -= fitted.min.y;
    obj.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    return fitted.getSize(new THREE.Vector3());
  }

  #buildHexProp(plan, proto) {
    const { spec } = plan;
    if (plan.kind === 'topper') {
      const model = proto.clone(true);
      this.#normalizeProp(model, spec.target);
      // 摆在浮岩顶：略埋进去一点，不会像"浮在空中的奖杯"
      model.position.y += plan.rock.r * 1.2;
      model.rotation.y = (plan.rock.x * 0.7) % (Math.PI * 2);
      plan.rock.holder.add(model);
      return {
        kind: 'topper', topper: true, spec, model, holder: plan.rock.holder,
      };
    }

    const holder = new THREE.Group();
    holder.position.set(plan.x, 0, plan.z);
    holder.rotation.y = plan.ry;
    const prop = {
      kind: plan.kind, spec, x: plan.x, z: plan.z, r: spec.r, ry: plan.ry,
      holder, buoys: [],
    };

    if (plan.kind === 'buoys') {
      const n = Math.max(3, plan.count || 4);
      const arc = Math.min(Math.PI * 1.1, 0.42 * n);
      const cos = Math.cos(plan.ry);
      const sin = Math.sin(plan.ry);
      for (let i = 0; i < n; i++) {
        const buoy = proto.clone(true);
        this.#normalizeProp(buoy, spec.target);
        const a = (n === 1 ? 0 : (i / (n - 1) - 0.5)) * arc;
        const bx = Math.sin(a) * spec.r * 0.9;
        const bz = Math.cos(a) * spec.r * 0.9;
        buoy.position.set(bx, 0, bz);
        buoy.rotation.y = -a;
        holder.add(buoy);
        prop.buoys.push({
          // 局部坐标转世界：three.js 绕 Y 旋转 x' = x·cos + z·sin，z' = −x·sin + z·cos
          x: plan.x + bx * cos + bz * sin,
          z: plan.z - bx * sin + bz * cos,
          r: 1.15,
          model: buoy,
        });
      }
    } else {
      const model = proto.clone(true);
      const size = this.#normalizeProp(model, spec.target);
      model.position.y += spec.y ?? -0.15;
      holder.add(model);
      prop.model = model;
      if (plan.kind === 'ramp') {
        // 甲板高度（归一化后模型的 42% 左右是台面）：船要先抬到这里才像开上台
        prop.deckY = Math.max(0.6, size.y * 0.42 + (spec.y ?? -0.15));
        // 贴水面的发光触发环：让玩家知道"这里能弹起来"
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(spec.r * 0.8, spec.r * 1.08, 32),
          new THREE.MeshBasicMaterial({
            color: 0x7fe6ff, transparent: true, opacity: 0.45,
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
          }),
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.06;
        holder.add(ring);
        prop.ring = ring;
      }
      if (plan.kind === 'solid') {
        prop.hexProp = true;
        this.solidProps.push(prop);
      }
    }
    this.group.add(holder);
    return prop;
  }

  /**
   * 漩涡外观：classic 保留原来的手搓圆环；海克斯换成设计好的警戒圈 GLB。
   * 只换视觉，拉力逻辑和判定半径都不变。
   */
  setWhirlpoolStyle(useGlb) {
    this.whirlpoolUsesGlb = !!useGlb;
    const token = ++this.whirlpoolToken;
    for (const w of this.whirlpools) {
      if (!w.holder) continue;
      if (!w.decor) w.decor = w.holder.children.slice();
      for (const child of w.decor) child.visible = !useGlb;
      if (w.glb) {
        w.holder.remove(w.glb);
        w.glb = null;
      }
    }
    if (!useGlb) return;
    this.#loadPropModel('/models/props/whirlpool_warning.glb').then((gltf) => {
      if (this.disposed || token !== this.whirlpoolToken || !this.whirlpoolUsesGlb) return;
      for (const w of this.whirlpools) {
        if (!w.holder) continue;
        const model = gltf.scene.clone(true);
        this.#normalizeProp(model, w.r * 2);
        model.position.y = 0.07;
        w.holder.add(model);
        w.glb = model;
      }
    }).catch(() => {});
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

  // ---------- 海克斯阵型 ----------
  /**
   * 每关换 1 个阵型。位置只依赖 (阵型 id, seed)，两端各算一遍就能对上。
   * 礁石阵沿用现有浮岩；其他阵型会撤掉浮岩，用 GLB 部件重新组成场地。
   * 漩涡阵不建模型，只把 6~7 个漩涡中心交给水面着色器（见 Water.setWhirlpools）。
   */
  setFormation(def, seed, opts = {}) {
    const token = ++this.formationToken;
    this.#clearFormation();
    this.formation = def || null;
    if (!def) {
      // 回到经典模式：先撤掉上层阵型留下的漩涡，再恢复原来的两个手搓漩涡
      this.whirlpools = this.whirlpools.filter((w) => !w.formation);
      if (!this.whirlpools.length) this.#buildWhirlpools();
      return;
    }
    // 海克斯里不再保留那两个"浮在水面上的独立漩涡模型"
    this.#clearWhirlpools();
    this.iceFormation = def.id === 'iceberg';
    // 礁石阵保留本关随机旋转后的浮岩，再补 3 块实体礁石；其它阵型撤掉浮岩重摆
    const keepRocks = def.id === 'reef';
    if (!keepRocks) this.#clearRocks();
    const plan = planHexFormation(def.id, seed, {
      rocks: keepRocks ? this.rocks : [],
      itemSpots: ARENA_ITEM_SPOTS,
      fenceRadius: this.fenceRadius,
      spawnZ: BOSS_SPAWN_DISTANCE,
    });
    if (!plan) return;
    for (const w of plan.whirlpools) {
      this.whirlpools.push({
        x: w.x, z: w.z, r: w.r, spin: w.spin,
        formation: true, bossAffect: true, holder: null, arms: [],
      });
    }
    const tint = opts.tint ?? null;
    Promise.all(plan.parts.map(async (p) => {
      const spec = FORMATION_SPECS.get(p.partId);
      if (!spec) return null;
      const gltf = await this.#loadPropModel(spec.model);
      if (this.disposed || token !== this.formationToken) return null;
      return this.#buildFormationPart(p, spec, gltf.scene, tint);
    })).catch(() => {});
  }

  #buildFormationPart(plan, spec, proto, tint) {
    const holder = new THREE.Group();
    holder.position.set(plan.x, 0, plan.z);
    holder.rotation.y = plan.ry;
    let model;
    let deckY = 0;
    if (plan.kind === 'kelp') {
      // 一个 kelp 部件 = 一丛海草堆：堆心撒 blades 株，外密内疏，看起来是实心草丛
      model = new THREE.Group();
      this.#buildKelpClump(model, proto, spec, tint, plan);
    } else {
      model = proto.clone(true);
      const size = this.#normalizeProp(model, spec.target);
      model.position.y += spec.y ?? -0.15;
      // 弹射台台面高度（归一化后约 42% 高度处），给船爬台用
      deckY = Math.max(0.6, size.y * 0.42 + (spec.y ?? -0.15));
      if (tint) this.#tintModel(model, tint);
    }
    holder.add(model);
    const part = {
      kind: plan.kind, spec, x: plan.x, z: plan.z, r: spec.r, ry: plan.ry,
      holder, model, formation: true,
    };
    if (plan.kind === 'launch') part.deckY = deckY;
    if (plan.kind === 'solid') this.solidProps.push(part);
    if (plan.kind === 'kelp') {
      this.kelpZones.push({ x: plan.x, z: plan.z, r: spec.r, blades: model.children.length });
    }
    if (plan.kind === 'spikes') this.spikeZones.push({ x: plan.x, z: plan.z, r: spec.r });
    if (plan.kind === 'launch') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(spec.r * 0.78, spec.r * 1.06, 36),
        new THREE.MeshBasicMaterial({
          color: 0xffd27f, transparent: true, opacity: 0.5,
          side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
        }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.07;
      holder.add(ring);
      part.ring = ring;
      this.launchPads.push(part);
    }
    this.group.add(holder);
    this.formationParts.push(part);
    return part;
  }

  /** 阵型 GLB 按海域统一调色；材质走缓存，避免同模型反复克隆 */
  #tintModel(root, tint) {
    root.traverse((o) => {
      if (!o.isMesh) return;
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => this.#tintMaterial(m, tint))
        : this.#tintMaterial(o.material, tint);
    });
  }

  /**
   * 海草堆：围绕堆心撒 N 株海草。
   * 位置用部件坐标做确定性哈希（同 seed 两端一致，不需要同步消息）；
   * 半径用 sqrt(rand) 保证面积均匀，中心自然更密。
   */
  #buildKelpClump(group, proto, spec, tint, plan) {
    let s = ((Math.imul(Math.round(plan.x * 97), 73856093)
      ^ Math.imul(Math.round(plan.z * 97), 19349663)) >>> 0) ^ 0x9e3779b9;
    const next = () => {
      s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
      return (s & 0xffffff) / 0x1000000;
    };
    const blades = Math.max(10, spec.blades || 12);
    for (let i = 0; i < blades; i++) {
      const blade = proto.clone(true);
      this.#normalizeProp(blade, spec.target * (0.68 + next() * 0.42));
      const ang = next() * Math.PI * 2;
      const rad = Math.sqrt(next()) * spec.r * 0.62;
      blade.position.x += Math.cos(ang) * rad;
      blade.position.z += Math.sin(ang) * rad;
      blade.position.y += (spec.y ?? 0) - 0.18 - next() * 0.18;
      blade.rotation.y = next() * Math.PI * 2;
      blade.rotation.z = (next() - 0.5) * 0.16;
      if (tint) this.#tintModel(blade, tint);
      group.add(blade);
    }
  }

  #clearFormation() {
    for (const part of this.formationParts) part.holder?.parent?.remove(part.holder);
    this.formationParts = [];
    this.solidProps = this.solidProps.filter((p) => !p.formation);
    this.launchPads = [];
    this.kelpZones = [];
    this.spikeZones = [];
    this.iceFormation = false;
  }

  #clearWhirlpools() {
    for (const w of this.whirlpools) {
      if (!w.holder) continue;
      this.group.remove(w.holder);
      w.holder.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.geometry?.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m?.dispose?.();
      });
    }
    this.whirlpools = [];
  }

  /** 同一份材质 + 同一主题色只克隆一次，避免换关反复泄漏材质 */
  #tintMaterial(mat, tint) {
    if (!mat) return mat;
    const key = mat.uuid + ':' + tint;
    let out = this.tintCache.get(key);
    if (!out) {
      out = mat.clone();
      out.color = out.color.clone().multiply(new THREE.Color(tint));
      this.tintCache.set(key, out);
    }
    return out;
  }

  /** 射线最近命中距离：给血月激光做"被石头截断"的视觉长度 */
  rayHitDistance(x, z, dx, dz, max) {
    let best = max;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len;
    const nz = dz / len;
    for (const o of this.obstacles) {
      const ox = x - o.x;
      const oz = z - o.z;
      const b = ox * nx + oz * nz;
      const c = ox * ox + oz * oz - o.r * o.r;
      const disc = b * b - c;
      if (disc < 0) continue;
      const t = -b - Math.sqrt(disc);
      if (t > 0.5 && t < best) best = t;
    }
    return best;
  }

  /** 线段是否被浮岩挡住（BOSS 的扇形/冲锋会被掩体挡下） */
  blocksLine(x1, z1, x2, z2, pad = 0) {
    for (const prop of this.solidProps) {
      const dx = x2 - x1;
      const dz = z2 - z1;
      const len2 = dx * dx + dz * dz || 1;
      let t = ((prop.x - x1) * dx + (prop.z - z1) * dz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = x1 + dx * t;
      const cz = z1 + dz * t;
      if (Math.hypot(cx - prop.x, cz - prop.z) < prop.r + pad) return true;
    }
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
    const loader = createGLTFLoader();
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
  constrain(boat, dt = 1 / 60) {
    // 弹射台上升段：先把船抬到台面高度，再交给腾空重力的下一帧。
    // 放在最前面是为了不让浮力/护栏在这一小段里把船又拉回水面。
    if (boat.rampRide) {
      this.#advanceRampRide(boat, dt);
      return;
    }
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
    // 主题布景浮冰：和礁石完全同一套推离半径与反弹系数，船不会再从冰体中间穿过去
    for (const c of this.decorColliders) {
      this.#pushOut(boat, c.x, c.z, c.r + 2.2, 1.3);
    }
    // 海克斯实体道具：沉船/火山柱等按视觉脚印做圆碰撞
    // 阵型实体：冰山撞起来更弹，柱林是硬掩体
    const solidBounce = this.iceFormation ? 1.55 : 1.15;
    for (const prop of this.solidProps) {
      this.#pushOut(boat, prop.x, prop.z, prop.r + 2.2, solidBounce);
    }
    // 浮标阵：撞到会弹开，但不扣血；跳台只做触发，不挡路
    for (const prop of this.hexProps) {
      if (prop.kind === 'buoys') {
        for (const b of prop.buoys) this.#pushOut(boat, b.x, b.z, b.r + 1.8, 1.35);
      } else if (prop.kind === 'ramp') {
        this.#tryRamp(boat, prop);
      }
    }
    // 弹射器阵：与跳台同一套触发，但发射更高、滞空更久
    for (const pad of this.launchPads) this.#tryRamp(boat, pad);
  }

  #pushOut(boat, cx, cz, min, restitution) {
    const dx = boat.pos.x - cx;
    const dz = boat.pos.z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= min || d < 0.001) return;
    const nx = dx / d;
    const nz = dz / d;
    boat.pos.x = cx + nx * min;
    boat.pos.z = cz + nz * min;
    const outward = boat.vel.x * nx + boat.vel.y * nz;
    if (outward < 0) {
      boat.vel.x -= nx * outward * restitution;
      boat.vel.y -= nz * outward * restitution;
      boat.speed = boat.vel.length();
    }
  }

  /**
   * 弹射台上升段：0.07~0.22 秒内把船从水面抬到台面高度（视觉上真的"开上台"），
   * 抬升结束才切 airborne 起跳。水平方向按进入时的速度方向走，不在这里额外位移，
   * 避免和 Boat 本帧已经算过的移动叠加成两倍速。
   */
  #advanceRampRide(boat, dt) {
    const r = boat.rampRide;
    r.t = Math.min(1, r.t + dt / r.dur);
    const e = 1 - (1 - r.t) * (1 - r.t);
    boat.pos.y = r.fromY + (r.toY - r.fromY) * e;
    boat.vy = 0;
    boat.heading = Math.atan2(r.dirX, r.dirZ);
    boat.speed = r.speed;
    boat.vel.set(r.dirX * r.speed, r.dirZ * r.speed);
    if (r.t < 1) return;
    boat.rampRide = null;
    boat.airborne = true;
    boat.waveJump = true; // 海啸抛飞那套轻重力：滞空更久，落水有明显弧线
    boat.airTime = 0;
    boat.vy = r.vy;
    boat.surfaceSplashed = false;
    boat.underwaterLandingY = null;
    boat.boostTimer = Math.max(boat.boostTimer || 0, r.boost || 0.9);
  }

  /** 压上跳台/弹射台：接触即触发，不再要求从正面撞入 */
  #tryRamp(boat, prop) {
    const now = performance.now();
    if (boat.rampRide) return;
    if ((boat.hexRampAt || 0) > now - 2200) return;
    if (boat.airborne || boat.sinkTimer > 0 || boat.bubbleLiftTimer > 0) return;
    const dx = boat.pos.x - prop.x;
    const dz = boat.pos.z - prop.z;
    // 船中心进入"台面半径 + 船体半径"就算碰到：从哪个部位擦上来都会弹
    const touch = prop.r + 1.4;
    if (dx * dx + dz * dz > touch * touch) return;
    const speed = Math.hypot(boat.vel.x, boat.vel.y);
    const fx = Math.sin(prop.ry);
    const fz = Math.cos(prop.ry);
    let dirX = fx;
    let dirZ = fz;
    if (speed > 0.6) {
      // 以玩家真实速度方向为主；同向撞击时向台面正向混合 25%，
      // 看起来像被台面"顺出去"。反向/侧向擦碰保留玩家方向，避免瞬间 180° 扭转。
      dirX = boat.vel.x / speed;
      dirZ = boat.vel.y / speed;
      if (dirX * fx + dirZ * fz > 0) {
        dirX = dirX * 0.75 + fx * 0.25;
        dirZ = dirZ * 0.75 + fz * 0.25;
        const len = Math.hypot(dirX, dirZ) || 1;
        dirX /= len;
        dirZ /= len;
      }
    }
    const launchSpeed = Math.max(speed, prop.spec.minSpeed || 6);
    boat.hexRampAt = now;
    boat.rampRide = {
      t: 0,
      // 固定爬坡距离反推时长：高速时不在台面上飞过头，低速时也看得清"上台阶"
      dur: THREE.MathUtils.clamp(2.4 / Math.max(launchSpeed, 1), 0.07, 0.22),
      fromY: boat.pos.y,
      toY: Math.max(prop.deckY || 1.1, boat.pos.y + 0.6),
      vy: prop.spec.launchVy || 7.4,
      boost: prop.spec.boost || 0.9,
      dirX,
      dirZ,
      speed: launchSpeed,
    };
    boat.vy = 0;
    boat.airborne = false;
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
      if (!w.arms?.length) continue;
      w.arms.forEach((arm, i) => {
        arm.rotation.z = t * (0.6 + i * 0.35) * (i % 2 ? -1 : 1);
      });
    }
    // 弹射台光圈呼吸，颜色比普通跳台更暖，方便一眼分辨
    for (const pad of this.launchPads) {
      if (!pad.ring) continue;
      pad.ring.material.opacity = 0.34 + Math.sin(t * 2.6) * 0.14;
      pad.ring.scale.setScalar(1 + Math.sin(t * 2.6) * 0.04);
    }
    // 海克斯道具：浮标随水面起伏，跳台光圈缓慢呼吸
    for (const prop of this.hexProps) {
      if (prop.kind === 'buoys') {
        prop.buoys.forEach((b, i) => {
          b.model.position.y = Math.sin(t * 1.5 + i * 1.3) * 0.14;
        });
      } else if (prop.kind === 'ramp' && prop.ring) {
        prop.ring.material.opacity = 0.3 + Math.sin(t * 2.2) * 0.12;
        prop.ring.scale.setScalar(1 + Math.sin(t * 2.2) * 0.03);
      }
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
      // 道具/漩涡的 clone 共用缓存里的几何与材质，跳过，最后按 URL 统一释放
      if (obj.userData?.hexShared) return;
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
    for (const pending of this.propCache.values()) {
      pending.then((gltf) => {
        gltf.scene.traverse((obj) => {
          if (!obj.isMesh) return;
          obj.geometry?.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const m of mats) {
            if (!m || disposed.has(m)) continue;
            disposed.add(m);
            for (const key of ['map', 'normalMap', 'roughnessMap']) m[key]?.dispose?.();
            m.dispose();
          }
        });
      }).catch(() => {});
    }
    this.propCache.clear();
    this.scene.remove(this.group);
  }
}
