// Effekseer 特效封装：.efkefc 粒子特效（护盾/氮气/漩涡/爆炸等）
// 依赖 public/effekseer/effekseer.min.js + effekseer.wasm（1.70e）
// 特效资源在 public/effects/（含外置纹理，须保持相对目录结构）

// 特效清单：name → { url, scale }
// scale：加载缩放（特效原尺寸按几十米的场景制作，需缩小适配赛艇）
export const FX_DEFS = {
  nitro:     { url: '/effects/Version16/Aura01.efkefc', scale: 0.25 },                  // 氮气光晕（船尾）
  jet:       { url: '/effects/Basic/Laser01.efkefc', scale: 0.18 },                     // 氮气喷射（船尾定向光束）
  shield:    { url: '/effects/Version16/Barrior01.efkefc', scale: 0.4 },                // 护盾包围圈
  tornado:   { url: '/effects/Version16/ForceFieldTornado.efkefc', scale: 0.4 },        // 漩涡
  explosion: { url: '/effects/Basic/Simple_Turbulence_Fireworks.efkefc', scale: 0.5 },  // 爆炸（炸弹/闪电）
  ring:      { url: '/effects/Basic/Simple_Ring_Shape1.efkefc', scale: 0.5 },           // 冲击环（拾取/命中）
  hit:       { url: '/effects/Basic/Simple_Ring_Shape2.efkefc', scale: 0.5 },           // 导弹命中
};

function effectScaleValue(scale) {
  const value = typeof scale === 'function' ? scale() : scale;
  if (Number.isFinite(value)) return { x: value, y: value, z: value };
  return {
    x: Number.isFinite(value?.x) ? value.x : 1,
    y: Number.isFinite(value?.y) ? value.y : 1,
    z: Number.isFinite(value?.z) ? value.z : 1,
  };
}

// setAllColor 是 Effekseer 实例级染色（对粒子颜色做乘法），用来把同一段素材
// 染成各船的主题色；不传 color 就保持素材原色。
function effectColorValue(color) {
  const value = typeof color === 'function' ? color() : color;
  if (!Number.isFinite(value)) return null;
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
    a: 255,
  };
}

// Keep one authoritative effect per gameplay event. These assets are from the
// bundled Effekseer Sample set and are intentionally reused instead of stacking
// a second shell around the same hit/target.
Object.assign(FX_DEFS, {
  tornado:  { url: '/effects/Version16/ForceFieldTornado.efkefc', scale: 0.4 },
  explosion:{ url: '/effects/Basic/Simple_Turbulence_Fireworks.efkefc', scale: 0.5 },
  ring:     { url: '/effects/Basic/Simple_Ring_Shape1.efkefc', scale: 0.5 },
  hit:      { url: '/effects/Basic/Simple_Ring_Shape2.efkefc', scale: 0.5 },
  itemBeam: { url: '/effects/Basic/Laser02.efkefc', scale: 0.22 },
  missile:  { url: '/effects/Basic/Laser03.efkefc', scale: 0.2 },
  magnet:   { url: '/effects/Version16/Barrior02.efkefc', scale: 0.28 },
  ink:      { url: '/effects/Basic/Simple_Distortion.efkefc', scale: 0.3 },
  mine:     { url: '/effects/Basic/Simple_Ring_Shape2.efkefc', scale: 0.35 },
  decoy:    { url: '/effects/Basic/Simple_Turbulence_Particles.efkefc', scale: 0.28 },
  tide:     { url: '/effects/Basic/Simple_Track1.efkefc', scale: 0.3 },
  bubble:   { url: '/effects/Version16/Aura01.efkefc', scale: 0.18 },
  bubblePop:{ url: '/effects/Basic/Simple_Ring_Shape1.efkefc', scale: 1.6 },
  antimagn: { url: '/effects/Version16/Barrior03.efkefc', scale: 0.38 },
});

