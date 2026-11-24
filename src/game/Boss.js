import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  BOSS_SKILLS, BOSS_GRACE_TIME, BOSS_PHASE_THRESHOLDS, BOSS_PHASE2_RATIO, BOSS_STAGGER,
} from '../data/bosses.js';
import { waveHeight } from '../utils/waves.js';
import { makeBubbleMaterial } from '../utils/bubbleMaterial.js';
import { BossAura, getGlowTexture } from './BossAura.js';
import { getBossAura } from '../data/bossAuras.js';

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
 * 自建骨骼包的根位移轨道经常按“厘米”导出，而模型节点是按“米”的：
 * 例如 Root_M_011 的绑定位置是 6.857，idle 轨道里却写 0 / 685.725，
 * 播放时整个身体被顶到 60 多米高空——玩家看到的就是“BOSS 透明/不见了”。
 * 这里把与绑定位置差出数量级的 position 轨道整条删掉，让根骨留在原地。
 * @returns {number} 删掉的轨道数
 */
export function stripBrokenRootMotion(clip, root) {
  let removed = 0;
  for (let i = clip.tracks.length - 1; i >= 0; i--) {
    const track = clip.tracks[i];
    const suffix = '.position';
    if (!track.name.endsWith(suffix)) continue;
    const bone = root.getObjectByName(track.name.slice(0, -suffix.length));
    if (!bone) continue;
    const rest = bone.position;
    const v = track.values;
    for (let k = 0; k + 2 < v.length; k += 3) {
      if (Math.abs(v[k] - rest.x) > 50
        || Math.abs(v[k + 1] - rest.y) > 50
        || Math.abs(v[k + 2] - rest.z) > 50) {
        clip.tracks.splice(i, 1);
        removed++;
        break;
      }
    }
  }
  return removed;
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
    // 三渲二粒子层（SkillFx）：变身/半血演出的元素色环、光柱从这里出，
    // 不依赖 Effekseer，保证「白色光柱」不会重新出现。
    this.skillFx = opts.skillFx || null;
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
    // 数据驱动的二阶段变身配置（def.phaseShift）：分步特效队列 + 招牌压力计时
    this.phaseShiftCfg = def.phaseShift || null;
    this.phaseFxQueue = [];
    this.phasePressureT = 0;
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
    this.status = { slow: 0, root: 0, blind: 0, confuse: 0, dive: 0, silence: 0, reverse: 0, bubble: 0 };
    // 当前沉水量（米，由 #applyPose 平滑过渡）：>0 表示被深水炸弹压在水下
    this.diveSink = 0;
    // 水泡浮空高度（米，同样由 #applyPose 平滑）：漩涡命中时把 BOSS 托离水面。
    // 刻意**不复用 airborne** —— airborne 在 BossMode#dealBossDamage 里是"完全免疫"，
    // 而用户要求"浮空期间玩家可以继续攻击"。所以浮空只挡技能、不挡伤害。
    this.liftY = 0;
    this.bubbleWrap = null;
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

    // 寒冰牢笼：冻结剩余时间 + 冰晶外壳/碎冰。
    // root/silence 由 BossMode 的 bossStatus 负责，这里只做"动作定格 + 冰块表现"。
    this.frozenT = 0;
    this.iceGroup = null;
    this.iceSpawn = 0;
    // 冰壳在 group 本地空间里的中心：默认按体高 0.42 估，命中瞬间改按
    // 当前蒙皮姿态的包围盒中心重算（腾空时 BOSS 会整体抬到十几米高）。
    this.iceCenter = new THREE.Vector3(0, (def.height || 7) * 0.42, 0);
    // 冰壳纵向放大系数：命中时按蒙皮姿态包围盒重算（腾空展翼时身体更高）
    this.iceFitY = 1;
    this.iceShards = [];
    this.iceChunkGeo = null;
    this.iceEdgeGeo = null;
    this.iceMat = null;
    this.iceEdgeMat = null;

    this.group = new THREE.Group();
    this.group.position.copy(this.pos);
    scene.add(this.group);
    this.modelShared = false;

    // 主题配置：光环、弱点圈、眼睛都从这里取色，5 头 BOSS 各不相同
    this.auraCfg = getBossAura(def.id);

    // 背部弱点：正面是装甲（伤害 -30%），绕到背后打核心（伤害 ×2）。
    // 双人时 BOSS 会盯着仇恨最高的人，另一人正好能绕背输出。
    this.#buildWeakPoint();
    this.#buildAura();
    this.#buildEyes();
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

  /**
   * 专属包围光环：地面法阵 / 环绕粒子 / 背后竖立法阵 / 招牌演出，
   * 由 data/bossAuras.js 按 BOSS id 配置，BossAura 统一驱动。
   * 跟随 BOSS 移动与转向；腾空、预警、二阶段的状态由 update 传入。
   */
  #buildAura() {
    this.aura = new BossAura({
      scene: this.scene,
      group: this.group,
      def: this.def,
      getCamera: this.opts.getCamera,
      hexVariant: this.opts.hexVariant,
    });
    // 兼容旧的可视化探针：原红环的位置现在由主题边界环承担
    this.groundRing = this.aura.boundaryRing || null;
  }

  /** 统一驱动光环：腾空收起、死亡淡出、施法预警自动降亮保证红圈可读 */
  #updateAura(dt) {
    this.aura?.update(dt, {
      visible: !this.airborne,
      dead: this.dead,
      dim: this.state === 'telegraph' ? 0.55 : 1,
    });
  }

  /**
   * 寒冰牢笼命中：把整只 BOSS 冻进一块程序化冰晶里，duration 秒内动作定格。
   * 移动/技能由 BossMode 的 root + silence 负责，这里只暂停动画并长出冰壳。
   */
  freeze(duration = 2.6) {
    if (this.dead) return;
    if (!this.iceGroup) this.#buildIceCage();
    if (this.frozenT <= 0) {
      this.#clearIceShards();
      this.iceSpawn = 0;
    }
    this.frozenT = Math.max(this.frozenT, duration);
    // 冰壳严格套在"当前这一帧的 BOSS 身体"上：腾空是蒙皮动画把 _rootJoint
    // 抬到十几米（不是 group.position.y），必须按蒙皮后的姿态包围盒取中心，
    // xyz 三个轴都跟着走，否则 BOSS 飞起来时冰块会留在下面的原地。
    this.#anchorIceCage();
    this.iceGroup.visible = true;
    const k0 = 0.55 + 0.45 * Math.min(1, this.iceSpawn);
    this.iceGroup.scale.set(k0, k0 * this.iceFitY, k0);
    this.hitFlash = 0;
  }

  /** 把冰壳中心对齐到 BOSS 当前姿态的世界包围盒中心（换回 group 本地坐标） */
  #anchorIceCage() {
    if (!this.iceGroup) return;
    this.group.updateMatrixWorld(true);
    const box = this.#visualBox();
    if (!box) {
      this.iceGroup.position.copy(this.iceCenter);
      return;
    }
    const local = this.group.worldToLocal(box.getCenter(new THREE.Vector3()));
    if (!Number.isFinite(local.y)) local.copy(this.iceCenter);
    this.iceCenter.copy(local);
    this.iceGroup.position.copy(local);
    // 冰壳纵向放大到刚好兜住当前姿态（腾空时身体更高），不会从头顶/脚下穿出来。
    // 只拉高、不放宽：横向按原体型，避免冰块变成一大团盖住半个场地。
    const H = this.def.height || 7;
    const size = box.getSize(new THREE.Vector3());
    this.iceFitY = Math.min(1.6, Math.max(1, (size.y * 0.5) / (H * 0.5)));
  }

  /**
   * 当前姿态的网格包围盒（世界坐标）。
   * 蒙皮网格用 SkinnedMesh.computeBoundingBox（r160 会逐顶点套骨骼矩阵），
   * 这样飞行/俯冲/跳劈的骨骼位移都能算进去；普通网格退回几何包围盒。
   * 模型还没加载好时返回 null。
   */
  #visualBox() {
    if (!this.model) return null;
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    this.model.updateWorldMatrix(true, true);
    this.model.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      if (obj.isSkinnedMesh && typeof obj.computeBoundingBox === 'function') {
        // 骨骼矩阵要按当前姿态刷新一次，否则拿到的是上一帧渲染前的矩阵
        obj.skeleton?.update?.();
        obj.computeBoundingBox();
        if (!obj.boundingBox || obj.boundingBox.isEmpty()) return;
        tmp.copy(obj.boundingBox).applyMatrix4(obj.matrixWorld);
      } else {
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        if (!obj.geometry.boundingBox) return;
        tmp.copy(obj.geometry.boundingBox).applyMatrix4(obj.matrixWorld);
      }
      box.union(tmp);
    });
    return box.isEmpty() ? null : box;
  }

  /** 冰晶外壳：4 块大小不一的多面体拼成，带描边和中心冷光，任何体型都能兜住 */
  #buildIceCage() {
    const H = this.def.height || 7;
    const R = this.def.radius || 5;
    const g = new THREE.Group();
    g.position.copy(this.iceCenter);

    this.iceChunkGeo = new THREE.IcosahedronGeometry(1, 1);
    this.iceEdgeGeo = new THREE.EdgesGeometry(this.iceChunkGeo, 12);
    // 用 Phong 而不是 Physical：冰块只需要冷色高光 + 自发光，
    // Physical 的 clearcoat 在低端机/软件渲染上编译和绘制都太重。
    this.iceMat = new THREE.MeshPhongMaterial({
      color: 0xd8f4ff,
      emissive: 0x2a6f96,
      emissiveIntensity: 0.85,
      specular: 0xffffff,
      shininess: 110,
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.iceEdgeMat = new THREE.LineBasicMaterial({
      color: 0xd6fbff,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    const chunks = [
      { p: [0, 0, 0], s: [R * 1.12, H * 0.5, R * 1.02], r: [0.12, 0.5, 0.1] },
      { p: [R * 0.42, -H * 0.06, -R * 0.3], s: [R * 0.66, H * 0.36, R * 0.6], r: [-0.2, 1.1, 0.3] },
      { p: [-R * 0.46, H * 0.04, R * 0.24], s: [R * 0.62, H * 0.34, R * 0.58], r: [0.3, -0.7, -0.2] },
      { p: [0, H * 0.02, 0], s: [R * 0.84, H * 0.56, R * 0.8], r: [0.05, 0.2, 0.05] },
    ];
    for (const c of chunks) {
      const mesh = new THREE.Mesh(this.iceChunkGeo, this.iceMat);
      mesh.position.set(...c.p);
      mesh.scale.set(...c.s);
      mesh.rotation.set(...c.r);
      mesh.renderOrder = 6;
      g.add(mesh);
      const edge = new THREE.LineSegments(this.iceEdgeGeo, this.iceEdgeMat);
      edge.position.copy(mesh.position);
      edge.scale.copy(mesh.scale);
      edge.rotation.copy(mesh.rotation);
      edge.renderOrder = 7;
      g.add(edge);
    }

    // 中心冷光：让冰块在暗场景里也有存在感
    const glowMat = new THREE.SpriteMaterial({
      map: getGlowTexture(),
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Sprite(glowMat);
    glow.scale.setScalar(R * 3.2);
    glow.renderOrder = 5;
    g.add(glow);

    this.iceGroup = g;
    this.group.add(g);
  }

  /** 冰块碎裂：隐藏冰壳，抛出一圈碎冰，1 秒左右自然淡出 */
  #shatterIce() {
    if (this.iceGroup) this.iceGroup.visible = false;
    const R = this.def.radius || 5;
    const H = this.def.height || 7;
    if (!this.iceChunkGeo || !this.iceMat) return;
    const count = 16;
    for (let i = 0; i < count; i++) {
      const mat = this.iceMat.clone();
      mat.opacity = 0.55;
      const mesh = new THREE.Mesh(this.iceChunkGeo, mat);
      const ang = Math.random() * Math.PI * 2;
      const rad = R * (0.3 + Math.random() * 0.7);
      // 碎冰从冰壳自己的中心炸开：腾空时冰块在十几米高，不能按地面原点算
      const local = new THREE.Vector3(
        this.iceCenter.x + Math.cos(ang) * rad,
        this.iceCenter.y + (H * (0.15 + Math.random() * 0.75) - H * 0.42),
        this.iceCenter.z + Math.sin(ang) * rad,
      );
      this.group.localToWorld(local);
      mesh.position.copy(local);
      const s = 0.22 + Math.random() * 0.42;
      mesh.scale.set(s, s * (0.7 + Math.random() * 0.8), s);
      mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      mesh.renderOrder = 6;
      this.scene.add(mesh);
      const sp = 3.5 + Math.random() * 6;
      this.iceShards.push({
        mesh,
        mat,
        vel: new THREE.Vector3(Math.cos(ang) * sp, 6 + Math.random() * 7, Math.sin(ang) * sp),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 9,
        ),
        life: 0.9 + Math.random() * 0.5,
        maxLife: 1.4,
      });
    }
  }

  #clearIceShards() {
    for (const s of this.iceShards) {
      this.scene.remove(s.mesh);
      s.mat.dispose();
    }
    this.iceShards.length = 0;
  }

  /** 冰壳生长缩放 + 碎冰物理，冻结结束后仍要继续跑碎冰 */
  #updateIce(dt) {
    if (this.iceGroup && this.iceGroup.visible) {
      if (this.iceSpawn < 1) {
        this.iceSpawn = Math.min(1, this.iceSpawn + dt / 0.18);
        const k = 0.55 + 0.45 * this.iceSpawn;
        this.iceGroup.scale.set(k, k * this.iceFitY, k);
      }
      if (this.iceMat) this.iceMat.opacity = 0.34 + Math.sin(this.bobT * 6) * 0.05;
    }
    for (let i = this.iceShards.length - 1; i >= 0; i--) {
      const s = this.iceShards[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.mesh);
        s.mat.dispose();
        this.iceShards.splice(i, 1);
        continue;
      }
      s.vel.y -= 16 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      s.mat.opacity = 0.55 * Math.min(1, s.life / (s.maxLife * 0.55));
    }
  }

  /**
   * 双眼光点：模型本身没有眼睛网格，用两个不吃雾的加色 sprite 顶在头部前方。
   * 远距离/暴风雪里也能一眼锁定 BOSS 的朝向；颜色跟随该 BOSS 的主题色。
   */
  #buildEyes() {
    const h = this.def.height || 7;
    const r = this.def.radius || 5;
    this.eyes = [];
    this.eyeMats = [];
    for (const sx of [-1, 1]) {
      const mat = new THREE.SpriteMaterial({
        map: getGlowTexture(), color: this.auraCfg?.eye ?? 0xff2a1a,
        transparent: true, opacity: 0.95,
        depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
      });
      const eye = new THREE.Sprite(mat);
      eye.scale.setScalar(Math.max(0.9, r * 0.22));
      eye.position.set(sx * r * 0.26, h * 0.84, r * 0.66);
      this.group.add(eye);
      this.eyes.push(eye);
      this.eyeMats.push(mat);
    }
  }

  #buildWeakPoint() {
    // 三处弱点：左右舷侧 + 背部核心。正面是装甲（伤害打折），
    // 只要不在正面扇形里，绕到侧面/背后就是弱点 —— 双人时一个人在正面拉仇恨，
    // 另一个从侧面输出，正好形成分工。
    const h = this.def.height || 6;
    const r = this.def.radius || 5;
    this.weakPoints = [];
    const weakRing = this.auraCfg?.weak?.ring ?? 0xff5a34;
    const weakCore = this.auraCfg?.weak?.core ?? 0xffb066;
    const make = (x, z, ry, scale) => {
      const group = new THREE.Group();
      const ringMat = () => new THREE.MeshBasicMaterial({
        color: weakRing, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      });
      const outer = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.95, 28), ringMat());
      const inner = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.78, 22), ringMat());
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.52, 12, 10),
        new THREE.MeshBasicMaterial({
          color: weakCore, transparent: true, opacity: 0.95,
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
    // 无动画 clip 的 BOSS（深渊传令官）：直接驱动骨骼做程序化姿态
    if (this.def.proceduralPose) this.#setupProceduralPose(root);
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
    // 自建骨骼包的单位错误根位移：必须在 #play 之前删，此时骨骼还在绑定位置
    if (this.def.fixRootMotion) {
      let removed = 0;
      for (const clip of clips.values()) removed += stripBrokenRootMotion(clip, root);
      if (removed) console.info(`[boss] ${this.def.id}: 移除 ${removed} 条单位错误的根位移轨道`);
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
    // 绑定姿态塌陷的模型：加载时量到的包围盒是假的（0.2m），
    // 先用 idle 首帧把骨架摆到真实姿态，再按真实蒙皮包围盒重新归一化。
    if (this.def.poseNormalize) {
      this.mixer.update(0.2);
      this.#realignPosedModel();
    }
    this.ready = true;
    this.opts.onReady?.();
  }

  /**
   * 按“已摆好 idle 姿态”的蒙皮包围盒重新归一化高度并贴回水面。
   * 只给绑定姿态不可信的模型用（def.poseNormalize），普通 BOSS 不跑。
   */
  #realignPosedModel() {
    const root = this.model;
    if (!root) return;
    root.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    if (size.y > 0.001) {
      const k = (this.def.height || 7) / size.y;
      if (Math.abs(k - 1) > 0.02) {
        root.scale.multiplyScalar(k);
        root.updateMatrixWorld(true);
        box = new THREE.Box3().setFromObject(root);
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const sink = this.def.waterSink ?? 0.45;
    root.position.x -= center.x;
    root.position.z -= center.z;
    root.position.y -= box.min.y + sink;
    this.modelBaseY = root.position.y;
    root.updateMatrixWorld(true);
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
    // 冻死时先炸掉冰壳，避免死亡演出里一直挂着一块冰
    if (this.frozenT > 0) {
      this.frozenT = 0;
      this.#shatterIce();
    }
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
    // 二阶段压力技不在 BOSS_SKILLS 表里（是 #pressureSkill 按 def.phaseShift 动态拼的）。
    // 客机也必须用同一份配置还原，否则只收到 bossHit 掉血、却看不到红圈预警。
    const p = this.phaseShiftCfg?.pressure;
    const pressureId = p ? (p.id || 'phasePulse') : null;
    const skill = BOSS_SKILLS[skillId]
      || (p && skillId === pressureId ? this.#pressureSkill(p) : null);
    if (!skill || this.dead) return;
    // 阶段转换：客机也播放该 BOSS 的专属变身演出（数值/伤害仍由主机负责）
    if (skillId === 'phaseBlast') {
      this.#beginPhaseShift(skill, false);
      return;
    }
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
    // 瞬移类：前摇优先用 blinkCast（第五关瞬狱斩先蹲身收翼，落下再单独挥砍）
    if (skill.kind === 'blink' && skill.blinkCast && this.def.anims?.[skill.blinkCast]) {
      return skill.blinkCast;
    }
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
    this.#updateAura(dt);
  }

  update(dt, t) {
    if (!this.ready) return;
    this.bobT += dt;

    // 冻结：动画、移动、技能 AI 全部定格，只让冰壳呼吸/碎冰飞散。
    // root/silence 由 BossMode 写入，这里管表现。
    if (this.frozenT > 0) {
      this.frozenT = Math.max(0, this.frozenT - dt);
      if (this.frozenT <= 0) this.#shatterIce();
      this.#updateIce(dt);
      this.#updateAura(dt);
      return;
    }
    this.#updateIce(dt);
    if (this.mixer) this.mixer.update(dt * (this.animScale || 1));

    if (this.dead) {
      this.deathT = (this.deathT || 0) + dt;
      // 死的时候还套着水泡的话，泡会留在原地 —— 直接收掉
      if (this.bubbleWrap) this.bubbleWrap.visible = false;
      this.group.position.y = -Math.min(1, this.deathT / 2.6) * this.def.height * 0.55;
      this.group.rotation.z = Math.min(0.5, this.deathT * 0.18);
      this.#updateAura(dt);
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
    // 二阶段变身的分步特效与招牌压力倒计时
    this.#updatePhaseShift(dt);

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
    // 双眼/光环都挂在出生点的水面上，腾空后会变成半空中漂浮的亮点，先收起来
    if (this.eyes) for (const e of this.eyes) e.visible = !this.airborne;
    // 专属包围光环：地面法阵 + 环绕粒子 + 背后竖立法阵 + 招牌演出
    this.#updateAura(dt);
    // 双眼光点：呼吸，读起来像"活着"
    if (this.eyeMats) {
      const k = 0.72 + Math.sin(this.bobT * 3.4) * 0.22;
      for (const m of this.eyeMats) m.opacity = k;
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
      this.#beginPhaseShift(BOSS_SKILLS.phaseBlast);
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

    // 二阶段招牌压力：按 phaseShift.pressure 周期性额外出手。
    // 复用普通技能管线（红圈预警 → 结算 → 命中反馈），所以和其它技能完全一致；
    // 客机在这里已经因为 netTarget 提前返回，不会本地偷偷放技能。
    const pressure = this.phaseShiftCfg?.pressure;
    if (pressure && this.phaseIndex > 0 && this.phaseLock <= 0
      && this.phasePressureT <= 0 && !this.airborne
      && this.status.bubble <= 0 && this.status.dive <= 0
      && this.staggerTimer <= 0) {
      this.phasePressureT = pressure.every || 9;
      this.#beginTelegraph(this.#pressureSkill(pressure), target);
      this.#applyPose(dt);
      return;
    }

    // 有技能可用且够得着：进入预警。腾空 / 被水泡困住期间不接新技能
    const skill = (this.airborne || this.status.bubble > 0)
      ? null : this.#pickSkill(dist, this.anchor);
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
    // 无 clip 的程序化骨骼 BOSS 也算「能踱步」：它没有动画可切，
    // 但走/跑两套骨骼姿态由实际速度驱动，所以照常按 2.4~4.6 秒随机切一次节奏。
    const canPace = !!this.def.proceduralPose
      || !!(this.def.anims?.move && this.def.anims?.moveFast);
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
      // 龙息扫射：判定是"从龙口喷出的扇形"，射程按 range 算
      case 'flamesweep': return this.def.radius + (skill.range || 28) + 4;
      case 'ring': return this.def.radius + (skill.radius || 20) + 2;
      // 落点类技能：追猎光柱是"从天而降"的锁定技，不受距离限制；
      // 其余落点（俯冲/落雷）仍按 30m 内才放
      case 'ground': return skill.track ? 999 : this.def.radius + 30;
      // 双段俯冲同样带追踪，整场都能扑
      case 'divecombo': return skill.track ? 999 : this.def.radius + 30;
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
    // （真正"打断读条"由 BossMode 的墨鱼/漩涡命中走 interruptCast()）
    if (this.status.silence > 0) return null;
    // 漩涡水泡：被关在泡里同样不能起新技能（用户口径：浮空期间不能放技能）
    if (this.status.bubble > 0) return null;
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
      || skill.kind === 'rift' || skill.kind === 'divecombo') {
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
   * 阶段转换（数据驱动）：读 def.phaseShift 播放变身动作、分步特效、
   * 二阶段数值增益与招牌压力；统一的白圈变身换成了每头 BOSS 各自的演出。
   * 仍然保留半径 30m 的红圈 AOE：变身不是无解秒杀，跑出圈就安全。
   * @param {object} blastSkill 30m 红圈机制技能（BOSS_SKILLS.phaseBlast）
   * @param {boolean} authoritative 主机负责数值/联网；客机只做视觉回放
   */
  #beginPhaseShift(blastSkill, authoritative = true) {
    if (!blastSkill) return;
    const cfg = this.phaseShiftCfg || {};
    const info = { x: this.pos.x, z: this.pos.z, heading: this.heading };
    const dur = Math.max(0.5, blastSkill.telegraph * this.telegraphScale);
    // 同上：先清旧预警，再写 telegraph，避免 #clearWarning 把新 telegraph 置空
    this.#clearWarning();
    this.telegraph = {
      skill: blastSkill, info, timer: dur, total: dur, heading: this.heading,
    };
    this.state = 'telegraph';
    // 变身动作按 clip 原速播放（enrage 通常 1.2~1.5 秒），不再强行 1.5 倍慢放
    this.animScale = 1;
    this.phaseLock = 8;
    if (!this.playOnce(cfg.anim || 'enrage', dur + 0.8)) this.#play('aoe');
    this.aura?.setPhase(2);

    // 变身第一帧就铺一圈主题色环：火焰橙 / 雷霆冷蓝 / 血月殷红 / 圣裁金
    // （旧实现在这里没有元素色，玩家看到的是 Effekseer 偏白的通用光柱）
    this.skillFx?.ringBurst(cfg.theme || this.def.fxTheme || 'fire', {
      x: this.pos.x,
      z: this.pos.z,
      radius: Math.max(12, (this.def.radius || 4) * 3),
      count: 64,
      up: 8,
    });

    if (authoritative) {
      // 二阶段数值：移速 / 冷却 / 伤害都按配置乘上去（客机不叠加，避免双倍）
      const buff = cfg.buff || {};
      this.speedScale *= buff.speed ?? 1;
      this.cooldownScale *= buff.cooldown ?? 1;
      this.damageScale *= buff.damage ?? 1;
      // first 从「变身形锁解除」开始算，否则 8 秒锁期内就把计时跑完了，
      // 解除锁定的瞬间立刻又吃一发压力技，玩家没有喘息窗口。
      this.phasePressureT = this.phaseLock + (cfg.pressure?.first ?? 5);
    }

    // 分步特效：t 秒后依次播放，贴本体 / 绕本体一圈两种锚点
    this.phaseFxQueue = (cfg.fx || []).map((s) => ({
      step: s, left: Math.max(0.001, s.t || 0.001),
    }));
    if (!this.phaseFxQueue.length) {
      // 没有配置时退回旧的通用演出（兼容以后再加的 BOSS）
      this.fx?.play('tornado', this.pos.x, this.def.height * 0.55, this.pos.z, 2.2);
      this.fx?.play('ring', this.pos.x, waveHeight(this.pos.x, this.pos.z, this.bobT) + 0.5, this.pos.z, 2.6);
      this.fx?.play('fxFireBand', this.pos.x, 3.0, this.pos.z, 3.2);
    }

    this.warning = this.#makeWarning(blastSkill, info);
    if (this.warning) this.scene.add(this.warning);
    this.opts.onPhaseChange?.(blastSkill, cfg);
    this.opts.onSkillVisual?.(blastSkill, info, 'cast');
    if (authoritative && this.isHost) {
      this.net?.send({
        t: 'bossCast', skill: blastSkill.id, x: info.x, z: info.z,
        h: info.heading, dur,
      });
    }
  }

  /** 二阶段变身的分步特效队列 + 招牌压力倒计时（每帧） */
  #updatePhaseShift(dt) {
    if (this.phaseFxQueue.length) {
      for (const item of this.phaseFxQueue) item.left -= dt;
      while (this.phaseFxQueue.length && this.phaseFxQueue[0].left <= 0) {
        this.#spawnPhaseFx(this.phaseFxQueue.shift().step);
      }
    }
    if (this.phaseShiftCfg?.pressure && this.phasePressureT > 0) {
      this.phasePressureT = Math.max(0, this.phasePressureT - dt);
    }
  }

  /** 播一段变身特效：at=self 贴本体；at=ring 按 count 绕本体均匀铺开 */
  #spawnPhaseFx(step) {
    if (!step?.key) return;
    const h = this.def.height || 7;
    const scale = step.scale ?? 1.6;
    const y = step.y != null ? h * step.y : Math.max(2.4, h * 0.55);
    if (step.at === 'ring') {
      const n = Math.max(1, step.count || 6);
      const r = step.radius ?? ((this.def.radius || 4) + 6);
      const offset = step.offset || 0;
      for (let i = 0; i < n; i++) {
        const a = offset + (i / n) * Math.PI * 2;
        this.fx?.play(step.key, this.pos.x + Math.cos(a) * r, y, this.pos.z + Math.sin(a) * r, scale);
      }
    } else {
      this.fx?.play(step.key, this.pos.x + (step.dx || 0), y, this.pos.z + (step.dz || 0), scale);
    }
  }

  /**
   * 半血演出复用二阶段配置：把 fx 队列的前 count 步立刻播一遍。
   * 不改数值、不拉预警、不放压力技 —— 只让半血那次“变招”也用这头 BOSS 自己的元素。
   * @returns {boolean} 有配置并成功播放时 true（让调用方跳过通用白色光柱兜底）
   */
  previewPhaseFx(count = 2) {
    const list = (this.phaseShiftCfg?.fx || []).slice(0, Math.max(1, count));
    for (const step of list) this.#spawnPhaseFx(step);
    return list.length > 0;
  }

  /** 把 phaseShift.pressure 的简写转成完整技能对象，交给 #beginTelegraph 走通用管线 */
  #pressureSkill(p) {
    return {
      id: p.id || 'phasePulse',
      name: p.name || '二阶段·领域',
      kind: p.kind || 'ground',
      radius: p.radius ?? 10,
      angle: p.angle,
      range: p.range,
      width: p.width,
      damage: p.damage ?? 10,
      telegraph: p.telegraph ?? 1.5,
      cooldown: 999,
      visual: p.visual || this.def.fxTheme || 'fire',
      element: p.element,
      anim: p.anim || 'aoe',
      blinkCast: p.blinkCast,
      fx: p.fx || [],
      fxScale: p.fxScale ?? 1.6,
      groundFx: p.groundFx,
      hitFx: p.hitFx,
      hitFxScale: p.hitFxScale,
      hitKind: p.hitKind,
      slowSpeed: p.slowSpeed,
      slowTime: p.slowTime,
      slowLabel: p.slowLabel,
      duration: p.duration,
      tickInterval: p.tickInterval,
      spotCount: p.spotCount,
      spotRadius: p.spotRadius,
      spotDelay: p.spotDelay,
      startDelay: p.startDelay,
      minHpRatio: 99,
    };
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
      // 落点接一刀：优先技能自带的落斩 clip（第五关的 ab_blink_slash），
      // 没有再退回语义映射（第三关走 dk_smash 重劈，第四关走本体普攻）。
      const slash = (skill.anim && this.def.anims?.[skill.anim]) ? skill.anim : this.#skillAnim(skill);
      this.#play(slash, true, true);
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

  /**
   * 无 clip BOSS 的程序化骨架。
   *
   * 深渊传令官的 GLB 只有 157 关节绑定、没有任何 AnimationClip，
   * 直接站着会像雕像。这里抓出肩 / 肘 / 腕 / 胸 / 颈 / 头 / 下颌 / 髋 / 膝，
   * 每帧在绑定姿势上叠加一层欧拉旋转：待机呼吸、行走摆腿、冲锋前倾、
   * 横扫扭腰、砸地举臂、咆哮张嘴，全部靠代码完成，不再另外找动画。
   *
   * 骨骼名来自 Aion 导出（Chest_M_014 / Shoulder_R_0697 / Jaw_M_0727 …），
   * 数字后缀每根骨都不同，所以一律用前缀正则匹配。
   */
  #setupProceduralPose(root) {
    const pick = (re) => {
      let found = null;
      root.traverse((o) => {
        if (!found && o.isBone && re.test(o.name)) found = o;
      });
      return found;
    };
    const defs = {
      chest: /^Chest_M/, back: /^BackB_M/,
      neck: /^Neck_M/, head: /^Head_M/, jaw: /^Jaw_M/,
      shR: /^Shoulder_R_/, shL: /^Shoulder_L_/,
      elR: /^Elbow_R_/, elL: /^Elbow_L_/,
      wrR: /^Wrist_R_/, wrL: /^Wrist_L_/,
      hipR: /^Hip_R_/, hipL: /^Hip_L_/,
      kneeR: /^Knee_R_/, kneeL: /^Knee_L_/,
      ankleR: /^Ankle_R_/, ankleL: /^Ankle_L_/,
      // 脚掌 / 脚趾：8 米高的巨物落地时脚趾要有抓地动作，
      // 只绑到脚踝的话脚掌永远是僵直的一块，看起来像假肢。
      toeR: /^MiddleToe1_R_/, toeL: /^MiddleToe1_L_/,
    };
    const rig = {};
    for (const [key, re] of Object.entries(defs)) {
      const bone = pick(re);
      if (!bone) continue;
      rig[key] = { bone, rest: bone.quaternion.clone(), cur: new THREE.Vector3(0, 0, 0) };
    }
    if (!rig.chest && !rig.shR) return;

    // ★ 关键：Aion 导出的骨骼 roll 很乱，髋/膝的局部 X 轴其实是沿腿的竖直轴，
    //   直接转局部 X 只会让腿“拧麻花”，脚不会前后迈；胸/头的局部 X 则是转身，
    //   所以以前看起来像在左右跳舞。这里在绑定姿势下把「世界语义轴」反算回
    //   每根骨骼自己的局部空间：
    //     ax = 前后俯仰（迈腿 / 屈膝 / 弯腰）
    //     ay = 左右转身
    //     az = 左右侧摆
    //   之后所有姿态都用「俯仰/转身/侧摆」表达，跟骨骼 roll 无关。
    this.group.updateMatrixWorld(true);
    const gInv = this.group.getWorldQuaternion(new THREE.Quaternion()).invert();
    const relInv = new THREE.Quaternion();
    for (const item of Object.values(rig)) {
      const worldQ = item.bone.getWorldQuaternion(new THREE.Quaternion());
      relInv.copy(gInv).multiply(worldQ).invert();
      item.ax = new THREE.Vector3(1, 0, 0).applyQuaternion(relInv).normalize();
      item.ay = new THREE.Vector3(0, 1, 0).applyQuaternion(relInv).normalize();
      item.az = new THREE.Vector3(0, 0, 1).applyQuaternion(relInv).normalize();
    }

    this.poseRig = rig;
    this._poseQuat = new THREE.Quaternion();
    this._poseQA = new THREE.Quaternion();
    this._poseQB = new THREE.Quaternion();
    this._poseQC = new THREE.Quaternion();
    this._poseTarget = {};
    for (const key of Object.keys(rig)) this._poseTarget[key] = [0, 0, 0];
  }

  #applyProceduralPose(dt) {
    const rig = this.poseRig;
    if (!rig) return;
    const t = this.bobT;
    const target = this._poseTarget;
    for (const key in target) {
      const a = target[key];
      a[0] = 0; a[1] = 0; a[2] = 0;
    }
    const put = (key, x = 0, y = 0, z = 0) => {
      const a = target[key];
      if (a) { a[0] = x; a[1] = y; a[2] = z; }
    };
    const add = (key, x = 0, y = 0, z = 0) => {
      const a = target[key];
      if (a) { a[0] += x; a[1] += y; a[2] += z; }
    };
    this.poseBobY = 0;

    // ---------- 待机：只有呼吸，没有左右重心摇摆 ----------
    // 上一版待机让骨盆在两条腿之间来回切重心（hipR/hipL 反相 + 膝盖交替屈伸），
    // 在 8 米高的体型上被放大成“左一晃右一晃”。这里全部删掉，
    // 只保留胸腔呼吸、头部缓慢扫视这种小幅度的生命感。
    const breathe = Math.sin(t * 1.25);
    put('chest', 0.03 * breathe, 0, 0);
    put('back', 0.02 * breathe);
    put('neck', 0.015 * Math.sin(t * 0.9));
    put('head', 0.03 * Math.sin(t * 0.75), 0.06 * Math.sin(t * 0.31));
    put('jaw', 0.04 + 0.03 * Math.sin(t * 0.9));
    put('shR', -0.05 * breathe);
    put('shL', -0.05 * breathe);
    put('elR', -0.08 + 0.03 * breathe);
    put('elL', -0.08 + 0.03 * breathe);
    put('kneeR', 0.04);
    put('kneeL', 0.04);
    put('ankleR', -0.04);
    put('ankleL', -0.04);

    // ---------- 走路 / 跑步：按真实位移速度驱动 ----------
    // 以前是「只要 state=chase 就用固定 4.2rad/s 摆腿」，站在停距也是原地踏步，
    // 幅度还只有 19°。现在用 BOSS 每帧实际位移算速度：
    //   norm < 0.4 → 走路（慢摆、小步幅）
    //   norm > 0.45 → 跑步（大步幅 + 前倾 + 手臂大幅摆动 + 身体起伏）
    // 站着不动 moveW=0，只剩待机摇摆。
    const hasPrev = this._posePrevX != null;
    const dxPose = hasPrev ? this.pos.x - this._posePrevX : 0;
    const dzPose = hasPrev ? this.pos.z - this._posePrevZ : 0;
    this._posePrevX = this.pos.x;
    this._posePrevZ = this.pos.z;
    const inst = dt > 1e-5 ? Math.min(18, Math.hypot(dxPose, dzPose) / dt) : 0;
    const speedK = 1 - Math.exp(-10 * dt);
    this.poseSpeed = (this.poseSpeed || 0) + (inst - (this.poseSpeed || 0)) * speedK;
    const norm = Math.min(1.3, this.poseSpeed / Math.max(0.001, (this.def.speed || 6) * 0.9));
    const moveW = THREE.MathUtils.smoothstep(norm, 0.06, 0.35);
    // 踱步段实际速度约为全速的 0.55（norm≈0.64），阈值放在 0.55~0.95
    // 才能让「走」和「跑」真的分成两套姿态，而不是永远半走半跑。
    const runW = THREE.MathUtils.smoothstep(norm, 0.55, 0.95);
    // 步频跟着速度走：走路≈0.8 个循环/秒，全速跑≈1.2 个循环/秒。
    // 8 米高的 BOSS 不能像小怪一样高频碎步，慢而大的步幅才不滑步。
    this.posePhase = (this.posePhase || 0) + dt * (1.8 + norm * 5.0);
    const walking = this.state === 'chase' ? moveW : 0;
    if (walking > 0.001) {
      const ph = this.posePhase;
      const c = Math.cos(ph);
      const s = Math.sin(ph);
      // 髋部摆幅：走路 17°、跑步 25°。这个 BOSS 的整条腿只有 1.7 米
      // （髋 y=2.65 → 脚踝 y=0.97），摆幅再大脚就会像钟摆一样甩到半空。
      const amp = (0.30 + 0.14 * runW) * walking;
      // φ=0 时右腿在最前、左腿在最后；φ=π 反过来。
      // 世界 X 轴俯仰：负 = 腿向前迈，正 = 腿向后蹬（已在绑定姿势下核对）。
      const hipR = -amp * c;
      const hipL = amp * c;
      add('hipR', hipR);
      add('hipL', hipL);
      // 摆动相（脚从后往前）才屈膝，峰值在 φ=3π/2；支撑相几乎伸直。
      // 用力矩平方让膝弯集中在半程，不会一整天都半蹲着。
      const swR = Math.max(0, -s);
      const swL = Math.max(0, s);
      const kneeAmp = 0.34 + 0.16 * runW;
      const kneeR = 0.04 + kneeAmp * walking * swR * swR;
      const kneeL = 0.04 + kneeAmp * walking * swL * swL;
      add('kneeR', kneeR);
      add('kneeL', kneeL);
      // 脚踝抵消「髋 + 膝」的累计俯仰，让脚掌始终接近水平：
      // 不补偿的话，膝盖一弯脚掌就整个翘起来，像在踮脚尖跳舞。
      add('ankleR', -(hipR + kneeR) * 0.9);
      add('ankleL', -(hipL + kneeL) * 0.9);
      // 脚趾：支撑相末尾抓地、摆动相略微收起来，给脚掌一点细节。
      add('toeR', -0.16 * Math.max(0, c) * walking);
      add('toeL', -0.16 * Math.max(0, -c) * walking);
      // 手臂与同侧腿反向，但幅度压小：这个 BOSS 的手臂很长，
      // 摆到 40° 会像在挥手跳舞，18° 左右才是正常走路。
      const arm = (0.13 + 0.09 * runW) * walking;
      add('shR', s * arm);
      add('shL', -s * arm);
      add('elR', (-0.06 - Math.max(0, -s) * 0.12 * runW) * walking);
      add('elL', (-0.06 - Math.max(0, s) * 0.12 * runW) * walking);
      // 躯干前倾，不拧腰（拧腰在正面看就是左右摇）
      add('chest', (0.05 + 0.11 * runW) * walking, 0, 0);
      add('back', 0.02 * walking);
      add('head', -(0.04 + 0.04 * runW) * walking, 0, 0);
      add('jaw', 0.05 * runW * walking * (0.5 + 0.5 * s));
      // ★ 不再让身体上下起伏：上一版按步频把骨盆压低 0.2~0.35 米
      //   （一步沉两次），这就是用户看到的“一直在蹦蹦跳跳”。
      //   脚离地的高度已经由膝盖控制，身体保持水平才像在走而不是蹦。
      this.poseBobY = 0;
    }

    // ---------- 技能前摇：按 skill.pose 切换姿态 ----------
    if (this.state === 'telegraph' && this.telegraph) {
      const total = Math.max(0.001, this.telegraph.total || 1);
      const p = Math.min(1, Math.max(0, 1 - Math.max(0, this.telegraph.timer) / total));
      const pose = this.telegraph.skill?.pose || 'cast';
      const step = (a, b) => THREE.MathUtils.smoothstep(p, a, b);

      if (pose === 'slashDown') {
        // 冲击向下挥砍：前 40% 双臂高举、身体后仰蓄力，
        // 40%~70% 随着冲锋整体前压、双臂从头顶劈到身前，末段屈膝收势。
        // 和 #beginTelegraph 里 p>0.4 开始的位移同步，看起来是“冲过去一刀劈下”。
        const up = Math.min(1, p / 0.4);
        const chop = step(0.4, 0.68);
        const settle = step(0.72, 1);
        // 俯仰：-2.4 举到头顶偏前，劈到 -0.2（身前下方）
        const sh = -2.4 * up + 2.2 * chop;
        // 侧摆：右臂向 +X 收拢为 +Z，左臂为 -Z，双臂在头顶合拢
        put('shR', sh, 0, 0.4 * up - 0.12 * chop);
        put('shL', sh, 0, -0.4 * up + 0.12 * chop);
        put('elR', -0.4 * up + 0.2 * chop);
        put('elL', -0.4 * up + 0.2 * chop);
        put('wrR', -0.2 * up + 0.55 * chop);
        put('wrL', -0.2 * up + 0.55 * chop);
        put('chest', -0.3 * up + 0.9 * chop - 0.25 * settle);
        put('back', -0.16 * up + 0.32 * chop);
        put('head', -0.35 * up + 0.55 * chop);
        put('jaw', 0.5 * chop);
        put('hipR', -0.18 * up + 0.3 * chop);
        put('hipL', 0.18 * up - 0.3 * chop);
        put('kneeR', 0.12 + 0.5 * chop);
        put('kneeL', 0.12 + 0.5 * chop);
        // 蓄力时踮一下、下劈时整个人压下去，给劈砍一点重量感
        this.poseBobY = 0.12 * up - 0.5 * chop;
      } else if (pose === 'sweep') {
        // 回身横扫：胸腔先向右拧，再整条脊柱甩向左
        const wind = Math.min(1, p / 0.55);
        const swing = step(0.55, 0.82);
        const yaw = 0.65 * wind - 1.5 * swing;
        put('chest', 0.16, yaw, 0);
        put('back', 0.04, yaw * 0.5, 0);
        put('head', 0, yaw * 0.45);
        put('shR', -0.72, 0, -0.22);
        put('shL', -0.45, 0, 0.18);
        put('elR', 0.35);
        put('elL', 0.28);
        put('kneeR', 0.18);
        put('kneeL', 0.18);
      } else if (pose === 'slam') {
        // 双拳砸海：举臂 → 下砸 → 屈膝
        const up = Math.min(1, p / 0.5);
        const down = step(0.5, 0.76);
        put('shR', -2.0 * up + 2.1 * down, 0, 0.16 * up);
        put('shL', -2.0 * up + 2.1 * down, 0, -0.16 * up);
        put('elR', -0.18 * up + 0.3 * down);
        put('elL', -0.18 * up + 0.3 * down);
        put('chest', -0.2 * up + 0.55 * down);
        put('back', -0.1 * up + 0.2 * down);
        put('head', -0.28 * up + 0.32 * down);
        put('kneeR', 0.14 + 0.5 * down);
        put('kneeL', 0.14 + 0.5 * down);
        put('hipR', -0.2 * down);
        put('hipL', -0.2 * down);
        put('jaw', 0.4 * down);
      } else if (pose === 'roar') {
        // 深渊咆哮：仰头、张嘴、胸腔后张
        const open = step(0.08, 0.45);
        put('chest', -0.22 * open);
        put('back', -0.1 * open);
        put('neck', -0.2 * open);
        put('head', -0.38 * open);
        put('jaw', 0.55 * open);
        put('shR', 0.32 * open, 0, -0.4 * open);
        put('shL', 0.32 * open, 0, 0.4 * open);
      } else if (pose === 'swordCast') {
        // 天罚圣剑：双臂高举、仰头
        const up = step(0.1, 0.55);
        put('shR', -1.95 * up, 0, -0.1 * up);
        put('shL', -1.95 * up, 0, 0.1 * up);
        put('elR', -0.15 * up);
        put('elL', -0.15 * up);
        put('chest', -0.18 * up);
        put('head', -0.32 * up);
        put('jaw', 0.22 * up);
      } else if (pose === 'summon') {
        // 圣光降临：展臂、仰头、张口
        const open = step(0.1, 0.5);
        put('shR', -0.6 * open, 0, -0.85 * open);
        put('shL', -0.6 * open, 0, 0.85 * open);
        put('chest', -0.16 * open);
        put('head', -0.3 * open);
        put('jaw', 0.35 * open);
      } else {
        // cast：单臂抬起，另一手护胸
        const raise = step(0.1, 0.5);
        put('shR', -1.5 * raise, 0, -0.2 * raise);
        put('elR', -0.2 * raise);
        put('shL', -0.25 * raise);
        put('chest', 0.1 * raise, -0.15 * raise);
        put('head', -0.12 * raise, 0.12 * raise);
      }
    }

    // ---------- 破韧跪伏 / 死亡塌陷 ----------
    if (this.state === 'stagger' || this.state === 'dying' || this.state === 'dead') {
      const down = this.state === 'stagger' ? 0.7 : 1;
      put('chest', 0.5 * down);
      put('back', 0.25 * down);
      put('head', 0.35 * down);
      put('kneeR', 0.85 * down);
      put('kneeL', 0.85 * down);
      put('hipR', -0.25 * down);
      put('hipL', -0.25 * down);
      put('shR', -0.2 * down);
      put('shL', -0.2 * down);
    }

    // 受击回弹：这只 GLB 没有 hurt 动画片段（anims 为空），applyDamage 只能写 hitFlash。
    // 之前 flash 只改材质自发光，在暴雪亮底上几乎看不出来；这里在程序化姿态上补一记
    // 「仰头 + 收肩 + 下沉」，让玩家和其他有 hurt 片段的 BOSS 一样看见打中的反应。
    // 读条 / 破韧阶段不叠加，免得和技能姿态打架。
    if (this.def.proceduralPose && this.hitFlash > 0
      && this.state !== 'telegraph' && this.state !== 'stagger') {
      const flinch = Math.min(1, this.hitFlash / 0.22);
      add('chest', -0.2 * flinch);
      add('neck', -0.16 * flinch);
      add('head', -0.24 * flinch);
      add('shR', 0.28 * flinch);
      add('shL', 0.28 * flinch);
      this.poseBobY = (this.poseBobY || 0) - 0.14 * flinch;
    }

    // 平滑逼近目标角，再按「骨骼局部轴 → 世界语义轴」还原成四元数叠回绑定姿势
    const k = 1 - Math.exp(-14 * dt);
    const q = this._poseQuat;
    const qa = this._poseQA;
    const qb = this._poseQB;
    const qc = this._poseQC;
    for (const key in rig) {
      const item = rig[key];
      const tgt = target[key];
      item.cur.x += (tgt[0] - item.cur.x) * k;
      item.cur.y += (tgt[1] - item.cur.y) * k;
      item.cur.z += (tgt[2] - item.cur.z) * k;
      // 依次绕「俯仰 / 转身 / 侧摆」的局部轴转，三轴在局部空间里正交
      qa.setFromAxisAngle(item.ax, item.cur.x);
      qb.setFromAxisAngle(item.ay, item.cur.y);
      qc.setFromAxisAngle(item.az, item.cur.z);
      q.copy(qa).multiply(qb).multiply(qc);
      item.bone.quaternion.copy(item.rest).multiply(q);
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
    // liftY 是漩涡水泡的浮空高度：抬升幅度刻意压在体高的 1/4 左右 ——
    // 抬太高会让船上的弹道（固定瞄准 height*0.45）从脚底穿过去，看起来"打不中"。
    const liftTarget = this.status.bubble > 0 ? (this.def.height || 7) * 0.26 : 0;
    this.liftY = THREE.MathUtils.lerp(this.liftY || 0, liftTarget, 1 - Math.exp(-5 * dt));
    this.#updateBubbleWrap();
    this.group.position.set(
      this.pos.x,
      wave + bob - this.diveSink + (this.hopY || 0) + this.liftY,
      this.pos.z,
    );
    this.group.rotation.y = this.heading;
    // 无 clip BOSS：先算骨骼姿态（会写入 poseBobY 跑步/下劈的身体起伏），
    // 再把它叠到模型自身的 y 上，避免和破韧下沉互相覆盖。
    this.#applyProceduralPose(dt);
    // 火龙没有跪地骨骼片段：破韧时整体前倾 + 下沉，配合慢速待机形成“被打懵跪伏”的观感。
    // 龙骑士用的是 dk_death 的跪姿片段（staggerClip 非空），不再叠加程序化倾角。
    if (this.model && this.staggerMax && !this.staggerClip) {
      const sp = this.staggerPose || 0;
      this.model.rotation.x = -0.42 * sp;
      this.model.position.y = (this.modelBaseY || 0)
        - (this.def.height || 7) * 0.22 * sp + (this.poseBobY || 0);
    } else if (this.model && this.def.proceduralPose) {
      this.model.position.y = (this.modelBaseY || 0) + (this.poseBobY || 0);
    }
    this.#pulseWeakPoint();
  }

  /**
   * 漩涡水泡：BOSS 被打中后套一层道具赛同款泡（`Boat#ensureBubbleWrap` 的放大版）。
   *
   * 三条硬口径（2026-11-22 用户指定）：
   *   ① 只有 BOSS 浮空，**小怪一个都不上浮** —— 这层泡只挂在 `this.group` 上；
   *   ② 浮空期间玩家照常输出，所以这里只做视觉 + 抬高度，绝不碰 airborne / 伤害入口；
   *   ③ 泡体尺寸按 BOSS 体量算，且刻意不超出模型外轮廓太多（半径 ≈ radius×1.02），
   *      免得 Effekseer/泡泡比 GLB 本体还大，看起来像换了一只怪。
   */
  #updateBubbleWrap() {
    const active = this.status.bubble > 0;
    if (!active) {
      if (this.bubbleWrap) this.bubbleWrap.visible = false;
      return;
    }
    if (!this.bubbleWrap) this.#buildBubbleWrap();
    const g = this.bubbleWrap;
    if (!g) return;
    g.visible = true;
    const t = this.bobT;
    const ud = g.userData;
    for (const m of ud.mats) if (m?.uniforms) m.uniforms.uTime.value = t;
    // 贴着泡壁螺旋上升的小水泡：出顶后从池底循环
    for (const s of ud.spots) {
      const y = ((s.y0 + t * s.speed) % ud.spanY + ud.spanY) % ud.spanY;
      const wob = Math.sin(t * 2.2 + s.a * 2) * (ud.r * 0.05);
      const rad = ud.r * 0.9 + wob;
      s.mesh.position.set(Math.cos(s.a + y * 0.06) * rad, y, Math.sin(s.a + y * 0.06) * rad);
      s.mesh.scale.setScalar(0.7 + (y / ud.spanY) * 0.6);
    }
    const pulse = 1 + Math.sin(t * 3.4) * 0.03;
    ud.shell.scale.setScalar(pulse);
    ud.inner.scale.setScalar(2 - pulse);   // 内外反向呼吸，薄膜才有"活着"的感觉
    ud.glow.material.opacity = 0.14 + Math.sin(t * 3.4) * 0.05;
  }

  #buildBubbleWrap() {
    const r = Math.max(2.5, (this.def.radius || 5) * 1.02);
    const centerY = (this.def.height || 7) * 0.42;
    const spanY = (this.def.height || 7) * 0.92;
    const g = new THREE.Group();
    const shellMat = makeBubbleMaterial({ tint: 0x9ae8ff, opacity: 1.0, rim: 1.5 });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 24), shellMat);
    shell.position.y = centerY;
    g.add(shell);
    const innerMat = makeBubbleMaterial({ tint: 0xd4f8ff, opacity: 0.5, rim: 0.9, phase: 2.1 });
    const inner = new THREE.Mesh(new THREE.SphereGeometry(r * 0.84, 26, 18), innerMat);
    inner.position.y = centerY;
    g.add(inner);
    const spots = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const rr = r * (0.085 + (i % 4) * 0.028);
      const mat = makeBubbleMaterial({ tint: 0xbdf2ff, opacity: 0.9, rim: 1.2, phase: i * 0.8 });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(rr, 12, 9), mat);
      g.add(mesh);
      // mat 必须一起存进来：下面 mats 数组靠它把 uTime 推给每一个小泡。
      // 2026-11-22 这里是漏的（只存了 mesh），导致 mats 里全是 undefined，
      // #updateBubbleWrap 每帧 `m.uniforms` 抛 TypeError → 整个 #frame 中断、
      // 画面停在最后一帧，玩家看到的就是"漩涡把 BOSS 托起来瞬间全屏卡死"。
      spots.push({ mesh, mat, a, y0: (i / 12) * spanY, speed: 0.6 + (i % 4) * 0.18 });
    }
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x7fe4ff, transparent: true, opacity: 0.16,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 18, 12), glowMat);
    glow.position.y = centerY;
    g.add(glow);
    g.userData = {
      shell, inner, glow, spots, r, spanY,
      mats: [shellMat, innerMat, glowMat, ...spots.map((s) => s.mat)],
    };
    g.visible = false;
    this.group.add(g);
    this.bubbleWrap = g;
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
    if (skill.kind === 'cone' || skill.kind === 'flamesweep') {
      const r = skill.range;
      // 扫射类会把扇形左右各甩出 sweepDeg/2，预警直接画"整个可能扫到"的扇面，
      // 否则玩家站在预警圈外、火舌甩过来仍然会挨打（读起来像 bug）
      const spanDeg = skill.kind === 'flamesweep'
        ? skill.angle + (skill.sweepDeg || 0)
        : skill.angle;
      const half = THREE.MathUtils.degToRad(spanDeg) / 2;
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
    } else if (skill.kind === 'divecombo') {
      // 双段俯冲：第二段比第一段大，按第二段半径画圈，圈外才是安全区
      geo = new THREE.CircleGeometry(skill.secondRadius || (skill.radius || 12) * 1.45, 56);
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

  /**
   * 打断当前读条（墨鱼、漩涡命中时由 BossMode 调用）。
   *
   * 只对 telegraph 阶段生效：清掉红圈与跟随光柱、放弃连招第二段、落回待机。
   * 顺带把 airborne 收掉 —— 第三关「龙鳞骤雨」是腾空读条的，如果被中途打断却留着
   * `airborne = true`，BossMode#dealBossDamage 会一直"完全免疫"，BOSS 就变成打不动的木桩。
   *
   * @returns {boolean} 是否真的打断到了（没在读条就返回 false，调用方不必提示）
   */
  interruptCast() {
    if (this.state !== 'telegraph' || !this.telegraph) return false;
    this.#clearWarning();
    // #clearWarning 在没有红圈网格时是早退的（telegraph 不会被它清掉），这里显式补一刀
    this.telegraph = null;
    this.state = 'idle';
    this.comboFollow = null;
    this.comboFirst = null;
    this.animHold = 0;
    this.hopY = 0;
    this.airborne = false;
    this.#play('idle');
    return true;
  }

  dispose() {
    this.#clearWarning();
    this.mixer?.stopAllAction();
    // 碎冰挂在 scene 上，不随 group 一起删
    this.#clearIceShards();
    // 竖立法阵/天雷挂在 scene 上，必须单独释放，否则换关会叠在一起
    this.aura?.dispose();
    this.aura = null;
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
