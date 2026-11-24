import * as THREE from 'three';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { Water } from './Water.js';
import { Environment } from './Environment.js';
import { Track } from './Track.js';
import { segmentCrossesLine, arcDelta, lapIsComplete, trackFinishLine } from './finishLine.js';
import {
  boatContactNormal, resolveBoatImpact, boatCollisionRadius, boatCollisionResponse,
} from './boatContact.js';
import { BossArena } from './BossArena.js';
import { BossThemes } from './BossThemes.js';
import { BossMode } from './BossMode.js';
import { ArenaMode } from './ArenaMode.js';
import { SkyTowerMode, SKY_TOWER_NET_TYPES } from './SkyTowerMode.js';
import { SkyTowerArena } from './SkyTowerArena.js';
import { CameraRig } from './CameraRig.js';
import { PostFx } from './PostFx.js';
import { isLakeStadiumEnabled, createLakeStadium } from './LakeStadium.js';
import { createArenaStadium } from './ArenaStadium.js';
import { createGuideSigns, guideSignsEnabled } from './GuideSigns.js';
import { Boat, NITRO_TOP_KMH } from './Boat.js';
import { ItemManager, ITEM_DEFS } from './Items.js';
import { LapTelemetry, IMPACT_ICONS, impactKeyFromFx } from './LapTelemetry.js';
import { GhostBoat } from './GhostBoat.js';
import { readGhost, decodeGhost, writeGhost, encodeGhost, ghostKey } from './GhostStore.js';
import { Effects } from './Effects.js';
import { NITRO_JETS, BOSS_BOOST_JET } from './nitroFx.js';
import { NitroSparkles } from './NitroSparkles.js';
import { NitroJetStream } from './NitroJetStream.js';
import { getBoat, hexBoatDef } from '../data/boats.js';
import { getMap, getWeather, tidalFactor } from '../data/maps.js';
import { SKY_TOWER } from '../data/skyTowerRun.js';
import { BOSS_ARENA, BOSS_LEVELS } from '../data/bosses.js';
import { getBossTheme } from '../data/bossThemes.js';
import { audio } from '../audio/AudioEngine.js';
import { settings } from '../settings.js';
import { setWaveScale, setBigWaves, clampWaveScale, waveCurrent, getWaveScale, waveHeight } from '../utils/waves.js';

// 云端天梯的地图桩：竞技场看台按 boundary.r 围一圈，塔就立在赛场正中央。
// 真正的场景（塔/10 层平台/浮空升降光柱/体积云海）由 SkyTowerScenery 自己建。
const SKY_TOWER_MAP_DEF = {
  id: 'skytower', name: '云端天梯',
  boundary: { x: 0, z: 0, r: 88 },
  // 第一层浮的这片海就是竞技场那片海：色板直接照抄 BOSS_ARENA，
  // 每层天气会再用 WEATHERS 的 waterColor 覆盖（跟竞技场切天气完全同一套口径）
  waterColor: 0x2fc8c8, waterDeep: 0x1460c8, waterCrest: 0x9ff2ee,
  skyTop: 0x3b63a8, skyBottom: 0xffc48a,
  fogColor: 0xb9d9f2, fogDensity: 0.0004,
  noMountains: true, noWaveLaunch: true,
  gates: [[0, 0], [0, 0]], gateWidth: 0,
  weatherBy: {},
};

// 画质档位：高（全后期）/ 中（泛光+调色）/ 低（直出）
const QUALITY_ORDER = ['high', 'medium', 'low'];
const QUALITY_LABEL = { high: '高', medium: '中', low: '低' };

// 氮气尾焰配置见 ./nitroFx.js（竞速逐船差异化 / 怪物模式统一 jet）。

// 喷口世界坐标的复用容器（follow 回调每帧同步消费，不需要每个喷口 new 一个）
const NITRO_NOZZLE_V = new THREE.Vector3();

// 归因副文案（2026-11-18 中央提示条）：主文案是「🧱 撞墙」，副文案补一句"为什么"就够。
// 沿用 C1 口径：不写具体损失数值、不写是谁打的 —— 那属于结算页的事，
// 比赛中每撞一下就报"掉了 6.2 m/s"只会让人更烦。
const IMPACT_HINTS = {
  wall: '蹭到护栏', rock: '撞上礁石', buoy: '顶到浮桶', boat: '被船顶开',
  fall: '掉出赛道', reset: '回到上一段', bomb: '被炸沉', missile: '吃了导弹',
  torpedo: '鱼雷命中', ink: '视线受阻', spin: '卷进漩涡', slow: '减速中',
  halfSpeed: '半速前进', octoGrab: '被缠住', capsize: '翻船', bubbleLift: '水泡顶起',
  geyserLift: '喷泉顶起', void: '拉进异世界', reverse: '方向反了', other: '受击',
};

// ---------- 竞速 / 道具开场镜头 ----------
// 参考 QQ 飞车的发车过场：高空回旋俯视 → 一路压低贴水 → 低空横扫整排赛艇
// → 落到本船船尾的标准追尾机位。没有标题卡（用户明确不要 Monster/Arena 那种大字）。
const RACE_INTRO_TIME = 5.6;

// 开场镜头跳过开关（?raceIntro=0）：无头回归测试 / 联机 e2e 用，
// 否则 5.6s 的过场会被 2~3fps 的软光栅放大成几十秒真实时间。
function skipRaceIntroByUrl() {
  try {
    if (typeof location === 'undefined') return false;
    return new URLSearchParams(location.search).get('raceIntro') === '0';
  } catch { return false; }
}


// 每帧复用的临时对象（避免渲染循环里反复 new）
const VIEW_SIZE = new THREE.Vector2();
const BLACK_PROBE = new Uint8Array(4);

function getStoredQuality() {
  // 老版本把画质存在 rapids-quality 里，新版本统一进 settings。
  // 先做一次性迁移：玩家上一台机器选过低画质，不该因为换了存档键又被拉回高画质。
  try {
    const legacy = localStorage.getItem('rapids-quality');
    if (QUALITY_LABEL[legacy] && !localStorage.getItem('rr-settings-v1')) {
      settings.set('quality', legacy);
    }
  } catch { /* 隐私模式下读不到 localStorage */ }
  const q = settings.get('quality');
  return QUALITY_LABEL[q] ? q : 'high';
}

// 船体几何 / 法向冲量已抽到 boatContact.js（纯函数、可单测）。
// 这两个名字保留导出：`tests/gameplay.test.mjs` 直接从这里 import。
export { boatCollisionRadius, boatCollisionResponse };

/** Visual capsize for the less stable boat after a substantial side impact. */
export function boatCollisionRoll(def, otherDef, impactSpeed, lateral) {
  const stability = Math.max(0, Math.min(1, def.stability));
  const otherStability = Math.max(0, Math.min(1, otherDef.stability));
  if (impactSpeed < 4 || stability >= otherStability) return 0;
  const severity = Math.min(1, (impactSpeed - 4) / 8 + (otherStability - stability) * 0.75);
  const angle = 0.70 + severity * 0.15; // 40-49 degrees
  return (lateral >= 0 ? 1 : -1) * angle;
}