// 舰炮专用特效：从 Effekseer Sample 的 02_Tktk03 / 03_Hanmado01 复制进来
// （含 Parts / Material / Texture 等外置资源，目录结构必须保持原样）
Object.assign(FX_DEFS, {
  muzzleLight: { url: '/effects/Tktk/Light.efkefc', scale: 0.12 },                       // 炮口闪光
  toonHit:     { url: '/effects/Tktk/ToonHit.efkefc', scale: 0.2 },                       // 轻武器命中
  toonWater:   { url: '/effects/Tktk/ToonWater.efkefc', scale: 0.22 },                    // 水刃/鱼雷溅起水柱
  hanmadoHit:  { url: '/effects/Hanmado/Effect/hit_hanmado_0409.efkefc', scale: 0.26 },   // 重炮命中爆点
  // 道具飞行体专用：丝带尾（细长、跟手）、剑轨（斩击感）、果冻（水泡/黏胶）
  ribbonTail:  { url: '/effects/Basic/Simple_Ribbon_Parent.efkefc', scale: 0.3 },
  slashRibbon: { url: '/effects/Basic/Simple_Ribbon_Sword.efkefc', scale: 0.26 },
  pudding:     { url: '/effects/Version16/ProceduralPudding.efkefc', scale: 0.3 },
  spawnRing:   { url: '/effects/Basic/Simple_SpawnMethod1.efkefc', scale: 0.24 },
});

// 官方 CC0 素材包（effekseer/EffectMaterials，1.7 格式）。
// 这些都是"成块"的完整演出，比程序化粒子厚，专门给 BOSS 技能用；
// 实际播放倍率由技能数据里的 fxScale / hitFxScale 决定（Boss.js 传入会覆盖这里的 scale）。
Object.assign(FX_DEFS, {
  fxFireBurst: { url: '/effects/EffectMaterials/ef_fire01.efkefc', scale: 0.5 },      // 爆燃火球
  fxFireBand:  { url: '/effects/EffectMaterials/ef_fire03.efkefc', scale: 0.5 },      // 横向火带（最厚）
  fxIceBloom:  { url: '/effects/EffectMaterials/ef_ice01.efkefc', scale: 0.5 },       // 冰花绽开
  fxIceMist:   { url: '/effects/EffectMaterials/ef_ice02.efkefc', scale: 0.5 },       // 冰雾膨胀
  fxIceShards: { url: '/effects/EffectMaterials/ef_ice03.efkefc', scale: 0.5 },       // 冰晶下坠
  fxArcBolt:   { url: '/effects/EffectMaterials/ef_lightning02.efkefc', scale: 0.5 }, // 竖向电流束
  fxBoltStorm: { url: '/effects/EffectMaterials/ef_lightning03.efkefc', scale: 0.5 }, // 多束光柱 + 连锁
  fxClawSlash: { url: '/effects/EffectMaterials/ef_parts_hit02.efkefc', scale: 0.5 }, // 青色爪痕
  fxUpdraft:   { url: '/effects/EffectMaterials/ef_wind02.efkefc', scale: 0.5 },      // 上升气流柱
  fxBigVortex: { url: '/effects/EffectMaterials/ef_wind03.efkefc', scale: 0.5 },      // 龙卷 + 地裂
});

// fx-projects 素材（Effekseer 1.7.3 无头 CLI 导出）。
// 每个目录同时有 <名>.efkefc 和 fxres.json（哈希文件名 → 实际文件名），
// 运行时必须走 loadEffect 的第 5 个参数 redirect 改写资源路径，
// 否则带哈希名的贴图 / .efkmodel 模型会 404（整条特效加载失败）。
const FX_PACK = (name, scale) => ({
  url: `/effects/${name}/${name}.efkefc`,
  scale,
  fxres: `/effects/${name}/fxres.json`,
});

