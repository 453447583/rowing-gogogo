import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  BOSS_SKILLS, BOSS_GRACE_TIME, BOSS_PHASE_THRESHOLDS, BOSS_PHASE2_RATIO, BOSS_STAGGER,
} from '../data/bosses.js';
import { waveHeight } from '../utils/waves.js';

const modelCache = new Map();
// 客机回放 BOSS 位置时的固定延迟（秒）：等于主机的同步间隔，正好够插值补帧。
// 数值太小会插不上（前一个快照还没到），太大则 BOSS 明显慢半拍。
const NET_REPLAY_DELAY = 0.1;

/** 海克斯模式：把本关技能顺序整体洗一遍（Fisher–Yates），每局每关都不同 */
function shuffledSkills(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function loadMonsterModel(url) {
  if (!modelCache.has(url)) {
    const loader = new GLTFLoader();
    modelCache.set(url, new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject)));
  }
  return modelCache.get(url);
}
const loadBossModel = loadMonsterModel;

/**
 * 从缓存的 gltf 克隆一份独立模型，并按高度归一化：
 * 水平居中、最低点刚好落在 y = -sink（沉入水面的深度）。
 * 必须每次重新克隆再测量——直接改 gltf.scene 会污染缓存，
 * 后续实例会在“已经被缩放过”的模型上再缩放一次，于是越缩越小、
 * 整体重心被抬到空中（这就是 2/3/4 关 BOSS 浮空的原因）。
 */
export function instantiateMonsterModel(gltf, { height, sink = 0.45, rotationY = 0 }) {
  const root = cloneSkinned(gltf.scene);
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = false;
    // 每个实例独立材质，受击闪白互不影响
    if (Array.isArray(obj.material)) obj.material = obj.material.map((m) => m.clone());
    else if (obj.material) obj.material = obj.material.clone();
  });
  root.scale.setScalar(1);
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  root.updateMatrixWorld(true);
  const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  root.scale.setScalar(height / Math.max(0.001, size.y));
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y - sink, -center.z);
  // 用一个外层组承担朝向，避免绕自身原点旋转时把已经偏心对齐的模型甩开
  const wrapper = new THREE.Group();
  wrapper.rotation.y = rotationY;
  wrapper.add(root);
  return wrapper;
}

// 地面预警贴图：红色扇形/圆环/矩形，命中前 1.2 秒出现。
function warningMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xff3b30, transparent: true, opacity: 0.32,
    side: THREE.DoubleSide, depthWrite: false,
  });
}

/**
 * 单翅膀修复：右翼等镜像部位靠骨骼的负缩放（-1,-1,-1）实现左右镜像。
 * 补丁动画包导出时经常整段丢失这几条 scale 轨道，于是该技能一播，
 * 镜像骨回落到节点默认的 +1，整只 BOSS 就只剩一只翅膀（喷火/裂隙/激光都中过招）。
 *
 * 这里在合并完所有 clip 后统一补轨道：
 *  1. 先从所有 clip 里找出「有负缩放关键帧」的骨骼，作为镜像骨参照；
 *  2. 某个 clip 里缺这条轨道、或导出的轨道是恒等 +1（等于没镜像），
 *     就用参照值补一条从头到尾恒定的 scale 轨道。
 * 返回值里的 mirror 还要用来改写骨骼的默认缩放（见 #setupModel）：
 * 交叉淡入淡出时动作权重和会短暂小于 1，mixer 会向“绑定原值”回退，
 * 绑定原值若是 +1，右翼就会塌一帧——也就是玩家说的“一瞬间单翅膀”。
 */
export function repairMirrorScaleTracks(clips) {
  const mirrorRef = new Map();
  for (const clip of clips.values()) {
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.scale')) continue;
      const v = track.values;
      for (let i = 0; i + 2 < v.length; i += 3) {
        if (v[i] < 0 || v[i + 1] < 0 || v[i + 2] < 0) {
          mirrorRef.set(track.name.slice(0, -'.scale'.length), [v[i], v[i + 1], v[i + 2]]);
          break;
        }
      }
    }
  }
  if (!mirrorRef.size) return { fixed: 0, mirror: mirrorRef };

  let fixed = 0;
  for (const clip of clips.values()) {
    const scaleTracks = new Map();
    for (const track of clip.tracks) {
      if (track.name.endsWith('.scale')) {
        scaleTracks.set(track.name.slice(0, -'.scale'.length), track);
      }
    }
    for (const [bone, ref] of mirrorRef) {
      const existing = scaleTracks.get(bone);
      if (existing) {
        // 已经带负值就是正常的镜像轨；只有「恒等 +1」才是导出丢镜像
        const v = existing.values;
        let negative = false;
        let identity = true;
        for (let i = 0; i + 2 < v.length; i += 3) {
          if (v[i] < 0 || v[i + 1] < 0 || v[i + 2] < 0) negative = true;
          if (Math.abs(v[i] - 1) > 1e-3 || Math.abs(v[i + 1] - 1) > 1e-3 || Math.abs(v[i + 2] - 1) > 1e-3) identity = false;
        }
        if (negative || !identity) continue;
        clip.tracks.splice(clip.tracks.indexOf(existing), 1);
      }
      const dur = Math.max(0.001, clip.duration || 0);
      clip.tracks.push(new THREE.VectorKeyframeTrack(
        `${bone}.scale`, [0, dur], [...ref, ...ref],
      ));
      fixed++;
    }
  }
  return { fixed, mirror: mirrorRef };
}

/**
 * BOSS 实体：模型 + 动画状态机 + 技能 AI + 地面预警。
 * 只负责“表现与决策”，命中判定交给 BossMode（它知道所有玩家位置）。
 */