// 游戏核心：一局比赛的完整生命周期
export class Game {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {object} opts.net NetClient
   * @param {string} opts.myId
   * @param {object} opts.startMsg 服务器 start 消息 {mapId, laps, round, rounds, order}
   * @param {Function} opts.onHud 每帧 HUD 数据回调
   * @param {Function} opts.onFinish 本地玩家完赛回调
   * @param {Function} opts.onGateAny 任意玩家过门回调（用于飘字等）
   */
  constructor(container, opts) {
    this.container = container;
    this.net = opts.net;
    this.myId = opts.myId;
    // 名次栏要把房主那一行标红，客机也需要知道远端房主是谁
    this.hostId = opts.hostId || opts.myId;
    this.opts = opts;
    // 挑战模式（2026-11-18）：单人专属玩法，赛道 / 物理 / 计圈 / 大浪全部沿用竞速口径，
    // 所以这里把 mode **归一化成 'race'** —— 下游几十处 `mode === 'race'` 的判定
    // （大浪、开场镜头、浪跳、布景分组）不用逐个加分支，少改动就少漏洞。
    // 唯一差异用 this.challenge 单独标记：幽灵（影子）只在这个模式里出现。
    this.challenge = opts.startMsg.mode === 'challenge';
    this.mode = this.challenge ? 'race' : (opts.startMsg.mode || 'race');
    // 海啸级大浪只在竞速 / 道具模式启用；其它模式走平静海面（视觉与物理同源）
    setBigWaves(this.mode === 'race' || this.mode === 'item');
    // 竞技场沿用「怪物模式的世界」：同一块圆形海面、同一条边界、同一个相位约定，
    // 所以这里把它并进 isBoss，只有在「要不要建 BossThemes / 建哪个 manager」时才区分。
    this.isArena = this.mode === 'arena';
    // 云端天梯：竞技场赛场中央立塔 + 自己的 bossMode 控制器，但不走 BOSS 那套主题/场地。
    // 用 isSkyTower 显式标记，isBoss 保持 false（避免 trigger bossThemes / BossArena / 终点线那些分支）。
    this.isSkyTower = this.mode === 'skytower';
    this.isBoss = this.mode === 'boss' || this.isArena;
    // 海克斯：赛艇开局随机，把极速/加速/转向压到均值 ±8%，避免随机到慢船明显吃亏
    this.hexStatCompressed = this.mode === 'boss' && opts.startMsg.variant === 'hex';
    this.mapDef = this.isBoss ? BOSS_ARENA
      : this.isSkyTower ? SKY_TOWER_MAP_DEF
        : getMap(opts.startMsg.mapId);
    this.laps = opts.startMsg.laps;
    this.order = opts.startMsg.order;
    // 玩家 id → 报名信息（名称/艇型/队伍），名次板列表用它取所有人名字
    this.entryById = new Map((this.order || []).map((e) => [e.id, e]));
    // 赛制：solo = 个人，team = 组队 3v3（队伍色圆点 / 队友道具免疫都看这个）
    this.format = opts.startMsg.format === 'team' ? 'team' : 'solo';
    this.teamNames = opts.startMsg.teamNames || { blue: '蓝队', red: '红队' };
    // 道具/炮火的队友判定：组队赛制下同一队且不是自己
    this.isTeammate = (a, b) => this.format === 'team' && a !== b
      && !!this.entryById.get(a)?.team
      && this.entryById.get(a)?.team === this.entryById.get(b)?.team;
    this.isHost = opts.isHost;
    this.solo = !!opts.solo;
    // 怪物模式从哪一关开始：单人练习可以直接选关，联机不带 stage 字段仍从第一关起
    this.bossStage = this.isBoss
      ? Math.min(BOSS_LEVELS.length, Math.max(1, opts.startMsg.stage || 1))
      : 1;
    this.weather = this.#themeWeather(getWeather(
      opts.startMsg.weather || (this.isBoss ? BOSS_LEVELS[this.bossStage - 1].weather : 'day'),
    ));

    // 状态
    // boss / 竞技场 / 天梯都自带过场与倒计时，Game 自己的 countdown 要跳过（置 racing）
    this.phase = (this.isBoss || this.isSkyTower) ? 'racing' : 'countdown';
    // 倒计时的"冻结补齐"：正常帧按 dt 走（低帧率下和物理同源），
    // 只有整整错过一大段墙钟（浏览器把隐藏标签页的 rAF 停掉）时才按真实时间补齐。
    // 浏览器对隐藏标签页会完全停掉 requestAnimationFrame，逐帧累减会让倒计时
    // 永久冻结在 3 秒 —— 双开自测时切到另一个窗口，那一端还卡在倒计时，
    // 另一端已经开跑，名次与道具命中判定全错位。
    this.countdownLeft = 3.999;
    this.perfectStart = false; // 倒计时末段按油门 → GO 弹射
    // 完美起步（严格档，2026-11-18）：口径照 QQ飞车 / 跑跑卡丁车的 Boost Start ——
    // 只有在「倒计时数字 1 变成 0 的那一瞬」**按下**油门才算，太早（抢跑）太迟都不算。
    // 判定见 #loop 里的倒计时段；这两个字段只做状态跟踪与探针读取。
    this.psHeld = false;        // 上一帧油门是否按着（边沿检测：只认"新按下"）
    this.psPressedAt = null;    // 真正触发判定的那一刻倒计时剩多少（调试/探针用）
    this.startSlowMo = 0;       // 冲线慢动作剩余真实时长（秒），见 #checkFinishLine
    this.startSlowMoScale = 0.32; // 慢动作倍率：0.32× ≈ 把 0.85s 拉成 2.7s 的观感
    this.raceTime = 0;
    this.lapStart = 0;
    this.lapTimes = [];
    this.bestLap = null;
    this.finished = false;
    this.finishTime = null;
    this.finishWindowActive = false;
    this.finishWindowRemaining = 0;
    this.podiumGroup = null;
    this.podiumEntries = [];
    // BOSS 锁头镜头 → 追尾镜头的交接标记：传送门阶段锁消失时慢速过渡，避免镜头猛甩
    this._bossLockOn = false;
    this.lastGateSent = -1;
    this.sendTimer = 0;
    this.aiSkill = {};
    // 逆行提示的时间滞回：急弯打方向的瞬间不算逆行，要持续背离才提示
    this.wrongWayTimer = 0;
    this.wrongWayShown = false;
    this.gateGrace = 0; // 刚过门的短暂宽限（门口/弯心方向没有意义）

    // ---------- 幽灵车 / 每圈评价 / 失败归因（2026-11-18）----------
    // 三者共用一份「本圈遥测」，见 LapTelemetry.js 顶部说明。
    this.telemetry = new LapTelemetry();
    this.ghostBoat = null;        // GhostBoat 实例（没有记录时为 null）
    this.ghostRecord = null;      // 当前记录 { lapTime, arcTotal, ... }
    this.ghostLapArc = 0;         // 记录那一圈的起点弧长（进度换算要用）
    this.ghostDelta = null;       // 本圈 vs 幽灵：>0 = 我落后
    this.ghostVisible = false;
    this.ghostSegT = null;        // 幽灵的 4 段分界时刻（圈评拿它当参照）
    // 进本局之前的最好成绩：结算页要拿它对比（本局破纪录后 ghostRecord 会被覆盖，
    // 直接用 ghostRecord 会变成"和自己打平"）
    this.ghostBest0 = null;
    this.ghostKeyId = '';         // mapId:boatId，存新纪录时复用
    this.ghostSavedFlash = 0;     // 刚生成新幽灵的提示计时
    // 中央提示条（2026-11-18 重做）：撞墙归因 / 完美起步等系统提示 / 每圈评价
    // 共用**同一个槽**，渲染位置 = 屏幕水平正中、距顶 25vh（见 index.html #hud-assist）。
    // 抢占规则：priority 3 = 归因，2 = 系统提示，1 = 圈评。
    // 低优先级的提示不丢，进 pending 等当前这条播完再上 —— 玩家不会在同一秒
    // 被告知四件互相打架的事，也不会因为撞了一下墙就把这圈的评价整段吞掉。
    this.notice = null;           // { main, sub, tone, priority }
    this.noticeTtl = 0;
    this.noticePending = null;    // { main, sub, tone, priority, ttl }
    this.noticeCooldown = 0;      // 同类提示 1.2s 内不重复报
    this.noticeLastKey = '';

    // 渲染基础
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    // 像素比由 PostFx 按画质档位统一设置（高 1.25 / 中低 1.0），这里不重复设置，
    // 避免开局先建一次 1.5 倍缓冲、随后又重建一次。
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    // Effekseer 粒子特效（护盾/氮气/漩涡/爆炸）
    this.fx = new Effects();
    this.fx.init(this.renderer);

    this.scene = new THREE.Scene();
    // 流光号氮气尾焰的「紫色风尾」粒子层（纯 three.js，叠在 Effekseer 三束雷光外面）。
    // 常驻一个 Points（单 draw call），只在本地流光号加速时发射，见 NitroSparkles.js。
    // 参数直接取流光号 sparkle 配置（色/密度/尺寸/寿命），换素材不用改这里。
    this.nitroSparkles = new NitroSparkles(this.scene, NITRO_JETS.dolphin?.sparkle || {});
    // 绯鲨号氮气尾焰的「直线水流」射流（纯 three.js，主视觉；toonWater 粒子降为辅助）。
    // 三根锥形水柱跟着三个喷口，参数取 skiff.stream 配置。
    this.nitroJetStream = new NitroJetStream(this.scene, NITRO_JETS.skiff?.stream || {}, 3);
    this.camera = new THREE.PerspectiveCamera(Number(settings.get('fov')) || 62, window.innerWidth / window.innerHeight, 0.1, 2500);
    this.cameraRig = new CameraRig(this.camera);
    // 基础视场角来自设置，CameraRig 在它之上叠速度/氮气的加成
    this.cameraRig.fovBase = Number(settings.get('fov')) || 62;
    // 电影级后处理（泛光/青橙调色/暗角/颗粒/SMAA 或 FXAA），画质可切换
    this.quality = getStoredQuality();
    // 怪物模式的主题场景发光面片密集，泛光压一档；其它模式用原来的强度。
    // 熔岩主题反过来：水面亮纹本来就是靠"超过 1 的自发光被 bloom 抓到"成立的，
    // 沿用 0.92 的阈值会把裂隙全滤掉，只剩一片暗红地壳。所以按地图单独放大/降阈，
    // 其余地图拿不到 lava 字段，这两个数仍是 1 / 0.92，渲染完全不变。
    this.post = new PostFx(this.renderer, this.scene, this.camera, {
      quality: this.quality,
      bloomScale: this.isBoss ? 0.55 : (this.mapDef.lava?.bloomScale ?? 1),
      bloomThreshold: this.isBoss ? 1.0 : (this.mapDef.lava?.bloomThreshold ?? 0.92),
      fx: this.fx,
    });
    // 渲染分辨率倍数：在画质档位之外单独降内部分辨率
    this.post.setPixelScale(settings.get('renderScale'));
    this.#bindSettings();

    // 显卡上下文丢失（驱动重置 / TDR）：高画质下的大帧很容易触发。
    // 必须 preventDefault 才能等到浏览器把上下文还回来；恢复后重建后处理缓冲。
    this.contextLost = false;
    this.qualityLockedByUser = false; // 玩家手动选过画质就不再自动降档
    this.autoQualitySteps = 0;
    this._onContextLost = (e) => {
      e.preventDefault(); // 允许 webglcontextrestored 触发
      this.contextLost = true;
      this._blackStreak = 0;
      if (this.quality !== 'low') {
        const next = this.quality === 'high' ? 'medium' : 'low';
        this.#applyQuality(next, { persist: false, announce: false });
        this.opts.onToast?.('⚙️ 显卡驱动重置，画质已自动降低以保持流畅');
      }
    };
    this._onContextRestored = () => {
      this.contextLost = false;
      this._blackStreak = 0;
      this._frameAt = performance.now();
      this.post.rebuild();
      this.opts.onToast?.('✅ 画面已恢复');
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this._onContextLost, false);
    this.renderer.domElement.addEventListener('webglcontextrestored', this._onContextRestored, false);

    this.clock = new THREE.Clock();
    this.elapsed = 0;

    // 场景构建
    // 水面尺寸必须跟着地图尺度走：默认 700（±350m）是为老地图定的，
    // 峡谷险道边界 r=840，船跑到 350m 外就只剩"远景海面"那块无波浪的平板
    // —— 用户看到的"灰色地皮"就是它。按 boundary.r 放大到能整圈盖住。
    // 水面必须跟着边界圆"一起挪"，不能只按半径放大：长赛道（霓虹海峡）的边界
    // 圆心在 z=-494，整条赛道南段离世界原点超过 600m，一块以原点为中心的水面
    // 根本盖不到 —— 那一段只剩无波浪的远景平板，也就是用户看到的"灰色地皮"。
    //
    // +300 的固定余量：boundary 只包住赛道，**不含开场镜头的活动范围**。
    // 霓虹海峡的发车点就在边界圆的北沿，机位一抬高（开场俯视段 115m）就会跨出
    // 水面板，画面上出现一块边界笔直的浅色楔形 —— 板子外面既没有波浪水面、
    // 也没有远景平板，直接是天空穹顶。留 300m 余量后，俯拍段四周都还在水里。
    const mapRadius = this.mapDef.boundary?.r ?? 420;
    const waterSize = Math.max(700, Math.round(mapRadius * 2.15) + 300);
    this.water = new Water(this.mapDef, waterSize);
    const waterCx = Number.isFinite(this.mapDef.boundary?.x) ? this.mapDef.boundary.x : 0;
    const waterCz = Number.isFinite(this.mapDef.boundary?.z) ? this.mapDef.boundary.z : 0;
    // 云端天梯（2026-11-24）：第一层改浮在竞技场那片海面上，所以水面**要显示**，
    // 只是整块下沉到 WATER_Y（-6m）—— 第一层玻璃盘顶面在 +0.3，往下看 6m 才是海，
    // 掉出第一层就直接落水（见 SkyTowerMode.#startWaterFall）。
    const waterY = this.isSkyTower ? SKY_TOWER.WATER_Y : 0;
    this.water.mesh.position.set(waterCx, waterY, waterCz);
    this.water.setQuality(this.quality);
    // 道具局部倒影通道（P1，仅高画质）：艇 / 浮标单独渲一张镜像图给水面采样
    this.water.enablePropReflection(this.renderer);
    this.scene.add(this.water.mesh);
    this.env = new Environment(this.scene, this.mapDef, {
      renderer: this.renderer, isBoss: this.isBoss, quality: this.quality, water: this.water,
    });
    this.track = this.isSkyTower
      ? new SkyTowerArena(this.scene)
      : this.isBoss
        ? new BossArena(this.scene, BOSS_ARENA)
        : new Track(this.scene, this.mapDef, { mode: this.mode, water: this.water });
    if (this.isSkyTower) {
      // Environment 的渐变天空/地形在云端会穿帮，整组隐藏（灯也在组里，等于一起关掉）：
      // 天梯的天空/灯光全部由 SkyTowerScenery 自己按天气重建。
      this.env.group.visible = false;
      // SceneDressing 直接挂 scene（不在 env.group 下），藏着赛道礁石/跳台/浮标，
      // 在云端塔上会凭空漂着一堆石头 —— 单独隐藏。
      if (this.env.dressing?.group) this.env.dressing.group.visible = false;
      // 关键：Environment 的雾会把 1400m 远的天空球整片染成雾色（看起来就是一块平紫色），
      // 天梯必须关掉场景雾，否则自写的体积云 shader 永远看不见。
      // 但 env 的雨/雪/星空顶（都挂在 scene 上，不在 group 里）要留着复用 ——
      // 每层切天气时 #applyTowerWeather 会连带更新它们。
      this._towerWeatherId = this.weather?.id || 'day';
    }
    // 终点线：**所有地图共用一个口径**（见 finishLine.js / trackFinishLine）。
    // 闭合环线 = 起点线；开环赛道 = 最后一门。圈数与结算只认"船头穿过这条线"。
    // 竞技场/怪物模式没有终点线，置 null 后所有冲线逻辑整体跳过。
    this.finishLine = (this.isBoss || this.isSkyTower) ? null : trackFinishLine(this.track);
    // 开环赛道没有"下一圈"：跑过终点线就是完赛；闭合环线跑满 this.laps 圈。
    this.finishLaps = this.finishLine?.open ? 1 : this.laps;
    // 撞碎火山岩掉出来的奖励核：拾取时由道具系统发一件随机道具。
    // 单人练习没有 ItemManager（this.items 为 null），这里静默跳过。
    this.track.onItemDrop = (boatId) => {
      this.items?.grantRandomItem?.(boatId);
    };
    // 湖泊环线专属赛事视觉层：只有这张图会创建，其它地图连对象都不存在。
    // 先建成隐藏，由 #applyStadium() 按「lake + 晴朗白天 + ?lakeStadium=0」统一决定可见性。
    // 只加看台/广告板这类岸边道具，不碰水面渲染。
    this.lakeStadium = this.mapDef.id === 'lake' && !this.isBoss
      ? createLakeStadium(this.scene, this.mapDef)
      : null;
    this.lakeStadium?.setEnabled(false);
    // 竞技场环形看台：竞技场模式专属（noMountains 后四周改由看台围合出竞技场感）。
    // 怪物模式不建 —— 它的主题自带火山/海岛背景，两套远景会打架。
    // scoreProvider：看台比分牌每 0.5s 拉一次实时比分（bossMode 在后面才建，闭包延迟取）
    this.arenaStadium = (this.isArena || this.isSkyTower)
      ? createArenaStadium(this.scene, this.mapDef, {
        scoreProvider: () => this.bossMode?.getScoreboard?.() || null,
      })
      : null;
    // 全地图通用弯道导向牌：箭头按该处弯道转向自动决定，永远指向弯内。
    // 放在 env / track 都建好之后，才能读静态碰撞体做净空、读赛道面高度定 y。
    // 和看台不同，它不跟天气联动（暴风雨 / 暴雪里反而最需要方向参照）。
    this.guideSigns = !this.isBoss && !this.isSkyTower
      ? createGuideSigns(this.scene, this.mapDef, {
        track: this.track,
        colliders: this.env?.colliders || [],
      })
      : null;
    this.guideSigns?.setEnabled(guideSignsEnabled());
    // 浮桶默认按 day 建，这里补一次"当前天气"的配色（天气在赛道之前就定好了）
    this.track.setBuoyPalette?.(this.weather?.id);
    // 镜头防穿地：把赛道面采样器交给相机。只有烘焙赛道才启用 ——
    // 普通水面图的 surfaceYAt 恒为 0，夹了等于把镜头锁在水面以上，白丢浪感。
    if (this.track.openTrack) {
      this.cameraRig.groundSampler = (x, z) => this.track.surfaceYAt(x, z);
    }
    this.colliders = this.env.colliders;

    // 怪物模式：四关各有独立主题场景（火山/珊瑚海/港口/冰海），换关时整组重建。
    // 其它模式走原来的地图天气，完全不受影响。
    this.themes = null;
    // 只有怪物模式才上四关主题；竞技场走下面 else 里的普通天气链路
    if (this.mode === 'boss') {
      this.themes = new BossThemes(this.scene, {
        env: this.env, arena: this.track, water: this.water,
      });
      this.themes.setTheme(this.bossStage);
    } else {
      // 昼夜+天气（应用到所有地图）
      this.env.setWeather(this.weather);
      // 天梯不用雾（见上方注释）：密度压到近 0，保留 fog 对象让 env 的其它代码不空指针
      if (this.isSkyTower && this.scene.fog) this.scene.fog.density = 0.000001;
      // 天梯的星场由 SkyTowerScenery 的天空着色器自己画（那层星空天才亮），
      // env 的 NightSky 半径只有几百米、会被 1400m 的天空球整片盖住，关掉省一次绘制
      if (this.isSkyTower) this.env.nightSky?.setVisible(false);
      this.water.setWeather(this.weather);
      setWaveScale(this.weather.waveScale ?? 1.0);
      // 调色也要在第一帧就位：开局若为暴雪，不能等第一次切天气才变冷白
      this.post?.setWeather?.(this.weather);
      // 水面倒影的环境贴图（天空 + 云 + 远山轮廓）：必须等 env 把天空穹顶建出来、
      // 天气参数套好之后再烘。烘不出（设备不支持半浮点渲染目标）会自动退回解析天空。
      // 第 5 参 = 烘图时要临时摘掉的物体：星空天气的三层星星/银河/星尘在 128² 罐里
      // 会糊成一片中性白，让整片海反射变成白板（见 Water.#renderEnvCube）。
      if (!this.isSkyTower) {
        this.water.bakeEnvironment(
          this.renderer, this.scene, this.camera.position, this.env.sky, this.#envExclude(),
        );
      }
    }
    // 必须在 setWeather 之后：色板/水色/浪花都要盖在天气档之上
    this.#applyStadium();

    // 玩家进度表（名次计算）
    this.progressMap = new Map(); // id -> {prog, gate, lap, finished, finishTime}

    // 艇
    this.boats = new Map(); // id -> Boat
    this.localBoat = null;
    this.aiBoats = [];
    this.#createBoats();
    this.#initGhost();
    // 竞速 / 道具的开场镜头（5.6s，无文字）：必须在船摆好之后建，机身路径要按发车格算。
    // phase 仍是 countdown，倒计时在这个镜头里是冻结的（见 #loop）。
    this.raceIntro = null;
    if (this.mode === 'race' || this.mode === 'item') this.#startRaceIntro();
    // 道具模式：没有漂移集气/氮气，只能靠道具比拼
    if (this.mode === 'item') {
      for (const b of this.boats.values()) b.nitroAllowed = false;
    }

    // 快照处理
    this.offGate = this.net.on('gate', (e) => this.#onRemoteGate(e.detail));
    this.offSnap = this.net.on('snap', (e) => this.#onSnapshot(e.detail));
    this.offFinishEvt = this.net.on('finish', (e) => {
      const pm = this.progressMap.get(e.detail.id);
      if (pm) { pm.finished = true; pm.finishTime = e.detail.time; }
    });

    // 道具模式
    this.items = null;
    if (this.mode === 'item') {
      this.items = new ItemManager({
        scene: this.scene,
        track: this.track,
        net: this.net,
        myId: this.myId,
        isHost: this.isHost || this.solo,
        solo: this.solo,
        storm: this.weather.id === 'storm',
        fx: this.fx,
        getCamera: () => this.camera,
        getBoats: () => this.boats,
        getRank: (id) => this.#rankOf(id),
        getGate: (id) => this.progressMap.get(id)?.gate ?? 0,
        // 组队赛制下道具要区分队友/对手（漩涡可命中队友、剑刃风暴会挡住队友等）
        isTeammate: (a, b) => this.isTeammate(a, b),
        // 道具提示（获得/使用/被挡…）也并入中央提示条：竞速与道具共用同一套版式，
        // 不再一半在底部弹大字、一半在中央出徽章。BOSS/竞技场仍走原来的卷轴 toast。
        onToast: (msg) => this.#noteItemToast(msg),
        // 被道具打中 → HUD 失败归因图标（C1：只图标，不写谁打的）
        onMyHit: (msg) => this.#noteItemHit(msg),
      });
      const itemNetTypes = ['itemPick', 'itemUse', 'itemHeld', 'itemHit', 'itemFx', 'lightning'];
      this.offItems = itemNetTypes.map((type) =>
        this.net.on(type, (e) => this.items.handleNet(e.detail)),
      );
      if (this.opts.input) {
        // 道具模式：Q/W/E 使用对应槽位道具（槽位空则忽略）
        this.opts.input.itemMode = true;
        this.opts.input.onItem = (slot) => {
          if (this.phase !== 'racing' || this.finished || !this.items) return;
          // 氮气键早就有"眩晕中不能用"的口径，道具键以前没有：被炸沉/打转时
          // 还能照常放护盾和导弹，既不合理也让受击状态失去意义。
          const b = this.localBoat;
          if (b && (b.stunTimer > 0 || b.sinkTimer > 0 || b.spinTimer > 0
            || b.voidTimer > 0 || b.capsizeTimer > 0)) return;
          const item = this.items.myItems[slot];
          if (!item) return;
          const consumed = this.items.useItem(this.myId, item, slot);
          if (consumed !== false) {
            this.items.myItems[slot] = null;
            // 名次栏图标要跟着消失；useItem 里有些分支会手动清槽，这里统一补一次广播
            this.items.syncHeld(this.myId);
          }
        };
      }
    }

    // 怪物模式（打 BOSS）
    this.bossMode = null;
    this.offBoss = [];
    if (this.mode === 'boss') {
      this.bossMode = new BossMode({
        scene: this.scene,
        fx: this.fx,
        net: this.net,
        myId: this.myId,
        isHost: this.isHost || this.solo,
        solo: this.solo,
        order: this.order,
        boats: this.boats,
        localBoat: this.localBoat,
        input: this.opts.input,
        arena: this.track,
        // 漩涡阵需要把漩涡中心写进水面着色器
        water: this.water,
        difficulty: opts.startMsg.difficulty || 'normal',
        // 怪物模式分支：classic（闯关，缺省）/ hex（海克斯，招式随机）
        variant: opts.startMsg.variant || 'classic',
        stage: this.bossStage,
        onToast: this.opts.onToast,
        onWeather: (id, stage) => this.#applyWeather(id, stage),
        onCutscene: (info) => this.opts.onBossCutscene?.(info),
        onCutsceneEnd: () => {
          // 过场结束：让追尾相机从当前机位平滑接管，避免镜头硬切
          this.cameraRig.adopt(this.camera);
          this.opts.onBossCutsceneEnd?.();
        },
        onStageResult: (data) => this.opts.onBossStageResult?.(data),
        // 海克斯三选一浮层（本局核心 / 通关卡牌）
        onHexCards: (info) => this.opts.onHexCards?.(info),
        // 海克斯「继续挑战 / 结束领奖」：以前这条没转发到 main，
        // BossMode 里 opts.onHexEndless 是 undefined，面板永远不显示 ——
        // 玩家只看到一条 toast，船还被锁在 endless 阶段，就是"啥也没有、动不了"。
        onHexEndless: (info) => this.opts.onHexEndless?.(info),
        // 选了「结束领奖」并开进传送门：上层记账后直接回大厅
        onHexExit: (data) => this.opts.onHexExit?.(data),
        onVictory: (data) => this.opts.onBossVictory?.(data),
        onDefeat: (data) => this.opts.onBossDefeat?.(data),
      });
      const bossNetTypes = [
        'bossState', 'bossHit', 'bossSummon', 'bossStage', 'bossEnd', 'bossCast',
        'bossDown', 'bossRescue', 'bossStagger',
        // 协同合击：进度同步 / 预备握手 / 完整演出广播（旧 bossCombo 已废弃）
        'bossComboState', 'bossComboArm', 'bossComboFire',
        // 技能演出 / 落雷 / 安全柱 / 熔岩 / 诱饵 / 血包 / 火力核心：
        // 漏掉任意一条，客机就只剩红圈没有演出，或干脆看不到拾取物
        'bossSkill', 'bossThunder', 'bossVortex', 'bossPillar', 'bossLava', 'bossLure',
        'healPack', 'fireCoreSpawn', 'fireCore',
        // 第二关符文安全圈 / 四核波次：客机靠这四条消息同步核心位置、扣血与弱点窗口
        'bossCoreWave', 'bossCoreHit', 'bossCoreWin', 'bossCoreWaveEnd',
        // 过关传送门：门的落点与每位玩家的“已准备”状态必须实时同步，
        // 否则客机看到的门在 A 点、主机判定在 B 点，永远凑不齐人
        'bossPortal', 'bossReady',
        // 第四关血祭祭坛：落点由主机定、完成结果由操作者广播。
        // 这两条以前只在服务端转发、客户端没注册，等于第四关祭坛在联机里是死的。
        'bossAltarSpawn', 'bossAltarDone',
      ];
      this.offBoss = bossNetTypes.map((type) =>
        this.net.on(type, (e) => this.bossMode.handleNet(e.detail)),
      );
    }

    // 潮汐竞技场（1v1）：接口与 BossMode 完全一致，所以下面所有 this.bossMode 的
    // 调用（canControl / driveBoat / driveAi / updateCamera / hudData / respawnLocal …）
    // 都不需要再加分支，直接指到这里。
    if (this.isArena) {
      this.bossMode = new ArenaMode({
        scene: this.scene,
        fx: this.fx,
        net: this.net,
        myId: this.myId,
        isHost: this.isHost || this.solo,
        solo: this.solo,
        order: this.order,
        boats: this.boats,
        localBoat: this.localBoat,
        input: this.opts.input,
        arena: this.track,
        camera: this.camera,
        onToast: this.opts.onToast,
        onMatchEnd: (d) => this.opts.onArenaEnd?.(d),
        // 复活瞬间把追尾相机硬切回船后：死亡期间相机在"抬高的俯视机位"，
        // 不硬切的话它会从半空用两三秒慢慢飞回来，中途还会穿一下水面
        onRespawn: () => { if (this.localBoat) this.cameraRig.snapTo(this.localBoat); },
        // 开场动画播完同样硬切一次：动画结尾机位 ≈ 追尾机位，snapTo 同步内部
        // heading/高度低通状态，第一帧起就是标准船尾视角，不会甩镜头
        onCinemaEnd: () => { if (this.localBoat) this.cameraRig.snapTo(this.localBoat); },
      });
      this.offBoss = [
        // 伤害/血量/回合/核心/撞出/盾击/技能 —— 少注册任何一种，客机就会
        // 「血条不动 / 核心不动 / 撞人没反馈 / 看不到对手放技能」，
        // 而且症状都不报错，只能靠联机实测发现。
        'arenaDmg', 'arenaHp', 'arenaRound', 'arenaEnd', 'arenaSkill',
        'arenaCore', 'arenaRing', 'arenaRam',
        // 道具：10 件道具沿用道具赛那套消息，ItemManager 自己会认
        'itemPick', 'itemUse', 'itemHit', 'itemFx',
      ].map((type) =>
        this.net.on(type, (e) => this.bossMode.handleNet(e.detail)),
      );
    }

    // 云端天梯：独立关卡控制器，复用 bossMode 那套主循环接口
    if (this.isSkyTower) {
      this.bossMode = new SkyTowerMode({
        scene: this.scene,
        fx: this.fx,
        net: this.net,
        myId: this.myId,
        isHost: this.isHost || this.solo,
        solo: this.solo,
        order: this.order,
        boats: this.boats,
        localBoat: this.localBoat,
        input: this.opts.input,
        camera: this.camera,
        arena: this.track,
        weather: this.weather,
        onToast: this.opts.onToast,
        onEnd: (d) => this.opts.onSkyTowerEnd?.(d),
        onCinemaEnd: () => { if (this.localBoat) this.cameraRig.snapTo(this.localBoat); },
        // 每层天气：天空/灯光由 SkyTowerScenery 自己换，这边负责"整条天气链"
        // —— 雨雪粒子、星空顶、水色、浪高全部走现有 Environment/Water，不再另写一套
        onLayerWeather: (w) => this.#applyTowerWeather(w),
        // 落海重生：镜头从海面硬切回第一层船尾（不切会慢慢飞上来、中途穿水）
        onRespawn: () => { if (this.localBoat) this.cameraRig.snapTo(this.localBoat); },
      });
      this.offBoss = SKY_TOWER_NET_TYPES.map((type) =>
        this.net.on(type, (e) => this.bossMode.handleNet(e.detail)),
      );
    }

    // 震屏强度：BossMode 与 ArenaMode 都实现 applyCameraShake，
    // 统一在这里把设置里的「镜头震动」喂进去
    if (this.bossMode) this.bossMode.shakeScale = this.shakeScale;

    window.addEventListener('resize', this.#onResize);
    // 着色器预热：开局/冲线时第一次出现的材质（岸边、道具、对手艇）在渲染线程里
    // 临时编译会卡住整帧，某些驱动还会因此丢上下文（表现为黑屏闪几秒再恢复）。
    // 这里在开赛前先编译一遍。
    //
    // 用同步 compile 而不是 compileAsync：后者的内部轮询（KHR_parallel_shader_compile）
    // 会在「这一局很快结束 / 玩家立刻退赛 / 换模式重开」时和 dispose() 抢——
    // 材质已经被释放，轮询仍去读 program.isReady()，直接抛
    // `TypeError: Cannot read properties of undefined (reading 'isReady')`。
    // 一次 uncaught 异常本身不致命，但它会打断 three 的预热轮询，而且每次快速重开
    // 都在控制台留一条假报错，联机自测时极易被误判成真实缺陷。
    // 同步编译只在这一瞬间多花几十~几百毫秒，而且发生在开赛前（倒计时遮罩之下）。
    try { this.renderer.compile?.(this.scene, this.camera); } catch { /* 预热失败不影响正常渲染 */ }
    if (typeof window !== 'undefined') window.__game = this; // 调试句柄
    // 隐藏标签页补帧：浏览器会暂停 rAF，但 WebSocket 消息照常到达。
    // 不补帧的话，这一端的船/倒计时/圈数会整段停住，另一端看到的就是"卡在起点的木头人"。
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
      if (document.hidden) this.#startHiddenTicker();
    }
    this.#loop();
  }

  #createBoats() {
    const spawns = new Map();
    this.order.forEach((entry, i) => {
      spawns.set(entry.id, this.track.spawnTransform(i, this.order.length));
    });

    for (const entry of this.order) {
      const baseDef = getBoat(entry.boatId);
      // 海克斯随机艇：数值压缩只影响本局，原始 BOATS 数据不变
      const def = this.hexStatCompressed ? hexBoatDef(baseDef) : baseDef;
      const isLocal = entry.id === this.myId;
      const boat = new Boat(this.scene, def, entry.name, isLocal, {
        color: this.weather.waterColor ?? this.mapDef.waterColor,
        crest: this.weather.waterCrest ?? this.mapDef.waterCrest ?? this.mapDef.waterColor,
        waveScale: clampWaveScale(this.weather.waveScale ?? 1),
        detail: this.quality !== 'low',
      });
      const s = spawns.get(entry.id);
      boat.resetTo(s.x, s.z, s.heading);
      // 竞速/道具水面启用大浪抛飞；BOSS/NPC 竞技场保持平稳
      boat.waveJumpEnabled = this.mode === 'race' || this.mode === 'item';
      // 熔岩硬核裂谷：关掉"浪尖抛飞"这条白嫖通道，浪面起伏和涌流漂移照常保留
      boat.waveLaunchEnabled = !this.mapDef.noWaveLaunch;
      // AI 不参与"冲出悬崖掉落"：掉下去一次这局就废了，
      // Track.#edgeRule 靠这个标记给 AI 保留护栏。
      boat.isAi = !!entry.ai;
      this.boats.set(entry.id, boat);

      // 出生点可能已经越过起点线（烘焙图固定往前 16m）：起始门 / 圈数跟着出生点走，
      // 否则"下一门"在船背后，一开局就报逆行，第一圈的中间门也不会判。
      // ⚠ 圈数从 1 起（不是 0）：1 = 正在跑第一圈，过线 +1，`lap > finishLaps` 完赛。
      // 旧版从 0 起，3 圈赛要跑 4 次线才结算（少算一圈）。
      this.progressMap.set(entry.id, {
        prog: -1, gate: s.gate || 0, lap: Math.max(1, s.lap || 0),
        // 本圈起点弧长：发车格在起点线**后方**，按绝对弧长算就是"上一圈的 99%"，
        // 进度条会一开局就跳到 99%（3 圈图 33%）再掉回 0。压线那一帧同理。
        // 记下起点弧长，进度按"相对本圈起点跑了多少"算（见 Track.progressRatio）。
        lapArc: this.track.arcAt ? this.track.arcAt(s.x, s.z).s || 0 : 0,
        finished: false, finishTime: null,
      });

      if (isLocal) {
        this.localBoat = boat;
        this.myEntry = entry;
        // 出弯小喷 / 双喷的中央提示（只有本地船挂，AI 不弹字）
        boat.onDriftBoost = (n) => this.#noteDriftBoost(n);
        // 记下发车格：还没过任何门时按 R 只能回到这里，
        // 不能拿"上一门"当地锚点（开环赛道的前几个门在发车点身后，
        // 那样一按 R 就被丢回倒车位置，看起来像方向反了/直接完赛）
        this.mySpawn = {
          ...s, gate: (s.gate || 0) % this.track.gates.length, lap: Math.max(1, s.lap || 0),
        };
      } else if (entry.ai) {
        this.aiBoats.push(boat);
        // AI 技能：错开强度
        this.aiSkill[entry.id] = 0.86 + this.aiBoats.length * 0.045;
      }
    }
    // 氮气音的距离衰减要知道"谁在听"：所有船都指向本地船。
    // AI 船不出声（见 Boat.#playNitroSound），这里只是让真人队友的氮气能算出远近。
    for (const b of this.boats.values()) b.listener = this.localBoat;
    this.cameraRig.snapTo(this.localBoat);
  }

  /**
   * 挑战模式的「影子」：把玩家自己在这张图、这条船上的最快一圈放回赛道。
   *
   * 2026-11-18 起影子**只属于挑战模式**（设置页里的「幽灵车 / 一直显示幽灵」
   * 两个开关已删除）。普通竞速 / 道具 / 弹射里不再出现半透明船 —— 那些模式的
   * 对手是 AI 或其它玩家，多一艘自己的影子只会让画面变乱、也分不清谁是谁。
   *
   * 只对自己生效，不进名次、不进碰撞、不进小地图（一辆看不见的船出现在
   * 排名里会让联机的人以为有人作弊）。地图/赛艇改过（弧长变化 > 2%）时
   * GhostStore 会直接作废旧记录，避免影子跑在护栏外面。
   */
  #initGhost() {
    if (!this.localBoat || !this.myEntry) return;
    if (!this.challenge) return;
    const mapId = this.opts.startMsg.mapId || this.mapDef.id || '';
    const boatId = this.myEntry.boatId || this.localBoat.def.id || '';
    this.ghostKeyId = `${mapId}:${boatId}`;
    const arcTotal = this.track.arcTotal || 0;
    const rec = readGhost(mapId, boatId, arcTotal);
    if (!rec) return;
    const data = decodeGhost(rec);
    if (!data) return;
    const spawn = this.mySpawn || { x: 0, z: 0 };
    const lapArc = Number(rec.lapArc)
      || this.track.arcAt?.(spawn.x, spawn.z)?.s
      || 0;
    if (!this.#spawnGhost(data, lapArc)) return;
    this.ghostRecord = { ...rec, lapTime: data.lapTime, arcTotal: data.arcTotal || arcTotal };
    // 进本局**之前**的最好成绩：结算页拿它对比（本局破纪录后 ghostRecord 会被覆盖）
    this.ghostBest0 = data.lapTime;
  }

  /**
   * 建一辆幽灵并放上赛道。开局读档与「刚跑出更快一圈」共用这条路径 ——
   * 所以第一次跑这张图的人，跑完第一圈之后**本局下一圈就能看到幽灵**，
   * 不必退出重开一局（用户实测最困惑的就是这一点：跑完一圈，第二圈什么都没有）。
   */
  #spawnGhost(data, lapArc) {
    if (!data || !this.localBoat) return null;
    const w = this.weather;
    const ghost = new GhostBoat(this.scene, this.localBoat.def, {
      color: w.waterColor ?? this.mapDef.waterColor,
      crest: w.waterCrest ?? this.mapDef.waterCrest ?? this.mapDef.waterColor,
      waveScale: clampWaveScale(w.waveScale ?? 1),
      detail: this.quality !== 'low',
    });
    if (!ghost.load(data, this.track, lapArc)) {
      ghost.dispose();
      return null;
    }
    // 换新之前先把旧的那辆收掉：中途更新记录时不会在场景里留一堆半透明船
    this.ghostBoat?.dispose();
    this.ghostBoat = ghost;
    this.ghostLapArc = lapArc;
    this.ghostSegT = ghost.segT;
    return ghost;
  }

  // ---------- 竞速 / 道具开场镜头 ----------
  /**
   * 构建开场镜头路径。全部按「本船 + 赛道前向」的局部坐标摆点：
   *   f = 赛道前进方向，r = 右手方向，原点 = 本地玩家的出发位
   * 这样任何地图（海湾直道 / 烘焙山洞）都能自动适配，不需要手调每个图。
   *
   * 关键点顺序：高空回旋（能看到整段起步直道）→ 一路压低贴水 →
   * 低空横扫整排赛艇 → 直接落到本船船尾的追尾机位。
   */
  #startRaceIntro() {
    if (skipRaceIntroByUrl()) return;
    const boats = [...this.boats.values()];
    const me = this.localBoat;
    if (!boats.length || !me) return;

    const h = me.heading;
    const f = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    const r = new THREE.Vector3(Math.cos(h), 0, -Math.sin(h));
    // 高度基准取起跑段的水面，不能用 me.pos.y：
    // 船刚生成时还在半空（等着砸进水里），拿它当基准整条路径会浮起 5m。
    const cy = this.track.gateY?.[0] ?? 0;
    // 局部坐标 → 世界坐标
    const P = (fw, rt, y) => new THREE.Vector3(
      me.pos.x + f.x * fw + r.x * rt, cy + y, me.pos.z + f.z * fw + r.z * rt,
    );
    // 船队横向范围（相对本地艇）：横扫段要比整排船更宽，所有赛艇才会依次划过
    let reach = 6;
    for (const b of boats) {
      if (b === me) continue;
      const lat = (b.pos.x - me.pos.x) * r.x + (b.pos.z - me.pos.z) * r.z;
      reach = Math.max(reach, Math.abs(lat) + 3);
    }
    // 横扫半径必须留在水面内：烘焙山洞的起步航道只有 17m 宽，
    // 按"船队半宽 +10"横出去会直接穿进洞壁/岸上的树里。
    const side = Math.min(reach, Math.max(6, (this.track.startWidth || 20) * 0.42));

    // 开场镜头路径。
    // 山洞/堤岸类烘焙地图（openTrack）的起步航道是夹在泥岸之间的一条窄水道：
    // 岸体只有单面网格，镜头一抬高就只剩"漂浮的褐色纸带"；航道本身只有十几米宽，
    // 侧向拉开也会钻进岸里/撞上礁石。这类图只做**沿航道纵向**的短推进：
    // 从船头正前方低位起镜，后撤越过船队，落到船尾追尾位。
    const compact = !!this.track.openTrack;
    const points = compact ? [
      P(14, 0, 5.5),               // 船头正前方：正面展示赛艇
      P(2, 0, 6.5),
      P(-6, 0, 6.0),
    ] : [
      P(-70, 60, 115),             // 高空：起步直道 + 整张图一起入画
      P(6, 96, 88),                // 回旋下降
      P(74, 86, 60),
      P(106, 34, 36),
      P(96, -24, 20),              // 一路压低，慢慢靠近水面
      P(58, -side * 0.9, 7.6),
      P(28, -side, 3.8),           // 贴水，船队侧前方
      P(24, side, 3.6),            // 横扫：整排赛艇依次从镜头前划过
      // 收尾阶段必须**绕到船侧后方**再落到船尾：从船头正上方压过去
      // 会有一瞬间镜头骑在艇上（船被裁出画面下沿），非常廉价。
      P(12, side * 0.7, 4.2),
      P(0, side * 0.35, 4.2),
    ];
    // 收尾：本船船尾的标准追尾位（与 CameraRig.follow 的第一帧基本重合）
    points.push(new THREE.Vector3(
      me.pos.x - f.x * 9.5, cy + 4.2, me.pos.z - f.z * 9.5,
    ));

    this.raceIntro = {
      t: 0,
      // 窄航道版路径短（约 24m），用原时长会慢得像卡住
      dur: compact ? 4.2 : RACE_INTRO_TIME,
      baseY: cy,
      curve: new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.4),
      pos: new THREE.Vector3(),
      look: new THREE.Vector3(),
      lookGrid: new THREE.Vector3(me.pos.x, cy + 1, me.pos.z),
      lookSelf: new THREE.Vector3(me.pos.x + f.x * 8, cy + 1.2, me.pos.z + f.z * 8),
    };
    // 过场也走墙钟：切后台再回来时镜头直接对齐到"本该在的进度"，
    // 不会出现"倒计时早跑完了、镜头还在高空慢慢扫"的分裂画面。
    this.introAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    // 过场期间收起常驻 HUD（复用竞技场的 CSS），画面上只有船和海。
    // 船顶的姓名牌是 3D 精灵，不吃 CSS，要单独收：镜头贴到艇上方掠过时
    // 那块名字会占掉半个屏幕，比 HUD 还抢戏。
    document.body?.classList?.add('intro-on');
    for (const b of boats) if (b.label) b.label.visible = false;
    this.camera.fov = this.cameraRig.fovBase;
    this.camera.updateProjectionMatrix();
    // 先把镜头放到路径起点，避免第一帧还停在 lobby 的机位
    this.raceIntro.curve.getPointAt(0, this.raceIntro.pos);
    this.camera.position.copy(this.raceIntro.pos);
    this.camera.lookAt(this.raceIntro.lookGrid);
  }

  /** 开场镜头推进：返回 true 表示这一帧相机由过场接管 */
  #raceIntroCamera(dt) {
    const intro = this.raceIntro;
    if (!intro) return false;
    // 只接管倒计时阶段；外部强行切阶段（调试/断线重连）时立刻交还
    if (this.phase !== 'countdown') { this.#endRaceIntro(); return false; }
    // 墙钟推进：后台标签页 rAF 被暂停时，过场不会跟着停在半空
    if (Number.isFinite(this.introAt)) {
      intro.t = (performance.now() - this.introAt) / 1000;
    } else {
      intro.t += dt;
    }
    const p = Math.min(1, intro.t / intro.dur);
    const u = p * p * (3 - 2 * p);  // smoothstep：起收慢、中段快
    intro.curve.getPointAt(Math.min(0.9999, u), intro.pos);
    // 贴水段别钻进浪里（浪峰 1m+，路径压得很低）；height 是相对起跑段水面的，要加回基准
    const surf = intro.baseY + waveHeight(intro.pos.x, intro.pos.z, this.elapsed) + 1.1;
    if (intro.pos.y < surf) intro.pos.y = surf;
    this.camera.position.copy(intro.pos);
    // 注视点：前 62% 盯发车区中心，后段渐移到本船前方 → 与追尾镜头无缝
    const k = THREE.MathUtils.clamp((p - 0.62) / 0.38, 0, 1);
    intro.look.lerpVectors(intro.lookGrid, intro.lookSelf, k * k * (3 - 2 * k));
    this.camera.lookAt(intro.look);
    if (p >= 1) this.#endRaceIntro();
    return true;
  }

  /** 结束过场：摘掉 HUD 遮罩，把追尾相机的内部状态对到本船（第一帧不甩镜头） */
  #endRaceIntro() {
    this.raceIntro = null;
    document.body?.classList?.remove('intro-on');
    for (const b of this.boats.values()) if (b.label) b.label.visible = true;
    if (this.localBoat) this.cameraRig.snapTo(this.localBoat);
  }

  /** 发车：倒计时归零、或主机已经开跑时被远端强行拉到 racing，都走这里 */
  #beginRace() {
    this.phase = 'racing';
    this.raceTime = 0;
    this.lapStart = 0;
    this.raceStartWall = performance.now();
    // 本圈遥测从发车瞬间开始（幽灵也是从这一刻起跑）
    const pm0 = this.progressMap.get(this.myId);
    this.telemetry.begin(pm0?.lapArc ?? 0, this.track.arcTotal || 1);
    this.lastCountdownShown = -99;
  }

  /**
   * 远端已经开跑、本端还卡在倒计时 → 直接发车。
   * 这是后台标签页/掉帧把倒计时拖住时的兜底：名次板与道具判定都按 raceTime 对齐主机，
   * 晚发车的那一端不会因为"少跑了几秒"而在结算时白赚时间。
   */
  #forceRaceStart(hostRaceTime) {
    if (this.phase !== 'countdown') return;
    this.#endRaceIntro();
    this.countdownLeft = 0;
    this.#beginRace();
    if (Number.isFinite(hostRaceTime) && hostRaceTime > 0) {
      this.raceTime = hostRaceTime;
      this.lapStart = 0;   // 第一圈从发车起算，晚加入的时间照实计入本圈
    }
    this.perfectStart = false;
    this.psHeld = false;
    this.sendTimer = 0;    // 立刻把自己的状态发出去，别等下一个 33ms
  }

  // ---------- 主循环 ----------
  #loop = () => {
    this.rafId = requestAnimationFrame(this.#loop);
    const frameNow = performance.now();
    // 真实帧间隔（含 GPU 排队时间）：用于一次性画质降档判断。
    // rawDt 为了物理稳定被截到 50ms，不能反映“真的卡”有多严重。
    const frameMs = this._frameAt ? frameNow - this._frameAt : 16.7;
    this._frameAt = frameNow;
    this._lastFrameAt = frameNow;
    const rawDt = Math.min(this.clock.getDelta(), 0.05);
    this.#frame(rawDt, frameMs, false);
  };

  /**
   * 一帧世界推进。
   * @param {number} rawDt 真实帧间隔（已截到 50ms）
   * @param {number} frameMs 未截断的帧间隔（画质降档判断用）
   * @param {boolean} headless 后台补帧：只跑模拟，不刷 HUD / 不渲染 / 不出声
   */
  #frame = (rawDt, frameMs, headless) => {
    let dt = rawDt;
    // BOSS 模式命中顿帧：极短时间内把世界几乎冻住，打击才有“重量”
    if (this.bossMode?.hitStop > 0) {
      this.bossMode.hitStop = Math.max(0, this.bossMode.hitStop - rawDt);
      dt = rawDt * 0.08;
    }
    // 冲线慢动作（2026-11-18）：只放慢**世界** —— 物理、浪、尾迹、粒子、环绕镜头
    // 全都吃这个 dt，所以是整体慢下来而不是画面跳帧；而真实计时（raceTime）在下面
    // 单独走 rawDt，慢放绝不会把成绩一起拖长。剩余时长也用 rawDt 递减，
    // 这样"0.85 秒慢动作"是玩家真实感受到的 0.85 秒。
    let slowK = 0;
    if (this.startSlowMo > 0) {
      this.startSlowMo = Math.max(0, this.startSlowMo - rawDt);
      slowK = this.startSlowMoScale;
      dt *= slowK;
    }
    this.elapsed += dt;

    this.water.update(this.elapsed);
    this.lakeStadium?.update?.(this.elapsed);
    this.arenaStadium?.update?.(this.elapsed, dt);
    this.env.update(dt, this.camera, this.localBoat?.speed || 0);
    this.themes?.update(dt, this.elapsed);
    // 昼夜循环：水面天光/水色跟随太阳，避免水面和天空脱节
    this.water.applyDayTint(this.env.dayTint);
    // 艇扰动波 + 尾迹：玩家走精细弧形泡沫尾迹，AI 走简化直线带
    // 云端天梯的船跑在玻璃平台上、不在水里，给空清单 —— 否则海面上会凭空
    // 多出一圈跟着船走的水波和泡沫尾迹（船明明在天上）
    const wakeLight = 0.32 + 0.68 * (this.env.dayTint?.light ?? 1);
    this.water.setBoatDisturbances(
      this.isSkyTower ? [] : [...this.boats.values()].map((b) => {
        b.wakeLight = wakeLight;
        return {
          x: b.pos.x, z: b.pos.z,
          heading: b.heading,
          speed: b.speed,
          maxSpeed: b.def.maxSpeed,
          boosting: b.boostTimer > 0,
          isLocal: b.isLocal,
          length: b.def.hull.length,
        };
      }),
      dt,
    );
    this.track.updateVisual(this.nextGate % this.track.gates.length, this.elapsed);
    this.track.updateMechs(dt, this.elapsed); // 赛道机关：加速带/伸缩柱动画

    // 潜行区/立交桥：所有艇按赛道位置计算目标高度（本地/AI/远程统一，视觉由各自 #applyPose 平滑）
    // 烘焙赛道（openTrack）的高度完全由 gateY 决定，必须一起算，否则云端 63m 爬不上去
    if (this.track.dives.length || this.track.overpass || this.track.openTrack || this.track.gateHeights) {
      for (const [id, b] of this.boats) {
        const progress = this.progressMap.get(id);
        // 门号提示：螺旋塔/自叠回程里同一片 x,z 上下叠着好几圈跑道，
        // 纯 2D 最近点会挑错层（高度瞬移 / 横向空气墙）。把"已通过的门"传给
        // Track 的探测函数，它只在门窗口里找中心线。constrain 也读这个。
        b.gateHint = progress ? progress.gate : null;
        // 传入门索引：立交桥上下两层共用同一片水面，只能靠"已通过的门"区分
        // ⚠ 秘境漂流（openTrack）的水线段：`diveHeightAt` 恒返回门高度（水线段就是 0），
        // 船会被**硬钉在 y=0**，而那段可见水面是带浪的 GLB 水面（借用游戏 Water 材质，
        // 晴天浪峰就有 +0.5m）—— 浪一过就把船盖住，玩家原话"吃水太深、水面几乎把赛艇挡住"。
        // 所以水线段（|h| < 1.5）不传 diveTargetY，让船正常吃浪；云端/瀑布/栈道这些
        // 抬高段照旧贴 gateY 走，否则会穿板、掉下去。
        const dh = this.track.diveHeightAt(b.pos, b.gateHint, b.deckState);
        b.diveTargetY = (this.track.openTrack && dh != null && Math.abs(dh) < 1.5) ? null : dh;
        // 光让船"跟着浪浮"还不够：洞里的可见水面是 cave_water 网格（基本是平的 ≈ gateY），
        // 船跟着海面浪谷往下沉，浪谷时整条船就沉到那块平水面底下（用户："隧道里吃水还是太深"）。
        // 这里给一个**不许沉下去的下限**：船高永远不低于赛道水面 + 5cm。
        // 开阔水面波浪本身就把船托得比这个高，所以不影响外面的浪感。
        b.floatFloorY = this.track.openTrack && !b.airborne && !b.onCoaster && b.fallTimer <= 0
          ? (this.track.surfaceYAt(b.pos.x, b.pos.z, b.gateHint) ?? 0) + 0.05
          : null;
        // 腾空中的船还要知道"脚下那块水面"在哪：瀑布坡 / 云端 / 栈道都是抬高的，
        // 不写这个就会在中段砸到 y=0 再被拉回去（20m 瞬移）。
        // 但**掉落中的船不能给**：掉落是从赛道面上往下掉，给了就等于"一帧落地"，
        // 船会原地弹回去重来，永远掉不下去。
        b.surfaceLandingY = b.airborne && this.track.openTrack && b.fallTimer <= 0
          ? this.track.surfaceYAt(b.pos.x, b.pos.z, b.gateHint)
          : null;
      }
    }

    // ---------- 断层火山带（熔岩图）----------
    // 规则（2026-11-14 硬核档）：速度 >= 门槛才起跳跨过去；不够快就掉进裂谷，
    // 1.05s 后退回上一个门重生 + 0.7s 硬直 + 1.2s 宽限（不扣时间、不 DNF）。
    // 跳板保送和浪尖抛飞都已关掉，所以过谷只能靠自己把速度拉到 20m/s 以上。
    // 起跳复用浪尖抛飞那套（waveJump 12m/s² 轻重力，仍受护栏约束），
    // 所以腾空手感和弹射/巨浪一致，落地不会被走廊硬拽回去。
    if (this.track.faults && this.track.faults.length) {
      for (const [id, b] of this.boats) {
        if (b.faultGrace > 0) b.faultGrace -= dt;
        if (b.faultFall > 0) {
          b.faultFall -= dt;
          b.airborne = true;
          b.vy = Math.max((b.vy || 0) - 30 * dt, -46);
          b.pos.y += b.vy * dt;
          b.vel.set(0, 0);
          b.speed = 0;
          // 掉落期间把落地高度压到谷底，否则一帧就会被"海面就在脚下"接住
          b.surfaceLandingY = -80;
          if (b.faultFall <= 0) {
            const pm = this.progressMap.get(id);
            const lastGi = this.track.gates.length - 1;
            // 硬核档：只退一个门（旧版退两门等于白送 ~70m 助跑），
            // 重生后还带 0.7s 硬直 + 初速 4 —— 掉一次谷要重新把速度拉回 20m/s。
            const gi = Math.max(0, Math.min(lastGi, (pm ? pm.gate : 2) - 1));
            const g = this.track.gates[gi];
            const gn = this.track.gates[(gi + 1) % this.track.gates.length];
            // 按地点回退 30m（掉落点更靠前，罚得比 R 键略轻一点），不再整门往回丢
            const rp = this.track.respawnPoint?.(b.pos, (gi + 1) % this.track.gates.length, 30);
            const px = rp ? rp.x : g[0];
            const pz = rp ? rp.z : g[1];
            const hd = rp ? rp.heading : Math.atan2(gn[0] - g[0], gn[1] - g[1]);
            b.airborne = false;
            // 掉断层只罚位置（退一段 + 硬直），氮气留着
            b.resetTo(px, pz, hd, { keepNitro: true });
            const syF = this.track.surfaceYAt?.(px, pz, gi);
            b.pos.y = Number.isFinite(syF) ? syF : (this.track.gateY?.[gi] ?? 0);
            b.speed = 4;   // 硬核档：不给白送的助跑速度
            b.vy = 0;
            b.stunTimer = Math.max(b.stunTimer, 0.7);  // 掉谷硬直：方向键短暂失灵
            b.faultFall = 0;
            b.faultGrace = 1.2;
            b.surfaceLandingY = null;
            b.blinkTimer = 0;
            if (b.isLocal) {
              audio.play('respawn', { gap: 200 });
              this.#notice('掉进断层', { tone: 'red', sub: '已退回赛道', ttl: 1.0, priority: 2 });
            }
          }
          continue;
        }
        if (b.faultGrace > 0 || b.airborne || b.fallTimer > 0) continue;
        const f = this.track.faultAt(b.pos);
        if (!f) continue;
        if (b.speed >= f.minSpeed) {
          b.airborne = true;
          b.waveJump = true;
          b.airTime = 0;
          // 6.0 m/s 竖直初速 + 12m/s² 轻重力 ≈ 1s 滞空：21m/s 才够跨 15m 裂谷
          b.vy = 6.0;
          b.surfaceSplashed = false;
          b.underwaterLandingY = null;
          b.faultGrace = 1.1;
          if (b.isLocal) this.#notice('跨越断层', { tone: 'blue', sub: '落地稳', ttl: 1.1, priority: 2 });
        } else {
          b.faultFall = 1.05;
          b.vy = 0;
          b.vel.set(0, 0);
          b.speed = 0;
          if (b.isLocal) { audio.play('fall_water'); this.#noteImpact('fall'); }
        }
      }
    }

    // ---------- 掉落 / 起飞（秘境漂流这类烧结赛道专属） ----------
    // 掉落是"三段式"：先在空中自由落体 → 最后 0.7s 艇身闪烁 → 归位到上一个门。
    // 触发来源有两个：① Track 打的 overEdge 标记（冲出无护栏的悬崖边缘）；
    // ② 掉到赛道面以下（弹射/被撞飞/贴边掉出都可兜住）。
    if (this.track.openTrack) {
      const FALL_TIME = 1.05;       // 整段坠落时长（含闪烁）
      const BLINK_FROM = 0.7;       // 剩这么多秒时开始闪
      for (const [id, b] of this.boats) {
        if (b.fallTimer == null) b.fallTimer = 0;
        if (b.overEdge > 0) b.overEdge -= dt; else b.overEdge = 0;
        if (b.fallTimer > 0) {
          b.fallTimer -= dt;
          b.airborne = true;
          b.vy = Math.max((b.vy || 0) - 30 * dt, -46);
          b.pos.y += b.vy * dt;
          b.vel.set(0, 0);
          b.speed = 0;
          // 闪烁只在最后一段：整段都闪会看不清自己是怎么掉下去的
          b.blinkTimer = b.fallTimer <= BLINK_FROM ? b.fallTimer : 0;
          if (b.fallTimer <= 0) {
            const pm = this.progressMap.get(id);
            const gi = Math.max(0, Math.min(this.track.gates.length - 2, (pm ? pm.gate : 1) - 1));
            const g = this.track.gates[gi], nx = this.track.gates[gi + 1];
            // 同样按地点回退 30m；掉出赛道与 R 键走同一套中线逻辑（含近道）
            const rp = this.track.respawnPoint?.(b.pos, (gi + 1) % this.track.gates.length, 30);
            const px = rp ? rp.x : g[0];
            const pz = rp ? rp.z : g[1];
            const hd = rp ? rp.heading : Math.atan2(nx[0] - g[0], nx[1] - g[1]);
            b.airborne = false;
            // 掉出赛道同样只罚位置/时间，氮气条与瓶子保留
            b.resetTo(px, pz, hd, { keepNitro: true });
            const syF = this.track.surfaceYAt?.(px, pz, gi);
            b.pos.y = Number.isFinite(syF) ? syF : (this.track.gateY[gi] ?? 0);
            b.diveTargetY = b.pos.y;
            b.fallTimer = 0;
            b.blinkTimer = 0;
            b.vy = 0;
            b.overEdge = 0;
            if (b.isLocal) {
              audio.play('respawn', { gap: 200 });
              this.#notice('掉出赛道', { tone: 'red', sub: '已重置', ttl: 1.0, priority: 2 });
            }
          }
          continue;
        }
        // 触发 ①：冲出悬崖边缘（Track.constrain 标记）
        if (b.overEdge > 0 && !b.isAi) {
          b.fallTimer = FALL_TIME;
          b.vy = 0;
          if (b.isLocal) { audio.play('fall_water'); this.#noteImpact('fall'); }
          continue;
        }
        // 触发 ②：已经掉到赛道面以下（含云端镂空 / 被撞出边界）
        const surf = this.track.surfaceYAt(b.pos.x, b.pos.z, b.gateHint) || 0;
        if (b.pos.y < surf - 3.5 && !b.airborne) {
          b.fallTimer = FALL_TIME;
          b.vy = 0;
          if (b.isLocal) { audio.play('fall_water'); this.#noteImpact('fall'); }
          continue;
        }
        // 触发 ③：老规则兜底 —— 高处 + 横向出走廊 + 还在半空
        const lat = this.track.lateralAt(b.pos, b.gateHint);
        const high = (this.track.gateY[lat.i] ?? 0) > 20;
        if (high && lat.lat > 10.5 && (b.pos.y ?? 0) > 15) b.fallTimer = FALL_TIME;
        // 触发 ④：高处赛道（云端塔 / 出口水槽）横向出走廊。
        // 为什么不能再用 y 判断：openTrack 下 `diveTargetY` 取自 #bakedHeightAt，
        // 它**不看横向距离**，只看最近门段 —— 船掉到塔底海面后仍会被钳在坡道高度上，
        // 于是 ②③ 全都不成立，玩家就卡死在那儿（截图里的 24%）。
        // 这里只认"离中心线超过 12m"：走廊半宽 7.5（含矮墙 9.7），12 只可能是真掉出去了。
        const deckY = this.track.gateY[lat.i] ?? 0;
        if (deckY > 4 && lat.lat > 12 && !b.airborne && b.fallTimer <= 0) {
          b.fallTimer = FALL_TIME;
          b.vy = 0;
          if (b.isLocal) { audio.play('fall_water'); this.#noteImpact('fall'); }
        }
        // 触发 ⑤：进度已经在抬高段，艇却泡回海面（y≈0），且持续 1s。
        // ②③④ 全部依赖局部探针，探针一旦选到 y=0 的门段（塔底同时贴着出口水槽/
        // 回程堤岸）就全都不成立 —— 玩家截图里"24% 卡在塔底海面、速度 0"就是它。
        const pm5 = this.progressMap.get(id);
        const pgY = pm5 ? (this.track.gateY[Math.min(pm5.gate, this.track.gateY.length - 1)] ?? 0) : 0;
        if (pgY > 8 && (b.pos.y ?? 0) < 3 && !b.airborne) {
          b.lowTimer = (b.lowTimer || 0) + dt;
          if (b.lowTimer > 1.0 && b.fallTimer <= 0) {
            b.fallTimer = FALL_TIME;
            b.vy = 0;
            if (b.isLocal) { audio.play('fall_water'); this.#noteImpact('fall'); }
          }
        } else {
          b.lowTimer = 0;
        }
      }

      // ---------- 起飞点（瀑布崖口） ----------
      // 过了崖口直接进弹道，而不是贴着瀑布水条往下滑 —— 用户原话：
      // "希望赛艇飞在空中，而不是依附于瀑布上，加大物理检测，类似现在巨浪的物理飞行效果"。
      // 用的就是浪尖抛飞那套（waveJump：12m/s² 轻重力 + 仍受护栏约束），
      // 所以手感和大浪起跳完全一致，不会再被走廊硬拉回瀑布面。
      const jumps = this.mapDef.baked && this.mapDef.baked.jumps;
      if (jumps) {
        for (const [id, b] of this.boats) {
          const pm = this.progressMap.get(id);
          if (!pm) continue;
          if (b.jumpGate == null) b.jumpGate = pm.gate;
          for (const j of jumps) {
            const prev = b.jumpGate;
            if (prev < j.gate && pm.gate >= j.gate
              && b.speed >= (j.minSpeed ?? 10) && !b.airborne && b.fallTimer <= 0) {
              b.airborne = true;
              b.waveJump = true;
              b.airTime = 0;
              b.vy = j.vy ?? 4;
              b.surfaceSplashed = false;
              b.underwaterLandingY = null;
            }
          }
          b.jumpGate = pm.gate;
        }
      }
    }

    if (this.phase === 'countdown') {
      // 开场镜头期间倒计时整体冻结：镜头还在高空横扫时就开始读秒，
      // 玩家会在完全看不见自己船的情况下白丢几秒起跑时间。
      if (!this.raceIntro) {
        // 这里只按 dt 走（和物理同源）。后台标签页的"整段丢失"由 visibilitychange
        // + 后台补帧定时器补（见 #catchUpHidden）——不在每帧用墙钟差，
        // 否则软件渲染/卡到 1fps 的低端机也会被当成"冻结"，倒计时会跳秒。
        this.countdownLeft = Math.max(0, this.countdownLeft - dt);
        // 倒计时提示音：跟屏幕上跳的数字同步（UI 用的是 ceil(left - 1)），
        // 数到 0 换成发车音。gap:0 —— 节流会把"1"和"GO"之间那 60ms 吃掉。
        const cdShown = Math.ceil(this.countdownLeft - 1);
        if (cdShown !== this.lastCountdownShown) {
          this.lastCountdownShown = cdShown;
          // 后台补帧不出声：双开时另一个窗口不应该在背景里"3、2、1"
          if (!headless) audio.play(cdShown > 0 ? 'countdown' : 'countdownGo', { gap: 0 });
        }
        // 完美起步（严格档，2026-11-18）：口径照 QQ飞车 / 跑跑卡丁车的 Boost Start ——
        // 只有在「倒计时数字 1 → 0 的那一瞬」**按下**油门才算，太早（抢跑）太迟都不算。
        //   · 判定窗口以 countdownLeft = 1.0 为中心 ±0.15s（60fps 下约 18 帧）；
        //   · 必须是"按下"这个动作落在窗口内 —— 从倒计时 3 秒就按住不放 = 抢跑失效，
        //     因为整段窗口里再没有"新按下"的边沿；
        //   · 已经判定成功的不再被后续误按取消（松手再按只多判一次，不会把成功改回失败）。
        const PS_HALF = 0.15;
        const rawThrottle = this.opts.input ? this.opts.input.throttle : 0;
        const pressed = rawThrottle > 0;
        if (pressed && !this.psHeld) {
          const off = this.countdownLeft - 1;   // 距"1 变 0"还有多少秒（正数 = 还早）
          this.psPressedAt = this.countdownLeft;
          if (!this.perfectStart && off <= PS_HALF && off >= -PS_HALF) {
            this.perfectStart = true;
          }
        }
        this.psHeld = pressed;
        if (this.countdownLeft <= 0) {
          this.#beginRace();
          if (this.perfectStart && this.localBoat) {
            this.localBoat.boostTimer = Math.max(this.localBoat.boostTimer, 1.8);
            audio.play('perfect_start');
            // 起跑瞬间给一条明确的"成了"（中央提示条，绿色）
            this.#notice('完美起步', { tone: 'green', sub: '氮气 1.8s', ttl: 1.2, priority: 2 });
          }
          // AI 也有概率完美起步（按技术档次）
          if (this.isHost) {
            for (const boat of this.aiBoats) {
              const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
              if (id && Math.random() < (this.aiSkill[id] || 0.9) * 0.45) {
                boat.boostTimer = Math.max(boat.boostTimer, 1.4);
              }
            }
          }
        }
      }
    } else if (this.phase === 'racing' || this.phase === 'finished') {
      // 慢放期间照真实时间走：否则一次 0.85 秒的慢放会让成绩凭空快 1.8 秒
      this.raceTime += slowK ? rawDt : dt;
    }

    if (this.finishWindowActive) {
      this.finishWindowRemaining -= dt;
      if (this.finishWindowRemaining <= 0) {
        this.finishWindowActive = false;
        this.finishWindowRemaining = 0;
      }
    }
    // 冲线后彻底交还操控权：油门/转向/漂移/氮气全部锁死（镜头切近景环绕）
    const canControl = this.phase === 'racing' && !this.finished
      && (!this.bossMode || this.bossMode.canControl());

    // 本地艇
    if (this.localBoat) {
      let input = canControl && this.opts.input
        ? {
            throttle: this.opts.input.throttle,
            steer: this.opts.input.steer,
            drift: this.opts.input.drift,
            nitro: this.opts.input.nitro,
          }
        : { throttle: 0, steer: 0, drift: false, nitro: false };
      // 打 BOSS：屏幕方向驱动（上=冲向怪物，左右=绕怪物横移）
      if (this.bossMode) input = this.bossMode.driveBoat(dt, input);
      this.#applySurface(this.localBoat);
      this.localBoat.updateLocal(dt, input, this.elapsed, [...this.colliders, ...this.track.shoreColliders, ...this.track.mechColliders], this.mapDef.boundary);
      this.#applyCurrent(this.localBoat, dt);
      this.#applyWaveDrift(this.localBoat, dt);
      // 第一阶段把船钳制在固定通道内（前后可动、左右到边界冻结）
      this.bossMode?.constrainBoat(this.localBoat);
      // 只有自己真正冲线后才把船约束在终点之后。以前用 finishWindowActive 判断，
      // solo 里 AI 先完赛也会打开这个窗口，结果正在比赛的本地艇被 keepAfterFinishLine
      // 拽到起点线外 2m —— 玩家看到的"直接瞬移完成"就是这个。
      if (this.finished) this.track.keepAfterFinishLine(this.localBoat);
      this.track.constrain(this.localBoat, dt); // 赛道护栏：不许开出赛道（dt 给蹭墙助滑用）
      this.track.applyMechs(this.localBoat, dt); // 赛道机关：加速带/伸缩柱
      this.track.updateCoaster(this.localBoat, dt); // 金龙过山车：弹射/自动轨道触发
      if (!this.isHost) this.#boatVsBoats(this.localBoat);
      if (this.phase === 'racing' && !this.finished && !this.isBoss) {
        this.#checkLocalGates();
        this.#checkFinishLine();
      }
      this.#updateWrongWay(dt);
      this.#updateAssist(dt);
    }

    // 音响的持续层：引擎 / 水声 / 漂移跟着本地艇的状态走。
    // 刻意不写进 Boat —— 音频关心的是"这一帧玩家该听到什么"，跟物理无关，
    // 塞进 Boat 会让每艘 AI 艇都去动音频节点。
    if (this.localBoat) {
      const b = this.localBoat;
      const spd = Math.min(1, Math.max(0, b.speed / (b.def.maxSpeed || 30)));
      audio.setEngine(spd, b.boostTimer > 0);
      if (b.drifting) {
        audio.startDrift();
        audio.setDrift(b.driftCharge);
      } else {
        audio.stopDrift();
      }
    }

    // 大浪环境声：随当前天气的浪高连续调整音量。
    // 触发阈值放在 1.2 倍浪高以上 —— 平静/黄昏基本听不到，暴风雨、暴雪才压上来。
    const waveK = THREE.MathUtils.clamp((getWaveScale() - 1.2) / 1.2, 0, 1);
    if (waveK > 0.03) {
      audio.startLoop('wave_loop', { vol: 0.18 + waveK * 0.5, fade: 0.5 });
      audio.setLoopVolume('wave_loop', 0.18 + waveK * 0.5);
    } else {
      audio.stopLoop('wave_loop', 0.8);
    }

    // AI 艇（仅主机模拟；倒计时期间不动）
    if (this.isHost) {
      const idle = { throttle: 0, steer: 0, drift: false, nitro: false };
      for (const boat of this.aiBoats) {
        const aiId = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
        // 怪物模式：AI 不跑赛道圈，改成绕 BOSS 走位 + 自动开炮的协同陪练
        const aiInput = this.phase === 'countdown' ? idle
          : this.bossMode ? this.bossMode.driveAi(dt, boat, aiId)
            : this.#aiControl(boat, dt);
        this.#applySurface(boat);
        boat.updateLocal(dt, aiInput, this.elapsed, [...this.colliders, ...this.track.shoreColliders, ...this.track.mechColliders], this.mapDef.boundary);
        this.#applyCurrent(boat, dt);
        this.#applyWaveDrift(boat, dt);
        this.track.constrain(boat, dt);
        this.track.applyMechs(boat, dt);
        this.track.updateCoaster(boat, dt); // AI 也会触发过山车（主机权威模拟）
        if (!this.isBoss) this.#checkAiGates(boat);
      }
    }

    // 远程艇插值
    for (const [id, boat] of this.boats) {
      if (id === this.myId || (this.isHost && this.aiBoats.includes(boat))) continue;
      boat.updateRemote(dt, this.elapsed);
      // 远程艇进度估算（用其位置投影）
      const pm = this.progressMap.get(id);
      if (pm && !pm.finished) {
        pm.prog = this.#progAt(boat.pos, pm.lap);
      }
    }

    // The host resolves every human/AI pair after remote snapshots are applied.
    if (this.isHost) this.#resolveAuthoritativeBoatCollisions();

    // 相机
    if (this.localBoat) {
      const cinematic = this.bossMode?.updateCamera(this.camera, dt) || this.#raceIntroCamera(dt);
      let followBoat = this.localBoat;
      // 阵亡观战：镜头交给还活着的队友。**1v1 竞技场没有队友**——这里 find 出来的
      // "队友"其实是正在打你的对手，会变成强制看敌人视角；竞技场的阵亡镜头由
      // ArenaMode.updateCamera 自己接管（抬高俯看，避免跟着沉船钻进水下）。
      if (this.bossMode && this.mode !== 'arena') {
        const me = this.bossMode.players.get(this.myId);
        if (me && !me.alive) {
          const mate = [...this.bossMode.players.values()].find((p) => p.alive);
          if (mate) followBoat = mate.boat;
        }
      }
      if (this.podiumGroup) {
        this.cameraRig.focusPodium(this.podiumGroup, dt);
      } else if (this.finished && !this.bossMode) {
        // 完赛特写：贴近赛艇缓慢环绕，右侧整块留给结算面板
        this.finishCamT = (this.finishCamT || 0) + dt;
        this.cameraRig.focusFinish(followBoat, dt, this.finishCamT, this.elapsed);
      } else if (!cinematic) {
        // 打 BOSS：低空追尾 + 注视点锁在 BOSS 身上（镜头永远朝向怪物，不俯视）
        const lock = this.bossMode?.getLockTarget?.();
        if (lock) {
          this.cameraRig.followLookAt(followBoat, lock, dt);
          this._bossLockOn = true;
        } else {
          // 击败 BOSS 后传送门阶段锁头会消失；先慢速过渡 1.35s 再回追尾，
          // 否则镜头会从尸体方向猛地甩到船头前方（晕 3D 的玩家尤其明显）
          if (this._bossLockOn) {
            this.cameraRig.relaxAfterLock(1.35);
            this._bossLockOn = false;
          }
          this.cameraRig.follow(followBoat, dt, this.elapsed);
        }
      }
      this.bossMode?.applyCameraShake?.(this.camera, dt);
      // 水下渲染切换：相机没入水面下 → 蓝绿浓雾/气泡/焦散渐入
      // 天梯在 120m 高空，没有水下；而且 env.setUnderwater 会重写雾色/雾密度，
      // 把天梯特意的"无雾"覆盖掉（天空球会被雾染成一块平板色），所以整段跳过。
      const uwK = this.isSkyTower ? 0
        : THREE.MathUtils.clamp((0.3 - this.camera.position.y) / 1.8, 0, 1);
      if (!this.isSkyTower) this.env.setUnderwater(uwK);
      // 后处理也要知道：水下靠"逐通道吸收"才有深海蓝调（雾只负责远景，不负责色温）
      this.post?.setUnderwater?.(uwK);
    }
    this.updatePodium(dt);

    // 道具模式更新（含闪电）
    // 倒计时也要跑：箱子外观由 items.update → boxField.update 每帧重排，
    // 以前整个倒计时不更新，发车画面里一个道具箱都看不见（全是 y=-600 的隐藏实例）。
    if (this.items) {
      this.items.update(dt, this.elapsed, this.elapsed);
    }

    // 怪物模式：关卡流程 / BOSS / 小怪 / 道具
    if (this.bossMode) this.bossMode.update(dt, this.elapsed);

    // 网络发送 30Hz（本地 + 主机代 AI）。与服务端广播同频，避免上下行
    // 采样周期不一致造成的半帧额外量化延迟。
    this.sendTimer -= dt;
    if (this.sendTimer <= 0 && this.phase !== 'countdown') {
      this.sendTimer = 0.033;
      this.#sendState();
    }

    // 后台补帧到此为止：画面/DOM/音频都不该在隐藏标签页里跑
    if (headless) return;

    // HUD
    if (this.opts.onHud) {
      const hud = this.#hudData();
      if (this.bossMode) Object.assign(hud, this.bossMode.hudData());
      this.opts.onHud(hud);
    }

    // 氮气尾焰：所有加速中的艇从各自的喷口挂喷射特效（逐船差异见 NITRO_JETS）
    this._lastDt = dt;          // 尾焰余辉要按帧时间递减（方法签名保持无参，测试按字符串断言）
    this.#updateNitroFx();

    // Effekseer 更新（渲染前）
    this.fx.update(dt);
    // 道具倒影（P1）：在主渲染之前，用镜像相机把"艇 / 浮标"单独渲一张低分辨率图。
    // 清单每帧给一次，内部按 uuid 比对 —— 没换船/换图就不会重复遍历。
    if (!this.isSkyTower) {
      this.water.setReflectProps(this.#reflectProps());
      this.water.renderPropReflection(this.renderer, this.scene, this.camera);
    }
    // 每帧先复位画布尺寸与 GL 视口/裁剪盒（见方法注释）
    this.#guardCanvasSize();
    this.#resetViewport();
    // 后处理渲染（低画质时内部直接走 renderer.render）
    this.post.render(dt);
    // Effekseer 绘制：中/高画质由 PostFx 里的 FxPass 画进合成器；
    // 低画质没有合成器，才需要在这里单独绘制
    if (!this.post.isActive) this.fx.draw(this.camera);
    this.#checkBlackFrame();
    this.#watchPerf(frameMs);
  };

  // ---------- 后台标签页补帧 ----------
  // 浏览器对隐藏页会直接停掉 rAF（Chrome/Safari 都是），但 WebSocket 照常收包。
  // 结果就是：切到另一个窗口后，这一端的船、倒计时、圈数整段停住，
  // 另一端看到的是"卡在起点的木头人"，名次和道具命中全部错位。
  // 这里用 1Hz 定时器（后台定时器被限流后的上限）把错过的世界以 20 个子步补上，
  // 只跑模拟不渲染 —— 20 步/秒 ≈ 一个 0.05s 固定步长的物理循环，开销 < 5% CPU。
  #onVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) {
      this._hiddenSince = performance.now();
      this._hiddenSim = 0;
      this.#startHiddenTicker();
    } else {
      const hiddenMs = this._hiddenSince ? performance.now() - this._hiddenSince : 0;
      this._hiddenSince = 0;
      this.#stopHiddenTicker();
      this.#catchUpHidden(hiddenMs);
    }
  };

  /**
   * 回到前台：把"隐藏期间实际没跑到的时长"补进倒计时。
   * 后台补帧定时器通常已经推进了整段时间（_hiddenSim），这里只补它没跑到的部分 ——
   * 浏览器把定时器限流到 1 次/分钟时，这行就是倒计时不会停在 3 秒的兜底。
   */
  #catchUpHidden(hiddenMs) {
    if (!(hiddenMs > 300)) return;
    if (this.phase !== 'countdown') return;
    const missed = Math.max(0, hiddenMs / 1000 - (this._hiddenSim || 0));
    if (missed <= 0.05) return;
    // 连开场过场都没跑完就被切走：过场直接收掉，从当前倒计时继续
    if (this.raceIntro) { this.#endRaceIntro(); return; }
    this.countdownLeft = Math.max(0, this.countdownLeft - missed);
  }

  #startHiddenTicker() {
    if (this._hiddenTimer != null) return;
    this._hiddenAt = performance.now();
    if (!this._hiddenSince) this._hiddenSince = this._hiddenAt;
    this._hiddenSim = this._hiddenSim || 0;
    this._hiddenTimer = setInterval(() => {
      const now = performance.now();
      const gap = Math.min(1.5, Math.max(0, (now - this._hiddenAt) / 1000));
      this._hiddenAt = now;
      if (gap < 0.02) return;
      // 与前台一致：单步不超过 0.05s（物理稳定性），最多补 1.5s
      const steps = Math.min(30, Math.max(1, Math.round(gap / 0.05)));
      const step = gap / steps;
      try {
        for (let i = 0; i < steps; i++) this.#frame(step, 16.7, true);
        this._hiddenSim += gap;
      } catch (err) {
        // 后台补帧绝对不能把整局带崩：出错就停掉补帧，切回前台照常跑
        console.warn('[后台补帧] 已停止', err);
        this.#stopHiddenTicker();
      }
    }, 250);
  }

  #stopHiddenTicker() {
    if (this._hiddenTimer == null) return;
    clearInterval(this._hiddenTimer);
    this._hiddenTimer = null;
    // 回到前台：把超长帧间隔丢掉，否则第一帧会按 0.05s 的截断值卡一下
    this.clock.getDelta();
    this._frameAt = performance.now();
  }

  /**
   * 画布尺寸守卫：renderer 的绘制尺寸与窗口不一致时（DPR 变化、外部 resize、
   * 后处理重建等），画面会只占屏幕的一部分、其余是未绘制的黑区。每帧比对，
   * 不一致就重新同步一次（#onResize 会同时更新相机与后处理缓冲）。
   */
  #guardCanvasSize() {
    const r = this.renderer;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const s = r.getSize(VIEW_SIZE);
    if (s.x !== w || s.y !== h) { this.#onResize(); return; }
    const c = r.domElement;
    if (Math.abs(c.clientWidth - w) > 1 || Math.abs(c.clientHeight - h) > 1) {
      this.#onResize();
    }
  }

  /**
   * 复位视口与裁剪盒。
   * Effekseer 的 WASM 运行时会自己调用 glViewport / glScissor（Emscripten 的
   * _glViewport / _glScissor 导入），退出时若不恢复，three 的状态缓存又以为
   * 状态没变、不会重新设置 —— 后续帧就只往一小块矩形里绘制，其余区域保留
   * 上一帧/未清除的像素，屏幕上表现为“整屏高度、竖直直边的黑色方块”闪烁。
   * 复位时先下发原生 GL 调用，再用 renderer 的 API 把缓存同步回整屏值。
   */
  #resetViewport() {
    const r = this.renderer;
    const gl = r.getContext();
    if (!gl || gl.isContextLost()) return;
    const c = r.domElement;
    if (!c.width || !c.height) return;
    // 先走原生 GL 强制拉回整屏：粒子运行时是 WASM，直接调 glViewport / glScissor，
    // three 的状态缓存感知不到；之后 three 再“设置”同样的值会命中缓存、不下发
    // GL 调用，脏状态就一直残留，后续帧只画一小块矩形，其余区域不被清除而发黑
    gl.viewport(0, 0, c.width, c.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, c.width, c.height);
    // 再走 three 的 API，把它的缓存也改成整屏值，保证后续 pass 的调用有效
    const s = r.getSize(VIEW_SIZE);
    r.setViewport(0, 0, s.x, s.y);
    r.setScissor(0, 0, s.x, s.y);
    r.setScissorTest(false);
  }

  /**
   * 黑帧守卫：帧末采样帧缓冲中线上的 5 个点，连续两次判定为“大面积纯黑”就重建
   * 渲染尺寸与后处理缓冲（等价于一次 resize 自愈），并打一条带 GL 状态的日志。
   * 正常游玩只做 5 次 1×1 的 readPixels，日志仅在异常时输出。
   */
  #checkBlackFrame() {
    const now = performance.now();
    if (now - (this._blackProbeAt || 0) < 1500) return;
    this._blackProbeAt = now;
    const gl = this.renderer.getContext();
    if (!gl || gl.isContextLost()) return;
    const canvas = this.renderer.domElement;
    if (!canvas.width || !canvas.height) return;
    let dark = 0;
    for (const fr of [0.04, 0.25, 0.45, 0.65, 0.9]) {
      gl.readPixels(
        Math.floor(canvas.width * fr), Math.floor(canvas.height * 0.5),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, BLACK_PROBE,
      );
      if (BLACK_PROBE[0] + BLACK_PROBE[1] + BLACK_PROBE[2] < 12) dark++;
    }
    // 至少 4/5 采样点纯黑才算异常（夜景/风暴里整屏偏暗但不会真黑）
    if (dark < 4) { this._blackStreak = 0; return; }
    this._blackStreak = (this._blackStreak || 0) + 1;
    if (this._blackStreak < 2) return;
    this._blackStreak = 0;
    console.warn('[黑屏守卫] 检测到黑帧，重建渲染缓冲', {
      dark,
      buffer: `${canvas.width}x${canvas.height}`,
      css: `${canvas.clientWidth}x${canvas.clientHeight}`,
      viewport: gl.getParameter(gl.VIEWPORT),
      scissor: gl.getParameter(gl.SCISSOR_BOX),
      scissorTest: gl.isEnabled(gl.SCISSOR_TEST),
      pixelRatio: this.renderer.getPixelRatio(),
    });
    this.#onResize();
    this.#resetViewport();
  }

  showPodium(entries = [], opts = {}) {
    // 组队赛制：全队上同一座宽冠军台；个人赛制仍是金银铜三阶台。
    const teamMode = !!opts.team;
    // DNF racers remain in the detailed results table, never on a podium.
    this.podiumEntries = entries.filter((entry) => entry.dnf !== true).slice(0, 3);
    for (const source of this.boats.values()) source.group.visible = false;
    this.podiumGroup?.traverse((obj) => {
      if (obj.isMesh) { obj.geometry.dispose(); if (obj.material) obj.material.dispose(); }
    });
    if (this.podiumGroup) this.scene.remove(this.podiumGroup);
    const group = new THREE.Group();
    // Results are staged at each map's authored offshore anchor, never beside
    // the finish line where course props can hide the podium from the camera.
    const podium = this.mapDef.podium || { x: 0, z: 0, heading: 0 };
    group.position.set(podium.x, 0.05, podium.z);
    group.rotation.y = podium.heading || 0;
    const podiumDefs = teamMode
      ? [{ x: 0, y: 0.8, h: 1.6, w: 11.4, c: 0xf0bf43 }]
      : [{ x: 0, y: 1.25, h: 2.5, w: 3.6, c: 0xf0bf43 }, { x: -4.4, y: 0.8, h: 1.6, w: 3.0, c: 0xb9c8d3 }, { x: 4.4, y: 0.5, h: 1.0, w: 3.0, c: 0xbd754e }];
    podiumDefs.forEach((p) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, 3.0), new THREE.MeshStandardMaterial({ color: p.c, metalness: 0.42, roughness: 0.3 }));
      mesh.position.set(p.x, p.y, 0); group.add(mesh);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(p.w * 1.02, 0.12, 3.1), new THREE.MeshStandardMaterial({ color: 0x5be0ff, emissive: 0x168eb5, emissiveIntensity: 1.5 }));
      trim.position.set(p.x, p.y + p.h * 0.5, 0); group.add(trim);
    });
    // 组队：队员在宽台上并排；个人：金银铜三阶高度
    const soloX = [0, -4.4, 4.4];
    const teamX = this.podiumEntries.length >= 3 ? [-3.7, 0, 3.7] : this.podiumEntries.length === 2 ? [-1.9, 1.9] : [0];
    this.podiumEntries.forEach((entry, i) => {
      const source = this.boats.get(entry.id);
      if (!source) return;
      const sourceVisual = source.modelRoot || source.fallbackHull || source.group;
      // 蒙皮模型（牛来号）必须走 SkeletonUtils.clone：Object3D.clone 只复制节点，
      // SkinnedMesh 的 skeleton 仍指向**原船那副骨架** —— 顶点被原船的骨骼矩阵驱动，
      // 于是领奖台上那一格完全空白（原船已经 hidden 在终点线那边）。
      const isSkinned = sourceVisual.getObjectByProperty?.('isSkinnedMesh', true) !== undefined;
      const clone = isSkinned ? cloneSkinned(sourceVisual) : sourceVisual.clone(true);
      clone.userData.podiumBoat = true;
      const PODIUM_SCALE = 0.82;
      clone.position.set(
        teamMode ? teamX[i] : soloX[i],
        teamMode ? 1.7 : [2.55, 1.7, 1.15][i],
        0,
      );
      clone.scale.multiplyScalar(PODIUM_SCALE);
      clone.rotation.y = Math.PI;
      // 角色赛艇的 modelLiftY 是"蹄子埋进水里 0.25m"，领奖台上得把这个沉入量补回来，
      // 否则牛会陷进奖台顶面里一截（黄牛配金台，颜色又接近，看着就像腿没了）。
      // 缩放是加在 clip 根节点上的，内部的 lift 也跟着缩了，所以这里乘同一个系数。
      if (source.def?.fitTo === 'height') {
        clone.position.y -= (Number(source.def.modelLiftY) || 0) * PODIUM_SCALE;
      }
      clone.traverse((obj) => { if (obj.isMesh) { obj.visible = true; obj.castShadow = false; obj.receiveShadow = false; } });

      // 领奖台动作：有 dance 剪辑的角色（牛来号）在台上跳自己的舞；
      // 其余船只没有骨骼动作，沿用 updatePodium 里的摇晃。
      const danceName = source.def?.anim?.dance;
      const danceClip = danceName ? (source.animClips || []).find((c) => c.name === danceName) : null;
      if (danceClip) {
        const mixer = new THREE.AnimationMixer(clone);
        const act = mixer.clipAction(danceClip);
        act.setLoop(THREE.LoopRepeat, Infinity);
        act.play();
        clone.userData.mixer = mixer;
        // 上了台就笑：morph target 在克隆体上是独立副本，直接推满
        if (source.def.smileMorph) {
          clone.traverse((obj) => {
            const idx = obj.morphTargetDictionary?.[source.def.smileMorph];
            if (idx !== undefined && obj.morphTargetInfluences) obj.morphTargetInfluences[idx] = 1;
          });
        }
      }
      group.add(clone);
    });
    this.scene.add(group);
    this.podiumGroup = group;
    this.podiumTime = 0;
  }

  updatePodium(dt) {
    if (!this.podiumGroup) return;
    this.podiumTime = (this.podiumTime || 0) + dt;
    const boats = this.podiumGroup.children.filter((obj) => obj.userData?.podiumBoat);
    boats.forEach((obj, i) => {
      obj.position.y += (Math.sin(this.podiumTime * (1.2 + i * 0.18) + i) * 0.08 - (obj.userData.wave || 0)) * 0.12;
      obj.userData.wave = Math.sin(this.podiumTime * (1.2 + i * 0.18) + i) * 0.08;
      obj.rotation.z = i === 0 ? Math.sin(this.podiumTime * 1.5) * 0.07 : i === 1 ? -0.08 : Math.sin(this.podiumTime * 0.75) * 0.11;
      // 角色赛艇的跳舞动作（其他船没有 mixer，是空操作）
      obj.userData.mixer?.update(dt);
    });
  }

  // ---------- 门/圈判定 ----------
  get nextGate() {
    const pm = this.progressMap.get(this.myId);
    return pm ? pm.gate : 0;
  }

  /**
   * 水面材质：目前只有冰原会改写抓地。
   * 判定按"圆心 + 半径"的硬边界，进出瞬间就能感到打滑变化，
   * 暴风雪只放大视觉冰壳、不改判定，保证同一走线在不同天气下判定一致。
   */
  #applySurface(boat) {
    const ice = this.mapDef.iceZone;
    const onIce = ice && Math.hypot(boat.pos.x - ice.x, boat.pos.z - ice.z) <= ice.r;
    boat.surfaceGrip = onIce ? ice.grip : 1;
    boat.surfaceSlip = onIce ? ice.slip : 1;
    boat.surfaceDriftGain = onIce ? ice.driftGain : 1;
    // 冰壳区的水面被 discard 掉了：船改贴冰面高度（0.26，与 Environment 的冰壳一致）
    boat.iceRideY = onIce ? 0.26 : null;
  }

  /**
   * 大浪涌流：把船在波面上缓慢"搬"向侧面/前方。
   * 与旧的隐形逆流不同，强度直接由波浪高度与阵风相位驱动，
   * 玩家看到浪尖翻白时就是推力最强的时候；水下/腾空/过山车不参与。
   */
  #applyWaveDrift(boat, dt) {
    if (!boat.waveJumpEnabled) return;
    if (this.phase !== 'racing') return;
    if (boat.airborne || boat.onCoaster || boat.diveTargetY != null) return;
    const [ux, uz] = waveCurrent(boat.pos.x, boat.pos.z, this.elapsed);
    // 海啸级涌流：位移强度翻倍，浪尖处能把船明显搬向侧面
    const drift = 1.6 * dt;
    boat.pos.x += ux * drift;
    boat.pos.z += uz * drift;
    // 轻微速度注入：船头与涌流同向时读起来是"被浪推着走"，逆向时有顶流感
    boat.vel.x += ux * drift * 0.75;
    boat.vel.y += uz * drift * 0.75;
  }

  /**
   * 潮汐推流：正弦相位（18s 一轮）让水流平滑翻面，不是硬切换；
   * 天气越差水流越猛（weatherMul）。空中/过山车不参与。
   *
   * 注意这里做的是"位移"而不是"加速度"：快艇的水动力模型每帧都会把速度
   * 重新分解成前向/侧向并做抓地衰减，直接加速度会在几帧内被吃掉（实测只剩
   * 0.07 m/s），手感上等于没有水流。改成让水"搬"船，才是真的在顶流。
   */
  #applyCurrent(boat, dt) {
    const cur = this.mapDef.current;
    if (!cur || boat.airborne || boat.onCoaster) return;
    // 倒计时/冲线后不给船加水流：否则玩家还没起步就被逆流推离起点线
    if (this.phase !== 'racing') return;
    const dist = Math.hypot(boat.pos.x - cur.x, boat.pos.z - cur.z);
    if (dist > cur.r) return;
    // 边缘渐弱：进水的那一刻不会被硬拽一下
    const falloff = Math.min(1, (cur.r - dist) / (cur.r * 0.35));
    const mul = cur.weatherMul?.[this.weather?.id] ?? 1;
    const phase = tidalFactor(this.elapsed, cur.period);
    const drift = cur.strength * 0.5 * mul * falloff * phase * dt;
    boat.pos.x += cur.dir[0] * drift;
    boat.pos.z += cur.dir[1] * drift;
    // 顺手带一点点速度，撞上水流时有被"顶"的手感
    boat.vel.x += cur.dir[0] * drift * 1.5;
    boat.vel.y += cur.dir[1] * drift * 1.5;
  }

  /**
   * 氮气尾焰：按船型从模型包围盒算出的喷口锚点挂持续特效。
   * 两条船同时加速最多 4 段（双喷口），加上远处 AI 也不会堆成一屏粒子：
   * 同一个 key 存在就只更新位置，不再重复 play。
   */
  #updateNitroFx() {
    const dt = this._lastDt || 0;
    for (const [id, b] of this.boats) {
      // 怪物模式：加速尾焰统一回到最早的 jet（Basic/Laser01），
      // 赛艇差异只体现在攻击粒子上；竞速 / 道具保持逐船差异化。
      const cfg = this.mode === 'boss' ? BOSS_BOOST_JET : NITRO_JETS[b.def.id];
      const anchors = b.nitroNozzles;
      // 2026-11-17 修复：原来只看 boostTimer（只有氮气瓶），所以
      //   · 单喷 / 双喷（漂移小喷，走 miniBoostTimer）完全没有尾焰；
      //   · 氮气被撞断 / 小喷接氮气的那一瞬间 boostTimer 归零，尾焰"闪一下就没了"。
      // 现在两个计时器合成一个"正在加速"信号，并留 0.12s 余辉，
      // 相邻两段加速之间不会出现一帧空档（tail 模式每帧还要重新贴喷口）。
      const boosting = b.boostTimer > 0 || b.miniBoostTimer > 0;
      if (boosting) b.nitroFxHold = 0.12;
      else b.nitroFxHold = Math.max(0, (b.nitroFxHold || 0) - dt);
      const flameOn = boosting || (b.nitroFxHold || 0) > 0;
      for (let i = 0; i < 3; i++) {
        const key = `boost:${id}:${i}`;
        const coreKey = `${key}:core`;
        // 单喷口用中间锚点，双喷口用左右；牛来号没有配置，永远走关闭分支。
        // ⚠ 还必须确认这个锚点真的存在：船体 GLB 是异步加载的，
        //   早期帧 nitroNozzles 还是空数组，以前这里会取到 undefined 直接抛异常。
        const anchor = anchors && anchors[i];
        // points：center = 只开中间；sides = 只开左右；triple = 左中右全开
        // （triple 是 2026-11-18 给绯鲨 / 流光加的：这两条船的水花 / 冰雾素材
        //   一放大就糊成"罩子"，所以改加一股喷口来加强喷射宽度，粒子尺寸不动）
        const on = !!cfg && !!anchor && flameOn
          && (cfg.points === 'triple'
            ? true
            : (cfg.points === 'center' ? i === 1 : i !== 1));
        if (!on) {
          this.fx.stopAttached(key);
          this.fx.stopAttached(coreKey);
          continue;
        }
        const follow = () => {
          anchor.getWorldPosition(NITRO_NOZZLE_V);
          return NITRO_NOZZLE_V;
        };
        // 光束素材默认朝 +Y：转成水平、朝船尾喷
        const rot = () => ({ x: Math.PI / 2, y: b.heading + Math.PI, z: 0 });
        if (!this.fx.attached.has(key)) {
          this.fx.playAttached(key, cfg.fx, follow, {
            rot, loop: true, scale: cfg.scale, color: cfg.color,
            loopEvery: cfg.loopEvery, pool: cfg.pool, trail: cfg.trail === true,
          });
        }
        // 内层火芯：同一喷口再叠一层更小更亮的火团，做出双层燃烧的层次
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
    // 中途退赛/被移除的船不会再进上面的循环，把它的残留尾焰收掉
    for (const key of this.fx.attached.keys()) {
      if (!key.startsWith('boost:')) continue;
      const rest = key.slice(6);
      const owner = rest.slice(0, rest.indexOf(':'));
      if (!this.boats.has(owner)) this.fx.stopAttached(key);
    }
    // 紫色风尾粒子：只有本地流光号、且非 BOSS 模式（BOSS 模式加速尾焰统一成 jet）时喷
    this.#updateNitroSparkles(dt);
    // 绯鲨号直线水流：本地 skiff 加速时，喷口射出三根 three.js 水柱（主视觉）
    this.#updateNitroStream(dt);
  }

  /**
   * 流光号尾焰的紫色风尾粒子。
   * 条件是「本地船就是流光号 + 正在加速（含 0.12s 余辉）+ 配置里有 sparkle」。
   * 只服务本地玩家：AI 的流光号仍只有 Effekseer 光束，避免多船各开一层粒子拖帧。
   */
  #updateNitroSparkles(dt) {
    const sp = this.nitroSparkles;
    if (!sp) return;
    const b = this.localBoat;
    let emit = null;
    if (b && this.mode !== 'boss' && b.def?.id === 'dolphin') {
      const cfg = NITRO_JETS[b.def.id];
      const boosting = b.boostTimer > 0 || b.miniBoostTimer > 0 || (b.nitroFxHold || 0) > 0;
      const anchors = b.nitroNozzles;
      if (cfg?.sparkle && boosting && anchors && anchors.length) {
        emit = { active: true, anchors, heading: b.heading, speed: b.speed || 0 };
      }
    }
    sp.update(dt, emit);
  }

  /**
   * 绯鲨号尾焰的直线水流射流（three.js，主视觉）。
   * 与粒子层同样只服务本地玩家、非 BOSS 模式；三根水柱分别贴三个喷口，
   * 加速（含 0.12s 余辉）时显示，其余时间隐藏（mesh 不参与排序开销）。
   */
  #updateNitroStream(dt) {
    const js = this.nitroJetStream;
    if (!js) return;
    const b = this.localBoat;
    let emit = null;
    if (b && this.mode !== 'boss' && b.def?.id === 'skiff') {
      const cfg = NITRO_JETS[b.def.id];
      const boosting = b.boostTimer > 0 || b.miniBoostTimer > 0 || (b.nitroFxHold || 0) > 0;
      const anchors = b.nitroNozzles;
      if (cfg?.stream && boosting && anchors && anchors.length) {
        emit = { active: true, anchors, heading: b.heading };
      }
    }
    js.update(dt, emit);
  }

  /**
   * 逆行提示（带时间滞回）。
   * 只比"船头 vs 下一门"会误报：急 Z 弯 / 发卡弯刚过门就得反打方向，
   * 那一瞬间船头确实背对下一门（霓虹海峡连续 ±34m 摆动尤其明显）。
   * 所以要求背离持续 0.9s 才提示，刚过门 1s 内也一律不提示。
   */
  #updateWrongWay(dt) {
    const pm = this.progressMap.get(this.myId);
    const boat = this.localBoat;
    if (this.gateGrace > 0) this.gateGrace = Math.max(0, this.gateGrace - dt);
    const canWarn = pm && boat && this.phase === 'racing' && !this.finished
      && !this.isBoss && boat.speed > 4 && this.gateGrace <= 0;
    if (!canWarn) {
      this.wrongWayTimer = 0;
      this.wrongWayShown = false;
      return;
    }
    if (this.track.isWrongWay(boat.pos, boat.heading, pm.gate)) this.wrongWayTimer += dt;
    else this.wrongWayTimer = 0;
    this.wrongWayShown = this.wrongWayTimer > 0.9;
  }

  // ---------- 幽灵车 / 每圈评价 / 失败归因（2026-11-18）----------
  //
  // 三件事共用同一份本圈遥测（LapTelemetry），也共用屏幕上同一条提示轨道
  // （中央偏下：`.hud-assist`）。归因的即时性比圈评强，所以归因先播、
  // 圈评自动顺延 —— 玩家不会在同一秒被告知四件互相打架的事。

  /** 每帧：采样本圈、推进幽灵、收集归因、递减提示计时 */
  #updateAssist(dt) {
    if (this.noticeTtl > 0) {
      this.noticeTtl = Math.max(0, this.noticeTtl - dt);
      // 当前这条播完，立刻接上被压住的提示（队列只有 1 格，后来的直接覆盖：
      // 撞墙连撞时宁可只看到最后一次，也不要排到下个弯才播）
      if (this.noticeTtl <= 0 && this.noticePending) {
        const p = this.noticePending;
        this.noticePending = null;
        this.notice = { main: p.main, sub: p.sub, tone: p.tone, priority: p.priority };
        this.noticeTtl = p.ttl;
      }
    }
    if (this.noticeCooldown > 0) this.noticeCooldown = Math.max(0, this.noticeCooldown - dt);
    if (this.ghostSavedFlash > 0) this.ghostSavedFlash = Math.max(0, this.ghostSavedFlash - dt);

    const b = this.localBoat;
    if (!b) return;
    const racing = this.phase === 'racing' && !this.finished && !this.isBoss;
    if (!racing) {
      // 倒计时 / 已完赛 / BOSS：幽灵原地收起，别停在赛道上当路障
      if (this.ghostBoat && this.ghostBoat.visible) {
        this.ghostBoat.setVisible(false);
        this.ghostVisible = false;
      }
      return;
    }

    const lapT = Math.max(0, this.raceTime - this.lapStart);
    this.telemetry.sample(b, this.track, lapT, dt);

    // 撞墙 / 撞硬物：Track.constrain 与 Boat 的碰撞里在「真撞」那一帧写值，
    // 这里读完立刻清零 —— 蹭墙（法向速度很小）不会写，所以不会一路闪图标。
    if (b.wallHitSpeed > 0) {
      this.telemetry.noteWall();
      this.#noteImpact('wall');
      b.wallHitSpeed = 0;
    }
    if (b.lastHardHit) {
      this.telemetry.noteWall();
      this.#noteImpact(b.lastHardHit.kind === 'buoy' ? 'buoy' : 'rock');
      b.lastHardHit = null;
    }

    if (this.ghostBoat) {
      const prog = GhostBoat.progressOf(this.track, b, this.ghostLapArc);
      const st = this.ghostBoat.update(dt, this.elapsed, lapT, prog);
      this.ghostDelta = st.delta;
      // 挑战模式的心智就是「影子始终在场上」：领先还是落后都看得见，
      // 不再有「领先 0.6 秒就收起来」那套阈值（玩家会以为影子消失了）。
      // 记录那一圈跑完后（st.finished）影子停在终点，不再跟着时间往前走。
      const show = !st.finished;
      this.ghostBoat.setVisible(show);
      this.ghostVisible = show;
    }
  }

  /**
   * 中央提示条的唯一入口（2026-11-18 重做）。
   *
   * 以前归因（大 emoji + 两字）和圈评（30px 两行）是两套版式、两条 TTL，
   * 凑在一起就变成"屏幕中间同时躺着两块字"。现在统一成一条斜切发光条：
   * 位置固定在屏幕正中距顶 25vh（参考图标红的那片空白），只换色调分类别。
   *
   * @param {string} main 主文案（白色斜体大字）
   * @param {object} o
   * @param {'red'|'green'|'blue'|'gold'|'purple'} o.tone 分类色
   * @param {string} o.sub  副文案（12px，跟在主文案右边）
   * @param {number} o.ttl  停留秒数
   * @param {number} o.priority 3=归因 2=系统提示 1=圈评；低的会被折叠进 pending
   * @param {string} o.key  同类节流键（1.2s 内同 key 不重复报）
   */
  #notice(main, { tone = 'blue', sub = '', ttl = 1.0, priority = 1, key = '' } = {}) {
    if (!main) return;
    if (key) {
      if (this.noticeCooldown > 0 && this.noticeLastKey === key) return;
      this.noticeCooldown = 1.2;
      this.noticeLastKey = key;
    }
    const item = { main, sub, tone, priority };
    // 当前这条还没播完、而且比新来的更重要 → 排队等着，不打断
    if (this.noticeTtl > 0 && priority < (this.notice?.priority || 0)) {
      this.noticePending = { ...item, ttl };
      return;
    }
    this.notice = item;
    this.noticeTtl = ttl;
    this.noticePending = null;
  }

  /**
   * 出弯小喷 / 双喷的反馈（2026-11-19）。
   *
   * 只在**比赛模式**报（`this.mode === 'race'`，挑战模式归一化后也是 race）：
   * 道具模式的提示条已经被道具进出占满，怪物模式没有漂移玩法，都不掺这一条。
   *
   * 两档刻意用不同颜色，一眼分得出这喷值不值：
   *   · n >= 2 → 金「双喷成功」（峰值滑移 ≥30°，稀有）
   *   · n == 1 → 绿「小喷成功」（≥16°，日常）
   * 节流键分开写，否则小喷刚报完 1.2s 内打出双喷会被自己挡掉。
   */
  #noteDriftBoost(n) {
    if (this.mode !== 'race') return;
    const double = n >= 2;
    this.#notice(double ? '双喷成功' : '小喷成功', {
      tone: double ? 'gold' : 'green',
      sub: double ? '滑移 30° 以上' : '滑移 16° 以上',
      ttl: 0.9,
      priority: 1,
      key: double ? 'driftBoost2' : 'driftBoost1',
    });
  }

  /**
   * 失败归因。同类 1.2 秒内只报一次（#notice 的 key 节流），
   * 避免贴墙跑时每帧刷一条。C1 口径保留：只说是哪一类，不写损失数值、不写谁打的。
   */
  #noteImpact(key) {
    if (!settings.get('impactIcon')) return;
    // 2026-11-19：比赛模式撞护栏不再弹中央文字（用户反馈太吵）。
    // 只静音 wall 这一项：撞礁石/浮桶/掉落/道具受击照旧提示。
    // 注意这里只关"文字"，物理撞击、音效、水花、失败归因统计都不受影响。
    if (key === 'wall') return;
    const meta = IMPACT_ICONS[key] || IMPACT_ICONS.other;
    // 物理撞击（墙/石/浮桶/掉出）走红，道具受击走紫 —— 一眼分得出"是自己撞的"还是"被人打的"
    const physical = key === 'wall' || key === 'rock' || key === 'buoy'
      || key === 'fall' || key === 'reset';
    this.#notice(`${meta.icon} ${meta.label}`, {
      tone: physical ? 'red' : 'purple',
      sub: IMPACT_HINTS[key] || '',
      ttl: 0.95,
      priority: 3,
      key,
    });
  }

  /** 道具模式的提示（获得/使用/被挡…）：全部并入同一条提示条，不再走底部大字 */
  #noteItemToast(msg) {
    const text = String(msg ?? '').trim();
    if (!text) return;
    // 只是粗分类：拦下/吃到是好事，被打是坏事，其余中性
    const tone = /挡|免疫|获得|成功|拿到|解/.test(text) ? 'green'
      : /击中|打中|被|墨|慢|沉|缠|翻|反/.test(text) ? 'purple'
        : 'blue';
    this.#notice(text, { tone, ttl: 1.4, priority: 2 });
  }

  /** 道具命中回调（ItemManager 在「本地玩家真的被打中」时调用，护盾拦下不算） */
  #noteItemHit(msg) {
    if (!msg || msg.id !== this.myId) return;
    this.#noteImpact(impactKeyFromFx(msg.fx));
  }

  /** 圈评：。buildReview 的 tone 直接映射成提示条色调（淡出仍交给 UI 按 ttl 算） */
  #showReview(review) {
    if (!review || !settings.get('lapReview')) return;
    // best=金（破纪录） / good=绿（更快） / bad=红（更慢） / even|first=蓝（中性）
    const tone = review.tone === 'best' ? 'gold'
      : review.tone === 'good' ? 'green'
        : review.tone === 'bad' ? 'red' : 'blue';
    this.#notice(review.main, { tone, sub: review.sub, ttl: 1.4, priority: 1 });
  }

  /**
   * 把刚跑完的一圈收尾：出评价、破纪录则存成新幽灵、下一圈重新采样。
   * @param {number} lapTime 本圈用时
   * @param {number} lapArc 本圈（下一圈）起点弧长
   */
  #finishLap(lapTime, lapArc) {
    const best = this.ghostRecord?.lapTime ?? null;
    const lap = this.telemetry.endLap(lapTime, {
      bestTime: best,
      ghostSegT: this.ghostSegT || null,
      seed: this.lapTimes.length + 1,
    });
    this.#showReview(lap.review);
    // 只有「比历史最快还快」才覆盖存档，否则每圈都写一次 localStorage
    if ((best == null || lapTime < best - 0.02) && this.ghostKeyId) {
      this.#saveGhost(lap, lapArc);
    }
    this.telemetry.begin(lapArc, this.track.arcTotal);
  }

  /** 打包 + 落盘 + 本局立刻换上新幽灵（不用重开一局才看到） */
  #saveGhost(lap, lapArc) {
    const mapId = this.opts.startMsg.mapId || this.mapDef.id || '';
    const boatId = this.myEntry?.boatId || this.localBoat?.def.id || '';
    const arcTotal = this.track.arcTotal || 0;
    const rec = encodeGhost(lap.samples, {
      mapId, boatId, arcTotal, lapTime: lap.lapTime, hz: 20,
    });
    if (!rec.n) return;
    rec.lapArc = lapArc;
    if (!writeGhost(rec)) return;
    this.ghostRecord = { ...rec };
    this.ghostSavedFlash = 2.4;
    const data = decodeGhost(rec);
    if (!data) return;
    if (this.ghostBoat) {
      // 已经有幽灵：就地把它的轨迹换成这一圈（本局剩下的圈立刻追新记录）
      if (this.ghostBoat.load(data, this.track, lapArc)) {
        this.ghostLapArc = lapArc;
        this.ghostSegT = this.ghostBoat.segT;
      }
    } else {
      // 开局时一条记录都没有（第一次跑这张图/这条船）：现在建出来。
      // 少了这一步，玩家跑完第一圈之后第二圈还是空的，看起来就像功能没生效。
      this.#spawnGhost(data, lapArc);
    }
  }

  /** 弧长进度：与"碰到第几个门"无关，漏门也不会让进度条卡住 */
  #progAt(pos, lap) {
    const T = this.track;
    const arc = T.arcAt ? T.arcAt(pos.x, pos.z).s : 0;
    return (Math.max(1, lap) - 1) * (T.arcTotal || 1) + arc;
  }

  /**
   * 船头这一帧的位移线段是否真的穿过了终点线。
   *
   * **这是圈数与完赛的唯一依据**（本地玩家 / AI 都走这里）。
   * 旧逻辑的三处硬伤，就是"冲过终点却不结算"与"船头没进终点就结算"的来源：
   *  1. 必须按顺序碰到每个门的圆形范围 —— 从门边绕过去几米，后面全部作废；
   *  2. 高速时逐帧采样点可能整体越过圆（尤其是低帧率 + 氮气）；
   *  3. 拿船中心判定：船头已经压线、中心还差 2m；把门当终点时又是
   *     中心进了 13m 半径就结算，船头离旗门还有十几米。
   *
   * 现在的规则（严格按用户口径）：
   *  - 船头线段从"线后"穿到"线前"，交点横向在赛道宽度内 → 有效；
   *  - 且距上次过线已经沿中心线跑够一圈的 45%（开环 20%）→ 计一圈，
   *    开局倒车再进线、原地蹭线都过不了这道门槛；
   *  - 与门序号完全解耦：漏门只影响小地图路标与道具，不影响圈数与结算。
   *
   * @param {object} boat 赛艇
   * @param {object} st 判定状态 `{arcPrev, bowPrev, arcSince}`，本地船用 this 自身
   * @returns {boolean} true = 船头这一帧压过了终点线
   */
  #crossedFinish(boat, st) {
    const line = this.finishLine;
    const T = this.track;
    if (!line || !T?.arcAt) return false;

    const half = (boat.def?.hull?.length || 4.5) * 0.5;
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    const bx = boat.pos.x + fx * half;   // 船头
    const bz = boat.pos.z + fz * half;
    const arc = T.arcAt(bx, bz).s;
    const total = T.arcTotal || 1;

    if (st.arcPrev == null) {
      st.arcPrev = arc;
      st.bowPrev = { x: bx, z: bz };
      st.arcSince = 0;
      return false;
    }
    // 弧长增量（首尾相接，跨越 0 点时取短边）—— 几何规则都在 finishLine.js，便于单测
    const d = arcDelta(st.arcPrev, arc, total);
    if (d > 0) st.arcSince = (st.arcSince || 0) + d;
    st.arcPrev = arc;

    const pv = st.bowPrev;
    const hit = segmentCrossesLine(
      pv.x, pv.z, bx, bz, line.x, line.z, line.dx, line.dz, line.halfWidth,
    );
    pv.x = bx;
    pv.z = bz;
    if (!hit) return false;
    // 没跑够一圈，蹭线不算。开环赛道只跑一趟，门槛按实际剩余弧长放宽
    if (!lapIsComplete(st.arcSince, total, line.open ? 0.20 : 0.45)) return false;
    st.arcSince = 0;
    return true;
  }

  #checkFinishLine() {
    const boat = this.localBoat;
    const pm = this.progressMap.get(this.myId);
    if (!boat || !pm || pm.finished || this.finished) return;
    if (!this.finishLine) return;
    const T = this.track;
    if (!this.#crossedFinish(boat, this)) return;

    pm.lap += 1;
    // 新一圈的进度基准 = 压线这一帧船心所在的弧长（不是 0：船头过线时
    // 船心还在线后两米，直接用 0 会让进度条先跳到 100% 再掉下来）
    pm.lapArc = this.track.arcAt(boat.pos.x, boat.pos.z).s || 0;
    const lapTime = this.raceTime - this.lapStart;
    this.lapStart = this.raceTime;
    if (pm.lap >= 2 && lapTime > 1) {
      this.lapTimes.push(lapTime);
      if (this.bestLap == null || lapTime < this.bestLap) this.bestLap = lapTime;
      audio.play('lap');
      // 每圈评价 + 幽灵存档。放在完赛判断**之前**：最后一圈往往是全场最快，
      // 放在 return 之后会被吞掉（完赛不评价、也不更新幽灵记录）。
      this.#finishLap(lapTime, pm.lapArc);
    }
    if (pm.lap > this.finishLaps) {
      this.finished = true;
      this.finishWindowActive = true;
      this.finishWindowRemaining = 10;
      this.finishTime = this.raceTime;
      this.localBoat?.cancelDriftForCollision();
      pm.finished = true;
      pm.finishTime = this.raceTime;
      pm.prog = T.totalProgressUnits(this.laps);
      // 冲线慢动作（任务2）：环绕镜头本来就在跑，这里再把世界放慢 0.32×，
      // 把"赢的那一刻"拉长成 0.85 秒的观感。只要自己压线就触发，不看名次。
      this.startSlowMo = 0.85;
      audio.play('finish');
      // finish: true 是完赛的**唯一**凭证 —— 服务器不再靠"消息里带 totalTime"猜
      this.net.send({
        t: 'gate', id: this.myId, gate: this.finishLine.index, lap: pm.lap,
        lapTime, totalTime: this.raceTime, finish: true,
      });
      this.opts.onFinish?.({ time: this.raceTime, bestLap: this.bestLap, rank: this.#myRank() });
      return;
    }
    this.net.send({
      t: 'gate', id: this.myId, gate: this.finishLine.index, lap: pm.lap, lapTime,
    });
    pm.prog = this.#progAt(boat.pos, pm.lap);
  }

  #checkLocalGates() {
    const pm = this.progressMap.get(this.myId);
    const boat = this.localBoat;
    if (!pm || !boat || !this.track?.gates?.length) return;
    const gateIdx = pm.gate;
    const N = this.track.gates.length;
    // ⚠ 门只是"小地图路标 / 道具 / 名次"用的进度刻度，**圈数与完赛完全不看门**：
    // 唯一的依据是 #checkFinishLine()（船头线段穿过终点线）。
    // 旧版在这里用 `track.onStartLine(boat.pos)`（船中心 ±4.8m）判"补最后一门并直接
    // 算这一圈"、开环赛道还拿"离最后一门 13m 的圆"当终点，两条都会让船头还没到线
    // 就结算 —— 已整段删除。
    if (this.track.checkGate(boat.pos, gateIdx)) {
      pm.gate = (gateIdx + 1) % N;
      this.gateGrace = 1.0; // 刚过门：门口打方向不算逆行
      // 服务器按 (lap-1)*N + gate + 1 记名次，所以每过一个门都要报一次进度
      this.net.send({
        t: 'gate', id: this.myId,
        gate: gateIdx === 0 ? 0 : gateIdx,
        lap: Math.max(1, pm.lap),
      });
    }
    pm.prog = this.#progAt(boat.pos, pm.lap);
  }

  #checkAiGates(boat) {
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    if (!id) return;
    const pm = this.progressMap.get(id);
    if (!pm || pm.finished) return;
    // AI 的圈数/完赛与本地玩家**同一条终点线、同一套船头压线判定**。
    // 旧版靠"过 0 号门就 +1 圈"，而 0 号门是靠船中心 ±4.8m 判的，
    // AI 会提前半条船结算 —— 主机端 AI 一冲线就开结算窗口，玩家还在跑。
    if (this.finishLine) {
      pm.finState ??= { arcPrev: null, bowPrev: null, arcSince: 0 };
      if (this.#crossedFinish(boat, pm.finState)) {
        pm.lap += 1;
        pm.lapArc = this.track.arcAt(boat.pos.x, boat.pos.z).s || 0;
        if (pm.lap > this.finishLaps) {
          const firstFinisher = !this.finishWindowActive && !this.finished;
          pm.finished = true;
          pm.finishTime = this.raceTime;
          this.net.send({
            t: 'gate', id, gate: this.finishLine.index, lap: pm.lap,
            totalTime: this.raceTime, finish: true,
          });
          // In solo play an AI can cross first. Start the same ten-second
          // observation window used when the local player finishes.
          if (firstFinisher && this.solo) {
            this.finishWindowActive = true;
            this.finishWindowRemaining = 10;
            this.opts.onFinish?.({
              time: this.raceTime,
              bestLap: null,
              rank: this.#rankOf(id),
              winnerId: id,
              ai: true,
            });
          }
          return;
        }
        this.net.send({ t: 'gate', id, gate: this.finishLine.index, lap: pm.lap });
      }
    }
    if (this.track.checkGate(boat.pos, pm.gate)) {
      const gateIdx = pm.gate;
      pm.gate = (gateIdx + 1) % this.track.gates.length;
      this.net.send({
        t: 'gate', id, gate: gateIdx === 0 ? 0 : gateIdx, lap: Math.max(1, pm.lap),
      });
    }
    pm.prog = this.track.progress(pm.gate, Math.max(1, pm.lap), boat.pos);
  }

  #onRemoteGate(msg) {
    const pm = this.progressMap.get(msg.id);
    if (!pm || msg.id === this.myId) return;
    const N = this.track.gates.length;
    const gate = Math.max(0, Math.min(N - 1, Math.round(Number(msg.gate) || 0)));
    const lap = Math.max(1, Math.round(Number(msg.lap) || 1));
    // 过期/重复消息（重连补发、AI 代发交错）不许把名次往回拽
    const curProg = (Math.max(1, pm.lap) - 1) * N + pm.gate;
    const nextProg = (lap - 1) * N + gate + 1;
    if (!pm.finished && nextProg <= curProg) return;
    pm.gate = (gate + 1) % N;
    pm.lap = lap;
    // 完赛凭证只有一个：发送方明确标了 finish: true（它自己的船头压过终点线）。
    // 旧版把"lap > laps"也当完赛 —— 远端只要过门过快了（或漏门跳号）就会被提前
    // 判完赛，结算窗口跟着提前弹出来。
    if (msg.finish === true) {
      pm.finished = true;
      pm.finishTime = msg.totalTime ?? null;
    }
  }

  #onSnapshot(msg) {
    // 主机已经发车、本端还卡在倒计时（后台标签页把 rAF 停掉时就是这样）：
    // 直接对齐到主机的赛程，不再等本地那一套读秒走完。
    if (!this.isHost && msg.ph === 'racing' && this.phase === 'countdown') {
      const rt = Number(msg.rt) || 0;
      if (rt > 0.5 || this.countdownLeft > 0.4) this.#forceRaceStart(rt);
    }
    for (const state of msg.p) {
      const [id, x, z, h, s, b, y, vx, vz, roll] = state;
      const auth = state[10];
      const boat = this.boats.get(id);
      if (!boat) continue;
      // 主机本地模拟的 AI 不需要快照
      if (this.isHost && this.aiBoats.includes(boat)) continue;
      // 自己永远以本地预测为准——服务端回传的是 33ms 前的滞后快照，写进本地
      // 预测只会让本机船和滞后位置打架；自身快照也不能进延迟回放缓冲
      // （remoteClock 对本机不推进，缓冲永远不会被消费）。
      // 服务器以 auth:true 推送的权威校正（碰撞回正/作弊纠错等）走专用通道。
      if (auth) {
        if (id !== this.myId) boat.applyNetworkCollisionState?.({ x, z, y, heading: h, speed: s, vx, vz, roll });
      } else if (id !== this.myId) {
        boat.setRemoteState(x, z, h, s, b, y, vx, vz, roll);
      }
    }
  }

  #resolveAuthoritativeBoatCollisions() {
    this.collisionPairKeys = new Set();
    for (const boat of this.boats.values()) this.#boatVsBoats(boat);
    this.collisionPairKeys = null;
  }

  // ---------- 艇间碰撞（各自权威艇视角） ----------
  //
  // 2026-11-15 重做：从「按中心连线推一把 + 一刀常速衰减」换成**真实接触点冲量**。
  //   · 法线取两船中轴线的最近点方向，细长船体侧撞时不再被推向斜前方；
  //   · 速度变化只沿法线按质量分配（正撞两船一起减速，擦边几乎不掉速）；
  //   · 接触点偏离重心产生力矩 → 船头朝被撞的反方向偏；
  //   · 结算完不再有与方向无关的 `vel *= 0.84~0.99`，那正是"撞一下就被硬拽一下"的元凶。
  // 数学与单测见 boatContact.js / tests/boat_contact.test.mjs。
  #boatVsBoats(localBoat) {
    const localId = [...this.boats.entries()].find(([, b]) => b === localBoat)?.[0] || '';
    if (!localBoat.vel) return;
    for (const [id, boat] of this.boats) {
      if (boat === localBoat) continue;
      // 泡泡蜻蜓幻境中的艇 = 可穿过的透明影子：任一方在 void 就跳过整对船体碰撞
      // （位置分离 + 冲量都不做）。必须两边都判 —— 主机对每艘船都跑一次本函数，
      // 只判 boat 的话 void 艇自己当 localBoat 时仍会去撞别人。
      // 这一处在 solo(主机权威) / 局域网主机 / 联机主机 / 联机客机全部路径共用。
      if (localBoat.voidTimer > 0 || boat.voidTimer > 0) continue;
      const pairKey = [localId, id].sort().join('|');
      if (this.collisionPairKeys?.has(pairKey)) continue;

      const contact = boatContactNormal(
        localBoat.def, localBoat.heading, localBoat.pos.x, localBoat.pos.z,
        boat.def, boat.heading, boat.pos.x, boat.pos.z,
      );
      const { nx, nz } = contact;
      // 重叠深度仍按「椭圆支撑半径」量：这套尺寸是发车并排格距与防穿模的老约定，
      // 换掉会连带改掉发车间距，所以这里只升级法线方向，不动尺寸口径。
      const minD = boatCollisionRadius(localBoat.def, localBoat.heading, nx, nz)
        + boatCollisionRadius(boat.def, boat.heading, nx, nz);
      const d = Math.hypot(localBoat.pos.x - boat.pos.x, localBoat.pos.z - boat.pos.z);
      if (!(d < minD)) continue;

      this.collisionPairKeys?.add(pairKey);

      const res = resolveBoatImpact({
        aDef: localBoat.def, bDef: boat.def,
        ax: localBoat.pos.x, az: localBoat.pos.z,
        bx: boat.pos.x, bz: boat.pos.z,
        aHeading: localBoat.heading, bHeading: boat.heading,
        avx: localBoat.vel.x, avz: localBoat.vel.y,
        bvx: boat.vel?.x || 0, bvz: boat.vel?.y || 0,
        aw: localBoat.angVel || 0, bw: boat.angVel || 0,
        nx, nz, penetration: minD - d,
        acx: contact.ax, acz: contact.az, bcx: contact.bx, bcz: contact.bz,
      });

      // 位置分离（沿接触法线、按质量比分配）：这一步必须每帧都做，
      // 否则两船会一点点叠在一起，看起来像互相穿过去。
      localBoat.pos.x += nx * res.sepA;
      localBoat.pos.z += nz * res.sepA;
      boat.pos.x -= nx * res.sepB;
      boat.pos.z -= nz * res.sepB;
      localBoat.group.position.x = localBoat.pos.x;
      localBoat.group.position.z = localBoat.pos.z;
      boat.group.position.x = boat.pos.x;
      boat.group.position.z = boat.pos.z;

      // 只是贴着（同速并排跑）→ 分开位置就够，速度一分不动，不会抖。
      if (res.impactSpeed <= 0) continue;

      const impact = res.impactSpeed;
      const stabA = Math.max(0, Math.min(1, localBoat.def.stability));
      const stabB = Math.max(0, Math.min(1, boat.def.stability));
      const hard = impact > 4.5;
      // 侧翻方向按「撞击发生在船的哪一侧」定，与撞石头走同一套符号
      const latA = nx * Math.cos(localBoat.heading) - nz * Math.sin(localBoat.heading);
      const latB = -nx * Math.cos(boat.heading) + nz * Math.sin(boat.heading);
      // 撞击音/抖动只在真撞上时才给，贴着磨不会一直响
      const shake = impact > 4 ? Math.min(0.42, 0.10 + impact * 0.018) : 0;
      const stun = impact > 6
        ? Math.min(0.38, 0.10 + impact * 0.012 + (1 - stabA) * 0.14) : 0;
      const stunB = impact > 6
        ? Math.min(0.38, 0.10 + impact * 0.012 + (1 - stabB) * 0.14) : 0;

      // 被船撞也是「不知道为什么输」的一大来源：只在真撞（>4.5m/s）时报，
      // 并排贴着磨一路不算 —— 否则整场都在闪图标
      if (hard && localBoat.isLocal) this.#noteImpact('boat');

      localBoat.applyBoatImpact?.(res.dvAx, res.dvAz, res.yawA, {
        roll: boatCollisionRoll(localBoat.def, boat.def, impact, latA),
        stun, shake, cancelDrift: hard,
        gripHold: hard ? 0.20 : 0.12,
      });
      boat.applyBoatImpact?.(res.dvBx, res.dvBz, res.yawB, {
        roll: boatCollisionRoll(boat.def, localBoat.def, impact, latB),
        stun: stunB, shake, cancelDrift: hard,
        gripHold: hard ? 0.20 : 0.12,
      });
    }
  }

  // ---------- AI 控制 ----------
  #aiControl(boat, dt) {
    const id = [...this.boats.entries()].find(([, b]) => b === boat)?.[0];
    const pm = this.progressMap.get(id);
    const skill = this.aiSkill[id] || 0.9;

    // 近道放弃后的冷静期：防止脱困后立刻重新承诺抄近道
    boat.aiScCd = Math.max(0, (boat.aiScCd || 0) - dt);

    // 近道抄失败检测：仅在已承诺抄近道时，若长时间极低速（卡在入口进不去），
    // 放弃近道回主道继续行驶（不额外倒车，避免倒车摆头导致原地乱动）。
    if (this.phase === 'racing' && boat.scCommit && boat.speed < 2.5) {
      boat.aiStuck = (boat.aiStuck || 0) + dt;
      if (boat.aiStuck > 1.0) {
        boat.scCommit = null;
        boat.aiScCd = 4;
        boat.aiStuck = 0;
      }
    } else {
      boat.aiStuck = 0;
    }

    // 通用脱困：AI 顶死墙/卡在浮桶或岩石上时速度会长期为 0，
    // 旧逻辑只会继续推油门（正对墙面推力被吃掉），看起来就是"跑着跑着停住不动"。
    // 现在检测到长时间低速就短促倒车退出来，脱困后再由正常循迹重新对准下一门。
    boat.aiReverse = Math.max(0, (boat.aiReverse || 0) - dt);
    if (this.phase === 'racing') {
      if (boat.speed < 2.0) boat.aiStallT = (boat.aiStallT || 0) + dt;
      else boat.aiStallT = 0;
      if (boat.aiStallT > 1.1 && boat.aiReverse <= 0) {
        boat.aiReverse = 0.9;
        boat.aiStallT = 0;
      }
    }
    if (boat.aiReverse > 0) {
      return { throttle: -0.75, steer: 0, drift: false, nitro: false };
    }

    // 前瞻目标：优先近道路径，否则下一门与再下一门的加权点
    const scTarget = this.track.aiShortcutTarget(pm.gate, boat.pos, boat);
    let lookX, lookZ;
    if (scTarget) {
      lookX = scTarget.x;
      lookZ = scTarget.z;
    } else {
      const g1 = this.track.gatePos(pm.gate);
      const g2 = this.track.gatePos((pm.gate + 1) % this.track.gates.length);
      lookX = g1[0] * 0.7 + g2[0] * 0.3;
      lookZ = g1[1] * 0.7 + g2[1] * 0.3;
    }

    // 回程码头窄口：把目标点整体推到空侧那半幅航道。
    // 光靠下面的"前方障碍规避"不够 —— 那是看到才躲，横移距离不够，
    // 会贴着码头边蹭过去（掉速 + 肉眼可见的撞墙）。
    const lane = this.track.narrowLaneShift?.(
      boat.pos.x, boat.pos.z, Math.sin(boat.heading), Math.cos(boat.heading),
    );
    if (lane) { lookX += lane.x; lookZ += lane.z; }

    let desired = Math.atan2(lookX - boat.pos.x, lookZ - boat.pos.z);
    let dh = desired - boat.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;

    // 前方障碍规避（静态障碍 + 升起中的伸缩柱 + 回程码头窄口）
    // 码头是"横在航道里的 8m 长条"，20m/s 下 10m 探测只有半秒反应时间，
    // 照普通障碍的距离躲会贴着船头才开始打方向 → 单独给 26m 提前量。
    const fx = Math.sin(boat.heading);
    const fz = Math.cos(boat.heading);
    for (const c of [...this.colliders, ...this.track.shoreColliders, ...this.track.mechColliders]) {
      const dx = c.x - boat.pos.x;
      const dz = c.z - boat.pos.z;
      const dist = Math.hypot(dx, dz);
      const lim = c.r + (c.dock ? 26 : 10);
      if (dist < lim) {
        const ahead = (dx * fx + dz * fz) / (dist || 1);
        if (ahead > 0.6) {
          const side = dx * fz - dz * fx;
          // 码头由三个并排圆组成，转向量叠加容易打过方向，力度单独收一档
          dh += (side > 0 ? -1 : 1) * (1 - dist / lim) * (c.dock ? 0.9 : 1.6);
        }
      }
    }

    const steer = THREE.MathUtils.clamp(dh * 2.2, -1, 1);
    const throttle = Math.abs(dh) > 1.2 ? 0.55 : skill;
    // 弯道漂移集气，满格放氮气（道具模式下 nitroAllowed=false 自动失效）
    const drift = Math.abs(dh) > 0.55 && boat.speed > 12;
    const nitro = boat.nitroAllowed && boat.nitroBottles > 0
      && boat.boostTimer <= 0 && Math.abs(dh) < 0.5;
    return { throttle, steer, drift, nitro };
  }

  // ---------- 状态发送 ----------
  #sendState() {
    const b = this.localBoat;
    if (b) {
      this.net.send({
        t: 'state', id: this.myId, auth: this.isHost,
        x: +b.pos.x.toFixed(2), z: +b.pos.z.toFixed(2), y: +b.pos.y.toFixed(2),
        h: +b.heading.toFixed(3), s: +b.speed.toFixed(1),
        b: b.boostTimer > 0,
        vx: +b.vel.x.toFixed(2), vz: +b.vel.y.toFixed(2), r: +b.collisionRoll.toFixed(3),
      });
    }
    if (this.isHost) {
      // 主机只代发自己模拟的 AI 艇。绝不能代发其他真人艇：主机的远程艇
      // 数据是滞后 ~200-400ms 的插值视图，若以 auth 身份代发，会在服务器
      // 上覆盖玩家自己上报的新鲜位置，导致快照目标点前后跳变、所有端看到
      // 该玩家移动缓慢卡顿，且客户端会把自己的船往滞后位置回拖。
      for (const [id, boat] of this.boats) {
        if (id === this.myId || !boat || !this.aiBoats.includes(boat)) continue;
        this.net.send({
          t: 'state', id, auth: true,
          x: +boat.pos.x.toFixed(2), z: +boat.pos.z.toFixed(2), y: +boat.pos.y.toFixed(2),
          h: +boat.heading.toFixed(3), s: +boat.speed.toFixed(1),
          b: boat.boostTimer > 0,
          vx: +boat.vel.x.toFixed(2), vz: +boat.vel.y.toFixed(2), r: +boat.collisionRoll.toFixed(3),
        });
      }
    }
  }

  // ---------- 断线重连后的进度补报 ----------
  // 断线那几秒穿过的门（甚至冲线）根本发不出去，服务端又只认"最多跳 2 门"，
  // 不补报的话这名玩家的服务端进度会永久卡在断线点：之后每个门都被拒，
  // 名次停在断线位置，结算时他还算未完赛。重连后补一条"我现在到哪了"。
  resyncProgress() {
    if (this.solo || this.phase !== 'racing') return;
    const N = this.track.gates.length;
    for (const [id, pm] of this.progressMap) {
      const mine = id === this.myId;
      const boat = this.boats.get(id);
      // 真人各报各的；AI 由主机代报
      if (!mine && !(this.isHost && boat && this.aiBoats.includes(boat))) continue;
      if ((pm.lap || 0) <= 0) continue; // 还没过起点线，没有可补的进度
      const done = mine ? this.finished : pm.finished;
      this.net.send({
        t: 'gate',
        id,
        gate: ((pm.gate - 1) % N + N) % N,
        lap: Math.max(1, pm.lap),
        resync: true,
        totalTime: done ? (mine ? (this.finishTime ?? this.raceTime) : pm.finishTime) : null,
      });
    }
  }

  // ---------- R 键重生 ----------
  // 锚点必须是"自己刚刚穿过的那个门"，不能按空间距离找最近的：
  //  - 开环赛道（秘境漂流）从中间发车，起点的空间最近门可能是终点线，
  //    以前 R 一下就被丢到终点前、朝反方向，再往前开直接"完赛"
  //  - 折返/上下层赛道里空间最近的门常常在另一条支路上，会把玩家
  //    从近道拽回主赛道，还面向逆行方向
  respawnLocal() {
    if (this.bossMode) {
      this.bossMode.respawnLocal();
      return;
    }
    if (!this.localBoat || this.phase !== 'racing' || this.finished) return;
    const pm = this.progressMap.get(this.myId);
    if (!pm) return;
    const N = this.track.gates.length;
    const nextGate = ((pm.gate % N) + N) % N;
    const reset = (x, z, heading, gateForY) => {
      // 失败归因：按 R 脱困也是一种「为什么我慢了」，给个复位图标
      this.#noteImpact('reset');
      // keepNitro：R 只是脱困，不该没收攒好的氮气条与氮气瓶
      this.localBoat.resetTo(x, z, heading, { keepNitro: true });
      // 高度优先问赛道本身（复位点可能落在两个门之间，用某一扇门的高度会串层），
      // 问不到再退回 gateY（烘焙赛道的立交桥/瀑布段全靠它）
      const sy = this.track.surfaceYAt?.(x, z, gateForY);
      this.localBoat.pos.y = Number.isFinite(sy)
        ? sy
        : (this.track.gateY?.[gateForY] ?? this.localBoat.pos.y);
    };

    // 还没过任何门（正在发车格上）：回到自己的发车位。
    // 这里不能用"上一门"：开环赛道的头几个门在发车点身后，
    // 复位会把人丢到倒车位置、朝向也反了（秘境漂流开局按 R 的 bug）。
    const spawn = this.mySpawn;
    if (spawn && nextGate === spawn.gate && Math.max(0, pm.lap) === spawn.lap) {
      reset(spawn.x, spawn.z, spawn.heading, nextGate);
      return;
    }

    // 按地点复位：沿**主道或近道自己的中线**往回退 35m。
    // 旧逻辑是"回到最后一个已穿过的门"，门间距 50~90m，一次 R 等于白送半条直道；
    // 现在退的是固定距离，近道里就沿近道退，不会被拽回主道。
    // pm.gate 不推进 —— 复位既不吞门，也不把圈数/名次往前送。
    const anchor = (nextGate - 1 + N) % N;
    const rp = this.track.respawnPoint?.(this.localBoat.pos, nextGate, 35);
    if (rp) {
      reset(rp.x, rp.z, rp.heading, anchor);
      return;
    }

    // 兜底（老赛道没有 respawnPoint 时）：回到最后一个已穿过的门
    const g = this.track.gatePos(anchor);
    const next = this.track.gatePos(nextGate);
    const dx = next[0] - g[0];
    const dz = next[1] - g[1];
    const len = Math.hypot(dx, dz) || 1;
    reset(g[0] - (dx / len) * 2, g[1] - (dz / len) * 2, Math.atan2(dx, dz), anchor);
  }

  // ---------- HUD ----------
  // finished 优先按完赛时间，其余按赛道进度从高到低
  #sortedProgress() {
    const entries = [...this.progressMap.entries()];
    entries.sort((a, b) => {
      const A = a[1], B = b[1];
      if (A.finished && B.finished) return (A.finishTime ?? 1e9) - (B.finishTime ?? 1e9);
      if (A.finished) return -1;
      if (B.finished) return 1;
      return B.prog - A.prog;
    });
    return entries;
  }

  #rankOf(targetId) {
    return this.#sortedProgress().findIndex(([id]) => id === targetId) + 1;
  }

  #myRank() {
    return this.#rankOf(this.myId);
  }

  /**
   * 本地艇当前生效的状态（负面 + 增益），给 HUD 的状态条用。
   * 以前只有墨汁和护盾有 HUD 反馈，被减速艇/鱼雷/章鱼打中时只能看头顶小图标，
   * 玩家经常“被打中了但不知道被打中什么、还有多久”。
   */
  #debuffChips() {
    const b = this.localBoat;
    if (!b) return [];
    const out = [];
    const push = (icon, label, left, buff = false) => {
      if (left > 0.05) out.push({ icon, label, t: left, buff });
    };
    push('💣', '沉没', b.sinkTimer);
    push('🌀', '打转', b.spinTimer);
    push('🐙', '缠身', b.octoGrabTimer);
    push('🐠', '翻船', b.capsizeTimer);
    push('🌑', '墨汁', this.items ? this.items.inkTimer : 0);
    push('😈', '反向', b.reverseControlTimer);
    push('🫧', '异世界', b.voidTimer);
    push('🐢', '半速', b.halfSpeedTimer);
    push('💥', '减速', b.slowTimer);
    push('🫧', '泡泡', b.bubbleLiftTimer);
    push('🛡️', '无敌', b.shieldTimer, true);
    // 同一帧最多显示 3 条，避免叠成一堵墙挡住左侧赛道
    return out.slice(0, 3);
  }

  #hudData() {
    const pm = this.progressMap.get(this.myId);
    // 进度条 = 「已完成圈数 + 本圈弧长比例」÷ 本局圈数。
    // ⚠ 分母必须是本局圈数 `this.laps`（开局消息下发），**不能**用 `track.laps`
    // （地图作者默认值）：单人设置里能把霓虹海峡从 1 圈改成 3 圈跑，
    // 旧版分母还是 1 圈，跑完第一圈就 100%（用户实测反馈）。
    const raceLaps = Math.max(1, Math.round(this.laps || this.finishLaps || 1));
    // 竞技场/BOSS 场地不是 Track（没有弧长表），进度条在那些模式里由血量接管，
    // 这里给 0 就够，绝不能因为少一个方法每帧抛异常（等于整屏黑）。
    const progress = !this.track.progressRatio
      ? 0
      : (pm?.finished ? 1 : this.track.progressRatio(pm?.lap || 1, this.localBoat.pos, raceLaps, pm?.lapArc));
    // 左侧名次板：全部玩家的名次、名称、头像，顺序变化时每帧重排
    const myTeam = this.entryById.get(this.myId)?.team || '';
    const standings = this.#sortedProgress().map(([id], i) => {
      const e = this.entryById.get(id) || this.order?.find((x) => x.id === id);
      // 名次栏道具图标：只给自己 + 同队看。对手手里的道具是隐藏信息，
      // 全亮出来等于开透视（竞速网游通行做法）。个人赛只有自己这一行有图标。
      const canSeeItems = this.mode === 'item' && this.items && (
        id === this.myId || (this.format === 'team' && !!e?.team && e.team === myTeam)
      );
      return {
        id,
        rank: i + 1,
        name: e?.name || '玩家',
        avatar: e?.avatar || '',
        ai: !!e?.ai,
        isMe: id === this.myId,
        isHost: id === this.hostId,
        // 组队赛制下给排名板画队伍色圆点；个人赛制为 undefined，UI 不渲染
        team: this.format === 'team' ? (e?.team || '') : '',
        items: canSeeItems ? this.items.getHeldItems(id) : [],
      };
    });
    // 名次下发到船本体：角色船（牛来号）靠 isLeader 触发笑脸，
    // 冲线后仍排在第一名时自动切到跳舞动作。
    for (const s of standings) {
      const b = this.boats.get(s.id);
      if (!b) continue;
      b.isLeader = s.rank === 1;
      b.finished = !!this.progressMap.get(s.id)?.finished;
    }
    // 小地图数据：所有艇位置 + 下一门
    const minimap = {
      gates: this.track.gates,
      gateWidth: this.track.gateWidth,
      nextGate: pm.gate,
      boats: [...this.boats.entries()].map(([id, b]) => ({
        x: b.pos.x, z: b.pos.z, heading: b.heading,
        color: '#' + b.def.color.toString(16).padStart(6, '0'),
        isMe: id === this.myId,
        finished: this.progressMap.get(id)?.finished ?? false,
      })),
    };
    return {
      phase: this.phase,
      countdown: Math.ceil(this.countdownLeft - 1),
      speed: Math.round(this.localBoat.speed * 3.6),
      // 仪表盘量程：至少要盖住氮气极速上限 240km/h，否则指针会一直顶格
      maxSpeed: Math.round(Math.max(this.localBoat.def.maxSpeed * 3.6 * 1.15, NITRO_TOP_KMH)),
      myName: this.myEntry?.name || '玩家',
      lap: Math.min(this.laps, Math.max(1, pm.lap || 1)),
      laps: this.laps,
      rank: standings.find((s) => s.isMe)?.rank || 1,
      standings,
      // 组队信息：HUD 排名板画队伍色圆点、结算展示队名
      format: this.format,
      myTeam,
      teamNames: this.teamNames,
      totalPlayers: this.progressMap.size,
      raceTime: this.raceTime,
      progress,
      boostState: this.localBoat.boostState,
      // 道具模式原来直接传 null → 右下氮气槽整条不显示（用户反馈"道具赛看不到氮气条"）。
      // 这里仍然**不改平衡**（nitroAllowed=false，不能漂移集气、不能 Ctrl 放），
      // 只把「氮气道具生效中」的剩余时间喂进这条槽，让它变成"加速剩余量"而不是死 UI。
      nitroCharge: this.localBoat.nitroAllowed
        ? this.localBoat.nitroCharge
        : (this.mode === 'item'
          ? Math.min(1, Math.max(0, this.localBoat.boostTimer / 4.2))
          : null),
      nitroBottles: this.localBoat.nitroAllowed ? this.localBoat.nitroBottles : 0,
      // 道具模式：槽是"只读状态条"，右侧那两格可存的氮气瓶要收起来（拿了也没处用）
      nitroLocked: !this.localBoat.nitroAllowed && this.mode === 'item',
      weather: this.weather,
      minimap,
      mode: this.mode,
      // 挑战模式标记：mode 已被归一化成 'race'（见构造函数），HUD / 探针靠这个
      // 布尔值区分「跟影子跑」和「跟 AI 跑」，别再用 mode === 'challenge' 去判断。
      challenge: !!this.challenge,
      // 3 格道具栏（Q/W/E）：null 表示空槽
      items: this.items ? this.items.myItems.map((it) => (it ? ITEM_DEFS[it] : null)) : null,
      magnetAim: this.items?.magnetAim ? {
        active: true,
        locked: !!this.items.magnetAim.target,
        timer: this.items.magnetAim.timer,
      } : null,
      ink: this.items ? Math.max(0, this.items.inkTimer) : 0,
      shield: this.localBoat.shieldTimer > 0 ? this.localBoat.shieldTimer : 0,
      flash: this.items ? this.items.screenFlash : 0,
      debuffs: this.#debuffChips(),
      wrongWay: this.wrongWayShown,
      // 幽灵车：delta > 0 = 我落后（红），< 0 = 我领先（金）
      ghost: this.ghostBoat ? {
        delta: this.ghostDelta,
        visible: this.ghostVisible,
        bestLap: this.ghostRecord?.lapTime ?? null,
        fresh: this.ghostSavedFlash > 0,
      } : null,
      // 中央提示条：撞墙归因 / 完美起步等系统提示 / 每圈评价共用同一个槽
      // （抢占与排队见 #notice；这里只把当前生效的那一条吐给 UI）
      notice: this.notice && this.noticeTtl > 0
        ? {
          main: this.notice.main,
          sub: this.notice.sub,
          tone: this.notice.tone,
          ttl: this.noticeTtl,
        }
        : null,
    };
  }

  /**
   * 主题地图的天气改写：熔岩夜航按玩家所选天气派生一套各自的火山调色。
   *
   * 关键点：**id 必须保留玩家选的那个**。RealSky 的 SKY_PRESETS、NightSky 星空、
   * 昼夜循环开关、水面泡沫分档、后处理调色档全都只认 id；旧版把 id 写死成
   * 'starry'，结果切黄昏/暴风雨/暴雪时天空一点不变（用户反馈"区别不开"）。
   * 熔岩自己的颜色/光照/雾/云放在 mapDef.lava.weatherBy[id] 里，只覆盖这些键，
   * `sky` 子对象交给 RealSky 继续微调大气参数。
   * 只覆盖本次下发的 weather，WEATHERS 全局表不动。
   * 构造和"玩家切天气"两条路径都要过这里 —— 只改 #applyWeather 的话开局仍是白天。
   */
  #themeWeather(base) {
    const lava = this.mapDef.lava;
    if (!lava) return base;
    const palette = lava.weatherBy?.[base.id] ?? lava.weather ?? {};
    const merged = { ...base, ...palette, id: base.id };
    // sky 里的天顶色/地平线色同步到 skyTop/skyBottom：
    // Water 的反射底色和远处的雾色都读这两个键，只有 RealSky 认得 w.sky
    if (palette.sky?.top !== undefined) merged.skyTop = palette.sky.top;
    if (palette.sky?.horizonColor !== undefined) merged.skyBottom = palette.sky.horizonColor;
    return merged;
  }

  /**
   * 烘水面倒影时要临时隐藏的物体。目前只有星空图层：
   * `NightSky.group` 里是三层星星（8150 点）+ 银河星带 + 星云 + 星尘 + 流星，
   * 它们在全屏下是一颗颗亮点，但 128² 的 cubemap 一次看整个半球 —— 每颗星占不到
   * 一个像素，几千颗叠起来在罐里平均成一片中性白（实测 ~1.9，三通道相等）。
   * 水面按菲涅尔吃这个白，夜里就变成"比天还亮的白板"，赛道和浮标全部糊掉。
   * 摘掉之后罐里只剩深蓝夜空与山影，反射才读得出"夜里的水"。
   * 水面星点反光（glintsRoot）不在 group 里，仍留在世界中，不受影响。
   */
  #envExclude() {
    const ns = this.env?.nightSky;
    return ns?.group ? [ns.group] : null;
  }

  /**
   * 进"道具倒影"的物体清单（P1）：所有艇 + 海上浮标 + 边缘浮桶线。
   * 为什么只挑这几类：它们是贴着水面、玩家在追尾机位里一直盯着的物体，
   * 水面上有没有它们自己的倒影，直接决定"浮在水里"还是"贴在水面上"。
   * 地形/树/赛门不进 —— 那等于把整场景再渲一遍，帧率不允许（见 PropReflection）。
   */
  #reflectProps() {
    const out = [];
    for (const b of this.boats?.values() ?? []) {
      if (b?.group) out.push(b.group);
    }
    for (const b of this.track?.marine?.buoys ?? []) {
      if (b?.fallback) out.push(b.fallback);
    }
    // 边缘浮桶整条线是 3 个 InstancedMesh（几公里几百个桶只占几次 draw call），
    // 倒影里也必须整条给上，否则岸边会出现"浮桶有倒影、中间那排没有"的断层
    const edge = this.track?.edgeBuoys?.body;
    if (edge) out.push(edge);
    return out;
  }

  /**
   * 云端天梯：每层天气（2026-11-24）。
   *
   * 用户要求"天气干脆复用现有的天气模式"，所以这里不新建任何天气系统，
   * 只是把天梯的层号翻成 WEATHERS 里的一条预设，然后调用**比赛模式同款**的三条链路：
   *   env.setWeather   → 雨/雪粒子、星空顶、雾色、光照（天梯的塔光由 scenery 自己管）
   *   water.setWeather → 海面水色/高光/浪花配色
   *   setWaveScale     → 海面浪高（暴风雨那层真的是涌浪）
   * 顺序有讲究：env 会改 scene.fog，天梯的天空球是 1400m 自写的体积云，
   * 雾一浓就被染成一块平色 —— 所以每次都把 fog 密度压回近 0。
   */
  #applyTowerWeather(w) {
    if (!w) return;
    // 同一套天气不重复套（第一层通常就是大厅选的天气，开局已经套过一次）
    if (this._towerWeatherId === w.id) return;
    this._towerWeatherId = w.id;
    this.weather = w;
    this.env.setWeather(w);
    if (this.scene.fog) this.scene.fog.density = 0.000001;
    // 星星：NightSky 挂在 scene 上、半径远小于 1400m 的天空球，会被整片盖住；
    // 天梯的星场由 SkyTowerScenery 的天空着色器自己画，这里把旧的那套关掉避免双重星
    this.env.nightSky?.setVisible(false);
    this.water.setWeather(w);
    setWaveScale(w.waveScale ?? 1.0);
    this.post?.setWeather?.(w);
  }

  // 关卡切换：怪物模式换主题场景，其它模式换天气预设
  #applyWeather(id, stage) {
    if (this.isBoss && this.themes) {
      const level = stage || this.bossMode?.stage || 1;
      this.themes.setTheme(level);
      const theme = getBossTheme(level);
      // 海克斯：天气与场景主题各自随机。主题自带天气只在同 id 时保留，
      // 不同时用随机天气覆盖天空/雾/光照/水色/浪高，布景仍是主题那一套。
      if (id && id !== theme.weather.id) {
        const weather = getWeather(id);
        this.weather = weather;
        this.env.setWeather(weather);
        this.env.refreshBossSky?.(weather);
        this.water.setWeather(weather);
        setWaveScale(weather.waveScale ?? 1);
        // 后处理调色也跟天气走（低画质 post 为 null，安全跳过）
        this.post?.setWeather?.(weather);
        this.#setWakeColors(weather.waterColor ?? theme.weather.waterColor);
      } else {
        this.#setWakeColors(theme.weather.waterColor);
      }
      return;
    }
    const weather = this.#themeWeather(getWeather(id));
    this.weather = weather;
    this.env.setWeather(weather);
    // 赛道边的浮桶跟着天气换配色（晴朗白+海蓝 / 黄昏暖橙 / 暴风雨深灰 / 暴风雪冰蓝）
    this.track?.setBuoyPalette?.(weather.id);
    this.water.setWeather(weather);
    setWaveScale(weather.waveScale ?? 1.0);
    this.post?.setWeather?.(weather);
    this.#setWakeColors(weather.waterColor ?? this.mapDef.waterColor);
    // 天空换了，倒影也得跟着换：否则切到黄昏后水面映的还是白天的蓝天
    this.water.bakeEnvironment(
      this.renderer, this.scene, this.camera.position, this.env.sky, this.#envExclude(),
    );
    // 切到黄昏/暴风雨/暴雪/星空时撤销赛事档，切回晴朗白天再自动打开
    this.#applyStadium();
  }

  /**
   * 湖泊环线「赛事化」视觉层的唯一开关点。
   * 只控制岸边道具（看台/广告板/立牌…）的可见性，**不改水色、不接后处理调色**。
   * 其它地图 lakeStadium 为 null，这里直接返回，渲染路径与改动前完全一致。
   */
  #applyStadium() {
    if (!this.lakeStadium) return;
    this.lakeStadium.setEnabled(isLakeStadiumEnabled(this.mapDef, this.weather));
  }

  /**
   * 浪花配色：白泡沫为主，掺一点当前海域的水色，
   * 免得在红海/冰海里拖出一条与场景无关的纯白带。
   */
  #setWakeColors(baseColor) {
    const water = new THREE.Color(baseColor ?? 0x2f9fc5);
    const foam = new THREE.Color(0xf2fbff);
    const ripple = water.clone().lerp(foam, 0.74);   // 外层半透明水带
    const crest = water.clone().lerp(foam, 0.90);    // 内层实心白泡沫
    for (const b of this.boats.values()) {
      b.wakeColor.ripple.copy(ripple);
      b.wakeColor.crest.copy(crest);
    }
  }

  /**
   * 订阅设置变更：画质 / 渲染分辨率 / 视场角 / 抖动都在这里落地。
   * 面板是"改了立刻生效"的，所以不能等到下一局才重建 —— 玩家会以为没生效。
   */
  #bindSettings() {
    this._onSettings = (e) => {
      const k = e.detail?.key;
      if (k !== '*') {
        if (k === 'quality') {
          // 玩家自己动过画质 → 本局不再让看门狗背着人降档
          this.qualityLockedByUser = true;
          this.#applyQuality(settings.get('quality'), { persist: false });
        } else if (k === 'renderScale') this.post.setPixelScale(settings.get('renderScale'));
        else if (k === 'fov') this.cameraRig.fovBase = Number(settings.get('fov')) || 62;
        else if (k === 'shake' && this.bossMode) this.bossMode.shakeScale = this.shakeScale;
        return;
      }
      // 恢复默认：全部重来一遍
      this.#applyQuality(settings.get('quality'), { persist: false });
      this.post.setPixelScale(settings.get('renderScale'));
      this.cameraRig.fovBase = Number(settings.get('fov')) || 62;
      if (this.bossMode) this.bossMode.shakeScale = this.shakeScale;
    };
    settings.addEventListener('change', this._onSettings);
    this._offSettings = () => settings.removeEventListener('change', this._onSettings);
  }

  /** 震屏强度（0 = 完全不抖，晕 3D 的玩家用） */
  get shakeScale() {
    return Math.max(0, Math.min(1, Number(settings.get('shake')) || 0));
  }

  #applyQuality(level, { persist = true, announce = true } = {}) {
    if (!QUALITY_LABEL[level] || level === this.quality) return;
    this.quality = level;
    this.post.setQuality(level);
    this.water?.setQuality(level);
    this.env?.setQuality?.(level);
    for (const b of this.boats?.values() ?? []) b.detail = level !== 'low';
    if (persist) settings.set('quality', level);
    if (announce) this.opts.onToast?.(`🖼 画质：${QUALITY_LABEL[level]}`);
  }

  /**
   * 性能看门狗：只在“持续”低帧率时降一档画质，最多两次。
   * 早先的动态分辨率会每 1.6s 改一次缓冲尺寸，在 Windows 上会闪黑；
   * 这里改成一次性降档：启动/冲线时的短暂卡顿不算（要连续 12s 低于 30fps）。
   */
  #watchPerf(frameMs) {
    // 设置里关掉「自动降画质」就彻底不动画质档（有些玩家宁愿卡也不愿糊）
    if (!settings.get('autoQuality')) return;
    if (this.contextLost || this.qualityLockedByUser || this.autoQualitySteps >= 2) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (!(frameMs > 1 && frameMs < 250)) return; // 切标签页/断点造成的超长帧忽略
    const w = this._perf || (this._perf = { sum: 0, n: 0, since: performance.now(), bad: 0 });
    w.sum += frameMs;
    w.n++;
    const now = performance.now();
    if (now - w.since < 4000) return;
    const avg = w.n ? w.sum / w.n : 16.7;
    w.sum = 0;
    w.n = 0;
    w.since = now;
    if (avg > 33) w.bad++;
    else w.bad = 0;
    if (w.bad < 3) return; // 连续 12s 低于 30fps 才降档
    w.bad = 0;
    if (this.quality === 'low') return;
    const next = this.quality === 'high' ? 'medium' : 'low';
    this.autoQualitySteps++;
    this.#applyQuality(next, { persist: false, announce: false });
    this.opts.onToast?.(`⚙️ 显卡有些吃力，画质已自动降到${QUALITY_LABEL[next]}`);
  }

  #onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.post?.setSize(window.innerWidth, window.innerHeight);
  };

  /** 海克斯三选一：UI 点击后转给 BossMode（本局核心 / 通关卡共用） */
  hexPickAction(act) {
    this.bossMode?.hexPickAction?.(act);
  }

  pickHexPick(id) {
    this.bossMode?.pickHexPick?.(id);
  }

  /** 海克斯无尽：第 4 层通关后的「继续挑战 / 结束领奖」 */
  chooseEndless(cont) {
    this.bossMode?.chooseEndless?.(cont);
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    // 后台补帧定时器与 visibility 监听必须一起摘掉：换局/回大厅后旧 Game
    // 若还在后台补帧，会继续推进旧场景并发 state，把新一局的快照写乱。
    this.#stopHiddenTicker();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    // 开场镜头中途退出（回大厅/换模式）：一定要摘掉 intro-on，
    // 否则常驻 HUD / 聊天 / 按钮会一直停在 opacity:0，整个界面像卡死。
    this.raceIntro = null;
    document.body?.classList?.remove('intro-on');
    window.removeEventListener('resize', this.#onResize);
    this.renderer.domElement.removeEventListener('webglcontextlost', this._onContextLost, false);
    this.renderer.domElement.removeEventListener('webglcontextrestored', this._onContextRestored, false);
    this.offGate?.();
    this.offSnap?.();
    this.offRoute?.();
    this.offFinishEvt?.();
    this._offSettings?.();
    for (const off of this.offItems || []) off();
    for (const off of this.offBoss || []) off();
    this.bossMode?.dispose();
    if (this.opts.input) {
      this.opts.input.onItem = null;
      this.opts.input.itemMode = false;
    }
    this.items?.dispose();
    this.post?.dispose();
    this.fx?.dispose();
    this.nitroSparkles?.dispose();
    this.nitroSparkles = null;
    this.nitroJetStream?.dispose();
    this.nitroJetStream = null;
    if (this.podiumGroup) {
      this.scene.remove(this.podiumGroup);
      this.podiumGroup = null;
    }
    for (const boat of this.boats.values()) boat.dispose();
    this.ghostBoat?.dispose();
    this.ghostBoat = null;
    this.themes?.dispose();
    this.track?.dispose();
    this.lakeStadium?.dispose?.();
    this.arenaStadium?.dispose?.();
    this.guideSigns?.dispose?.();
    this.env?.dispose();
    // 水面终于有了要显式释放的 GPU 资源（环境反射的 cubemap）
    this.water?.dispose?.();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