Object.assign(FX_DEFS, {
  // 火焰
  fxFireBall:      FX_PACK('P2_FireBall', 0.35),        // 火球爆燃（龙口 / 命中点）
  fxMeteor:        FX_PACK('N_MagicMeteor', 0.4),       // 竖向火柱 / 火流星（俯冲、熔岩柱）
  // 雷 / 剑
  fxSpear1:        FX_PACK('T2_Spear1', 0.4),           // 橙红放射能量核心（尾扫 + 第二关核心）
  fxSwordLightning:FX_PACK('P2_SwordLightning', 0.4),   // 蓝紫雷斩（第三关横扫）
  fxMagicThunder:  FX_PACK('N_MagicThunder', 0.45),     // 笔直闪电柱 + 蓝白光爆（纯贴图，流光号尾焰用）
  fxSwordMoonlight:FX_PACK('P2_SwordMoonlight', 0.4),   // 巨型月牙刀光（第三关扇形劈砍）
  fxLightningStrike:FX_PACK('P1_LightningStrike', 0.5), // 天雷落地 + 电弧 + 烟尘（第三关落雷）
  fxSword1:        FX_PACK('T2_Sword1', 0.4),           // 青蓝剑气（第三关冲锋路径）
  // 终结 / 拾取
  fxBossDeath:     FX_PACK('A_BossDeath', 0.5),         // 白色大爆裂 + 碎片（BOSS 死亡）
  fxBenediction:   FX_PACK('P2_Benediction', 0.45),     // 金色圣光球（火力核心拾取）
  // 血 / 暗
  fxMagicDark:     FX_PACK('N_MagicDark', 0.35),        // 血色触手（章鱼）
  fxDark2:         FX_PACK('T2_Dark2', 0.35),           // 紫色暗影爆刺（方向转换器）
  // 地阵 / 环形
  fxMagic2Holy:    FX_PACK('M_Magic2Holy', 0.45),       // 符文六角阵（安全圈 / 异世界门）
  fxMagicCircle:   FX_PACK('A_MagicCircle', 0.5),       // 五芒星阵（泡泡蜻蜓）
  fxMagic1Water:   FX_PACK('M_Magic1Water', 0.5),       // 蓝色水环（扩散浪 / 减速）
  fxThunderRing:   FX_PACK('M_Thunder2', 0.45),         // 暗红警戒环（水雷）
  // 其它
  fxCosmicMist:    FX_PACK('P2_CosmicMist', 0.4),       // 青蓝光球（泡泡陷阱）
  fxMonsterRoar:   FX_PACK('P1_MonsterRoar', 0.35),     // 黑色咆哮冲击（墨鱼爆墨）
  // 前两关火龙新增：振翼冲击 / 龙鳞骤雨 / 火焰法阵 / 余烬刀光
  fxSonicBoom:     FX_PACK('P1_SonicBoom', 0.45),       // 白色声爆冲击环（裂空翼击）
  fxScaleRain:     FX_PACK('P1_PhantasmMeteor', 0.45),  // 陨石雨（龙鳞骤雨的整片演出）
  fxFireRune:      FX_PACK('M_Magic1Fire', 0.5),        // 橙色火焰法阵（落点预警 + 烧穿）
  fxEmberSlash:    FX_PACK('P2_SwordEmber', 0.4),       // 余烬刀光（尾扫）
  fxClaw4:         FX_PACK('T2_Claw4', 0.4),            // 四道爪痕（俯冲 / 翼击命中）
  fxWaterImpact:   FX_PACK('M_WaterImpact', 0.5),       // 落水水花（俯冲入海）
});

// 第五头 BOSS「深渊传令官」专用：全部是怪物模式此前没用过的 Effekseer。
// P2_SwordSacred / P1_Herald 是仓库里一直没接进游戏的完整包；
// ef_holy01 / ef_lightning01 / ef_parts_hit01 是 EffectMaterials 里最后三段未注册素材。
Object.assign(FX_DEFS, {
  fxSwordSacred: FX_PACK('P2_SwordSacred', 0.5),                                     // 天罚圣剑（半血大招）
  fxHerald:      FX_PACK('P1_Herald', 0.5),                                          // 传令官圣光（咆哮 / 召唤）
  fxHoly1:       { url: '/effects/EffectMaterials/ef_holy01.efkefc', scale: 0.5 },   // 圣光爆发
  fxBolt1:       { url: '/effects/EffectMaterials/ef_lightning01.efkefc', scale: 0.5 }, // 单束闪电
  fxPartsHit1:   { url: '/effects/EffectMaterials/ef_parts_hit01.efkefc', scale: 0.5 }, // 爪击命中
});