export class Boss {
  /**
   * @param {THREE.Scene} scene
   * @param {object} def BOSSES 表项
   * @param {object} opts
   * @param {number} opts.hp 已按难度缩放的血量
   * @param {object} opts.fx Effects 实例
   * @param {Function} opts.getPlayers () => [{ id, boat, alive }]
   * @param {Function} opts.onSkillResolve (skill, info) => void
   */
  constructor(scene, def, opts) {
    this.scene = scene;
    this.def = def;
    this.opts = opts;
    // 玩法分支：classic = 现有闯关（技能按 def.skills 的固定顺序出），
    // hex = 海克斯（每关先用计划里抽好的 5 个技能子集，出手后轮转到队尾）。
    this.variant = opts.variant === 'hex' ? 'hex' : 'classic';
    // 牌组只在海克斯模式下存在；classic 保持 null，下面完全走原来的 def.skills 分支。
    // 子集与顺序由 buildRunPlan(seed) 决定（房主/客机一致），这里只做拷贝，不再本地洗牌。
    this.skillDeck = this.variant === 'hex'
      ? (opts.skills?.length ? opts.skills.slice() : shuffledSkills(def.skills))
      : null;
    // 海克斯连招（计划里每关 1~2 组）：两段技能都就绪时优先打。
    // 进关先攒 6 秒，避免开局第一波就是两连击。
    this.combos = (opts.combos || []).map((c) => ({ ...c, cd: 6 }));
    this.comboFollow = null;
    this.comboFirst = null;
    this.comboGap = 0;
    this.comboGapDur = 0;
    this.fx = opts.fx;
    this.net = opts.net;
    this.isHost = !!opts.isHost;
    this.maxHp = Math.max(1, opts.hp);
    this.hp = this.maxHp;
    this.speedScale = 1;
    this.rageMult = 1;
    this.cooldownScale = 1;
    // 关卡节奏（BossMode 按 BOSS_PACE 写入）：预警时长倍率，
    // <1 表示红圈刚亮就出手（第四关），>1 表示给玩家更多反应时间（第三关）。
    this.telegraphScale = 1;
    this.pace = null;
    // 元素主题：fire = 周身火星，ice = 飘落的雪花（第三、四关）
    this.fxTheme = def.fxTheme || 'fire';
    this.damageScale = 1;
    this.range = { x: 0, z: 0 };

    this.pos = new THREE.Vector3(0, 0, 0);
    this.target = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.state = 'idle'; // idle | chase | telegraph | dying | dead
    this.dead = false;
    this.ready = false;
    this.animName = null;
    this.animHold = 0;
    // 高空态（第二关「龙鳞骤雨」）：腾空期间玩家打不到本体，只能躲鳞片；
    // airHold = 悬停剩余时间（鳞片落完后转俯冲），landT = 俯冲剩余时间。
    this.airborne = false;
    this.airHold = 0;
    this.landT = 0;
    this.telegraph = null;
    this.cooldowns = {};
    // 阶段转换大招：血量每跌破一个阈值触发一次，打乱“站着挨打”的节奏
    this.phaseIndex = 0;
    this.phaseLock = 0;
    // 第一阶段固定站位：BOSS 不追人，只在前方定时放技能。
    // BossMode 在血量进入最后 1/3 时把它置为 false，解禁追击与环绕。
    this.anchor = true;
    this.lure = null;
    // 追击节奏：血量 > 1/3 时踱步与奔跑随机交替，血量 ≤ 1/3 后全程奔跑。
    this.paceTimer = 0;
    this.paceRun = true;
    // 开局安全期：先让玩家看清场地/捡道具，再开始放技能
    for (const name of this.skillDeck || def.skills) {
      this.cooldowns[name] = BOSS_GRACE_TIME + Math.random() * 1.5;
    }
    this.hitFlash = 0;
    this.netTarget = null;
    // 客机 BOSS 回放缓冲：主机 10Hz 下发坐标，直接贴会让 BOSS 一跳一跳的。
    // 这里缓存若干帧，统一在"100ms 之前"那个时刻线性插值（和赛艇的延迟回放同一套思路）。
    this.netSnaps = [];
    this.netClock = 0;
    this.bobT = Math.random() * 10;
    // 道具控制状态（由 BossMode 写入）
    this.status = { slow: 0, root: 0, blind: 0, confuse: 0, dive: 0, silence: 0, reverse: 0 };
    // 当前沉水量（米，由 #applyPose 平滑过渡）：>0 表示被深水炸弹压在水下
    this.diveSink = 0;
    // 跳劈（slam）的离地高度：预警后半程画一条抛物线，
    // #applyPose 把它叠加到 group.position.y 上，落地瞬间归零
    this.hopY = 0;
    // 破韧（stagger）：打侧面/背面弱点或抓出招后摇会填满韧性槽，
    // 满槽跪地 staggerTimer 秒。只有配置了 staggerMax 的 BOSS（前三关）启用。
    this.staggerMax = Math.max(0, def.staggerMax || 0);
    this.stagger = 0;
    this.staggerTimer = 0;
    this.staggerLock = 0;
    this.staggerPose = 0;
    this.staggerClip = null;
    this.modelBaseY = 0;

    this.group = new THREE.Group();
    this.group.position.copy(this.pos);
    scene.add(this.group);
    this.modelShared = false;

    // 背部弱点：正面是装甲（伤害 -30%），绕到背后打核心（伤害 ×2）。
    // 双人时 BOSS 会盯着仇恨最高的人，另一人正好能绕背输出。
    this.#buildWeakPoint();
    this.#buildGroundRing();
    this.#buildEyes();
    this.#buildEmbers();
    this.#buildStunFx();

    // def.clipModels：额外的动画包（如龙骑士新做的 dk_run），骨骼与本体一致，
    // 只把里面的 AnimationClip 合并进同一个 mixer，模型本身仍用 def.model。
    // 额外包按“可选”处理：新加的动画还没导出/路径写错时，BOSS 仍用本体模型出场，
    // 不能因为一个补丁包把整只龙换成占位棱柱。
    loadBossModel(def.model)
      .then((gltf) => Promise.all(
        (def.clipModels || []).map((url) => loadBossModel(url).catch((err) => {
          console.warn('[boss] 额外动画包加载失败，已忽略', url, err);
          return null;
        })),
      ).then((extra) => this.#setupModel(gltf, extra.filter(Boolean))))
      .catch((err) => {
        console.warn('[boss] 模型加载失败', def.model, err);
        this.#buildFallback();
      });
  }

  /** 余烬用的柔边圆点贴图（PointsMaterial 默认是硬方块） */
  #emberTexture() {
    if (Boss._emberTex) return Boss._emberTex;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    Boss._emberTex = new THREE.CanvasTexture(c);
    return Boss._emberTex;
  }

  /**
   * 双眼红光：模型本身没有眼睛网格，用两个不吃雾的加色 sprite 顶在头部前方。
   * 远距离/暴风雪里也能一眼锁定 BOSS 的朝向。
   */
  #buildEyes() {
    const h = this.def.height || 7;
    const r = this.def.radius || 5;
    this.eyes = [];
    this.eyeMats = [];
    for (const sx of [-1, 1]) {
      const mat = new THREE.SpriteMaterial({
        color: 0xff2a1a, transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const eye = new THREE.Sprite(mat);
      eye.scale.setScalar(Math.max(1.1, r * 0.3));
      eye.position.set(sx * r * 0.26, h * 0.84, r * 0.66);
      this.group.add(eye);
      this.eyes.push(eye);
      this.eyeMats.push(mat);
    }
  }

  /**
   * 周身余烬：40 颗火星从体表往上飘，飘到 1.4 倍身高就回收重来。
   * 全部在 BOSS 的局部空间里，所以跟着 BOSS 走、跟着转向。
   */
  #buildEmbers() {
    const h = this.def.height || 7;
    const r = this.def.radius || 5;
    const icy = this.fxTheme === 'ice';
    const count = 40;
    const pos = new Float32Array(count * 3);
    const data = [];
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = r * (0.55 + Math.random() * 0.5);
      data.push({
        x: Math.cos(a) * rad,
        z: Math.sin(a) * rad,
        // 火星往上飘；雪花从头顶往下落
        y: icy ? Math.random() * h * 1.35 : Math.random() * h * 1.2,
        sp: icy ? -(1.2 + Math.random() * 1.8) : 1.6 + Math.random() * 2.4,
        drift: 0.6 + Math.random() * 1.2,
        phase: Math.random() * 6,
      });
      pos[i * 3] = data[i].x;
      pos[i * 3 + 1] = data[i].y;
      pos[i * 3 + 2] = data[i].z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: icy ? 0xd2efff : 0xff7a30,
      size: icy ? 1.05 : 1.15,
      transparent: true,
      opacity: icy ? 0.85 : 0.75,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
      map: this.#emberTexture(), alphaTest: 0.01,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    this.group.add(pts);
    this.embers = { pts, geo, mat, pos, data, h, r, icy };
  }

  /**
   * 脚下红色战斗光圈：贴水面、跟着 BOSS 移动、缓慢自转 + 呼吸。
   * 远距离靠它定位 BOSS 的位置（尤其暴风雪/熔岩这种低对比场景），
   * 地面原本那两个静态同心环已经删掉，避免叠成双层。
   */
  #buildGroundRing() {
    const r = (this.def.radius || 5) * 1.35;
    this.groundRingMat = new THREE.MeshBasicMaterial({
      color: 0xff3b2a, transparent: true, opacity: 0.34,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.84, r, 96), this.groundRingMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.09;
    ring.frustumCulled = false;
    this.group.add(ring);
    this.groundRing = ring;
  }

  #buildWeakPoint() {
    // 三处弱点：左右舷侧 + 背部核心。正面是装甲（伤害打折），
    // 只要不在正面扇形里，绕到侧面/背后就是弱点 —— 双人时一个人在正面拉仇恨，
    // 另一个从侧面输出，正好形成分工。
    const h = this.def.height || 6;
    const r = this.def.radius || 5;
    this.weakPoints = [];
    const make = (x, z, ry, scale) => {
      const group = new THREE.Group();
      const ringMat = () => new THREE.MeshBasicMaterial({
        color: 0xff5a34, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const outer = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.95, 28), ringMat());
      const inner = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 22), ringMat());
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.52, 12, 10),
        new THREE.MeshBasicMaterial({
          color: 0xffb066, transparent: true, opacity: 0.95,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      group.add(outer, inner, core);
      group.position.set(x, h * 0.52, z);
      group.rotation.y = ry;
      group.scale.setScalar(scale);
      this.group.add(group);
      const wp = { group, outer, inner, core, phase: Math.random() * 6 };
      this.weakPoints.push(wp);
      return wp;
    };
    // 左侧、右侧：贴着船体侧面，朝外
    make(-r * 0.94, -r * 0.1, -Math.PI / 2, 1.0);
    make(r * 0.94, -r * 0.1, Math.PI / 2, 1.0);
    // 背部核心：更大更亮，P2 绕后时的主要目标
    make(0, -r * 0.66, Math.PI, 1.35);
    this.weakPoint = this.weakPoints[this.weakPoints.length - 1];
  }

  #setupModel(gltf, extras = []) {
    const root = instantiateMonsterModel(gltf, {
      height: this.def.height,
      sink: this.def.waterSink ?? 0.45,
      rotationY: this.def.modelRotationY ?? 0,
    });

    this.model = root;
    this.modelBaseY = root.position.y;
    this.group.add(root);
    this.modelShared = true;
    // 右手剑骨骼：横扫剑击的剑刃特效挂在这里，看起来才像“剑拿在骑士手里”。
    // dragonknight.glb 里这个节点的名字是 Bone_Sword_R_1（导出时空格已转下划线）。
    this.swordBone = root.getObjectByName('Bone_Sword_R_1') || null;
    this._boneWorld = new THREE.Vector3();

    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    // 同名 clip 以额外动画包为准：本体 dragonknight.glb 里的 clip 是静帧
    // （255 通道全零运动，播了等于没播），真正带关键帧的是 dk_idle/dk_attack 等包。
    const clips = new Map();
    for (const clip of gltf.animations || []) clips.set(clip.name, clip);
    for (const extra of extras) {
      for (const clip of extra.animations || []) clips.set(clip.name, clip);
    }
    // 补丁包经常漏掉镜像骨的负缩放轨道，漏一条就变单翅膀（见修复函数注释）
    const mirrorFix = repairMirrorScaleTracks(clips);
    if (mirrorFix.fixed) console.info(`[boss] ${this.def.id}: 补回 ${mirrorFix.fixed} 条镜像骨缩放轨道`);
    // 镜像骨的“绑定原值”也设成负缩放：交叉淡化时权重和 < 1，mixer 会向绑定原值回退，
    // 原值若是 +1，右翼会在切动作的一瞬间塌掉（单翅膀一闪）。必须在 #play 之前设置，
    // 因为 saveOriginalState 是在第一次激活动作时抓当前骨骼值的。
    for (const [bone, scale] of mirrorFix.mirror) {
      const node = root.getObjectByName(bone);
      if (node) node.scale.set(scale[0], scale[1], scale[2]);
    }
    for (const [name, clip] of clips) this.actions[name] = this.mixer.clipAction(clip);
    this.animScale = 1;
    this.#play('idle');
    this.ready = true;
    this.opts.onReady?.();
  }

  #buildFallback() {
    // 模型缺失时也要能打：用暗红色棱柱代替，避免整局卡死
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(this.def.radius * 0.8, this.def.height, 7),
      new THREE.MeshStandardMaterial({ color: 0x8a1a1a, emissive: 0x400808, roughness: 0.5 }),
    );
    mesh.position.y = this.def.height * 0.5;
    this.group.add(mesh);
    this.model = mesh;
    this.modelBaseY = mesh.position.y;
    this.swordBone = null;
    this._boneWorld = new THREE.Vector3();
    this.ready = true;
    this.opts.onReady?.();
  }

  #play(semantic, once = false, force = false) {
    const clipName = this.def.anims?.[semantic];
    const action = clipName ? this.actions?.[clipName] : null;
    // force：同一段动画需要“从头再播一遍”（例如瞬移前摇和落点劈砍共用一段时）
    if (!action || (!force && this.animName === clipName)) return;
    if (this.current) this.current.fadeOut(0.18);
    action.reset();
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    action.clampWhenFinished = once;
    action.fadeIn(0.18).play();
    this.current = action;
    this.animName = clipName;
  }

  /**
   * 外部指定播一段骨骼动作（阶段转换的 enrage 等）。
   * hold > 0 时锁住这段时间不切回待机，动作播完停在最后一帧再淡出。
   * @returns {boolean} 该语义在这个 BOSS 上没有对应 clip 时返回 false
   */
  playOnce(semantic, hold = 0) {
    if (!this.def.anims?.[semantic]) return false;
    this.#play(semantic, true, true);
    if (hold > 0) this.animHold = Math.max(this.animHold, hold);
    return true;
  }

  /** 受击闪白 + 血条变化 */
  applyDamage(amount) {
    if (this.dead) return 0;
    // 腾空躲到高空时完全免疫：这一段玩家唯一的任务就是躲开落下的龙鳞，
    // 否则“飞得再高也能被平A打下来”就成了纯演出，没有玩法意义。
    if (this.airborne) return 0;
    const dealt = Math.min(this.hp, Math.max(0, amount));
    this.hp -= dealt;
    this.hitFlash = 0.22;
    // 受击回弹：只在待机/追击时插一段短促的挨打动作。
    // 出招（telegraph）和破韧跪地期间不打断，否则玩家看不清 BOSS 正在放什么招；
    // 冷却 1.4 秒，避免连射时动作被反复重置、看起来像抽搐。
    const now = performance.now();
    const canFlinch = this.def.anims?.hurt && this.animHold <= 0
      && this.staggerTimer <= 0 && this.state !== 'telegraph';
    if (canFlinch && now > (this.hurtLockUntil || 0)) {
      this.hurtLockUntil = now + 1400;
      this.#play('hurt', true, true);
      this.animHold = 0.55;
    }
    if (this.hp <= 0) this.die();
    return dealt;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dying';
    this.deathT = 0;
    // 破韧跪地中被打死：先解除被冻结的跪姿，否则死亡动画会卡在跪着的那一帧；
    // 火龙的程序化前倾/下沉也要复位，避免叠在死亡演出上。
    if (this.staggerClip && this.current) {
      this.current.paused = false;
      this.current.stop();
      this.current = null;
      this.animName = null;
    }
    this.staggerTimer = 0;
    this.staggerPose = 0;
    this.staggerClip = null;
    this.stagger = 0;
    if (this.stunGroup) this.stunGroup.visible = false;
    if (this.model && this.staggerMax) {
      this.model.rotation.x = 0;
      this.model.position.y = this.modelBaseY || 0;
    }
    this.#clearWarning();
    this.#play('death', true);
    this.opts.onDeath?.();
  }

  /** 客机根据主机的施法消息，本地生成同样的预警圈 */
  showWarning(skillId, x, z, heading, dur, targetId = null) {
    const skill = BOSS_SKILLS[skillId];
    if (!skill || this.dead) return;
    this.#clearWarning();
    this.telegraph = {
      skill, info: { x, z, heading, targetId }, timer: dur, total: dur, heading,
    };
    this.warning = this.#makeWarning(skill, this.telegraph.info);
    if (this.warning) this.scene.add(this.warning);
    this.#attachFollowFx(skill, dur);
    this.state = 'telegraph';
    if (skill.anim === 'fly' && this.def.anims?.fly) {
      this.airborne = true;
      this.#play('fly', true);
    } else this.#play(this.#skillAnim(skill));
  }

  /**
   * 技能对应的动作语义：真正的喷吐类技能才用 breath（仰头张口），
   * 冲锋用 moveFast（冲刺/奔跑），其余按技能自带的 anim，没有再退回施法。
   * 注意不能“见扇形就用 breath”：冰霜 BOSS 的挥砍也是扇形（顺带喷雪），
   * 若也套仰头咆哮，剑就完全不动了——这正是第三关之前只有跑步生效的观感来源。
   */
  #skillAnim(skill) {
    if (skill.anim === 'flame' && this.def.anims?.breath) return 'breath';
    if (skill.kind === 'path' && this.def.anims?.moveFast) return 'moveFast';
    return skill.anim || 'cast';
  }

  get hpRatio() {
    return Math.max(0, Math.min(1, this.hp / this.maxHp));
  }

  /** 主机同步下来的状态（客机不跑 AI，只追随） */
  setNetState(state) {
    this.netTarget = state;
    // 存一份带本地时间戳的快照，供 #followNet 回放（主机下发的是 10Hz）
    this.netSnaps.push({ t: this.netClock, x: state.x, z: state.z, h: state.h || 0 });
    if (this.netSnaps.length > 24) this.netSnaps.shift();
    if (state.hp != null) this.hp = state.hp;
    // 客机本地不跑 addStagger，韧性槽由主机快照覆盖；本地计时衰减只影响两帧之间
    if (state.stagger != null && this.staggerMax > 0) {
      this.stagger = Math.max(0, Math.min(1, state.stagger)) * this.staggerMax;
    }
    if (state.state === 'dying' || state.state === 'dead') {
      if (!this.dead) {
        this.dead = true;
        this.state = 'dying';
        this.deathT = 0;
        this.opts.onDeath?.();
      }
    }
  }

  /**
   * 客机 BOSS 位置回放。
   * 主机每 0.1 秒发一次坐标，之前是"收到就往那个点滑过去"，等于永远在追一个
   * 落后半拍又在抖的目标，观感就是一卡一卡。这里把快照按本地时钟排好，
   * 统一在"100ms 之前"那个时刻做线性插值：帧率再高也是连续运动，同时
   * 只比主机晚一成秒，不影响看招。
   */
  #followNet(dt) {
    this.netClock += dt;
    const buf = this.netSnaps;
    if (!buf.length) return;
    const renderT = this.netClock - NET_REPLAY_DELAY;
    // 丢掉已经过去的帧，但至少留两帧出来做插值
    while (buf.length > 2 && buf[1].t <= renderT) buf.shift();
    const a = buf[0];
    const b = buf[1] || a;
    const span = b.t - a.t;
    const k = span > 1e-4
      ? Math.min(1, Math.max(0, (renderT - a.t) / span))
      : 1;
    this.pos.x = a.x + (b.x - a.x) * k;
    this.pos.z = a.z + (b.z - a.z) * k;
    // 朝向走最短弧，避免 179° → -179° 时原地转一大圈
    let dh = b.h - a.h;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.heading = a.h + dh * k;
  }

  /**
   * 过场/倒计时期间只做“待机演出”：不推进技能 AI、不消耗冷却，
   * 避免玩家还在看动画时就被开场的范围技能命中。
   */
  updateIdle(dt) {
    if (!this.ready) return;
    this.bobT += dt;
    if (this.mixer) this.mixer.update(dt);
    this.#applyPose(dt);
  }

  update(dt, t) {
    if (!this.ready) return;
    this.bobT += dt;
    if (this.mixer) this.mixer.update(dt * (this.animScale || 1));

    if (this.dead) {
      this.deathT = (this.deathT || 0) + dt;
      this.group.position.y = -Math.min(1, this.deathT / 2.6) * this.def.height * 0.55;
      this.group.rotation.z = Math.min(0.5, this.deathT * 0.18);
      if (this.deathT > 4) this.state = 'dead';
      return;
    }

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt);
      this.#setEmissive(this.hitFlash / 0.22);
    }
    // 出手动作锁定：喷吐类技能命中后还要保持 0.95 秒的喷吐姿势，
    // 否则雪花刚喷出来、BOSS 就已经闭嘴回待机了
    if (this.animHold > 0) this.animHold = Math.max(0, this.animHold - dt);

    // 高空态：悬停（等鳞片全部落完）→ 收翼俯冲 → 落地解除免疫
    if (this.landT > 0) {
      this.landT = Math.max(0, this.landT - dt);
      if (this.landT <= 0) this.airborne = false;
    } else if (this.airHold > 0) {
      this.airHold = Math.max(0, this.airHold - dt);
      if (this.airHold <= 0) {
        this.#play('flyDive', true);
        this.animHold = 1.5;
        this.landT = 1.5;
      }
    }
    // 双眼/火星都挂在出生点的水面上，腾空后会变成半空中漂浮的红点，先收起来
    if (this.eyes) for (const e of this.eyes) e.visible = !this.airborne;
    if (this.embers?.pts) this.embers.pts.visible = !this.airborne;

    // 脚下红环：自转 + 呼吸（纯视觉，不参与判定）
    if (this.groundRing) {
      this.groundRing.rotation.z += dt * 0.35;
      this.groundRingMat.opacity = 0.26 + Math.sin(this.bobT * 2.1) * 0.1;
    }
    // 双眼红光：呼吸，读起来像"活着"
    if (this.eyeMats) {
      const k = 0.72 + Math.sin(this.bobT * 3.4) * 0.22;
      for (const m of this.eyeMats) m.opacity = k;
    }
    // 周身余烬 / 飘雪
    if (this.embers) {
      const { pos, data, geo, h, icy } = this.embers;
      for (let i = 0; i < data.length; i++) {
        const d = data[i];
        d.y += d.sp * dt;
        d.x += Math.sin(this.bobT * 1.4 + d.phase) * d.drift * dt;
        d.z += Math.cos(this.bobT * 1.1 + d.phase) * d.drift * dt;
        // 火星飘到顶 / 雪花落到水线，都回收重来
        if (d.y > h * 1.45 || d.y < -0.8) {
          const a = Math.random() * Math.PI * 2;
          const rad = this.embers.r * (0.55 + Math.random() * 0.5);
          d.x = Math.cos(a) * rad;
          d.z = Math.sin(a) * rad;
          d.y = icy ? h * 1.35 : 0.2;
          d.phase = Math.random() * 6;
        }
        pos[i * 3] = d.x;
        pos[i * 3 + 1] = d.y;
        pos[i * 3 + 2] = d.z;
      }
      geo.attributes.position.needsUpdate = true;
    }

    // 破韧节奏：无论主机/客机都本地推进（客机靠 bossStagger 消息进入，之后自己倒计时），
    // 这样跪地动画、头顶星星和伤害窗口的时间轴在三端一致。
    this.#updateStaggerTimers(dt);

    // 客机：位置/朝向按快照回放，动画继续本地播放
    if (this.netTarget) {
      this.#followNet(dt);
      // 客机没有主机的跃起位移，按预警进度本地补一条同样形状的抛物线，
      // 否则多人模式里 BOSS 会“贴地滑”到落点而不是跳过去
      this.hopY = 0;
      const ws = this.telegraph?.skill;
      if (ws?.kind === 'slam' && this.telegraph.total > 0) {
        const p = 1 - Math.max(0, this.telegraph.timer) / this.telegraph.total;
        const u = Math.max(0, Math.min(1, (p - 0.42) / 0.58));
        this.hopY = Math.sin(u * Math.PI) * Math.min(20, (this.def.height || 7) * 2.45);
      }
      this.#applyPose(dt);
      this.#updateWarning(dt);
      return;
    }

    // 冷却
    for (const name of this.skillDeck || this.def.skills) {
      this.cooldowns[name] = Math.max(0, (this.cooldowns[name] || 0) - dt);
    }
    // 连招冷却 / 两段之间的间隔（只在主机推进，客机不看这块）
    for (const combo of this.combos) {
      combo.cd = Math.max(0, combo.cd - dt);
    }
    this.comboGap = Math.max(0, this.comboGap - dt);
    for (const key of Object.keys(this.status)) {
      this.status[key] = Math.max(0, this.status[key] - dt);
    }
    this.phaseLock = Math.max(0, this.phaseLock - dt);
    const moveScale = this.status.slow > 0 ? 0.4 : 1;

    // 预警阶段
    if (this.state === 'telegraph') {
      const warn = this.telegraph;
      warn.timer -= dt;
      const progress = warn.total > 0 ? 1 - Math.max(0, warn.timer) / warn.total : 1;
      // 冲锋追踪（charge.track）：预警前半段持续把朝向修正到目标船上。
      // 玩家只靠横向移动躲不掉，必须急转方向或开氮气甩开。
      if (warn.skill.kind === 'path' && warn.skill.track
        && this.status.root <= 0 && progress < 0.55) {
        const tgt = (this.opts.getPlayers?.() || [])
          .find((p) => p.id === warn.info.targetId && p.boat);
        if (tgt?.boat) {
          const want = Math.atan2(tgt.boat.pos.x - this.pos.x, tgt.boat.pos.z - this.pos.z);
          let dh = want - warn.heading;
          while (dh > Math.PI) dh -= Math.PI * 2;
          while (dh < -Math.PI) dh += Math.PI * 2;
          warn.heading += dh * Math.min(1, dt * 2.6);
        }
      }
      this.#face(warn.heading, dt, 3.2);
      // 冲锋类技能（charge）：预警后半程 BOSS 真的沿预警方向前冲。
      // 以前这里只播 dk_run 不推进坐标，2 秒里就是一台“原地跑步机”。
      if (warn.skill.kind === 'path' && this.status.root <= 0 && warn.total > 0) {
        if (progress > 0.4) {
          const lunge = this.def.speed * (this.rageMult || 1) * 2.2 * moveScale * dt;
          this.pos.x += Math.sin(warn.heading) * lunge;
          this.pos.z += Math.cos(warn.heading) * lunge;
          this.#clampArena();
        }
      }
      // 跳劈（slam）：预警后半程 BOSS 沿抛物线跃到落点。
      // 位移和落点都写进 pos，结算时命中原点才会跟着 BOSS 真正落地。
      if (warn.skill.kind === 'slam') {
        const jumpStart = 0.42;
        if (progress > jumpStart) {
          if (!warn.jumping) {
            warn.jumping = true;
            // 让跳跃片段正好在预警结束时播完（落地帧 = 结算帧），
            // 不靠手调倍速，换动画包也不会错位
            const clipDur = this.actions?.[this.def.anims?.jumpSlam]
              ?.getClip?.().duration || 1.2;
            this.animScale = clipDur / Math.max(0.3, warn.timer);
            this.#play('jumpSlam', true);
          }
          const u = Math.min(1, (progress - jumpStart) / (1 - jumpStart));
          // 缓出：前段跃得远、后段收在落点上，读起来是“砸下来”而不是“滑过去”
          const ease = 1 - (1 - u) ** 2.2;
          const sx = warn.info.startX ?? this.pos.x;
          const sz = warn.info.startZ ?? this.pos.z;
          this.pos.x = sx + (warn.info.x - sx) * ease;
          this.pos.z = sz + (warn.info.z - sz) * ease;
          this.#clampArena();
          this.hopY = Math.sin(u * Math.PI) * Math.min(20, (this.def.height || 7) * 2.45);
        }
      }
      this.#updateWarning(dt);
      if (warn.timer <= 0) this.#resolveSkill();
      this.#applyPose(dt);
      return;
    }

    // 被深水炸弹压进水里：这 3 秒不能起新技能，只露背脊
    if (this.status.dive > 0) {
      this.state = 'idle';
      this.#play('idle');
      this.#applyPose(dt);
      return;
    }

    // 破韧跪地：不移动、不转技能、不消耗冷却，纯挨打窗口
    if (this.staggerTimer > 0) {
      this.state = 'stagger';
      this.#applyPose(dt);
      return;
    }

    // 阶段转换：血量跌破阈值时定身蓄力放大招。
    // 放在普通技能之前，保证“过线必放”，同时把节奏从连招切成一次明确的躲避。
    if (this.phaseIndex < BOSS_PHASE_THRESHOLDS.length
      && this.phaseLock <= 0
      && this.hpRatio <= BOSS_PHASE_THRESHOLDS[this.phaseIndex]) {
      this.phaseIndex += 1;
      this.#beginPhaseBlast(BOSS_SKILLS.phaseBlast);
      this.#applyPose(dt);
      return;
    }

    const players = this.#alivePlayers();
    if (!players.length) {
      this.state = 'idle';
      this.#play('idle');
      this.#applyPose(dt);
      return;
    }

    const lureActive = this.lure && this.lure.t > 0;
    const target = lureActive
      ? {
          id: 'lure',
          boat: { pos: { x: this.lure.x, z: this.lure.z, vel: { x: 0, y: 0 } } },
          hp: 100,
        }
      : this.#pickTarget(players);
    if (this.lure) this.lure.t = Math.max(0, this.lure.t - dt);
    const dx = target.boat.pos.x - this.pos.x;
    const dz = target.boat.pos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.target.set(target.boat.pos.x, 0, target.boat.pos.z);

    // 有技能可用且够得着：进入预警。腾空期间不接新技能（要等落水后才继续战斗）
    const skill = this.airborne ? null : this.#pickSkill(dist, this.anchor);
    if (skill) {
      this.#rotateSkillDeck(skill);
      this.#beginTelegraph(skill, target);
      this.#applyPose(dt);
      return;
    }

    // 第一阶段：原地不动，只转向玩家（“BOSS 在前方”）
    if (this.anchor) {
      this.state = 'chase';
      this.#face(Math.atan2(dx, dz), dt, 2.0 * this.def.turnRate);
      if (this.animHold <= 0) this.#play('idle');
      this.#applyPose(dt);
      return;
    }

    // 第二阶段：追击 + 狂怒加速
    this.state = 'chase';
    const desired = Math.atan2(dx, dz);
    this.#face(desired, dt, 2.0 * this.def.turnRate);
    // 第三、四关从第一阶段就追到赛艇面前（pace.move）。
    // 停在本关通道近端（radius+10 ≈ BOSS_LANE.near 14m），正好贴脸放技能，
    // 又不会一直把玩家往场地边缘顶。
    const keep = this.def.radius + (this.pace?.move ? 10 : 9);
    // 走/跑节奏：骨架同时有 move 与 moveFast 两段才谈得上踱步。
    // 血量 > 1/3 时每 2.4~4.6 秒随机切一次；≤ 1/3（狂暴）全程奔跑。
    const canPace = !!(this.def.anims?.move && this.def.anims?.moveFast);
    if (canPace) {
      this.paceTimer = Math.max(0, this.paceTimer - dt);
      if (this.hpRatio <= BOSS_PHASE2_RATIO) {
        this.paceRun = true;
        this.paceTimer = 0;
      } else if (this.paceTimer <= 0) {
        this.paceRun = Math.random() < 0.5;
        this.paceTimer = 2.4 + Math.random() * 2.2;
      }
    }
    // pace.walkStride 允许按关卡单独调“踱步比奔跑慢多少”：
    // 第三关保留 0.55 的从容感，第二关给 0.9（不然一半时间都在 0.55 倍速，玩家还是嫌慢）。
    const stride = canPace && !this.paceRun ? (this.pace?.walkStride ?? 0.55) : 1;
    let moving = false;
    // 腾空期间原地悬停：飞在十几米高的空中还贴着玩家平移，读起来像贴地滑行
    if (this.status.root <= 0 && !this.airborne && dist > keep) {
      const step = this.def.speed * this.speedScale * (this.rageMult || 1) * moveScale * stride * dt;
      // 方向转换器失控：仍然面向玩家，但往前一步变成往后退一步
      const flow = this.status.reverse > 0 ? -1 : 1;
      const px = this.pos.x;
      const pz = this.pos.z;
      this.pos.x += Math.sin(this.heading) * step * flow;
      this.pos.z += Math.cos(this.heading) * step * flow;
      this.#clampArena();
      // 被场地边界挡住时实际位移≈0：不能再假装“在跑”，否则就是原地跑步机
      moving = Math.hypot(this.pos.x - px, this.pos.z - pz) > step * 0.3;
    } else if (this.status.root <= 0 && !this.airborne && dist < this.def.radius + 2) {
      // 太近就横移拉开，避免和玩家模型重叠
      this.pos.x -= Math.sin(this.heading) * dt * 2.5;
      this.pos.z -= Math.cos(this.heading) * dt * 2.5;
      this.#clampArena();
    }
    // 远距离用冲刺（龙骑士的 dk_run）、踱步用 walk；只有真的在位移时才播移动动画，
    // 走到停距后站定待机，站在赛艇面前等技能冷却，出手时再切攻击/喷吐动作。
    // animHold 期间保持当前出手动作，不切回待机。
    if (this.animHold <= 0) {
      if (!moving) this.#play('idle');
      else if (canPace) this.#play(this.paceRun ? 'moveFast' : 'move');
      else if (this.def.anims?.moveFast && dist > this.def.radius + (this.pace?.move ? 10 : 24)) this.#play('moveFast');
      else this.#play('move');
    }
    this.#applyPose(dt);
  }

  #alivePlayers() {
    return (this.opts.getPlayers?.() || []).filter((p) => p.alive !== false && p.boat);
  }

  #pickTarget(players) {
    if (this.status.confuse > 0) return players[Math.floor(Math.random() * players.length)];
    // 仇恨锁定：最近持续输出最高的人会被优先盯上，
    // 双人时自然形成“一个人拉怪、另一个绕背打弱点”的分工。
    const aggroId = this.opts.getAggroId?.();
    if (aggroId) {
      const mark = players.find((p) => p.id === aggroId);
      if (mark) return mark;
    }
    // 没有仇恨时：优先距离近、血量低的玩家
    let best = players[0];
    let bestScore = Infinity;
    for (const p of players) {
      const d = Math.hypot(p.boat.pos.x - this.pos.x, p.boat.pos.z - this.pos.z);
      const score = d + (p.hp ?? 100) * 0.18;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  /**
   * 海克斯：刚出手的技能排到队尾。
   * 一关内的技能顺序因此会不断轮转，玩家背不出固定连招；classic 下是空操作。
   */
  #rotateSkillDeck(skill) {
    if (!this.skillDeck) return;
    const i = this.skillDeck.indexOf(skill);
    if (i < 0) return;
    this.skillDeck.push(...this.skillDeck.splice(i, 1));
  }

  /** 技能射程（原 #pickSkill 的 switch，抽出来给连招复用） */
  #skillReach(skill) {
    switch (skill.kind) {
      case 'cone': return this.def.radius + (skill.range || 24) + 4;
      case 'ring': return this.def.radius + (skill.radius || 20) + 2;
      // 落点类技能：追猎光柱是"从天而降"的锁定技，不受距离限制；
      // 其余落点（俯冲/落雷）仍按 30m 内才放
      case 'ground': return skill.track ? 999 : this.def.radius + 30;
      case 'path': return this.def.radius + 46;
      // 跳劈是“跃过去砸”，射程给到 55m：只要玩家还在视野里就扑上来
      case 'slam': return this.def.radius + 55;
      // 熔岩海啸：火墙会一路推进到 reach 末端，整条通道都算射程
      case 'wave': return this.def.radius + (skill.reach || 54);
      // 暗影缠触：脚下圈是“点名型”地面技能，中距离就放
      case 'zone': return this.def.radius + 40;
      // 第四关的吸取/全屏/瞬移/水柱都是“场地级”技能，不看距离
      case 'pull': case 'screen': case 'blink': case 'geyser': return 999;
      default: return 999;
    }
  }

  /** 技能此刻能不能出手：血量闸门 + 距离 + 贴脸限制 */
  #skillUsable(skill, dist, anchored) {
    // 终盘技能（雷霆棋盘）：血量没降到阈值以下就不进池。
    // 海克斯放宽闸门（阈值 ×0.7），终盘技能能更早出现；其余判断保持不变。
    if (skill.minHpRatio != null) {
      const gate = skill.minHpRatio * (this.variant === 'hex' ? 0.7 : 1);
      if (this.hp / this.maxHp > gate) return false;
    }
    // 第一阶段固定站位：技能只要能覆盖整条通道，就不看距离
    if (anchored) return !(skill.kind === 'path' && dist < 16);
    // 第二阶段恢复正常射程：落雷/俯冲不再隔着整个战场随手丢
    if (skill.kind === 'path' && dist < 16) return false;
    // 贴脸放海啸起点就在脚下，玩家等于零反应时间，留给喷火/尾扫这些正常技能
    if (skill.kind === 'wave' && dist < 20) return false;
    // 贴脸时吸取/瞬移没有意义，留给喷火与落雷
    if ((skill.kind === 'pull' || skill.kind === 'blink') && dist < 14) return false;
    return dist <= this.#skillReach(skill);
  }

  /**
   * 海克斯连招：两段技能都就绪且都在射程内时优先打第一段，
   * 第二段由 #resolveSkill 结算后排队接上。classic 没有 combos，等价空操作。
   */
  #pickCombo(dist, anchored) {
    for (const combo of this.combos) {
      if (combo.cd > 0) continue;
      const [aId, bId] = combo.skills || [];
      const a = BOSS_SKILLS[aId];
      const b = BOSS_SKILLS[bId];
      if (!a || !b) continue;
      if ((this.cooldowns[aId] || 0) > 0 || (this.cooldowns[bId] || 0) > 0) continue;
      if (!this.#skillUsable(a, dist, anchored) || !this.#skillUsable(b, dist, anchored)) continue;
      combo.cd = combo.cooldown || 18;
      this.comboFollow = bId;
      this.comboFirst = aId;
      this.comboGapDur = combo.gap ?? 0.45;
      this.opts.onCombo?.(combo, a, b);
      return a;
    }
    return null;
  }

  #pickSkill(dist, anchored = false) {
    // 墨鱼沉默：状态期间不起新技能，但已经读条的技能照常结算
    if (this.status.silence > 0) return null;
    // 连招第二段：第一段结算后等 gap 结束直接接上，期间不插其他技能
    if (this.comboFollow) {
      if (this.comboGap > 0) return null;
      const name = this.comboFollow;
      this.comboFollow = null;
      const follow = BOSS_SKILLS[name];
      if (follow && (this.cooldowns[name] || 0) <= 0
        && this.#skillUsable(follow, dist, anchored)) {
        return follow;
      }
      // 目标跑远了就放弃第二段，回到正常出招
    }
    const combo = this.#pickCombo(dist, anchored);
    if (combo) return combo;
    // 海克斯模式按洗牌后的牌组顺序挑；classic 仍是数据里写死的顺序
    const order = this.skillDeck || this.def.skills;
    for (const name of order) {
      if ((this.cooldowns[name] || 0) > 0) continue;
      const skill = BOSS_SKILLS[name];
      if (!skill) continue;
      if (!this.#skillUsable(skill, dist, anchored)) continue;
      return skill;
    }
    return null;
  }

  #beginTelegraph(skill, target) {
    const heading = Math.atan2(target.boat.pos.x - this.pos.x, target.boat.pos.z - this.pos.z)
      + (this.status.blind > 0 ? (Math.random() - 0.5) * 1.3 : 0);
    const scatter = this.status.blind > 0 ? (Math.random() - 0.5) * 16 : 0;
    const info = { x: this.pos.x, z: this.pos.z, heading, targetId: target.id };
    if (skill.kind === 'ground' || skill.kind === 'geyser' || skill.kind === 'zone'
      || skill.kind === 'rift') {
      info.x = target.boat.pos.x + scatter;
      info.z = target.boat.pos.z + scatter;
      // 落点稍微预判玩家的速度方向
      info.x += (target.boat.vel?.x || 0) * 0.35;
      info.z += (target.boat.vel?.y || 0) * 0.35;
      // 水柱：第一段扎在玩家脚下，第二段从 BOSS 脚下扩散，两个原点都要带上
      info.ox = this.pos.x;
      info.oz = this.pos.z;
    } else if (skill.kind === 'rain') {
      // 龙鳞骤雨：整片区域点名在目标船脚下（带 0.5 秒速度预判），
      // 玩家只要在预警时间内跑出这块圆就完全安全，落点精度不重要。
      info.x = target.boat.pos.x + (target.boat.vel?.x || 0) * 0.5 + scatter * 0.5;
      info.z = target.boat.pos.z + (target.boat.vel?.y || 0) * 0.5 + scatter * 0.5;
      const maxR = (this.opts.arenaRadius || 92) - (skill.radius || 24);
      const dd = Math.hypot(info.x, info.z);
      if (dd > maxR) {
        info.x = (info.x / dd) * maxR;
        info.z = (info.z / dd) * maxR;
      }
    } else if (skill.kind === 'blink') {
      // 瞬移落点 = 目标船头前方（“瞬移到玩家面前”），预警圈就画在那里
      const bh = Number.isFinite(target.boat.heading) ? target.boat.heading : heading;
      const off = (this.def.radius || 5) + 7;
      info.x = target.boat.pos.x + Math.sin(bh) * off + scatter * 0.5;
      info.z = target.boat.pos.z + Math.cos(bh) * off + scatter * 0.5;
      const maxR = (this.opts.arenaRadius || 92) - 12;
      const dd = Math.hypot(info.x, info.z);
      if (dd > maxR) {
        info.x = (info.x / dd) * maxR;
        info.z = (info.z / dd) * maxR;
      }
    } else if (skill.kind === 'slam') {
      // 跳劈落点 = 目标位置 + 0.55 秒速度预判，预警圈画在预判点上。
      // 玩家在预警期间继续移动就能跑出中心（但外圈 22m 仍会吃第二段伤害），
      // BOSS 会在预警后半程真的跃到落点，所以“站着不动”一定吃满三段。
      info.x = target.boat.pos.x + (target.boat.vel?.x || 0) * 0.55 + scatter;
      info.z = target.boat.pos.z + (target.boat.vel?.y || 0) * 0.55 + scatter;
      const maxR = (this.opts.arenaRadius || 92) - 12;
      const dd = Math.hypot(info.x, info.z);
      if (dd > maxR) {
        info.x = (info.x / dd) * maxR;
        info.z = (info.z / dd) * maxR;
      }
      // 起跳点：跃起位移要按这两点插值，不能从“当前追踪位置”临时算
      info.startX = this.pos.x;
      info.startZ = this.pos.z;
      this.hopY = 0;
    }
    // 第三关拉长 / 第四关压缩预警：红圈节奏由关卡的 telegraphScale 决定。
    // 全屏大招例外：它只能靠“跑到柱子 / 贴住队友”来躲，必须给足 3 秒，
    // 不能跟着第四关的 0.55 倍压成 1.6 秒（否则根本来不及横跨场地）。
    const dur = skill.kind === 'screen'
      ? Math.max(3.0, skill.telegraph || 0)
      : Math.max(0.35, (skill.telegraph || 1.5) * this.telegraphScale);
    // 必须先清掉上一轮预警：旧预警网格还在时 #clearWarning 会把
    // 刚写入的 this.telegraph 一起置空，下一帧读 warn.timer 就会炸
    this.#clearWarning();
    this.telegraph = { skill, info, timer: dur, total: dur, heading };
    this.state = 'telegraph';
    this.cooldowns[skill.id] = skill.cooldown * this.cooldownScale;
    this.animScale = 1.35;
    if (skill.anim === 'fly' && this.def.anims?.fly) {
      // 龙鳞骤雨：先腾空到高空（悬停片段只播一遍并停在最后一帧的 14 单位高度）
      this.airborne = true;
      this.#play('fly', true);
    } else this.#play(this.#skillAnim(skill));
    this.warning = this.#makeWarning(skill, info);
    if (this.warning) this.scene.add(this.warning);
    this.#attachFollowFx(skill, dur);
    this.opts.onSkillVisual?.(skill, info, 'cast');
    if (this.isHost) {
      this.net?.send({
        t: 'bossCast', skill: skill.id, x: info.x, z: info.z,
        h: info.heading, dur, target: info.targetId,
      });
    }
    // BOSS 的躯体和命中点都远大于赛艇，特效按体量放大，否则几乎看不见。
    // fxScale 允许逐个技能调倍率（不同素材原始尺寸差很多，统一 1.8 会有的太大有的太小）
    const fxList = skill.fx && skill.fx.length ? skill.fx : ['ring'];
    const baseScale = skill.fxScale ?? 1.8;
    const h = this.def.height;
    // 多段特效：第 0 段用 fxScale，后续段用 fxScale2（没配则按 0.8 倍），
    // 让“火星 + 火带”这种组合能各用各的尺寸。
    // 带 handFx 的技能（手持武器）不再在脚下放本体，避免同一个剑特效叠两份。
    if (!skill.handFx) {
      fxList.forEach((fxName, i) => {
        this.fx?.play(
          fxName,
          this.pos.x,
          Math.max(2.4, h * 0.55),
          this.pos.z,
          i === 0 ? baseScale : (skill.fxScale2 ?? baseScale * 0.8),
        );
      });
    }
    // 手持武器特效（第三关横扫剑击）：P2_SwordLightning 里那把剑挂到右手剑骨上，
    // 剑才会跟着挥砍动作出现在骑士手里，而不是凭空在身体中心挥舞。
    // 素材里的剑模型存活时间远长于这一刀，必须用 life 到期 stopAttached，
    // 否则挥完之后剑会一直留在场上（就是之前“剑一直在场上”的原因）。
    if (skill.handFx) {
      const hfx = skill.handFx;
      this.fx?.playAttached(
        'skillSword',
        hfx.fx,
        () => {
          // 骨骼世界坐标：每帧跟着挥砍的手臂走（getWorldPosition 内部会刷新矩阵）
          if (this.swordBone) {
            this.swordBone.getWorldPosition(this._boneWorld);
            return this._boneWorld;
          }
          // 模型缺失 / 没有剑骨时退回身体右前方，至少不要生在脚下
          const reach = h * 0.34;
          return {
            x: this.pos.x + Math.sin(this.heading) * reach + Math.cos(this.heading) * reach * 0.6,
            y: h * 0.5,
            z: this.pos.z + Math.cos(this.heading) * reach - Math.sin(this.heading) * reach * 0.6,
          };
        },
        {
          life: hfx.life ?? 1.3,
          scale: hfx.scale ?? baseScale,
          rot: () => ({ x: 0, y: this.heading, z: 0 }),
        },
      );
    }
    // 龙口特效：按 BOSS 朝向推到嘴前，避免火球生在身体中心（喷火类技能用）
    if (skill.mouthFx) {
      const reach = h * 0.55;
      this.fx?.play(
        skill.mouthFx.fx,
        this.pos.x + Math.sin(this.heading) * reach,
        Math.max(2.6, h * 0.62),
        this.pos.z + Math.cos(this.heading) * reach,
        skill.mouthFx.scale ?? baseScale,
      );
    }
  }

  /**
   * 阶段转换大招：定身蓄力，脚下亮起半径 30m 的红圈，
   * 蓄力结束对圈内玩家结算。圈外的玩家完全安全，是“必须跑”而不是“必死”。
   */
  #beginPhaseBlast(skill) {
    if (!skill) return;
    const info = { x: this.pos.x, z: this.pos.z, heading: this.heading };
    const dur = Math.max(0.5, skill.telegraph * this.telegraphScale);
    // 同上：先清旧预警，再写 telegraph，避免 #clearWarning 把新 telegraph 置空
    this.#clearWarning();
    this.telegraph = {
      skill, info, timer: dur, total: dur, heading: this.heading,
    };
    this.state = 'telegraph';
    this.animScale = 1.5;
    this.phaseLock = 8;
    this.#play('aoe');
    this.warning = this.#makeWarning(skill, info);
    if (this.warning) this.scene.add(this.warning);
    // 蓄力演出：BOSS 身上卷起龙卷、脚下扩散光环，远距离也能看出“要放大了”
    this.fx?.play('tornado', this.pos.x, this.def.height * 0.55, this.pos.z, 2.2);
    this.fx?.play('ring', this.pos.x, waveHeight(this.pos.x, this.pos.z, this.bobT) + 0.5, this.pos.z, 2.6);
    // 崩海咆哮是 30m 范围 AOE，蓄力时先在脚下烧起一道火柱（ef_fire03），
    // 让"圈内会挨打"这件事在红圈之外还有一层实体视觉。scale 3.2 起步才够高
    this.fx?.play('fxFireBand', this.pos.x, 3.0, this.pos.z, 3.2);
    this.opts.onPhaseChange?.(skill);
    this.opts.onSkillVisual?.(skill, info, 'cast');
    if (this.isHost) {
      this.net?.send({
        t: 'bossCast', skill: skill.id, x: info.x, z: info.z,
        h: info.heading, dur,
      });
    }
  }

  #resolveSkill() {
    const { skill, info } = this.telegraph;
    this.state = 'chase';
    this.animScale = 1;
    this.#clearWarning();
    // 连招：第一段结算后开始计 gap，第二段到点自动接上（#pickSkill 里消费）
    if (this.comboFirst === skill.id) {
      this.comboFirst = null;
      this.comboGap = this.comboGapDur;
    }
    // 冲锋在预警后半程已经真的往前冲了一段，结算必须以 BOSS 当前站位为起点，
    // 否则伤害通道还留在起跑点，和画面里的冲锋位置对不上。
    // 跳劈同理：跃起后落点就在 info.x/info.z，用当前站位才能和落地重合。
    const origin = (skill.kind === 'path' || skill.kind === 'slam')
      ? { ...info, x: this.pos.x, z: this.pos.z }
      : info;
    const heading = skill.kind === 'path' && info.heading != null
      ? info.heading
      : this.heading;
    this.opts.onSkillResolve?.(skill, { ...origin, heading });
    // 落地/冲刺结束：把抛物线高度归零，否则 BOSS 会停在空中
    this.hopY = 0;
    // 落点特效（groundFx）：俯冲的“火流星砸海”、焚风灼膛的“烧穿点”都挂在这里。
    // 必须用 origin（冲锋时才是 BOSS 真实站位），不能用预警圈的初始坐标。
    if (skill.groundFx) {
      this.fx?.play(
        skill.groundFx.fx,
        origin.x,
        skill.groundFx.y ?? 0.8,
        origin.z,
        skill.groundFx.scale ?? 1.0,
      );
    }
    // 技能画面统一交给 SkillFx（喷火/冰霜/闪电/水花），
    // 不再叠 Effekseer 的“烟花”爆炸，避免整个场面糊成一团。
    // 喷吐动作（仰头张口）命中后把姿势多留一个伤害窗口，
    // 让“张嘴 → 雪花持续喷出”在同一段动画里完成；
    // 瞬移则是在落点补一刀近战横扫（用户明确要求：不要接喷血/喷吐）。
    if (skill.kind === 'blink') {
      // 落点接一刀：用技能自己的动作（第三关走 dk_smash 重劈，第四关走本体普攻），
      // 不再一律用 attack。前摇阶段可能已经在播同一段，所以这里强制从头重播。
      this.#play(this.#skillAnim(skill), true, true);
      this.animHold = 0.8;
      this.animScale = 1.35;
    } else if (skill.kind === 'slam') {
      // 跳劈落地：jumpSlam 在预警阶段已经按“落地对齐”的倍速播完，
      // 这里只是把落地砸击的姿势多留 0.7 秒，让三段 AOE 有时间炸出来
      this.animHold = 0.7;
    } else if (this.#skillAnim(skill) === 'breath' || skill.anim === 'flame') {
      // 第一关没有 breath 段，喷火映射到 roar：若这里立刻切回 idle，
      // 火焰粒子还在喷、BOSS 却已经闭嘴站着。凡是火焰系吐息都要保持出手姿势。
      this.animHold = 0.95;
    } else if (skill.anim === 'fly' && this.def.anims?.flyDive) {
      // 空中技能（龙鳞骤雨）：鳞片还在相继落地，先保持高空悬停，
      // 全部落完之后才收翼俯冲回水面（落地才解除免疫）。
      const dropT = (skill.startDelay ?? 0.15)
        + Math.max(0, (skill.spotCount || 12) - 1) * (skill.spotDelay ?? 0.085);
      this.airHold = dropT;
      this.animHold = dropT + 1.7;
    } else if (skill.anim === 'wingBlast') {
      // 振翼冲击：冲击环刚推出去，翅膀还保持着最大展开的一帧
      this.animHold = 0.8;
    } else if (skill.kind === 'grid') {
      // 雷霆棋盘：整段棋盘循环（4 波约 5.4 秒）里都保持举剑引雷的姿势
      this.animHold = (skill.waves || 4) * ((skill.warnTime ?? 0.9) + (skill.activeTime ?? 0.45)) + 0.2;
    } else if (skill.kind === 'laser') {
      // 血月激光：光束扫完一整圈之前不收手
      this.animHold = (skill.duration || 2.6) + 0.3;
    } else if (skill.kind === 'rift') {
      // 裂隙喷发：水柱破水的那一下正对上双翼下砸，姿势再留 0.6 秒才收
      this.animHold = 0.6;
    } else if (skill.kind === 'gate') {
      // 深渊召唤门：门开的同时龙首还压在海面上，让“推门”这段动作播完
      this.animHold = 0.8;
    } else this.#play('idle');
  }

  #face(desired, dt, rate) {
    let dh = desired - this.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    this.heading += dh * Math.min(1, rate * dt);
  }

  #clampArena() {
    const r = (this.opts.arenaRadius || 92) - 12;
    const d = Math.hypot(this.pos.x, this.pos.z);
    if (d > r && d > 0.001) {
      this.pos.x = (this.pos.x / d) * r;
      this.pos.z = (this.pos.z / d) * r;
    }
  }

  #applyPose(dt = 0.016) {
    // 跟随真实水面起伏（和船用同一套波浪函数），再加一点轻柔的呼吸浮动
    const wave = waveHeight(this.pos.x, this.pos.z, this.bobT);
    const bob = Math.sin(this.bobT * 1.3) * 0.1;
    // 深水炸弹命中后：整体沉到水线以下（只留背脊），浮现时自己会平滑回来
    const diveSink = this.status.dive > 0 ? Math.min(1, this.status.dive / 0.35) * (this.def.height || 7) * 0.62 : 0;
    this.diveSink = THREE.MathUtils.lerp(this.diveSink || 0, diveSink, 1 - Math.exp(-6 * dt));
    // 沉水量必须真的写进坐标：以前只算 offset 没用上，BOSS 只有 HUD 显示在"水中"。
    // 水面是不透明面片，身体压到水线以下会被它挡住，只留背脊/头部露出。
    // hopY 是跳劈的抛物线高度，叠加在上面（落地那一帧由 #resolveSkill 归零）。
    this.group.position.set(
      this.pos.x,
      wave + bob - this.diveSink + (this.hopY || 0),
      this.pos.z,
    );
    this.group.rotation.y = this.heading;
    // 火龙没有跪地骨骼片段：破韧时整体前倾 + 下沉，配合慢速待机形成“被打懵跪伏”的观感。
    // 龙骑士用的是 dk_death 的跪姿片段（staggerClip 非空），不再叠加程序化倾角。
    if (this.model && this.staggerMax && !this.staggerClip) {
      const sp = this.staggerPose || 0;
      this.model.rotation.x = -0.42 * sp;
      this.model.position.y = (this.modelBaseY || 0) - (this.def.height || 7) * 0.22 * sp;
    }
    this.#pulseWeakPoint();
  }

  /** 弱点脉动：给玩家一个明确的“别打正面、绕侧后”的目标 */
  #pulseWeakPoint() {
    if (!this.weakPoints) return;
    const t = this.bobT;
    for (const wp of this.weakPoints) {
      wp.group.visible = !this.dead && !this.airborne;
      const base = 0.5 + Math.sin(t * 3.4 + wp.phase) * 0.24;
      wp.outer.material.opacity = base;
      wp.inner.material.opacity = 0.32 + base * 0.5;
      wp.outer.rotation.z = t * 0.9;
      wp.inner.rotation.z = -t * 1.6;
      wp.core.scale.setScalar(0.85 + Math.sin(t * 5.2 + wp.phase) * 0.18);
    }
  }

  #setEmissive(k) {
    if (!this.model) return;
    this.model.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m.emissive) continue;
        m.emissive.setRGB(k * 0.9, k * 0.25, k * 0.2);
      }
    });
  }

  /** 眩晕星形贴图：四角星 + 中心光晕，加法混合后像“头顶转圈的星星” */
  #stunTexture() {
    if (Boss._stunTex) return Boss._stunTex;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.translate(64, 64);
    // 中心光晕
    const grad = g.createRadialGradient(0, 0, 2, 0, 0, 62);
    grad.addColorStop(0, 'rgba(255,250,210,1)');
    grad.addColorStop(0.4, 'rgba(255,214,110,0.55)');
    grad.addColorStop(1, 'rgba(255,180,60,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.arc(0, 0, 62, 0, Math.PI * 2);
    g.fill();
    // 四角星芒
    g.strokeStyle = 'rgba(255,244,180,0.95)';
    g.lineWidth = 9;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-44, 0); g.lineTo(44, 0);
    g.moveTo(0, -44); g.lineTo(0, 44);
    g.moveTo(-24, -24); g.lineTo(24, 24);
    g.moveTo(24, -24); g.lineTo(-24, 24);
    g.stroke();
    Boss._stunTex = new THREE.CanvasTexture(c);
    return Boss._stunTex;
  }

  /**
   * 头顶眩晕特效：三颗星星绕 BOSS 头部转圈 + 上下浮动。
   * 只在破韧窗口显示，第四关没有 staggerMax 就不会创建。
   */
  #buildStunFx() {
    if (!this.staggerMax) return;
    const h = this.def.height || 7;
    const r = this.def.radius || 5;
    const tex = this.#stunTexture();
    const group = new THREE.Group();
    group.position.y = h * 1.12;
    group.visible = false;
    this.stunStars = [];
    for (let i = 0; i < 3; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex, color: 0xffe27a, transparent: true, opacity: 0.9,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(Math.max(1.5, r * 0.46));
      group.add(sprite);
      this.stunStars.push({ sprite, mat, phase: (i / 3) * Math.PI * 2 });
    }
    this.group.add(group);
    this.stunGroup = group;
  }

  #updateStunFx(dt) {
    if (!this.stunGroup) return;
    const show = !this.dead && !this.airborne && (this.staggerTimer > 0 || this.staggerPose > 0.12);
    this.stunGroup.visible = show;
    if (!show) return;
    const h = this.def.height || 7;
    const r = this.def.radius || 5;
    const t = this.bobT;
    this.stunGroup.position.y = h * 1.12 + Math.sin(t * 4.2) * 0.16;
    this.stunGroup.rotation.y = t * 0.9;
    for (const st of this.stunStars) {
      const a = t * 3.2 + st.phase;
      st.sprite.position.set(
        Math.cos(a) * r * 0.55,
        Math.sin(a * 2 + st.phase) * 0.3,
        Math.sin(a) * r * 0.55,
      );
      st.mat.opacity = 0.68 + Math.sin(t * 8 + st.phase) * 0.28;
    }
  }

  #updateStaggerTimers(dt) {
    if (!this.staggerMax) return;
    if (this.staggerTimer > 0) {
      this.staggerTimer = Math.max(0, this.staggerTimer - dt);
      this.staggerPose = Math.min(1, this.staggerPose + dt * 5);
      if (this.staggerTimer <= 0) this.#endStagger();
    } else {
      if (this.staggerLock > 0) this.staggerLock = Math.max(0, this.staggerLock - dt);
      // 没有持续输出时韧性缓慢回落：打两下就跑不会永久攒着
      else this.stagger = Math.max(0, this.stagger - BOSS_STAGGER.decay * dt);
      this.staggerPose = Math.max(0, this.staggerPose - dt * 3.2);
    }
    this.#updateStunFx(dt);
  }

  /**
   * 累积韧性。返回 true 表示这一下正好填满、BOSS 进入破韧跪地。
   * 破韧中 / 结束后的免疫期 / 第四关（无 staggerMax）都不接受积累。
   */
  addStagger(amount) {
    if (!this.staggerMax || this.dead || this.staggerTimer > 0 || this.staggerLock > 0
      || this.status.dive > 0) return false;
    if (amount <= 0) return false;
    this.stagger = Math.min(this.staggerMax, this.stagger + amount);
    if (this.stagger < this.staggerMax) return false;
    this.beginStagger();
    return true;
  }

  /** 进入破韧跪地（主机由 addStagger 调用；客机收到 bossStagger 后也调这里） */
  beginStagger(duration = BOSS_STAGGER.duration) {
    if (!this.staggerMax || this.dead) return false;
    this.staggerTimer = Math.max(this.staggerTimer, duration);
    this.stagger = 0;
    this.staggerLock = 0;
    this.staggerPose = Math.min(1, this.staggerPose + 0.2);
    this.state = 'stagger';
    this.hopY = 0;
    this.#clearWarning();
    this.#beginStaggerPose();
    this.#updateStunFx(0);
    return true;
  }

  /**
   * 跪地姿势。
   * 有 stagger 片段（龙骑士）→ 停在 dk_death 的 55% 处保持跪姿；
   * 没有片段（火龙）→ 保留 idle，由 #applyPose 做“整体前倾 + 下沉”的程序化跪伏。
   */
  #beginStaggerPose() {
    const clipName = this.def.anims?.stagger;
    const action = clipName ? this.actions?.[clipName] : null;
    this.staggerClip = null;
    if (action) {
      if (this.current && this.current !== action) this.current.fadeOut(0.2);
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      const hold = Math.min(
        action.getClip().duration,
        this.def.staggerHold ?? Math.min(action.getClip().duration * 0.55, 1.4),
      );
      action.time = hold;
      action.paused = true;
      action.enabled = true;
      action.setEffectiveWeight(1);
      this.current = action;
      this.animName = clipName;
      this.staggerClip = clipName;
    } else {
      // 火龙没有跪地片段：待机动作放慢 + 程序化前倾，读起来像被打懵了。
      // 这里走 #play 而不是手动清空 current，确保旧的攻击动作能正常淡出，
      // 否则破韧结束后旧 clip 会一直以权重 1 混在 idle 上。
      this.animScale = 0.28;
      this.#play('idle');
    }
  }

  #endStagger() {
    this.staggerTimer = 0;
    this.staggerLock = BOSS_STAGGER.lock;
    this.stagger = 0;
    this.state = 'chase';
    this.animScale = 1;
    this.staggerClip = null;
    if (this.current) this.current.paused = false;
    this.#play('idle');
  }

  // ---------- 地面预警 ----------
  /**
   * 跟随红圈落点的竖向光柱（熔岩追猎这类"从天往下灌"的锁定技能用）。
   * 必须钉在世界坐标并按 warning.position 逐帧跟随 —— 挂在 BOSS 身上会变成
   * "光柱跟着龙跑、红圈跟着船跑"的两套位置。
   */
  #attachFollowFx(skill, dur) {
    const f = skill.followFx;
    if (!f || !this.fx?.playAttached) return;
    this.fx.playAttached('skillFollowFx', f.fx, () => {
      const p = this.warning?.position;
      const i = this.telegraph?.info;
      return {
        x: p?.x ?? i?.x ?? this.pos.x,
        y: f.y ?? 5.5,
        z: p?.z ?? i?.z ?? this.pos.z,
      };
    }, { life: dur + 0.12, scale: f.scale ?? 1.6, loop: true });
  }

  #makeWarning(skill, info) {
    // 这几种技能自带贴地演出（召唤门 / 棋盘 / 旋转光束），
    // 再叠一圈红圆盘只会误导玩家“站圈外就安全”。
    if (skill.kind === 'gate' || skill.kind === 'grid' || skill.kind === 'laser') return null;
    let geo;
    if (skill.kind === 'cone') {
      const r = skill.range;
      const half = THREE.MathUtils.degToRad(skill.angle) / 2;
      const seg = 24;
      const pos = [];
      const idx = [];
      // 判定原点在嘴部（BOSS 半径 ×0.78，见 BossMode 的 #skillHits），
      // 预警扇形也必须从嘴部起画，否则贴脸那段「红圈外」其实是命中区
      const mouth = (this.def.radius || 5) * 0.78;
      const ox = Math.sin(info.heading) * mouth;
      const oz = Math.cos(info.heading) * mouth;
      pos.push(ox, 0, oz);
      for (let i = 0; i <= seg; i++) {
        const a = info.heading + (i / seg - 0.5) * half * 2;
        pos.push(ox + Math.sin(a) * r, 0, oz + Math.cos(a) * r);
        if (i > 0) idx.push(0, i, i + 1);
      }
      geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
    } else if (skill.kind === 'ring') {
      // 环带宽度与命中判定一致（±3.4），玩家能精确判断“站在环上会挨打”
      geo = new THREE.RingGeometry(
        Math.max(0.5, skill.radius - 3.4),
        skill.radius + 3.4,
        64,
      );
      geo.rotateX(-Math.PI / 2);
    } else if (skill.kind === 'path') {
      // 判定通道是「身前 4m → 42m」（见 BossMode 的 #skillHits），
      // 预警矩形必须同起点同长度；用居中的 40m 平面会让近端多出 16m 假安全区、
      // 远端少判一截，玩家站在红框外照样被撞到。
      const len = 46;
      geo = new THREE.PlaneGeometry(skill.width || 8, len);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, len / 2 - 4);
    } else if (skill.kind === 'wave') {
      // 熔岩海啸：整条推进通道都要标红（宽 = 火墙宽度，长 = reach），
      // 玩家才能提前判断往哪边跑出通道
      const len = skill.reach || 54;
      geo = new THREE.PlaneGeometry(skill.width || 30, len);
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, 0, len / 2);
    } else if (skill.kind === 'screen') {
      // 全屏大招：整个竞技场铺一层暗红（不是普通技能的 0.32 亮红，避免整屏糊死）
      geo = new THREE.CircleGeometry((this.opts.arenaRadius || 92) - 1, 64);
      geo.rotateX(-Math.PI / 2);
    } else if (skill.kind === 'pull') {
      // 吸取范围：只画外缘的一圈，中间不是伤害区
      geo = new THREE.RingGeometry(
        Math.max(1, (skill.radius || 60) - 4), skill.radius || 60, 96,
      );
      geo.rotateX(-Math.PI / 2);
    } else if (skill.kind === 'slam') {
      // 跳劈：落地 22m + 0.5 秒余波 26m。红圈按最大的余波半径画，
      // 圈外才是真安全区（只画 22m 会让玩家以为跑出内圈就没事）
      geo = new THREE.CircleGeometry(skill.waveRadius || skill.outerRadius || 26, 56);
      geo.rotateX(-Math.PI / 2);
    } else {
      geo = new THREE.CircleGeometry(skill.radius || 10, 40);
      geo.rotateX(-Math.PI / 2);
    }
    const mesh = new THREE.Mesh(geo, warningMaterial());
    // 全屏血幕覆盖的是整片竞技场，必须以场地中心为圆心；
    // 挂在 BOSS 身上时它离中心最远 80m，红色圆盘会大半个铺到场地外
    if (skill.kind === 'screen') mesh.position.set(0, 0.12, 0);
    else mesh.position.set(info.x, 0.12, info.z);
    if (skill.kind === 'cone') mesh.rotation.y = 0;
    if (skill.kind === 'path' || skill.kind === 'wave') mesh.rotation.y = info.heading;
    mesh.renderOrder = 3;
    return mesh;
  }

  #updateWarning(dt) {
    if (!this.warning) return;
    const warn = this.telegraph;
    if (!warn) return;
    // 客机没有本地 AI 计时，预警由这里自行倒计时并清理
    if (this.netTarget) {
      warn.timer = Math.max(0, warn.timer - dt);
      if (warn.timer <= 0) {
        // 客机也要看到“技能真的炸出来了”，否则只有红圈没有命中演出
        const at = this.warning
          ? { x: this.warning.position.x, z: this.warning.position.z }
          : { x: this.pos.x, z: this.pos.z };
        if (warn.skill?.hitFx) this.fx?.play(warn.skill.hitFx, at.x, 1.3, at.z, warn.skill.hitFxScale ?? 2.0);
        this.#clearWarning();
        return;
      }
    }
    const k = 1 - Math.max(0, warn.timer) / warn.total;
    // 追猎光柱（ground + track）：红圈前半段死死咬住目标船。
    // trackSpeed 高于赛艇极速，所以"一路直线后撤"必被追上；trackUntil 之后红圈
    // 锁定不动，最后 0.6~0.7 秒急转 / 开氮气冲出圈才是唯一解法。
    // 这里同时更新 warn.info —— 结算用的是 info，不只是画圈，否则圈跟着人跑、
    // 伤害却留在起手点，就成了"看着躲开了还挨打"。
    if (warn.skill?.track && warn.info) {
      if (k < (warn.skill.trackUntil ?? 0.62)) {
        const tgt = (this.opts.getPlayers?.() || [])
          .find((p) => p.id === warn.info.targetId && p.boat);
        if (tgt?.boat) {
          const dx = tgt.boat.pos.x - warn.info.x;
          const dz = tgt.boat.pos.z - warn.info.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.001) {
            const step = Math.min(dist, (warn.skill.trackSpeed || 24) * dt);
            warn.info.x += (dx / dist) * step;
            warn.info.z += (dz / dist) * step;
          }
        }
      }
      if (this.warning) {
        this.warning.position.x = warn.info.x;
        this.warning.position.z = warn.info.z;
      }
    }
    // 越接近命中越亮，并且轻微呼吸放大，远距离也能一眼看清危险区
    const blink = Math.max(0, Math.sin(k * Math.PI * 6)) * 0.1 * k;
    // 全屏大招的红幕只做淡淡的整体泛红，否则整块场地糊成一片
    this.warning.material.opacity = warn.skill?.kind === 'screen'
      ? 0.1 + k * 0.22
      : 0.26 + Math.min(0.52, k * 0.6) + blink;
    this.warning.scale.setScalar(1 + Math.sin(k * Math.PI * 3) * 0.035);
    // 冲锋预警要跟着 BOSS 前冲的真实位移走，红框停在起跑点的话，
    // 后半程玩家明明站在框外也会被撞到。追踪冲锋时朝向也在变，旋转要同步。
    if (warn.skill?.kind === 'path') {
      this.warning.position.x = this.pos.x;
      this.warning.position.z = this.pos.z;
      this.warning.rotation.y = warn.heading;
    }
    // 贴着当前水面高度，暴风雪/暴风雨的高浪也不会把预警淹掉
    this.warning.position.y = waveHeight(this.warning.position.x, this.warning.position.z, this.bobT) + 0.35;
  }

  #clearWarning() {
    // 跟随红圈的光柱必须一起收掉：它挂在世界坐标上，不主动停会一直留在场上
    this.fx?.stopAttached?.('skillFollowFx');
    if (!this.warning) return;
    this.warning.parent?.remove(this.warning);
    this.warning.geometry?.dispose();
    this.warning.material?.dispose();
    this.warning = null;
    this.telegraph = null;
  }

  dispose() {
    this.#clearWarning();
    this.mixer?.stopAllAction();
    this.scene.remove(this.group);
    this.group.traverse((obj) => {
      if (!obj.isMesh) return;
      // 克隆模型的几何体与缓存 gltf 共享，不能释放；只有兜底模型是自建的
      if (!this.modelShared) obj.geometry?.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m?.dispose());
    });
  }
}