// 第一关新增「熔岩追猎」的锁定光柱。
// T2_Light3 是唯一一段"线状光束 + 热浪扭曲"的未使用素材，天生适合
// "从天往下灌一束光、红圈跟着船走"的读法；其余未使用素材（N_MagicThunder /
// P2_SwordSacred / P1_Herald）要么偏雷、要么是实体剑，和火龙的锁定光柱对不上。
Object.assign(FX_DEFS, {
  fxTrackBeam: FX_PACK('T2_Light3', 0.4),
});

// 官方 EffectMaterials 里的另外两段常用火焰 / 风（与上面同目录）
Object.assign(FX_DEFS, {
  fxFire2: { url: '/effects/EffectMaterials/ef_fire02.efkefc', scale: 0.5 },  // 中段火球，喷火补一层
  fxWind1: { url: '/effects/EffectMaterials/ef_wind01.efkefc', scale: 0.5 },  // 横向风刃，振翼补一层
});

// 小怪技能：同一批官方素材按小怪体量（1.5~4m）重新定标。
// 不能沿用上面 BOSS 那套 0.5 倍率——那是按 6~10m 的 BOSS 调的，
// 放到企鹅（1.4m）身上会糊满半个屏幕。
Object.assign(FX_DEFS, {
  minionIceFly:  { url: '/effects/EffectMaterials/ef_ice03.efkefc', scale: 0.16 },      // 冰锥飞行（冰晶拖尾）
  minionIceHit:  { url: '/effects/EffectMaterials/ef_ice01.efkefc', scale: 0.22 },      // 冰锥命中（冰花）
  minionClaw:    { url: '/effects/EffectMaterials/ef_parts_hit02.efkefc', scale: 0.3 }, // 蟹钳爪痕
  minionBoltFly: { url: '/effects/EffectMaterials/ef_lightning02.efkefc', scale: 0.14 },// 放电弹体（电流束）
  minionBoltHit: { url: '/effects/EffectMaterials/ef_lightning03.efkefc', scale: 0.2 }, // 放电命中（连锁光柱）
  minionWaterSplash: { url: '/effects/M_WaterImpact/M_WaterImpact.efkefc', scale: 0.24 },// 撕咬/钳击水面爆点
});

// 2026-11-13 怪物模式新增道具的专属特效。
// 只登记素材包里**还没有被引用**的三段，其余全部复用现成 FX_DEFS
// （三连弹借 fxWaterImpact、引雷落地借 fxLightningStrike、冲角撞击借 fxSonicBoom），
// 避免同一个 .efkefc 被 loadEffect 两次白白多占内存。
Object.assign(FX_DEFS, {
  fxHarpoonFly: FX_PACK('P2_BloodLance', 0.3),   // 深海鱼叉飞行体：血枪穿刺
  fxHarpoonHit: FX_PACK('M_AttackImpact', 0.45), // 鱼叉贯穿命中（比普通 hit 重一档）
  fxThunderFly: FX_PACK('A_BlueLaser', 0.28),    // 引雷针飞行体：蓝色光束
  // 冲角护符的船身光罩。和 shield 的 Barrior01 刻意错开，免得玩家分不清
  ramCrest: { url: '/effects/Version16/Barrior02.efkefc', scale: 0.34 },
});

// 2026-11-14 道具赛新增三件区域型道具的专属特效。
// 只有这三个是**新加载**的（目录里都有 fxres.json，哈希资源能正常改写）：
//   fxHolySandstorm 圣光沙暴 · fxGateOfCalve 逆流之门 · fxSwordStorm 剑刃风暴
// 血枪狙击 / 圣域 / 护盾墙**刻意不加新素材**：
//   血枪直接复用 BOSS 模式已在用的 `fxHarpoonFly`(P2_BloodLance) + `fxHarpoonHit`，
//   圣域的地面法阵复用 `fxMagic2Holy`（符文六角阵），护盾墙复用已注册的 `antimagn`(Barrior03)。
//   理由同上面鱼叉那段：同一个 .efkefc 被 loadEffect 两次只会白占内存。
// 注意 `public/effects/MagicArea/` 与 `public/effects/BloodLance/` **没有 fxres.json**，
// 里面的贴图是哈希名裸文件，直接 FX_PACK 会 404 掉整条特效 —— 别图省事往那边引。
Object.assign(FX_DEFS, {
  fxHolySandstorm: FX_PACK('P1_HolySandstorm', 0.5), // 金色沙暴柱（罩住第一名）
  fxGateOfCalve:   FX_PACK('P2_GateOfCalve', 0.4),   // 紫金传送门（逆流之门两端）
  fxSwordStorm:    FX_PACK('P2_SwordStorm', 0.36),   // 环形剑刃风暴（跟随施放者）
});
// 巨鲸鲨吐泡泡没有新增素材：泡泡本体是 three.js 的菲涅尔球（位置要逐帧控，efk 追不上），
// 只有「嘴里那口气」和「破裂」两下借现成的 M_Magic1Water 蓝水环（fxMagic1Water），
// 播放时用 play 的 scale 参数按 0.2 / 0.55 两档缩放，避免同一个特效重复加载三份。

// Effekseer 运行时是全局单例：重复 initRuntime 会重新编译/重新初始化 WASM，
// 把**已经在用的 context 全部作废**（大厅展示台 + 比赛各有一份 Effects）。
// 所以整页只初始化一次，后来的调用者排队等同一个回调。
let runtimeState = 'idle'; // idle | loading | ready | failed
const runtimeWaiters = [];

function ensureRuntime(onReady, onError) {
  const eff = window.effekseer;
  if (!eff) {
    onError();
    return;
  }
  if (runtimeState === 'ready') { onReady(); return; }
  runtimeWaiters.push({ onReady, onError });
  if (runtimeState === 'loading') return;
  runtimeState = 'loading';
  eff.initRuntime('/effekseer/effekseer.wasm', () => {
    runtimeState = 'ready';
    for (const w of runtimeWaiters.splice(0)) w.onReady();
  }, () => {
    runtimeState = 'failed';
    for (const w of runtimeWaiters.splice(0)) w.onError();
  });
}

export class Effects {
  constructor() {
    this.ctx = null;            // EffekseerContext
    this.renderer = null;
    this.disposed = false;
    this.effects = {};          // name -> EffekseerEffect | null
    this.attached = new Map();  // key -> { handle, follow, life }
    this.transient = [];        // one-shot handles, bounded to avoid particle buildup
    this.maxTransient = 48;
    this.updateAccumulator = 0;
    this.updateStep = 1 / 30;
    this.failed = false;
    // 2026-11-22：某些 .efkefc 在无头/低端 GPU 上加载后会破坏 Effekseer WASM 状态，
    // 之后每次 ctx.play 都抛 "null function or function signature mismatch"，直接卡死主循环。
    // 这里给单个特效做"一次失败即拉黑"，并把整层 FX 调用包在 try 里，保证游戏逻辑不受牵连。
    this.brokenFx = new Set();
  }

  /**
   * 在渲染器创建后调用（WASM 异步加载）
   * @param {THREE.WebGLRenderer} renderer
   * @param {string[]|null} names 只加载这些特效（展示台只用到氮气那几段，避免加载全表）
   */
  init(renderer, names = null) {
    if (!window.effekseer) {
      console.warn('[fx] effekseer.min.js 未加载，特效已禁用');
      this.failed = true;
      return;
    }
    this.renderer = renderer;
    ensureRuntime(() => {
      if (this.disposed) return;
      this.ctx = window.effekseer.createContext();
      if (!this.ctx) { this.failed = true; return; }
      this.ctx.init(renderer.getContext());
      // 快速渲染模式：跳过状态回读（每帧后需 renderer.resetState()）
      this.ctx.setRestorationOfStatesFlag(false);
      this.#loadAll(names);
    }, () => {
      console.warn('[fx] Effekseer WASM 加载失败，特效已禁用');
      this.failed = true;
    });
  }

  #loadAll(names = null) {
    const allow = names ? new Set(names) : null;
    for (const [name, def] of Object.entries(FX_DEFS)) {
      if (allow && !allow.has(name)) continue;
      const onError = (reason, path) => {
        console.warn('[fx] 特效加载失败:', name, reason, path);
        this.effects[name] = null;
      };
      if (!def.fxres) {
        this.effects[name] = this.ctx.loadEffect(def.url, def.scale, null, onError);
        continue;
      }
      // fx-projects 素材：先取同目录 fxres.json（哈希名 → 实际文件名）再加载。
      // 音频统一指向静音占位：工程引用的 wav 不在素材包里，缺一整个特效都会加载失败。
      const dir = def.url.slice(0, def.url.lastIndexOf('/') + 1);
      fetch(def.fxres)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((manifest) => {
          if (this.disposed || !this.ctx) return;
          const map = (manifest && manifest.res) || {};
          const redirect = (p) => {
            const base = p.split('/').pop();
            const lower = base.toLowerCase();
            if (/\.(wav|ogg|mp3)$/.test(lower)) return '/effects/_silence.wav';
            if (map[base]) return dir + map[base];
            return dir + (lower.endsWith('.png') ? base : `${base}.png`);
          };
          this.effects[name] = this.ctx.loadEffect(def.url, def.scale, null, onError, redirect);
        });
    }
  }

  /** 一次性播放（scale 可选：BOSS 级技能需要放大才看得见） */
  play(name, x, y, z, scale = null) {
    const effect = this.effects[name];
    if (!this.ctx || !effect || this.brokenFx.has(name)) return null;
    try {
      const handle = this.ctx.play(effect, x, y, z);
      if (handle) {
        if (scale != null && handle.setScale) handle.setScale(scale, scale, scale);
        this.transient.push(handle);
        while (this.transient.length > this.maxTransient) {
          const stale = this.transient.shift();
          try { stale?.stop(); } catch { /* already ended */ }
        }
      }
      return handle;
    } catch (e) {
      // 单个特效把 WASM 弄坏时立刻拉黑，不让异常冒到主循环把游戏卡死
      this.brokenFx.add(name);
      console.warn(`[fx] 特效 ${name} 播放失败，已禁用：`, e?.message);
      return null;
    }
  }

  /**
   * 跟随播放（如护盾/氮气/漩涡）
   * @param {string} key 唯一键（同键重复调用会先停旧的）
   * @param {string} name 特效名
   * @param {Function} follow () => {x, y, z} 每帧更新位置
   * @param {object} opts { life: 秒（到期自动停，0=一直）, rot: () => {x,y,z} 每帧更新朝向（弧度）, loop: 播完自动重播（默认开） }
   */
  playAttached(key, name, follow, opts = {}) {
    if (!this.ctx || !this.effects[name] || this.brokenFx.has(name)) return;
    this.stopAttached(key);
    const effect = this.effects[name];
    let handle;
    try {
      handle = this.#spawnInstance({ effect, scale: opts.scale, color: opts.color });
    } catch (e) {
      this.brokenFx.add(name);
      console.warn(`[fx] 特效 ${name} 实例创建失败，已禁用：`, e?.message);
      return;
    }
    if (!handle) return;
    const p = follow();
    try {
      handle.setLocation(p.x, p.y, p.z);
      if (opts.rot) { const r0 = opts.rot(); handle.setRotation(r0.x, r0.y, r0.z); }
    } catch (e) {
      this.brokenFx.add(name);
      console.warn(`[fx] 特效 ${name} 定位失败，已禁用：`, e?.message);
      try { handle.stop(); } catch { /* */ }
      return;
    }
    // One-shot item effects must never be replayed after their native handle
    // expires. Callers opt into looping only for persistent jet/shield/aura FX.
    this.attached.set(key, {
      handles: [handle], effect, follow, life: opts.life || 0, rot: opts.rot || null,
      scale: opts.scale ?? null, loop: opts.loop === true, color: opts.color ?? null,
      // 拖尾模式：每一发在出生点"定住"，船开走后在身后留一串，看起来就是从
      // 喷口连续喷射出去的尾焰（否则永远只有喷口处一颗光球，像挂着个球）。
      trail: opts.trail === true,
      // 周期重播：不等上一发播完就叠下一发（尾焰用）。单发素材在生命尾巴上
      // 粒子会断流，只有重播而没有重叠时，喷射看起来是一顿一顿的脉冲。
      loopEvery: opts.loopEvery > 0 ? opts.loopEvery : 0,
      pool: Math.max(1, opts.pool || 2),
      next: opts.loopEvery > 0 ? opts.loopEvery : 0,
    });
  }

  /** 开一发新的实例并把缩放 / 染色贴上（新实例总是回到素材默认值） */
  #spawnInstance(a) {
    try {
      const handle = this.ctx.play(a.effect, 0, 0, 0);
      if (!handle) return null;
      if (a.scale != null && handle.setScale) {
        const s = effectScaleValue(a.scale);
        handle.setScale(s.x, s.y, s.z);
      }
      const color = effectColorValue(a.color);
      if (color && handle.setAllColor) handle.setAllColor(color.r, color.g, color.b, color.a);
      return handle;
    } catch {
      return null;
    }
  }

  /** 把一发实例摆到当前喷口位置并套上朝向（拖尾模式用，只摆一次） */
  #placeHandle(handle, a) {
    try {
      const p = a.follow();
      handle.setLocation(p.x, p.y, p.z);
      if (a.rot) { const r = a.rot(); handle.setRotation(r.x, r.y, r.z); }
    } catch { /* 跟随目标没了，交给下一帧的清理 */ }
  }

  stopAttached(key) {
    const a = this.attached.get(key);
    if (!a) return;
    const list = a.handles ?? (a.handle ? [a.handle] : []);
    for (const h of list) {
      try { h.stop(); } catch { /* 已结束 */ }
    }
    this.attached.delete(key);
  }

  /** 每帧更新（在 renderer.render 之前调用） */
  update(dt) {
    if (!this.ctx) return;
    for (const [key, a] of this.attached) {
      if (a.life > 0) {
        a.life -= dt;
        if (a.life <= 0) {
          this.stopAttached(key);
          continue;
        }
      }
      // 丢掉已经播完的实例（Effekseer 的 handle 播完就 exists=false）
      if (a.handles) a.handles = a.handles.filter((h) => h && h.exists !== false);

      if (a.loopEvery > 0) {
        // 周期重播：一次性的喷射素材播到尾巴粒子会明显变稀，只靠"播完再放"
        // 就会看到一顿一顿的脉冲。这里不等它结束就提前叠一发新的，旧实例自己
        // 播完退出，所以整个加速期间喷口上始终有粒子在喷（持续冲刺尾焰）。
        a.next -= dt;
        // 掉帧 / 低帧率时一帧只补一发，尾焰就会在身后留下一段空隙（看起来像
        // 间断一两下再喷）。这里按漏掉的时间把该补的几发一次补齐；上限 8 发
        // 兜住切后台回来这种超长帧，避免瞬间炸出一大堆粒子。
        let spawns = 0;
        while ((a.next <= 0 || a.handles.length === 0) && spawns < 8) {
          a.next += a.loopEvery;
          spawns += 1;
          const h = this.#spawnInstance(a);
          if (!h) break;
          // 拖尾模式下每发只在出生时对齐喷口，之后船开走它留在原地
          if (a.trail) this.#placeHandle(h, a);
          a.handles.push(h);
          while (a.handles.length > a.pool) {
            const old = a.handles.shift();
            try { old.stop(); } catch { /* 已结束 */ }
          }
        }
        // 补发被上限截断时把积压的时间丢掉，否则接下来每帧都会补满 8 发
        if (spawns >= 8) a.next = a.loopEvery;
      } else if (a.loop && !a.handles[0]?.exists) {
        // 老行为：播完再重播（护盾 / 漩涡这类不需要重叠的持续特效）
        const h = this.#spawnInstance(a);
        if (!h) { this.stopAttached(key); continue; }
        a.handles = [h];
      }
      // 一次性挂载特效播完后保持安静，等调用方 stopAttached
      if (!a.handles?.length) continue;
      if (a.trail) {
        // 拖尾：每发在出生点定住，但把**最新一发**重新贴到喷口上。
        // 这样喷口处永远有一团正在喷的尾焰（腾空、掉帧、上下起伏都不会出现
        // "尾焰从喷口断开/消失"的空档），身后仍然留着一串逐渐散开的尾迹。
        this.#placeHandle(a.handles[a.handles.length - 1], a);
        continue;
      }
      try {
        const p = a.follow();
        const r = a.rot ? a.rot() : null;
        for (const handle of a.handles) {
          handle.setLocation(p.x, p.y, p.z);
          if (a.scale != null && handle.setScale) {
            const s = effectScaleValue(a.scale);
            handle.setScale(s.x, s.y, s.z);
          }
          const c = effectColorValue(a.color);
          if (c && handle.setAllColor) handle.setAllColor(c.r, c.g, c.b, c.a);
          if (r) handle.setRotation(r.x, r.y, r.z);
        }
      } catch {
        this.stopAttached(key);
      }
    }
    // Keep follow transforms responsive, but advance the particle simulation at
    // a bounded cadence. Effekseer updates are considerably more expensive than
    // the Three.js scene and do not benefit from running at high refresh rates.
    this.updateAccumulator += Math.min(dt, 0.05);
    if (this.updateAccumulator < this.updateStep) return;
    const simDt = Math.min(this.updateAccumulator, 0.1);
    this.updateAccumulator = 0;
    this.transient = this.transient.filter((handle) => {
      if (handle?.exists !== false) return true;
      try { handle?.stop(); } catch { /* already ended */ }
      return false;
    });
    try {
      this.ctx.update(simDt * 60.0);
    } catch (e) {
      // WASM 状态一旦被某个素材弄坏，ctx.update 会连帧抛错；这里只报一次并停掉整层特效，
      // 绝不让异常冒泡到 Game.#frame（那正是"放个道具整个界面卡死"的根因）。
      console.warn('[fx] Effekseer 更新失败，特效层已停用：', e?.message);
      this.failed = true;
      this.ctx = null;
    }
  }

  /** 渲染（在 renderer.render 之后调用） */
  draw(camera) {
    if (!this.ctx || this.failed) return;
    try {
      this.ctx.setProjectionMatrix(camera.projectionMatrix.elements);
      this.ctx.setCameraMatrix(camera.matrixWorldInverse.elements);
      this.ctx.draw();
    } catch (e) {
      console.warn('[fx] Effekseer 渲染失败，特效层已停用：', e?.message);
      this.failed = true;
      this.ctx = null;
    }
    // Effekseer 弄脏了 GL 状态，重置给 three.js
    if (this.renderer.resetState) this.renderer.resetState();
  }

  dispose() {
    this.disposed = true;
    for (const key of [...this.attached.keys()]) this.stopAttached(key);
    if (this.ctx) {
      try { this.ctx.stopAll(); } catch { /* ignore */ }
      try { window.effekseer?.releaseContext?.(this.ctx); } catch { /* ignore */ }
      this.ctx = null;
    }
    this.transient.length = 0;
  }
}
